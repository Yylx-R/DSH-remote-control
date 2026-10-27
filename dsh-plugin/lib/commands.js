// 指令路由：把手机发来的 {op, rid, ...} 翻译成 DSH 的 host 服务调用
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'

const MAX_TEXT = 200_000
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

function blockText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

// DSH 会把运行时上下文、系统提醒、时间采样当成 user/message 注入会话，
// 这些不应该出现在手机端的聊天记录里。
const INJECTED_PATTERNS = [
  /^Current runtime context\./,
  /^<system-reminder>/,
  /^Time sampled (while|at) preparing/,
  /^Current DSH file policy/,
  /^Approval policy: /,
]

function isInjectedText(text) {
  const t = String(text || '').trim()
  if (!t) return false
  return INJECTED_PATTERNS.some((re) => re.test(t))
}

// 附件路径是我们自己追加给 agent 的，不该出现在手机聊天记录里
function stripAttachmentLines(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !/^\[手机上传附件\]/.test(line.trim()))
    .join('\n')
    .trim()
}

function normalizeRecord(rec) {
  const ev = rec && rec.event ? rec.event : rec
  const type = String(ev?.type || rec?.type || 'unknown')
  const data = ev?.data || rec?.data || {}
  const msg = data.message || data
  const out = { type, seq: ev?.seq ?? rec?.seq, time: ev?.time ?? rec?.time }
  if (type === 'user/message') {
    const text = stripAttachmentLines(blockText(msg?.content) || String(ev?.text || rec?.text || ''))
    if (isInjectedText(text)) return null
    return { ...out, role: 'user', text: text || '[附件]' }
  }
  if (type === 'assistant/message') {
    const text = String(blockText(msg?.content) || ev?.text || rec?.text || '').trim()
    // 只调用了工具、没有正文的回合不产生气泡
    if (!text) return null
    return { ...out, role: 'assistant', text }
  }
  if (type === 'tool/call') return null
  if (type !== 'user/message' && type !== 'assistant/message') return null
  return out
}

// 把网关的 assistant-stream 帧压平成手机端能直接用的形状：
//   {type:'assistant-stream', frame:{type:'chunk', chunk:{type:'text-delta', text}}}
//   → {type:'assistant-stream', frame:{type:'text-delta', text}}
// 其余帧（start / block-start / block-stop / 无文本 chunk）直接丢弃。
function simplifyFrame(frame) {
  if (!frame || typeof frame !== 'object') return null
  if (frame.type === 'assistant-stream') {
    const chunk = frame.frame?.chunk || frame.frame
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      return { type: 'assistant-stream', frame: { type: 'text-delta', text: chunk.text } }
    }
    return null
  }
  if (frame.type === 'event') {
    const ev = frame.event
    if (ev?.type === 'user/message') {
      const raw = blockText(ev.data?.message?.content || ev.data?.content)
      const text = stripAttachmentLines(raw)
      if (isInjectedText(text)) return null
      if (text === String(raw || '').trim()) return frame
      const block = [{ type: 'text', text: text || '[附件]' }]
      const data = { ...(ev.data || {}), content: block }
      if (ev.data?.message) data.message = { ...ev.data.message, content: block }
      return { ...frame, event: { ...ev, data } }
    }
    if (ev?.type === 'assistant/message') {
      const text = String(blockText(ev.data?.message?.content || ev.data?.content) || '').trim()
      if (!text) return null
    }
    return frame
  }
  return frame
}

function summaryOf(s) {
  const proj = s?.projections
  let title = null
  if (proj && typeof proj === 'object') {
    const values = proj.values || proj
    if (values && typeof values.title === 'string') title = values.title
  }
  return {
    sessionId: s.sessionId,
    title,
    running: !!s.running,
    blank: !!s.blank,
    updatedAt: s.updatedAt,
    cwd: s.cwd ?? null,
    agentAvailable: !!s.agentAvailable,
    formatStatus: s.formatStatus ?? null,
  }
}

