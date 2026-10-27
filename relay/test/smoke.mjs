// 端到端冒烟：注册→登录两设备→配对→WS 互发→blob 上传下载
const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const WS = BASE.replace(/^http/, 'ws') + '/ws'

let pass = 0
let fail = 0
const ok = (name) => {
  pass++
  console.log(`  ok   ${name}`)
}
const bad = (name, detail) => {
  fail++
  console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`)
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

function connect(token, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS)
    const inbox = []
    const waiters = []
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', token })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(ev.data)
      if (frame.t === 'welcome') return resolve({ ws, inbox, waiters, frame, label })
      const w = waiters.shift()
      if (w) w(frame)
      else inbox.push(frame)
    })
    ws.addEventListener('error', () => reject(new Error('ws error')))
    ws.addEventListener('close', (ev) => reject(new Error(`ws closed ${ev.code} ${ev.reason}`)))
  })
}

function next(conn, timeoutMs = 3000) {
  if (conn.inbox.length) return Promise.resolve(conn.inbox.shift())
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ t: 'timeout' }), timeoutMs)
    conn.waiters.push((f) => {
      clearTimeout(t)
      resolve(f)
    })
  })
}

async function main() {
  console.log(`relay smoke @ ${BASE}`)
  const handle = 'smoke_' + Math.random().toString(36).slice(2, 8)
  const password = 'smoke-pass-123'

  let r = await api('/healthz')
  r.status === 200 && r.json?.ok ? ok('healthz') : bad('healthz', r.text)

  r = await api('/api/register', { method: 'POST', body: { handle, password } })
  r.status === 200 ? ok('register (first user = admin)') : bad('register', r.text)

  r = await api('/api/login', {
    method: 'POST',
    body: { handle, password, device: { kind: 'desktop', name: 'PC-Test', platform: 'win32' } },
  })
  const desktop = r.json
  r.status === 200 && desktop.token ? ok('login desktop') : bad('login desktop', r.text)

  r = await api('/api/login', {
    method: 'POST',
    body: { handle, password, device: { kind: 'mobile', name: 'Phone-Test', platform: 'android' } },
  })
  const mobile = r.json
  r.status === 200 && mobile.token ? ok('login mobile') : bad('login mobile', r.text)

  r = await api('/api/me', { token: desktop.token })
  r.json?.devices?.length === 2 ? ok('me: 2 devices') : bad('me devices', r.text)

  r = await api('/api/pair/start', { method: 'POST', token: desktop.token })
  const code = r.json?.code
  r.status === 200 && code ? ok(`pair start (code ${code})`) : bad('pair start', r.text)

  r = await api('/api/pair/claim', { method: 'POST', token: mobile.token, body: { code } })
  r.status === 200 && r.json?.desktop ? ok('pair claim') : bad('pair claim', r.text)

  r = await api('/api/pair/confirm', { method: 'POST', token: desktop.token, body: { code, allow: true } })
  r.status === 200 && r.json?.ok ? ok('pair confirm') : bad('pair confirm', r.text)

  const dConn = await connect(desktop.token, 'desktop')
  const mConn = await connect(mobile.token, 'mobile')
  dConn.frame.pairs?.length === 1 ? ok('desktop welcome has 1 pair') : bad('desktop pairs', JSON.stringify(dConn.frame))
  mConn.frame.pairs?.length === 1 ? ok('mobile welcome has 1 pair') : bad('mobile pairs', JSON.stringify(mConn.frame))

  mConn.ws.send(
    JSON.stringify({ t: 'msg', to: desktop.device.id, kind: 'dsh', body: { hello: 'from phone' } }),
  )
  const ack = await next(mConn)
  ack.t === 'ack' && ack.delivered ? ok('sender got ack delivered') : bad('ack', JSON.stringify(ack))

  const got = await next(dConn)
  got.t === 'msg' && got.body?.hello === 'from phone' ? ok('desktop received msg') : bad('recv', JSON.stringify(got))

  // 离线队列：断开手机，再发一条，重连后应补发
  mConn.ws.close()
  await new Promise((r2) => setTimeout(r2, 200))
  dConn.ws.send(JSON.stringify({ t: 'msg', to: mobile.device.id, kind: 'dsh', body: { offline: true } }))
  const dAck = await next(dConn)
  dAck.t === 'ack' && dAck.delivered === false ? ok('offline msg queued') : bad('offline ack', JSON.stringify(dAck))

  const mConn2 = await connect(mobile.token, 'mobile2')
  const queued = await next(mConn2)
  queued.t === 'msg' && queued.body?.offline ? ok('offline msg flushed on reconnect') : bad('flush', JSON.stringify(queued))

  // blob 往返
  const payload = Buffer.from('hello blob ' + Date.now())
  let res = await fetch(BASE + '/api/blob', {
    method: 'POST',
    headers: { authorization: `Bearer ${desktop.token}`, 'content-type': 'application/octet-stream', 'x-name': 'a.txt' },
    body: payload,
  })
  const up = await res.json()
  up.blobId ? ok('blob upload') : bad('blob upload', JSON.stringify(up))
  res = await fetch(BASE + '/api/blob/' + up.blobId, { headers: { authorization: `Bearer ${desktop.token}` } })
  const back = Buffer.from(await res.arrayBuffer())
  back.equals(payload) ? ok('blob download roundtrip') : bad('blob download')

  // 解除配对后不能再发
  res = await fetch(BASE + '/api/pairs', { headers: { authorization: `Bearer ${desktop.token}` } })
  const pairs = (await res.json()).pairs
  res = await fetch(BASE + '/api/pairs/' + pairs[0].pairId, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${desktop.token}` },
  })
  res.status === 200 ? ok('pair revoke') : bad('pair revoke', String(res.status))

  dConn.ws.close()
  mConn2.ws.close()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((err) => {
  console.error('smoke crashed:', err)
  process.exit(1)
})
