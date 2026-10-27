import { secrets } from './_secrets.mjs'
const S = secrets()

// 联调用的「假手机」：用 HTTP + WebSocket 模拟 PWA 的行为，不依赖浏览器。
// 用途：验证 配对 → 会话列表 → 发消息 → 收流式回复 全链路。
// 用法：
//   node scripts/phone-sim.mjs pair <配对码>           # 认领配对码并等待确认
//   node scripts/phone-sim.mjs chat <会话ID> <文字>     # 发消息并打印回复
//   node scripts/phone-sim.mjs list                    # 列会话
const BASE = process.env.PHONE_SERVER || S.server
const HANDLE = process.env.PHONE_HANDLE || S.handle
const PASSWORD = process.env.PHONE_PASSWORD || S.password
const DEVICE_NAME = process.env.PHONE_DEVICE || '调试手机'
const TOKEN_FILE = new URL('./.phone-token', import.meta.url)
import { readFileSync, writeFileSync } from 'node:fs'

async function login() {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      handle: HANDLE,
      password: PASSWORD,
      device: { kind: 'mobile', name: DEVICE_NAME, platform: 'node-sim' },
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'login failed')
  writeFileSync(TOKEN_FILE, data.token)
  return data
}

async function token() {
  try {
    const t = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (t) return t
  } catch {}
  const d = await login()
  return d.token
}

async function api(path, init = {}) {
  const t = await token()
  const res = await fetch(BASE + path, {
    ...init,
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', ...(init.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${res.status} ${data.error || ''}`)
  return data
}

function connect() {
  return new Promise(async (resolve, reject) => {
    const t = await token()
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws')
    const pending = new Map()
    const streams = new Map()
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', token: t })))
    ws.addEventListener('message', (ev) => {
      const f = JSON.parse(ev.data)
      if (f.t === 'welcome') resolve({ ws, pending, streams })
      else if (f.t === 'error') console.log('[phone] 服务器错误', f)
      else if (f.t === 'msg') {
        const b = f.body || {}
        if (b.op === 'reply' && pending.has(b.rid)) {
          const { resolve: r } = pending.get(b.rid)
          pending.delete(b.rid)
          r(b)
        } else if (b.op === 'stream') {
          const cb = streams.get(b.subId)
          if (cb) cb(b)
        }
      }
    })
    ws.addEventListener('error', reject)
    setTimeout(() => reject(new Error('ws timeout')), 8000)
  })
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2)
  if (cmd === 'login') {
    const d = await login()
    console.log('登录成功', d.device)
    return
  }
  if (cmd === 'list') {
    const { ws, pending } = await connect()
    const rid = 'r' + Date.now()
    const p = new Promise((r) => pending.set(rid, { resolve: r }))
    ws.send(JSON.stringify({ t: 'msg', id: rid, to: (await pickDesktop())?.id, kind: 'dsh', body: { op: 'sessions.list', rid } }))
    console.log(JSON.stringify(await p, null, 2))
    ws.close()
    return
  }
  if (cmd === 'pairs') {
    console.log(JSON.stringify(await pairs(), null, 2))
    return
  }
  if (cmd === 'pair') {
    const code = a1
    const claimed = await api('/api/pair/claim', { method: 'POST', body: JSON.stringify({ code }) })
    console.log('已认领，等待电脑确认…', claimed)
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 1000))
      const st = await api('/api/pair/status?code=' + code)
      console.log('状态', st.state)
      if (st.state === 'confirmed') {
        console.log('配对完成', st)
        return
      }
      if (st.state === 'expired' || st.state === 'rejected') throw new Error('配对失败：' + st.state)
    }
    return
  }
  if (cmd === 'peek') {
    const sessionId = a1
    const { ws, pending, streams } = await connect()
    const desktop = (await pairs()).find((x) => x.kind === 'desktop')
    if (!desktop) throw new Error('没有已配对的电脑')
    const rid = 'k' + Date.now()
    const p = new Promise((r) => pending.set(rid, { resolve: r }))
    ws.send(JSON.stringify({ t: 'msg', id: rid, to: desktop.id, kind: 'dsh', body: { op: 'sessions.snapshot', rid, sessionId, maxMessages: Number(process.env.SIM_MAX || 40) } }))
    console.log('snapshot:', JSON.stringify(await p).slice(0, 1500))
    const subId = 's' + Date.now()
    const frid = 'f' + Date.now()
    const fp = new Promise((r) => pending.set(frid, { resolve: r }))
    ws.send(JSON.stringify({ t: 'msg', id: frid, to: desktop.id, kind: 'dsh', body: { op: 'sessions.follow', rid: frid, sessionId, subId } }))
    console.log('follow:', JSON.stringify(await fp))
    streams.set(subId, (b) => {
      if (b.frame) console.log('stream:', JSON.stringify(b.frame).slice(0, 400))
      if (b.error) console.log('stream error:', b.error)
      if (b.done) console.log('stream done')
    })
    await new Promise((r) => setTimeout(r, 5000))
    ws.close()
    return
  }
  if (cmd === 'chat') {
    const sessionId = a1
    const text = a2 || '你好'
    const { ws, pending, streams } = await connect()
    const desktop = await pickDesktop()
    if (!desktop) throw new Error('没有已配对的电脑')
    const subId = 's' + Date.now()
    const followRid = 'f' + Date.now()
    const followP = new Promise((r) => pending.set(followRid, { resolve: r }))
    ws.send(JSON.stringify({ t: 'msg', id: followRid, to: desktop.id, kind: 'dsh', body: { op: 'sessions.follow', rid: followRid, sessionId, subId } }))
    console.log('follow:', JSON.stringify(await followP))
    streams.set(subId, (b) => {
      if (b.frame) console.log('stream:', JSON.stringify(b.frame).slice(0, 300))
      if (b.error) console.log('stream error:', b.error)
      if (b.done) console.log('stream done')
    })
    await new Promise((r) => setTimeout(r, 800))
    const rid = 'p' + Date.now()
    const p = new Promise((r) => pending.set(rid, { resolve: r }))
    ws.send(JSON.stringify({ t: 'msg', id: rid, to: desktop.id, kind: 'dsh', body: { op: 'sessions.prompt', rid, sessionId, text } }))
    console.log('prompt:', JSON.stringify(await p))
    await new Promise((r) => setTimeout(r, 3000))
    ws.close()
    return
  }
  console.log('用法: login | pairs | list | pair <code> | chat <sessionId> <text>')
}

async function pairs() {
  const me = await api('/api/me')
  return (me.pairs || []).map((p) => (p.peer ? { ...p.peer, pairId: p.pairId } : p))
}

// 优先选在线的电脑，避免把消息投给已离线的旧设备
async function pickDesktop() {
  const list = (await pairs()).filter((p) => p.kind === 'desktop')
  return list.find((p) => p.online) || list[0]
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
