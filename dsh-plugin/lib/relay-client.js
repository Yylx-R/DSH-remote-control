// 中继客户端：出站 WebSocket 连接中转服务器（Node 24 全局 WebSocket，无第三方依赖）
import { platform, release } from 'node:os'
import { randomUUID } from 'node:crypto'
import { saveConfig } from './config.js'

const HEARTBEAT_MS = 20_000
const MAX_BACKOFF_MS = 30_000

export function createRelayClient({ cfg, log, onBody }) {
  let ws = null
  let stopped = false
  let attempts = 0
  let reconnectTimer = null
  let heartbeatTimer = null
  let deviceId = cfg.deviceId || ''
  let pairs = []

  const httpBase = () => String(cfg.serverUrl || '').trim().replace(/\/+$/, '')
  const wsUrl = () => httpBase().replace(/^http/, 'ws') + '/ws'

  function deviceInfo() {
    return {
      kind: 'desktop',
      name: String(cfg.deviceName || '').trim() || '我的电脑',
      platform: `${platform()}/${release()}`,
    }
  }

  async function ensureAuth() {
    cfg.refresh?.()
    if (cfg.token && cfg.deviceId) return true
    if (!httpBase()) {
      log.warn('未配置 serverUrl，跳过连接')
      return false
    }
    if (!cfg.handle || !cfg.password) {
      log.warn(`未配置 handle/password（配置文件：${cfg.__path}），跳过连接`)
      return false
    }
    try {
      const res = await fetch(httpBase() + '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: cfg.handle, password: cfg.password, device: deviceInfo() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        log.error(`登录中继失败 HTTP ${res.status} ${data.error || ''}`)
        return false
      }
      cfg.token = data.token
      cfg.deviceId = data.device?.id || ''
      deviceId = cfg.deviceId
      saveConfig(cfg)
      log.info(`登录中继成功：${deviceInfo().name} (${deviceId})`)
      return true
    } catch (err) {
      log.error(`登录中继异常：${err.message}`)
      return false
    }
  }

  function rawSend(frame) {
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  function send(to, body, blobs) {
    return rawSend({ t: 'msg', id: randomUUID(), to, kind: 'dsh', body, blobs: blobs || [] })
  }

  async function dispatch(frame) {
    switch (frame.t) {
      case 'welcome':
        attempts = 0
        pairs = Array.isArray(frame.pairs) ? frame.pairs : []
        log.info(`中继已连接，在线配对 ${pairs.length} 个`)
        return
      case 'msg':
        try {
          await onBody(frame.body, frame)
        } catch (err) {
          log.error(`处理指令失败：${err.message}`)
        }
        return
      case 'pair.request':
        log.info(`收到配对请求：${frame.mobile?.name || frame.mobile?.id} code=${frame.code}`)
        return
      case 'pair.revoked':
        log.warn(`配对已被解除：${frame.pairId}`)
        return
      case 'pair.result':
        log.info(`配对结果：${frame.ok ? '成功' : '被拒绝'} ${frame.pairId || ''}`)
        return
      case 'kick':
        log.warn(`被服务器断开：${frame.reason}`)
        try {
          ws?.close(4000, 'kick')
        } catch {}
        return
      case 'error':
        log.warn(`服务器错误：${frame.error}`)
        return
      case 'queue.done':
        log.info(`补发离线消息 ${frame.count} 条`)
        return
      default:
        return
    }
  }

  function scheduleReconnect() {
    if (stopped) return
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 5))
    attempts += 1
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  async function connect() {
    if (stopped) return
    // 已经有一条活着的连接就不重复建（防止同一设备被自己顶掉）
    if (ws && ws.readyState <= 1) return
    if (!(await ensureAuth())) {
      scheduleReconnect()
      return
    }
    // 同一时刻只保留一条连接，避免新旧连接互相顶掉（4002 风暴）
    if (ws) {
      try { ws.close(1000, 'replace') } catch {}
      ws = null
    }
    let socket
    try {
      socket = new WebSocket(wsUrl())
    } catch (err) {
      log.error(`创建 WebSocket 失败：${err.message}`)
      scheduleReconnect()
      return
    }
    ws = socket

    socket.addEventListener('open', () => {
      rawSend({ t: 'hello', token: cfg.token })
      log.info(`WebSocket 已打开：${wsUrl()}`)
      clearInterval(heartbeatTimer)
      heartbeatTimer = setInterval(() => rawSend({ t: 'ping' }), HEARTBEAT_MS)
      heartbeatTimer.unref?.()
    })

    socket.addEventListener('message', (ev) => {
      let frame
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (!frame || typeof frame !== 'object') return
      void dispatch(frame)
    })

    socket.addEventListener('close', (ev) => {
      // 已经被新连接替换掉的旧 socket：不要动心跳，也不要再触发重连
      if (ws !== socket) return
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
      ws = null
      if (stopped) return
      log.warn(`WebSocket 关闭 code=${ev.code}，${Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 5))}ms 后重连`)
      scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      /* close 事件会随后触发 */
    })
  }

  return {
    start() {
      stopped = false
      log.info(`启动中继客户端，目标 ${httpBase() || '(未配置)'}`)
      void connect()
    },
    stop() {
      stopped = true
      clearTimeout(reconnectTimer)
      clearInterval(heartbeatTimer)
      try {
        rawSend({ t: 'bye' })
        ws?.close(1000, 'bye')
      } catch {}
      ws = null
      log.info('中继客户端已停止')
    },
    restart() {
      const old = ws
      const wasOpen = !!old && old.readyState <= 1
      this.stop()
      attempts = 0
      const begin = () => this.start()
      if (wasOpen) {
        let done = false
        const go = () => { if (done) return; done = true; begin() }
        old.addEventListener('close', go, { once: true })
        const timer = setTimeout(go, 500)
        timer.unref?.()
      } else {
        begin()
      }
    },
    send,
    get deviceId() {
      return deviceId
    },
    get pairs() {
      return pairs
    },
    get online() {
      return !!ws && ws.readyState === 1
    },
  }
}
