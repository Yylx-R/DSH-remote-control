import { secrets } from './_secrets.mjs'
const S = secrets()

// 验证「手机看电脑画面」：以手机身份连 relay，向在线电脑发 screen.capture，下载并保存截图。
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.PHONE_SERVER || S.server
const HANDLE = process.env.PHONE_HANDLE || S.handle
const PASSWORD = process.env.PHONE_PASSWORD || S.password
const TOKEN_FILE = new URL('./.phone-token', import.meta.url)
const OUT = process.env.SCREEN_OUT || join(tmpdir(), 'dsh-remote-screen.jpg')

async function login() {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: HANDLE, password: PASSWORD, device: { kind: 'mobile', name: '调试手机', platform: 'node-sim' } }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'login failed')
  writeFileSync(TOKEN_FILE, data.token)
  return data
}

let token = ''
try {
  token = readFileSync(TOKEN_FILE, 'utf8').trim()
} catch {}
if (!token) token = (await login()).token

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

const t0 = Date.now()
const shot = await ask('screen.capture', { maxWidth: 1280, quality: 55 })
console.log('电脑返回:', JSON.stringify(shot), `${Date.now() - t0}ms`)

const res = await fetch(`${BASE}/api/blob/${shot.blobId}`, { headers: { authorization: `Bearer ${token}` } })
if (!res.ok) throw new Error(`下载失败 ${res.status}`)
const buf = Buffer.from(await res.arrayBuffer())
writeFileSync(OUT, buf)
console.log('已保存:', OUT, `${(buf.length / 1024).toFixed(0)}KB`)

await fetch(`${BASE}/api/blob/${shot.blobId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
ws.close()
process.exit(0)
