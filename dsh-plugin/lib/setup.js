// 电脑端配置页：在 DSH 自己的 Web 服务上挂两个路由，浏览器里填服务器地址/账号/密码即可。
//   GET  /remote-control        配置页面
//   GET  /remote-control/status 当前连接状态（页面轮询用）
//   POST /remote-control/save   保存配置并立即重连
import { saveConfig } from './config.js'

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 远程控制 · 电脑端配置</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 16px 48px; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f6f7f9; color: #1a1d21; }
  @media (prefers-color-scheme: dark) { body { background: #101317; color: #e6e8eb; } }
  .wrap { max-width: 520px; margin: 0 auto; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p.sub { margin: 0 0 22px; color: #6b7280; font-size: 13px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 18px; }
  @media (prefers-color-scheme: dark) { .card { background: #171b21; border-color: #262b33; } }
  label { display: block; font-size: 12px; color: #6b7280; margin: 14px 0 6px; }
  label:first-child { margin-top: 0; }
  input[type=text], input[type=password], input[type=url] {
    width: 100%; padding: 10px 12px; font-size: 14px; border-radius: 10px;
    border: 1px solid #d1d5db; background: transparent; color: inherit; outline: none;
  }
  input:focus { border-color: #4d6bfe; }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 18px; }
  button { padding: 10px 18px; font-size: 14px; border-radius: 10px; border: 0; cursor: pointer;
           background: #4d6bfe; color: #fff; font-weight: 500; }
  button:disabled { opacity: .6; cursor: default; }
  .ghost { background: transparent; color: #6b7280; border: 1px solid #d1d5db; }
  .msg { margin-top: 14px; font-size: 13px; min-height: 20px; }
  .ok { color: #16a34a; } .err { color: #dc2626; }
  .state { margin-top: 18px; font-size: 13px; color: #6b7280; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; margin-right: 6px; }
  .dot.on { background: #22c55e; }
  .tip { margin-top: 20px; font-size: 12px; color: #6b7280; line-height: 1.7; }
</style>
</head>
<body>
<div class="wrap">
  <h1>DSH 远程控制 · 电脑端</h1>
  <p class="sub">填写你自己的中转服务器地址和账号。保存后立即生效，不需要重启 DSH。</p>
  <div class="card">
    <label for="serverUrl">服务器地址</label>
    <input id="serverUrl" type="url" placeholder="http://你的服务器IP或域名" autocomplete="off" />
    <label for="handle">账号</label>
    <input id="handle" type="text" placeholder="在中继服务器上注册的账号" autocomplete="username" />
    <label for="password">密码</label>
    <input id="password" type="password" placeholder="登录密码" autocomplete="current-password" />
    <label for="deviceName">这台电脑的名称（手机端显示用）</label>
    <input id="deviceName" type="text" placeholder="留空则显示为「我的电脑」" autocomplete="off" />
    <div class="row">
      <button id="save">保存并连接</button>
      <button id="refresh" class="ghost">刷新状态</button>
    </div>
    <div class="msg" id="msg"></div>
    <div class="state" id="state"></div>
  </div>
  <div class="tip">
    第一次使用：先在服务器上注册账号（第一个注册的账号是管理员），再回到这里填地址和账号密码。<br />
    保存后，手机上用同一个账号登录、在「电脑」页输入配对码即可连上这台电脑。
  </div>
</div>
<script>
const $ = (s) => document.querySelector(s)
const msg = (text, cls) => { const m = $('#msg'); m.textContent = text || ''; m.className = 'msg ' + (cls || '') }

async function load() {
  const r = await fetch('/remote-control/status', { cache: 'no-store' })
  const j = await r.json()
  $('#serverUrl').value = j.serverUrl || ''
  $('#handle').value = j.handle || ''
  $('#deviceName').value = j.deviceName || ''
  $('#password').placeholder = j.hasPassword ? '已保存，留空则不修改' : '登录密码'
  const online = j.online
  $('#state').innerHTML = '<span class="dot ' + (online ? 'on' : '') + '"></span>' +
    (online ? '已连接到 ' + (j.serverUrl || '') + '，设备 ID ' + (j.deviceId || '-') : '未连接') +
    (j.error ? '（' + j.error + '）' : '')
}

async function save() {
  const body = {
    serverUrl: $('#serverUrl').value.trim(),
    handle: $('#handle').value.trim(),
    password: $('#password').value,
    deviceName: $('#deviceName').value.trim(),
  }
  if (!body.serverUrl) return msg('请填写服务器地址', 'err')
  if (!body.handle) return msg('请填写账号', 'err')
  $('#save').disabled = true
  msg('正在保存…')
  try {
    const r = await fetch('/remote-control/save', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status))
    msg('已保存，正在连接…', 'ok')
    $('#password').value = ''
    setTimeout(() => { load() }, 1500)
  } catch (e) {
    msg('保存失败：' + e.message, 'err')
  } finally {
    $('#save').disabled = false
  }
}

$('#save').onclick = save
$('#refresh').onclick = load
load()
setInterval(load, 4000)
</script>
</body>
</html>`

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

export function registerSetup(hostCtx, { cfg, log, client }) {
  const web = hostCtx.get?.('webServer')
  if (!web || typeof web.register !== 'function') {
    log.warn('webServer 不可用，跳过电脑端配置页')
    return null
  }

  const origin = (() => {
    try {
      return web.getOrigin?.() || ''
    } catch {
      return ''
    }
  })()

  web.register({
    kind: 'exact',
    path: '/remote-control',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE)
    },
  })

  web.register({
    kind: 'exact',
    path: '/remote-control/status',
    handler: (req, res) => {
      cfg.refresh?.()
      sendJson(res, 200, {
        serverUrl: cfg.serverUrl || '',
        handle: cfg.handle || '',
        deviceName: cfg.deviceName || '',
        hasPassword: !!cfg.password,
        online: !!client?.online,
        deviceId: cfg.deviceId || '',
      })
    },
  })

  web.register({
    kind: 'exact',
    path: '/remote-control/save',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const serverUrl = String(body.serverUrl || '').trim().replace(/\/+$/, '')
        const handle = String(body.handle || '').trim()
        const password = String(body.password || '')
        const deviceName = String(body.deviceName || '').trim()
        if (!serverUrl) return sendJson(res, 400, { ok: false, error: '请填写服务器地址' })
        if (!/^https?:\/\//i.test(serverUrl)) return sendJson(res, 400, { ok: false, error: '服务器地址要以 http:// 或 https:// 开头' })
        if (!handle) return sendJson(res, 400, { ok: false, error: '请填写账号' })

        const changed = serverUrl !== cfg.serverUrl || handle !== cfg.handle || (password && password !== cfg.password)
        cfg.serverUrl = serverUrl
        cfg.handle = handle
        cfg.deviceName = deviceName
        if (password) cfg.password = password
        if (changed) {
          // 换了服务器/账号/密码，旧 token 不再有效
          cfg.token = ''
          cfg.deviceId = ''
        }
        cfg.enabled = true
        saveConfig(cfg)
        cfg.refresh?.()
        log.info(`配置已更新：${serverUrl} ${handle}${changed ? '（已清除旧登录态）' : ''}`)
        try {
          client?.restart?.()
        } catch (err) {
          log.warn(`重连失败：${err.message}`)
        }
        sendJson(res, 200, { ok: true })
      } catch (err) {
        log.error(`保存配置失败：${err.message}`)
        sendJson(res, 400, { ok: false, error: err.message })
      }
    },
  })

  log.info(`电脑端配置页：${origin}/remote-control`)
  return `${origin}/remote-control`
}
