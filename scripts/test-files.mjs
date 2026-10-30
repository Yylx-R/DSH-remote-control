import { secrets } from './_secrets.mjs'
const S = secrets()

// 验证「手机取回电脑上的交付物」：以手机身份连 relay，
// 向在线电脑发 files.list 列出会话目录，再 files.send 取一个文件并下载保存。
// 用法：node scripts/test-files.mjs [文件名过滤]
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.PHONE_SERVER || S.server
const HANDLE = process.env.PHONE_HANDLE || S.handle
const PASSWORD = process.env.PHONE_PASSWORD || S.password
const FILTER = process.argv[2] || ''
const OUT_DIR = process.env.FILES_OUT || tmpdir()
const TOKEN_FILE = new URL('./.phone-token', import.meta.url)

let token = ''
try {
  token = readFileSync(TOKEN_FILE, 'utf8').trim()
} catch {}
if (!token) {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: HANDLE, password: PASSWORD, device: { kind: 'mobile', name: '调试手机', platform: 'node-sim' } }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'login failed')
  token = data.token
  writeFileSync(TOKEN_FILE, token)
}

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${res.status} ${data.error || ''}`)
  return data
}

const me = await api('/api/me')
const desktop = (me.pairs || []).map((p) => (p.peer ? { ...p.peer, pairId: p.pairId } : p)).find((p) => p.kind === 'desktop' && p.online)
if (!desktop) throw new Error('没有在线的电脑')
console.log('目标电脑:', desktop.name, desktop.id)

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws')
const pending = new Map()
let ridSeq = 0

function ask(op, body = {}, timeout = 40_000) {
  const rid = `t${Date.now()}-${++ridSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(rid)
      reject(new Error(`超时：${op}`))
    }, timeout)
    pending.set(rid, { resolve, reject, timer })
    ws.send(JSON.stringify({ t: 'msg', id: rid, to: desktop.id, kind: 'control', body: { op, rid, ...body } }))
  })
}

await new Promise((resolve, reject) => {
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', token })))
  ws.addEventListener('message', (ev) => {
    const f = JSON.parse(ev.data)
    if (f.t === 'welcome') return resolve()
    if (f.t === 'error') return reject(new Error(`服务器错误 ${JSON.stringify(f)}`))
    if (f.t === 'msg') {
      const b = f.body || {}
      const p = pending.get(b.rid)
      if (!p) return
      pending.delete(b.rid)
      clearTimeout(p.timer)
      if (b.ok) p.resolve(b.data)
      else p.reject(new Error(b.error?.message || '失败'))
    }
  })
})

const sessions = await ask('sessions.list', {})
const session = (sessions.items || []).find((s) => !s.blank) || (sessions.items || [])[0]
if (!session) throw new Error('电脑上没有会话')
console.log('会话:', session.title || session.sessionId, '·', session.cwd || '')

const listed = await ask('files.list', { sessionId: session.sessionId })
console.log(`目录 ${listed.cwd} 共 ${listed.items.length} 个文件：`)
for (const it of listed.items.slice(0, 12)) {
  console.log(`  ${(it.size / 1024).toFixed(1).padStart(8)}KB  ${it.path}`)
}

const pick = listed.items.find((it) => it.path.includes(FILTER)) || listed.items[0]
if (!pick) throw new Error('目录里没有文件')
console.log('取回:', pick.path)

const sent = await ask('files.send', { sessionId: session.sessionId, path: pick.path })
console.log('电脑返回:', JSON.stringify(sent))

const res = await fetch(`${BASE}/api/blob/${sent.blobId}`, { headers: { authorization: `Bearer ${token}` } })
if (!res.ok) throw new Error(`下载失败 ${res.status}`)
const buf = Buffer.from(await res.arrayBuffer())
const out = join(OUT_DIR, sent.name)
writeFileSync(out, buf)
console.log('已保存:', out, `${(buf.length / 1024).toFixed(1)}KB`, buf.length === pick.size ? '大小一致 ✅' : `大小不符 ❌ (原 ${pick.size})`)

await fetch(`${BASE}/api/blob/${sent.blobId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
ws.close()
process.exit(0)
