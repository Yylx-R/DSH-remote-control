import { secrets } from './_secrets.mjs'
const S = secrets()

// 以「手机」身份给电脑发一条指令并打印回复（运维用）
//   node scripts/send-op.mjs <op> [jsonParams]
// 例：node scripts/send-op.mjs device.stopClient
const SERVER = process.env.DSH_SERVER || S.server
const HANDLE = process.env.DSH_HANDLE || S.handle
const PASSWORD = process.env.DSH_PASSWORD || S.password

const op = process.argv[2]
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {}
if (!op) {
  console.error('用法：node scripts/send-op.mjs <op> [jsonParams]')
  process.exit(1)
}

const res = await fetch(`${SERVER}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ handle: HANDLE, password: PASSWORD, name: '运维脚本', platform: 'node' }),
})
const login = await res.json()
if (!res.ok) {
  console.error('登录失败', login)
  process.exit(1)
}

const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws')
const rid = 'rid-' + Date.now()

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('超时：电脑未回复')), 20000)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', token: login.token })))
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data))
    if (frame.t === 'welcome') {
      const desktop = (frame.pairs || []).find((p) => p.kind === 'desktop')
      if (!desktop) {
        clearTimeout(timer)
        reject(new Error('没有在线的电脑'))
        return
      }
      ws.send(JSON.stringify({
        t: 'msg',
        id: rid,
        to: desktop.id,
        kind: 'op',
        body: { op, rid, params },
      }))
    }
    if (frame.t === 'msg' && frame.body?.rid === rid) {
      clearTimeout(timer)
      console.log(JSON.stringify(frame.body))
      resolve()
    }
  })
  ws.addEventListener('error', (e) => reject(new Error(String(e?.message || e))))
})

ws.close()
process.exit(0)