export function createCommandRouter({ ctx, log, client, cfg, follows = new Map() }) {
  const sc = () => ctx.sessionController

  const relayBase = () => String(cfg.serverUrl || '').replace(/\/+$/, '')

  // 手机上传的附件先落在 relay，再由电脑端下载并存到会话工作区的 uploads/ 下
  async function downloadBlob(blobId) {
    const res = await fetch(`${relayBase()}/api/blob/${encodeURIComponent(blobId)}`, {
      headers: { authorization: `Bearer ${cfg.token}` },
    })
    if (!res.ok) throw Object.assign(new Error(`附件下载失败 HTTP ${res.status}`), { code: 'blob/download' })
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error('附件超过 50MB'), { code: 'blob/too-large' })
    let name = ''
    try {
      name = decodeURIComponent(res.headers.get('x-name') || '')
    } catch {}
    return { buf, name }
  }

  function safeFileName(name) {
    const base = basename(String(name || '')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
    if (base) return base
    return `file-${Date.now()}${extname(String(name || '')) || ''}`
  }

  async function saveAttachments(cwd, attachments) {
    if (!Array.isArray(attachments) || !attachments.length) return []
    const dir = join(cwd || process.cwd(), 'uploads')
    await mkdir(dir, { recursive: true })
    const saved = []
    for (const a of attachments.slice(0, 10)) {
      if (!a || !a.blobId) continue
      const { buf, name } = await downloadBlob(String(a.blobId))
      const finalName = safeFileName(a.name || name)
      const path = join(dir, finalName)
      await writeFile(path, buf)
      saved.push({ name: finalName, path, size: buf.length, mime: String(a.mime || '') })
      log.info(`已接收手机附件：${finalName}（${buf.length} 字节）→ ${path}`)
    }
    return saved
  }

  async function snapshotOnce(params) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('snapshot/timeout')), 12_000)
    try {
      const it = sc().follow(params, ac.signal)
      for await (const frame of it) {
        if (frame?.type === 'snapshot') return frame
      }
      return null
    } finally {
      clearTimeout(timer)
      try {
        ac.abort()
      } catch {}
    }
  }

  async function firstSnapshot(sessionId, maxMessages) {
    const address = { kind: 'session', sessionId }
    // follow 的 snapshot 是从会话开头给记录的；要拿「最近一段」，直接要一个足够大的窗口，
    // 归一化之后再截取末尾若干条（比 page() 更稳，page 在某些版本上会因 signal 报错）。
    const frame = await snapshotOnce({ address, maxMessages: Math.max(1000, maxMessages) })
    return frame
  }

  function stopFollow(subId) {
    const ac = follows.get(subId)
    if (!ac) return false
    follows.delete(subId)
    try {
      ac.abort()
    } catch {}
    return true
  }

  function startFollow(sessionId, subId, frame) {
    stopFollow(subId)
    const ac = new AbortController()
    const target = frame.from
    follows.set(subId, ac)
    ;(async () => {
      try {
        const it = sc().follow(
          { address: { kind: 'session', sessionId }, assistantStream: true },
          ac.signal,
        )
        for await (const f of it) {
          if (ac.signal.aborted) break
          // snapshot 里的原始记录先在电脑端归一化，手机端拿到的就是 {role, text}
          const frame =
            f?.type === 'snapshot' && Array.isArray(f.records)
              ? { ...f, records: f.records.map(normalizeRecord).filter(Boolean) }
              : f
          const out = simplifyFrame(frame)
          if (!out) continue
          client.send(target, { op: 'stream', subId, frame: out })
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          client.send(target, { op: 'stream', subId, error: String(err?.message || err) })
        }
      } finally {
        if (follows.get(subId) === ac) follows.delete(subId)
        client.send(target, { op: 'stream', subId, done: true })
      }
    })()
    return true
  }

  async function handle(body, frame) {
    if (!body || typeof body !== 'object') return
    const rid = body.rid
    const reply = (data) => client.send(frame.from, { op: 'reply', rid, ok: true, data })
    const fail = (err) => {
      const code = err?.code || 'internal'
      const message = String(err?.message || err)
      log.warn(`指令 ${body.op} 失败：${code} ${message}`)
      client.send(frame.from, { op: 'reply', rid, ok: false, error: { code, message } })
    }

    try {
      switch (body.op) {
        case 'ping':
          return reply({ now: Date.now(), deviceName: cfg.deviceName || null })

        case 'device.stopClient':
          client.stop()
          return reply({ stopped: true })

        case 'device.startClient':
          client.start()
          return reply({ started: true })

        case 'device.info':
          return reply({
            deviceId: client.deviceId,
            online: client.online,
            serverUrl: String(cfg.serverUrl || ''),
            deviceName: cfg.deviceName || null,
            pairs: client.pairs.map((p) => ({ id: p.id, kind: p.kind, name: p.name })),
          })

        case 'status': {
          const list = await sc().list({}, AbortSignal.timeout(10_000))
          const items = Array.isArray(list?.items) ? list.items : []
          return reply({
            deviceName: cfg.deviceName || null,
            sessions: items.length,
            running: items.filter((s) => s.running).length,
          })
        }

        case 'sessions.list': {
          const list = await sc().list({}, AbortSignal.timeout(15_000))
          const items = Array.isArray(list?.items) ? list.items : []
          const mapped = items.map(summaryOf)
          mapped.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          return reply({ items: mapped })
        }

        case 'sessions.create': {
          const req = {}
          if (typeof body.cwd === 'string' && body.cwd) req.cwd = body.cwd
          const created = await sc().create(req)
          return reply({ sessionId: created.sessionId })
        }

        case 'sessions.prompt': {
          const sessionId = String(body.sessionId || '')
          let text = String(body.text || '').slice(0, MAX_TEXT)
          if (!sessionId) throw Object.assign(new Error('sessionId 缺失'), { code: 'bad/request' })
          // 手机可能只发附件、不带文字
          const saved = await saveAttachments(String(body.cwd || ''), body.attachments)
          if (saved.length) {
            const lines = saved.map((s) => `[手机上传附件] ${s.name} → ${s.path}`)
            text = (text.trim() ? text + '\n\n' : '') + lines.join('\n')
          }
          if (!text.trim()) throw Object.assign(new Error('内容为空'), { code: 'bad/request' })
          const mode = body.mode === 'steer' ? 'steer' : 'queue'
          const out = await sc().prompt(
            {
              requestId: randomUUID(),
              sessionId,
              mode,
              content: [{ type: 'text', text }],
            },
            AbortSignal.timeout(30_000),
          )
          log.info(`prompt 已提交：${sessionId} mode=${mode} accepted=${!!out?.accepted} 附件=${saved.length} 文本=${text.slice(0, 30)}`)
          return reply({ accepted: !!out?.accepted, attachments: saved.map((s) => ({ name: s.name, path: s.path })) })
        }

        case 'sessions.cancel': {
          await sc().cancel({ sessionId: String(body.sessionId || '') })
          return reply({ ok: true })
        }

        case 'sessions.snapshot': {
          const snap = await firstSnapshot(String(body.sessionId || ''), Math.max(200, Number(body.maxMessages) || 400))
          if (!snap) return reply({ records: [], hasMore: false })
          const records = (Array.isArray(snap.records) ? snap.records.map(normalizeRecord).filter(Boolean) : []).slice(-80)
          return reply({ records, hasMore: !!snap.hasMore, cursor: snap.cursor ?? null })
        }

        case 'sessions.follow': {
          const sessionId = String(body.sessionId || '')
          const subId = String(body.subId || randomUUID())
          if (!sessionId) throw Object.assign(new Error('sessionId 缺失'), { code: 'bad/request' })
          startFollow(sessionId, subId, frame)
          return reply({ subId })
        }

        case 'sessions.unfollow': {
          const ok = stopFollow(String(body.subId || ''))
          return reply({ ok })
        }

        case 'workspaces.list': {
          const reg = ctx.workspaceRegistry
          if (!reg) return reply({ items: [] })
          const list = await reg.list()
          return reply({ items: Array.isArray(list) ? list : [] })
        }

        case 'screen.capture': {
          const mod = await import(`./screen.js?v=${Date.now()}`)
          const maxWidth = Math.min(4096, Math.max(320, Number(body.maxWidth) || 3840))
          const quality = Math.min(92, Math.max(20, Number(body.quality) || 90))
          const target = ['primary', 'secondary', 'all'].includes(body.target) ? body.target : 'primary'
          const shot = await mod.captureScreen({ maxWidth, quality, target })
          const res = await fetch(relayBase() + '/api/blob', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${cfg.token}`,
              'content-type': 'image/jpeg',
              'x-name': encodeURIComponent('screen.jpg'),
            },
            body: shot.buffer,
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || `上传截屏失败 ${res.status}`)
          return reply({
            blobId: data.blobId,
            size: shot.buffer.length,
            width: shot.width,
            height: shot.height,
            target,
            screens: shot.screens || [],
            ts: shot.ts,
          })
        }

        case 'screen.control': {
          const mod = await import(`./screen.js?v=${Date.now()}`)
          const action = String(body.action || 'alt_tab')
          const res = await mod.controlScreen(action)
          return reply(res)
        }

        case 'pair.code': {
          const base = String(cfg.serverUrl || '').replace(/\/+$/, '')
          const res = await fetch(base + '/api/pair/start', {
            method: 'POST',
            headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
            body: '{}',
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw Object.assign(new Error(data.error || 'pair/start failed'), { code: data.error || 'internal' })
          return reply(data)
        }

        default:
          throw Object.assign(new Error(`未知指令 ${body.op}`), { code: 'op/unknown' })
      }
    } catch (err) {
      fail(err)
    }
  }

  return {
    handle,
    dispose() {
      for (const subId of [...follows.keys()]) stopFollow(subId)
    },
  }
}
