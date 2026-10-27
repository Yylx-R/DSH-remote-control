// 独立验证 lib/setup.js 的配置页（不依赖 DSH 宿主）
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_PROFILE_DIR = mkdtempSync(join(tmpdir(), 'setup-'))

const { loadConfig, saveConfig } = await import('file:///E:/插件设计/dsh-plugin/lib/config.js')
const { registerSetup } = await import('file:///E:/插件设计/dsh-plugin/lib/setup.js')

const cfg = loadConfig({})
cfg.refresh = () => {}
let restarted = 0
const client = { restart: () => { restarted++ } }
const log = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.log('[warn]', ...a),
  error: (...a) => console.log('[error]', ...a),
}

const routes = []
const fakeWeb = {
  register: (r) => routes.push(r),
}
const hostCtx = {
  get: (k) => (k === 'webServer' ? fakeWeb : undefined),
  webServer: fakeWeb,
}
registerSetup(hostCtx, { cfg, log, client })
console.log('注册路由：', routes.map(r => `${r.kind} ${r.path}`).join(', '))

const server = http.createServer(async (req, res) => {
  const route = routes.find(r => r.kind === 'exact' && r.path === req.url.split('?')[0])
  if (!route) { res.writeHead(404); res.end('nf'); return }
  await route.handler(req, res)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const page = await (await fetch(`${base}/remote-control`)).text()
console.log('GET /remote-control：', page.length, '字节，含表单：', /id="serverUrl"/.test(page))
const status = await (await fetch(`${base}/remote-control/status`)).json()
console.log('GET status：', JSON.stringify(status))

const save = await (await fetch(`${base}/remote-control/save`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ serverUrl: 'https://example.com/', handle: 'alice', password: 'secret123', deviceName: '我的台式机', enabled: true }),
})).json()
console.log('POST save：', JSON.stringify(save))
console.log('落盘配置：', JSON.stringify(loadConfig({})))
console.log('client.restart 调用次数：', restarted)

server.close()
