// 冒烟测试用 relay：只验证 TLS / WSS / 反代链路，不含业务逻辑
// 正式版会替换为完整的中转服务（账号、路由、离线队列、blob）
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 8787)
const PUBLIC_URL = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ts: Date.now(), publicUrl: PUBLIC_URL }))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, req) => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress
  console.log(`[ws] connect ${ip}`)

  ws.send(JSON.stringify({ t: 'welcome', proto: 1, msg: 'smoke ok', serverTime: Date.now() }))

  ws.on('message', (data) => {
    ws.send(JSON.stringify({ t: 'echo', body: data.toString(), serverTime: Date.now() }))
  })

  ws.on('close', () => console.log(`[ws] close ${ip}`))
})

// 30s 心跳，踢掉死连接（与客户端 ping 节奏一致）
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue }
    ws.isAlive = false
    ws.ping()
  }
}, 30_000)
wss.on('close', () => clearInterval(heartbeat))

server.listen(PORT, '0.0.0.0', () => {
  console.log(`relay listening on :${PORT}  public=${PUBLIC_URL}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[relay] ${sig} received, closing...`)
    wss.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000)
  })
}
