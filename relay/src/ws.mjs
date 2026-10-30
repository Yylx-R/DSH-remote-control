// WebSocket 连接枢纽：设备在线表、消息转发、离线队列、配对通知
import { WebSocketServer } from 'ws'
import { now, uid, sha256 } from './util.mjs'
import { arePaired, nextSeq } from './db.mjs'

const MAX_BODY = 512 * 1024
const QUEUE_LIMIT = 500

export function createHub({ db, cfg }) {
  const conns = new Map() // deviceId -> { ws, device, alive }
  let wss = null

  const isOnline = (id) => {
    const c = conns.get(id)
    return !!(c && c.ws.readyState === 1)
  }
  const size = () => conns.size

  function send(deviceId, frame) {
    const c = conns.get(deviceId)
    if (!c || c.ws.readyState !== 1) return false
    try {
      c.ws.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  function kick(deviceId, reason) {
    const c = conns.get(deviceId)
    if (!c) return
    try {
      c.ws.send(JSON.stringify({ t: 'kick', reason }))
    } catch {}
    try {
      c.ws.close(4001, String(reason).slice(0, 120))
    } catch {}
  }

  function markDelivered(id) {
    db.prepare('UPDATE messages SET delivered=1, delivered_at=? WHERE id=?').run(now(), id)
  }

  function flushQueue(deviceId) {
    const rows = db
      .prepare(
        'SELECT * FROM messages WHERE to_device=? AND delivered=0 ORDER BY seq ASC LIMIT ?',
      )
      .all(deviceId, QUEUE_LIMIT)
    for (const m of rows) {
      const ok = send(deviceId, {
        t: 'msg',
        id: m.id,
        seq: m.seq,
        from: m.from_device,
        kind: m.kind,
        body: JSON.parse(m.body),
        blobs: m.blobs ? JSON.parse(m.blobs) : [],
        createdAt: m.created_at,
        queued: true,
      })
      if (!ok) break
      markDelivered(m.id)
    }
    if (rows.length) send(deviceId, { t: 'queue.done', count: rows.length })
  }

  function handleHello(ws, frame) {
    const raw = String(frame.token || '')
    if (!raw) return ws.close(4003, 'auth/required')
    const device = db
      .prepare('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL')
      .get(sha256(raw))
    if (!device) return ws.close(4003, 'auth/invalid')

    const old = conns.get(device.id)
    if (old) {
      console.log(`[relay] hello ${device.id} from ${ws._socket?.remoteAddress}: replace old conn same=${old.ws === ws} ready=${old.ws.readyState} oldFrom=${old.ws._socket?.remoteAddress}`)
      try {
        old.ws.close(4002, 'replaced')
      } catch {}
    }

    conns.set(device.id, { ws, device, alive: true })
    db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now(), device.id)

    const pairs = db
      .prepare(
        `SELECT d.id, d.kind, d.name, d.platform, d.pubkey FROM pairs p
         JOIN devices d ON d.id = CASE WHEN p.a=? THEN p.b ELSE p.a END
         WHERE p.revoked_at IS NULL AND (p.a=? OR p.b=?) AND d.revoked_at IS NULL`,
      )
      .all(device.id, device.id, device.id)

    send(device.id, {
      t: 'welcome',
      device: { id: device.id, kind: device.kind, name: device.name, platform: device.platform },
      pairs,
      serverTime: now(),
      heartbeatMs: 30000,
    })
    flushQueue(device.id)
  }

  function handleMsg(ws, device, frame) {
    const to = String(frame.to || '')
    const kind = String(frame.kind || 'dsh').slice(0, 32)
    const id = String(frame.id || uid('m')).slice(0, 64)
    if (!to) {
      console.log(`[relay] msg ${device.id} 无目标设备（target/required）`)
      send(device.id, { t: 'error', id, error: 'target/required' })
      return
    }
    if (to === device.id) {
      send(device.id, { t: 'error', id, error: 'target/self' })
      return
    }
    if (!arePaired(db, device.id, to)) {
      send(device.id, { t: 'error', id, error: 'pair/required' })
      return
    }
    const bodyText = JSON.stringify(frame.body ?? {})
    if (bodyText.length > MAX_BODY) {
      send(device.id, { t: 'error', id, error: 'msg/too-large' })
      return
    }
    const blobs = Array.isArray(frame.blobs) ? frame.blobs.slice(0, 20).map(String) : []
    const op = String(frame.body?.op || '')

    // 流式帧与指令回包是「一次性」的：目标离线时直接丢弃，不进离线队列
    // （否则一次长任务会把几百条 stream 帧写进库，撑爆存储也没意义）
    if (kind === 'dsh' && (op === 'stream' || op === 'reply')) {
      const ok = send(to, {
        t: 'msg',
        id,
        from: device.id,
        kind,
        body: frame.body ?? {},
        blobs,
        createdAt: now(),
      })
      if (!ok) console.log(`[relay] drop ${op} ${device.id} -> ${to}（目标离线）`)
      return
    }

    const seq = nextSeq(db, device.user_id, 'msg')
    const createdAt = now()
    db.prepare(
      `INSERT INTO messages(id, user_id, seq, from_device, to_device, kind, body, blobs, delivered, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
    ).run(id, device.user_id, seq, device.id, to, kind, bodyText, JSON.stringify(blobs), createdAt, createdAt + 7 * 86400_000)

    const ok = send(to, {
      t: 'msg',
      id,
      seq,
      from: device.id,
      kind,
      body: frame.body ?? {},
      blobs,
      createdAt,
    })
    if (ok) markDelivered(id)
    console.log(`[relay] msg ${device.id} -> ${to} kind=${kind} op=${frame.body?.op || '-'} delivered=${ok}`)
    send(device.id, { t: 'ack', id, seq, delivered: ok })
  }

  function handleFrame(ws, frame) {
    const conn = [...conns.values()].find((c) => c.ws === ws)
    if (!conn) {
      if (frame.t === 'hello') return handleHello(ws, frame)
      return ws.close(4003, 'auth/required')
    }
    const { device } = conn
    switch (frame.t) {
      case 'ping':
        conn.alive = true
        return send(device.id, { t: 'pong', ts: now() })
      case 'ack':
        if (frame.id) markDelivered(String(frame.id))
        return
      case 'msg':
        return handleMsg(ws, device, frame)
      case 'bye':
        return ws.close(1000, 'bye')
      default:
        return send(device.id, { t: 'error', error: 'frame/unknown' })
    }
  }

  function attach(server) {
    wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_BODY + 64 * 1024 })

    wss.on('connection', (ws, req) => {
      ws.alive = true
      const authTimer = setTimeout(() => {
        const authed = [...conns.values()].some((c) => c.ws === ws)
        if (!authed) ws.close(4003, 'auth/timeout')
      }, 10000)

      ws.on('message', (data) => {
        let frame
        try {
          frame = JSON.parse(data.toString())
        } catch {
          return ws.send(JSON.stringify({ t: 'error', error: 'frame/invalid' }))
        }
        if (!frame || typeof frame !== 'object') return
        if (frame.t === 'hello') clearTimeout(authTimer)
        try {
          handleFrame(ws, frame)
        } catch (err) {
          console.error('[ws]', err)
          try {
            ws.send(JSON.stringify({ t: 'error', error: 'internal' }))
          } catch {}
        }
      })

      ws.on('pong', () => {
        ws.alive = true
      })

      ws.on('close', () => {
        clearTimeout(authTimer)
        for (const [id, c] of conns) {
          if (c.ws === ws) {
            conns.delete(id)
            db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now(), id)
            break
          }
        }
      })

      ws.on('error', () => {})
    })

    const timer = setInterval(() => {
      for (const [id, c] of conns) {
        if (!c.alive) {
          // 容忍一次丢包：连续两个周期都没反应才断开，避免弱网下频繁闪断
          c.miss = (c.miss || 0) + 1
          if (c.miss < 2) {
            try {
              c.ws.ping()
            } catch {}
            continue
          }
          console.log(`[relay] heartbeat 超时，断开 ${id}`)
          try {
            c.ws.terminate()
          } catch {}
          conns.delete(id)
          continue
        }
        c.alive = false
        c.miss = 0
        try {
          c.ws.ping()
        } catch {}
      }
    }, 30000)
    timer.unref?.()

    return wss
  }

  return { attach, send, isOnline, size, kick, close: () => wss?.close() }
}
