// HTTP API：账号、设备、配对、blob、审计
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { now, uid, sha256, token, hashPassword, verifyPassword, pairCode, readJson, sendJson } from './util.mjs'
import { audit, arePaired, createPair } from './db.mjs'

const HANDLE_RE = /^[a-zA-Z0-9_.-]{3,32}$/

function cors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-sha256, x-name')
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
}

export function createHttp({ db, hub, cfg }) {
  const deviceByToken = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    if (!m) return null
    return db
      .prepare('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL')
      .get(sha256(m[1])) ?? null
  }

  const userOf = (device) => db.prepare('SELECT * FROM users WHERE id=?').get(device.user_id)

  const publicDevice = (d) => ({
    id: d.id,
    kind: d.kind,
    name: d.name,
    platform: d.platform,
    pubkey: d.pubkey,
    lastSeenAt: d.last_seen_at,
    online: hub.isOnline(d.id),
  })

  const pairsOf = (deviceId) =>
    db
      .prepare(
        `SELECT p.id AS pair_id, p.created_at AS paired_at, d.* FROM pairs p
         JOIN devices d ON d.id = CASE WHEN p.a=? THEN p.b ELSE p.a END
         WHERE p.revoked_at IS NULL AND (p.a=? OR p.b=?) AND d.revoked_at IS NULL`,
      )
      .all(deviceId, deviceId, deviceId)
      .map((row) => ({ pairId: row.pair_id, pairedAt: row.paired_at, peer: publicDevice(row) }))

  return async function handle(req, res) {
    cors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    const method = req.method

    try {
      if (path === '/healthz') {
        const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
        const devices = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL').get().n
        sendJson(res, 200, { ok: true, ts: now(), users, devices, online: hub.size() })
        return
      }

      // ---------- 注册 / 登录 ----------
      if (path === '/api/register' && method === 'POST') {
        const body = await readJson(req)
        const handleName = String(body.handle || '').trim()
        const password = String(body.password || '')
        if (!HANDLE_RE.test(handleName)) return sendJson(res, 400, { error: 'handle/invalid' })
        if (password.length < 8) return sendJson(res, 400, { error: 'password/too-short' })
        if (db.prepare('SELECT 1 FROM users WHERE handle=?').get(handleName)) {
          return sendJson(res, 409, { error: 'handle/taken' })
        }

        const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
        let role = 'user'
        if (userCount === 0) {
          role = 'admin'
        } else {
          const code = String(body.invite || '').trim().toUpperCase()
          const inv = db.prepare('SELECT * FROM invites WHERE code=?').get(code)
          if (!inv || inv.expires_at < now() || inv.used >= inv.max_uses) {
            return sendJson(res, 403, { error: 'invite/invalid' })
          }
          db.prepare('UPDATE invites SET used=used+1 WHERE code=?').run(code)
        }

        const user = { id: uid('user'), handle: handleName, role, created_at: now() }
        db.prepare(
          'INSERT INTO users(id, handle, password_hash, role, created_at) VALUES (?,?,?,?,?)',
        ).run(user.id, user.handle, hashPassword(password), user.role, user.created_at)
        audit(db, { userId: user.id, action: 'user.register', target: user.handle })
        sendJson(res, 200, { user: { id: user.id, handle: user.handle, role: user.role } })
        return
      }

      if (path === '/api/login' && method === 'POST') {
        const body = await readJson(req)
        const handleName = String(body.handle || '').trim()
        const user = db.prepare('SELECT * FROM users WHERE handle=?').get(handleName)
        if (!user || user.disabled_at || !verifyPassword(String(body.password || ''), user.password_hash)) {
          return sendJson(res, 401, { error: 'auth/invalid' })
        }
        const dev = body.device || {}
        const kind = dev.kind === 'desktop' ? 'desktop' : 'mobile'
        const name = String(dev.name || (kind === 'desktop' ? '我的电脑' : '我的手机')).slice(0, 64)
        const raw = token()
        const platform = String(dev.platform || '').slice(0, 64)
        const existing = db
          .prepare('SELECT * FROM devices WHERE user_id=? AND kind=? AND name=? AND revoked_at IS NULL')
          .get(user.id, kind, name)
        let device
        if (existing) {
          // 同名同类型设备视为同一台，重新登录只轮换令牌，不新增设备
          device = { id: existing.id, user_id: user.id, kind, name, platform, created_at: existing.created_at }
          db.prepare('UPDATE devices SET token_hash=?, platform=?, last_seen_at=? WHERE id=?').run(
            sha256(raw),
            platform,
            now(),
            device.id,
          )
          audit(db, { userId: user.id, deviceId: device.id, action: 'device.relogin', target: name })
        } else {
          device = {
            id: uid('dev'),
            user_id: user.id,
            kind,
            name,
            platform,
            pubkey: dev.pubkey ? String(dev.pubkey).slice(0, 512) : null,
            created_at: now(),
          }
          db.prepare(
            `INSERT INTO devices(id, user_id, kind, name, platform, pubkey, token_hash, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          ).run(
            device.id,
            device.user_id,
            device.kind,
            device.name,
            device.platform,
            device.pubkey,
            sha256(raw),
            device.created_at,
          )
          audit(db, { userId: user.id, deviceId: device.id, action: 'device.login', target: name })
        }
        sendJson(res, 200, {
          token: raw,
          device: { id: device.id, kind, name, platform: device.platform },
          user: { id: user.id, handle: user.handle, role: user.role },
        })
        return
      }

      // ---------- 以下均需设备 token ----------
      const device = deviceByToken(req)
      if (!device) return sendJson(res, 401, { error: 'auth/expired' })
      db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now(), device.id)

      if (path === '/api/me' && method === 'GET') {
        const user = userOf(device)
        const devices = db
          .prepare('SELECT * FROM devices WHERE user_id=? AND revoked_at IS NULL')
          .all(device.user_id)
        sendJson(res, 200, {
          user: { id: user.id, handle: user.handle, role: user.role },
          device: publicDevice(device),
          devices: devices.map(publicDevice),
          pairs: pairsOf(device.id),
        })
        return
      }

      if (path === '/api/pairs' && method === 'GET') {
        sendJson(res, 200, { pairs: pairsOf(device.id) })
        return
      }

      if (path.startsWith('/api/pairs/') && method === 'DELETE') {
        const pairId = path.slice('/api/pairs/'.length)
        const row = db.prepare('SELECT * FROM pairs WHERE id=? AND revoked_at IS NULL').get(pairId)
        if (!row || (row.a !== device.id && row.b !== device.id)) {
          return sendJson(res, 404, { error: 'pair/not-found' })
        }
        db.prepare('UPDATE pairs SET revoked_at=? WHERE id=?').run(now(), pairId)
        const other = row.a === device.id ? row.b : row.a
        hub.send(other, { t: 'pair.revoked', pairId, by: device.id })
        audit(db, { userId: device.user_id, deviceId: device.id, action: 'pair.revoke', target: pairId })
        sendJson(res, 200, { ok: true })
        return
      }

      if (path.startsWith('/api/devices/') && path.endsWith('/revoke') && method === 'POST') {
        const id = path.slice('/api/devices/'.length, -'/revoke'.length)
        const row = db.prepare('SELECT * FROM devices WHERE id=? AND user_id=?').get(id, device.user_id)
        if (!row) return sendJson(res, 404, { error: 'device/not-found' })
        db.prepare('UPDATE devices SET revoked_at=? WHERE id=?').run(now(), id)
        hub.kick(id, 'auth/revoked')
        audit(db, { userId: device.user_id, deviceId: device.id, action: 'device.revoke', target: id })
        sendJson(res, 200, { ok: true })
        return
      }

      // ---------- 配对 ----------
      if (path === '/api/pair/start' && method === 'POST') {
        if (device.kind !== 'desktop') return sendJson(res, 403, { error: 'scope/denied' })
        // 清掉该设备旧的未使用配对码
        db.prepare("DELETE FROM pairings WHERE desktop_id=? AND state='open'").run(device.id)
        const code = pairCode(8)
        const expiresAt = now() + 5 * 60 * 1000
        db.prepare(
          'INSERT INTO pairings(code, user_id, desktop_id, state, expires_at, created_at) VALUES (?,?,?,?,?,?)',
        ).run(code, device.user_id, device.id, 'open', expiresAt, now())
        audit(db, { userId: device.user_id, deviceId: device.id, action: 'pair.start', target: code })
        sendJson(res, 200, { code, expiresAt })
        return
      }

      if (path === '/api/pair/claim' && method === 'POST') {
        const body = await readJson(req)
        const code = String(body.code || '').trim().toUpperCase()
        const p = db.prepare('SELECT * FROM pairings WHERE code=?').get(code)
        if (!p || p.expires_at < now() || p.state !== 'open') {
          return sendJson(res, 404, { error: 'pair/invalid' })
        }
        if (p.desktop_id === device.id) return sendJson(res, 400, { error: 'pair/self' })
        const desktop = db.prepare('SELECT * FROM devices WHERE id=?').get(p.desktop_id)
        if (!desktop || desktop.revoked_at) return sendJson(res, 404, { error: 'pair/invalid' })
        db.prepare("UPDATE pairings SET mobile_id=?, state='claimed' WHERE code=?").run(device.id, code)
        hub.send(p.desktop_id, {
          t: 'pair.request',
          code,
          mobile: publicDevice(device),
        })
        audit(db, { userId: p.user_id, deviceId: device.id, action: 'pair.claim', target: code })
        sendJson(res, 200, {
          code,
          desktop: publicDevice(desktop),
          state: 'claimed',
        })
        return
      }

      if (path === '/api/pair/confirm' && method === 'POST') {
        const body = await readJson(req)
        const code = String(body.code || '').trim().toUpperCase()
        const allow = body.allow !== false
        const p = db.prepare('SELECT * FROM pairings WHERE code=?').get(code)
        if (!p || p.desktop_id !== device.id || p.state !== 'claimed' || p.expires_at < now()) {
          return sendJson(res, 404, { error: 'pair/invalid' })
        }
        if (!allow) {
          db.prepare("UPDATE pairings SET state='cancelled', used_at=? WHERE code=?").run(now(), code)
          hub.send(p.mobile_id, { t: 'pair.result', code, ok: false })
          return sendJson(res, 200, { ok: false })
        }
        const pair = createPair(db, p.user_id, p.desktop_id, p.mobile_id)
        db.prepare("UPDATE pairings SET state='confirmed', used_at=? WHERE code=?").run(now(), code)
        hub.send(p.mobile_id, { t: 'pair.result', code, ok: true, pairId: pair.id })
        hub.send(p.desktop_id, { t: 'pair.result', code, ok: true, pairId: pair.id })
        audit(db, { userId: p.user_id, deviceId: device.id, action: 'pair.confirm', target: code })
        sendJson(res, 200, { ok: true, pairId: pair.id })
        return
      }

      if (path === '/api/pair/status' && method === 'GET') {
        const code = String(url.searchParams.get('code') || '').toUpperCase()
        const p = db.prepare('SELECT * FROM pairings WHERE code=?').get(code)
        if (!p) return sendJson(res, 404, { error: 'pair/invalid' })
        // 发起配对的电脑需要知道是谁在请求，才能在电脑上显示「XX 手机请求配对」
        const mobile = p.mobile_id
          ? db.prepare('SELECT * FROM devices WHERE id=?').get(p.mobile_id)
          : null
        sendJson(res, 200, {
          state: p.state,
          expiresAt: p.expires_at,
          mobile: mobile ? publicDevice(mobile) : null,
        })
        return
      }

      // ---------- 邀请码（admin） ----------
      if (path === '/api/invites' && method === 'GET') {
        if (userOf(device).role !== 'admin') return sendJson(res, 403, { error: 'scope/denied' })
        const rows = db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 100').all()
        sendJson(res, 200, { invites: rows })
        return
      }

      if (path === '/api/invites' && method === 'POST') {
        const user = userOf(device)
        if (user.role !== 'admin') return sendJson(res, 403, { error: 'scope/denied' })
        const body = await readJson(req)
        const maxUses = Math.max(1, Math.min(50, Number(body.maxUses || 1)))
        const ttlHours = Math.max(1, Math.min(24 * 30, Number(body.ttlHours || 168)))
        const code = pairCode(8)
        db.prepare(
          'INSERT INTO invites(code, created_by, max_uses, used, expires_at, created_at) VALUES (?,?,?,?,?,?)',
        ).run(code, user.id, maxUses, 0, now() + ttlHours * 3600_000, now())
        audit(db, { userId: user.id, deviceId: device.id, action: 'invite.create', target: code })
        sendJson(res, 200, { code, maxUses, expiresAt: now() + ttlHours * 3600_000 })
        return
      }

      // ---------- blob ----------
      if (path === '/api/blob' && method === 'POST') {
        const maxBytes = cfg.blobMaxMb * 1024 * 1024
        const declared = Number(req.headers['content-length'] || 0)
        if (declared > maxBytes) return sendJson(res, 413, { error: 'blob/too-large' })
        const blobId = uid('blob')
        const file = join(cfg.blobDir, blobId)
        const hash = createHash('sha256')
        let size = 0
        const guard = new Transform({
          transform(chunk, _enc, cb) {
            size += chunk.length
            if (size > maxBytes) return cb(Object.assign(new Error('too large'), { code: 'blob/too-large' }))
            hash.update(chunk)
            cb(null, chunk)
          },
        })
        await pipeline(req, guard, createWriteStream(file))
        db.prepare(
          'INSERT INTO blobs(id, user_id, size, sha256, name, storage_key, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(blobId, device.user_id, size, hash.digest('hex'), String(req.headers['x-name'] || '').slice(0, 200), blobId, now(), now() + 7 * 86400_000)
        sendJson(res, 200, { blobId, size })
        return
      }

      if (path.startsWith('/api/blob/') && method === 'GET') {
        const blobId = path.slice('/api/blob/'.length)
        const row = db.prepare('SELECT * FROM blobs WHERE id=? AND user_id=?').get(blobId, device.user_id)
        if (!row) return sendJson(res, 404, { error: 'blob/not-found' })
        const file = join(cfg.blobDir, row.storage_key)
        const info = await stat(file)
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': info.size,
          'x-sha256': row.sha256 || '',
          'x-name': encodeURIComponent(row.name || ''),
        })
        await pipeline(createReadStream(file), res)
        return
      }

      if (path.startsWith('/api/blob/') && method === 'DELETE') {
        const blobId = path.slice('/api/blob/'.length)
        const row = db.prepare('SELECT * FROM blobs WHERE id=? AND user_id=?').get(blobId, device.user_id)
        if (!row) return sendJson(res, 404, { error: 'blob/not-found' })
        db.prepare('DELETE FROM blobs WHERE id=?').run(blobId)
        await unlink(join(cfg.blobDir, row.storage_key)).catch(() => {})
        sendJson(res, 200, { ok: true })
        return
      }

      // ---------- 审计 ----------
      if (path === '/api/audit' && method === 'GET') {
        const limit = Math.min(500, Number(url.searchParams.get('limit') || 100))
        const rows = db
          .prepare('SELECT * FROM audit WHERE user_id=? ORDER BY id DESC LIMIT ?')
          .all(device.user_id, limit)
        sendJson(res, 200, { audit: rows })
        return
      }

      sendJson(res, 404, { error: 'not-found' })
    } catch (err) {
      const code = err?.code || 'internal'
      const status = code === 'blob/too-large' ? 413 : code.startsWith('body/') ? 400 : 500
      if (status === 500) console.error('[http]', err)
      if (!res.headersSent) sendJson(res, status, { error: code })
    }
  }
}
