// 远程 DSH 手机端（PWA）
import { icon, mountIcons } from './icons.js'
const $ = (sel) => document.querySelector(sel)

const LS = {
  token: 'dsh.token',
  handle: 'dsh.handle',
  device: 'dsh.device',
  target: 'dsh.target',
}

const state = {
  base: location.origin,
  token: localStorage.getItem(LS.token) || '',
  handle: localStorage.getItem(LS.handle) || '',
  device: JSON.parse(localStorage.getItem(LS.device) || 'null'),
  pairs: [],
  devices: [],
  target: JSON.parse(localStorage.getItem(LS.target) || 'null'),
  sessions: [],
  current: null,
  messages: [],
  attachments: [],
  streaming: false,
  ws: null,
  retry: 0,
  pending: new Map(),
  subId: null,
  pollTimer: null,
  viewAuto: false,
  viewTimer: null,
  viewZoom: 1,
  viewRot: localStorage.getItem('dsh.orient') === 'port',
  viewMeta: '',
  viewShot: null,
  viewBusy: false,
  viewFrom: null,
}

// 调试用：浏览器控制台里可以直接看状态
window.__dshState = state

// ---------------- 小工具 ----------------
let toastTimer = null
function toast(text) {
  const t = $('#toast')
  t.textContent = text
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), 2600)
}

function timeAgo(ts) {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

const INJECTED_PATTERNS = [
  /^Current runtime context\./,
  /^<system-reminder>/,
  /^Time sampled (while|at) preparing/,
  /^Current DSH file policy/,
  /^Approval policy: /,
]

function normalize(rec) {
  // 电脑端插件已经归一化过：{ role, text }
  if (rec && (rec.role === 'user' || rec.role === 'assistant') && typeof rec.text === 'string') {
    if (rec.role === 'user' && INJECTED_PATTERNS.some((re) => re.test(rec.text.trim()))) return null
    if (rec.role === 'assistant' && !rec.text.trim()) return null
    return { role: rec.role, text: rec.text }
  }
  const ev = rec && rec.event ? rec.event : rec
  const type = String(ev?.type || rec?.type || '')
  const data = ev?.data || rec?.data || {}
  const msg = data.message || data
  if (type === 'user/message') {
    const text = textOf(msg?.content)
    if (INJECTED_PATTERNS.some((re) => re.test(text.trim()))) return null
    return { role: 'user', text }
  }
  if (type === 'assistant/message') return { role: 'assistant', text: textOf(msg?.content) }
  return null
}

function show(name, { title, subtitle, back } = {}) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = true
  const target = $(`#screen-${name}`)
  if (target) target.hidden = false
  state.screen = name
  if (title !== undefined) $('#title').textContent = title
  $('#subtitle').textContent = subtitle || ''
  $('#back').hidden = !back
  $('#menu').hidden = name === 'login'
  $('#screen-btn').hidden = name === 'login' || name === 'pair'
  if (name !== 'view') stopAutoView()
  if (name !== 'view' && document.body.classList.contains('fs')) {
    document.body.classList.remove('fs')
    document.exitFullscreen?.().catch(() => {})
  }
  if (name === 'view') setTimeout(fitShot, 40)
  if (name !== 'chat') $('#main').scrollTop = 0
}

// ---------------- HTTP ----------------
async function http(path, { method = 'GET', body } = {}) {
  const res = await fetch(state.base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) {
    logout()
    throw new Error('登录已过期，请重新登录')
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ---------------- WebSocket ----------------
function setConn(on) {
  const dot = $('#conn')
  dot.classList.toggle('on', on)
  dot.classList.toggle('off', !on)
}

function connectWS() {
  if (!state.token) return
  const url = state.base.replace(/^http/, 'ws') + '/ws'
  let ws
  try {
    ws = new WebSocket(url)
  } catch {
    return
  }
  state.ws = ws
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'hello', token: state.token }))
    state.retry = 0
    setConn(true)
  }
  ws.onmessage = (ev) => {
    let frame
    try {
      frame = JSON.parse(ev.data)
    } catch {
      return
    }
    handleFrame(frame)
  }
  ws.onclose = () => {
    setConn(false)
    if (state.kicked) {
      state.kicked = false
      toast('该设备已在其他窗口连接，本窗口已停止重连')
      return
    }
    if (!state.token) return
    const delay = Math.min(15000, 1000 * 2 ** Math.min(state.retry++, 4))
    setTimeout(connectWS, delay)
  }
  ws.onerror = () => {}
}

function handleFrame(frame) {
  switch (frame.t) {
    case 'welcome':
      state.pairs = Array.isArray(frame.pairs) ? frame.pairs : []
      if (state.screen === 'devices') renderDevices()
      return
    case 'msg':
      handleBody(frame.body)
      return
    case 'kick':
      // 同一设备在别处重新连接时会被踢，不要清掉登录态，也不再自动重连（否则两个窗口会互相踢）
      state.kicked = true
      toast(`已被服务器断开：${frame.reason || ''}`)
      setConn(false)
      try {
        state.ws?.close()
      } catch {}
      return
    case 'error':
      toast(`服务器错误：${frame.error || ''}`)
      return
    default:
      return
  }
}

function handleBody(body) {
  if (!body || typeof body !== 'object') return
  if (body.op === 'reply') {
    const p = state.pending.get(body.rid)
    if (!p) return
    state.pending.delete(body.rid)
    clearTimeout(p.timer)
    if (body.ok) p.resolve(body.data)
    else p.reject(new Error(body.error?.message || body.error?.code || '执行失败'))
    return
  }
  if (body.op === 'stream') handleStream(body)
}

function ask(op, body = {}, timeout = 60000) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== 1) return reject(new Error('未连接到服务器'))
    if (!state.target) return reject(new Error('还没有选择电脑'))
    const rid = Math.random().toString(36).slice(2, 10)
    const timer = setTimeout(() => {
      state.pending.delete(rid)
      reject(new Error('电脑没有响应（超时）'))
    }, timeout)
    state.pending.set(rid, { resolve, reject, timer })
    state.ws.send(JSON.stringify({ t: 'msg', id: rid, to: state.target.id, kind: 'dsh', body: { op, rid, ...body } }))
  })
}

// ---------------- 流式 ----------------
function handleStream(body) {
  if (state.subId && body.subId !== state.subId) return
  // 调试用：记录最近收到的帧，排查重复投递/卡住问题
  const log = (state.frameLog ||= [])
  log.push(`${String(body.subId || '').slice(0, 8)}:${body.frame?.type || (body.done ? 'done' : body.error || '?')}`)
  if (log.length > 60) log.shift()
  // 看门狗：连续一段时间没有新帧就认为本轮结束，避免「停止」按钮卡住
  clearTimeout(state.idleTimer)
  state.idleTimer = setTimeout(() => {
    if (state.streaming) setStreaming(false)
  }, 6000)
  if (body.error) {
    toast(`会话流出错：${body.error}`)
    setStreaming(false)
    return
  }
  if (body.done) {
    setStreaming(false)
    return
  }
  const f = body.frame
  if (!f) return
  if (f.type === 'snapshot') {
    state.messages = (f.records || [])
      .map(normalize)
      .filter(Boolean)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
    renderMessages()
    return
  }
  if (f.type === 'event') {
    const ev = f.event
    const m = normalize(ev)
    if (m) {
      if (m.role === 'user') {
        // 本机乐观气泡 / 重复投递：最后一条是同样的用户消息就不再追加
        const last = state.messages[state.messages.length - 1]
        if (last && last.role === 'user' && last.text.trim() === m.text.trim()) {
          last.local = false
          renderMessages()
          return
        }
      }
      if (m.role === 'assistant') {
        if (!m.text.trim()) return
        const last = state.messages[state.messages.length - 1]
        if (last && last.role === 'assistant' && last.streaming) {
          last.text = m.text || last.text
          last.streaming = false
          renderMessages()
          setStreaming(false)
          return
        }
        state.messages.push(m)
        renderMessages()
        setStreaming(false)
        return
      }
      state.messages.push(m)
      renderMessages()
      return
    }
    if (ev && (ev.type === 'turn/end' || ev.type === 'turn/error')) setStreaming(false)
    return
  }
  if (f.type === 'assistant-stream') {
    const chunk = f.frame || {}
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      const last = state.messages[state.messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) last.text += chunk.text
      else state.messages.push({ role: 'assistant', text: chunk.text, streaming: true })
      renderMessages()
    }
  }
}

function setStreaming(on) {
  state.streaming = on
  $('#stop').hidden = !on
  $('#send').hidden = on
  if (!on) {
    const last = state.messages[state.messages.length - 1]
    if (last && last.streaming) {
      last.streaming = false
      renderMessages()
    }
  }
}

// ---------------- 渲染 ----------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function inlineMd(s) {
  return esc(s)
    .replace(/!\[[^\]]*\]\((?:[A-Za-z]:\\|\/)[^)]*\)/g, '<span class="muted">[图片]</span>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

// 极简 markdown：标题 / 列表 / 代码块 / 表格 / 粗体 / 行内代码
function renderMarkdown(text) {
  const lines = String(text || '').split('\n')
  const out = []
  let inCode = false
  let list = null
  let table = null
  const flushList = () => {
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null }
  }
  const flushTable = () => {
    if (table) {
      const [head, ...rows] = table
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      table = null
    }
  }
  for (const raw of lines) {
    if (/^```/.test(raw.trim())) {
      flushList(); flushTable()
      out.push(inCode ? '</code></pre>' : '<pre><code>')
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(esc(raw)) ; continue }
    const line = raw.trimEnd()
    if (!line.trim()) { flushList(); flushTable(); out.push('') ; continue }
    const cells = line.trim().startsWith('|') ? line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()) : null
    if (cells) {
      flushList()
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
      if (!table) table = []
      table.push(cells)
      continue
    }
    flushTable()
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) { flushList(); out.push(`<h4>${inlineMd(h[2])}</h4>`) ; continue }
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (li) { (list = list || []).push(`<li>${inlineMd(li[1])}</li>`) ; continue }
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ol) { flushList(); out.push(`<div class="li">${inlineMd(ol[1])}</div>`) ; continue }
    flushList()
    out.push(`<div>${inlineMd(line)}</div>`)
  }
  flushList(); flushTable()
  if (inCode) out.push('</code></pre>')
  return out.join('')
}

function renderMessages() {
  const box = $('#messages')
  box.innerHTML = ''
  for (const m of state.messages) {
    const div = document.createElement('div')
    div.className = `msg ${m.role}`
    if (m.role === 'assistant') div.innerHTML = renderMarkdown(m.text)
    else div.textContent = m.text || ''
    if (m.streaming) {
      const cur = document.createElement('span')
      cur.className = 'cursor'
      div.appendChild(cur)
    }
    box.appendChild(div)
  }
  box.scrollTop = box.scrollHeight
}

function renderDevices() {
  const box = $('#device-list')
  box.innerHTML = ''
  const online = new Map((state.devices || []).map((d) => [d.id, d.online]))
  const desktops = (state.pairs || [])
    .map((p) => (p && p.peer ? { ...p.peer, pairId: p.pairId } : p))
    .filter((p) => p && p.kind === 'desktop')
  if (!desktops.length) {
    box.innerHTML = '<p class="muted">还没有配对的电脑。点下面的按钮，在电脑上生成配对码。</p>'
    return
  }
  for (const d of desktops) {
    const row = document.createElement('div')
    row.className = 'row'
    const isOn = online.get(d.id)
    row.innerHTML = `
      <span class="row-ic ${isOn ? 'on' : ''}">${icon('monitor', 22)}</span>
      <div class="grow">
        <div class="name">${escapeHtml(d.name || d.id)}</div>
        <div class="meta">${escapeHtml(d.platform || '')}</div>
      </div>
      <span class="badge ${isOn ? '' : 'gray'}">${isOn ? '在线' : '离线'}</span>`
    row.onclick = () => selectTarget(d)
    box.appendChild(row)
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function renderSessions() {
  const box = $('#session-list')
  box.innerHTML = ''
  if (!state.sessions.length) {
    box.innerHTML = '<p class="muted">这台电脑上还没有会话，点「新会话」开始。</p>'
    return
  }
  for (const s of state.sessions) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `
      <span class="row-ic">${icon('chat', 20)}</span>
      <div class="grow">
        <div class="name">${escapeHtml(s.title || '未命名会话')}</div>
        <div class="meta">${escapeHtml(s.cwd || '')} · ${timeAgo(s.updatedAt)}</div>
      </div>
      ${s.running ? '<span class="badge run">运行中</span>' : ''}`
    row.onclick = () => openSession(s)
    box.appendChild(row)
  }
}

// ---------------- 流程 ----------------
async function loadMe() {
  const me = await http('/api/me')
  state.pairs = me.pairs || []
  state.devices = me.devices || []
  if (state.target) {
    const still = state.pairs.find((p) => p.id === state.target.id)
    if (!still) {
      state.target = null
      localStorage.removeItem(LS.target)
    }
  }
  if (state.screen === 'devices') renderDevices()
}

function selectTarget(d) {
  state.target = { id: d.id, name: d.name }
  localStorage.setItem(LS.target, JSON.stringify(state.target))
  openSessions()
}

async function openSessions() {
  show('sessions', { title: state.target?.name || '会话', subtitle: '选择会话', back: true })
  await refreshSessions()
}

async function refreshSessions() {
  try {
    const data = await ask('sessions.list')
    state.sessions = data.items || []
    renderSessions()
  } catch (err) {
    toast(err.message)
  }
}

async function openSession(s) {
  if (state.subId) {
    ask('sessions.unfollow', { subId: state.subId }).catch(() => {})
    state.subId = null
  }
  state.current = s
  state.messages = []
  renderMessages()
  show('chat', { title: s.title || '会话', subtitle: s.cwd || '', back: true })
  setStreaming(!!s.running)
  try {
    const snap = await ask('sessions.snapshot', { sessionId: s.sessionId, maxMessages: 60 })
    state.messages = (snap.records || []).map(normalize).filter(Boolean)
    renderMessages()
  } catch (err) {
    // 历史拉取失败也要继续订阅，否则连新回复都收不到
    toast(`历史消息加载失败：${err.message}`)
  }
  try {
    const sub = await ask('sessions.follow', { sessionId: s.sessionId })
    state.subId = sub.subId
  } catch (err) {
    toast(`订阅会话失败：${err.message}`)
  }
}

// ---------------- 附件（图片/文件） ----------------
const MAX_UPLOAD = 50 * 1024 * 1024

async function uploadOne(file) {
  if (file.size > MAX_UPLOAD) throw new Error(`${file.name} 超过 50MB`)
  const res = await fetch('/api/blob', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${state.token}`,
      'content-type': file.type || 'application/octet-stream',
      'x-name': encodeURIComponent(file.name || 'file'),
    },
    body: file,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `上传失败 ${res.status}`)
  return {
    blobId: data.blobId,
    name: file.name || 'file',
    mime: file.type || '',
    size: file.size,
    preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
  }
}

async function addFiles(fileList) {
  const files = Array.from(fileList || [])
  if (!files.length) return
  toast(`正在上传 ${files.length} 个文件…`)
  for (const f of files) {
    try {
      state.attachments.push(await uploadOne(f))
    } catch (err) {
      toast(err.message)
    }
  }
  renderAttachments()
}

function renderAttachments() {
  const bar = $('#attachment-bar')
  bar.innerHTML = ''
  if (!state.attachments.length) {
    bar.hidden = true
    return
  }
  bar.hidden = false
  const hint = document.createElement('div')
  hint.className = 'attach-hint'
  hint.textContent = `待发送 ${state.attachments.length}`
  bar.appendChild(hint)
  state.attachments.forEach((a, i) => {
    const chip = document.createElement('div')
    chip.className = 'attach-chip'
    if (a.preview) {
      const img = document.createElement('img')
      img.src = a.preview
      // 内联尺寸：即使样式表被旧缓存命中，也不会撑满屏幕
      img.style.width = '48px'
      img.style.height = '48px'
      img.style.maxWidth = '48px'
      img.style.maxHeight = '48px'
      img.style.objectFit = 'cover'
      img.style.borderRadius = '7px'
      img.style.display = 'block'
      img.onclick = () => window.open(a.preview, '_blank')
      chip.appendChild(img)
    } else {
      const ic = document.createElement('span')
      ic.className = 'attach-icon'
      ic.innerHTML = icon('file', 26)
      chip.appendChild(ic)
    }
    const name = document.createElement('span')
    name.className = 'attach-name'
    name.textContent = a.name
    chip.appendChild(name)
    const del = document.createElement('button')
    del.className = 'attach-del'
    del.innerHTML = icon('x', 13)
    del.setAttribute('aria-label', '移除附件')
    del.onclick = () => {
      state.attachments.splice(i, 1)
      renderAttachments()
    }
    chip.appendChild(del)
    bar.appendChild(chip)
  })
}

function clearAttachments() {
  for (const a of state.attachments) if (a.preview) URL.revokeObjectURL(a.preview)
  state.attachments = []
  renderAttachments()
}

function openAttachSheet() {
  $('#attach-sheet').hidden = false
}

function closeAttachSheet() {
  $('#attach-sheet').hidden = true
}

async function sendMessage() {
  const input = $('#input')
  const text = input.value.trim()
  const files = state.attachments.slice()
  if ((!text && !files.length) || !state.current) return
  const label = text || '[附件]'
  input.value = ''
  input.style.height = 'auto'
  state.messages.push({ role: 'user', text: label, local: true })
  renderMessages()
  clearAttachments()
  setStreaming(true)
  try {
    await ask('sessions.prompt', {
      sessionId: state.current.sessionId,
      cwd: state.current.cwd || '',
      text,
      attachments: files.map((a) => ({ blobId: a.blobId, name: a.name, mime: a.mime })),
    })
  } catch (err) {
    setStreaming(false)
    toast(err.message)
  }
}

async function stopRun() {
  if (!state.current) return
  try {
    await ask('sessions.cancel', { sessionId: state.current.sessionId })
    toast('已请求停止')
  } catch (err) {
    toast(err.message)
  }
}

async function createSession() {
  try {
    const out = await ask('sessions.create', {})
    toast('已创建新会话')
    await refreshSessions()
    const s = state.sessions.find((x) => x.sessionId === out.sessionId)
    if (s) openSession(s)
    else openSession({ sessionId: out.sessionId, title: '新会话' })
  } catch (err) {
    toast(err.message)
  }
}

// ---------------- 登录 / 配对 / 设置 ----------------
async function doLogin() {
  const handle = $('#login-handle').value.trim()
  const password = $('#login-password').value
  const name = $('#login-device').value.trim() || '我的手机'
  const errBox = $('#login-err')
  errBox.textContent = ''
  if (!handle || !password) {
    errBox.textContent = '请填写账号和密码'
    return
  }
  try {
    const data = await http('/api/login', {
      method: 'POST',
      body: { handle, password, device: { kind: 'mobile', name, platform: navigator.userAgent.slice(0, 60) } },
    })
    state.token = data.token
    state.handle = data.user?.handle || handle
    state.device = data.device
    localStorage.setItem(LS.token, state.token)
    localStorage.setItem(LS.handle, state.handle)
    localStorage.setItem(LS.device, JSON.stringify(state.device))
    connectWS()
    await loadMe()
    show('devices', { title: '远程 DSH', subtitle: state.handle })
    renderDevices()
  } catch (err) {
    errBox.textContent = err.message
  }
}

function logout() {
  state.token = ''
  state.device = null
  state.target = null
  state.subId = null
  localStorage.removeItem(LS.token)
  localStorage.removeItem(LS.device)
  localStorage.removeItem(LS.target)
  try {
    state.ws?.close()
  } catch {}
  state.ws = null
  setConn(false)
  show('login', { title: '远程 DSH' })
}

async function claimPair() {
  const code = $('#pair-code').value.trim().toUpperCase()
  const status = $('#pair-status')
  if (code.length !== 8) {
    status.textContent = '配对码是 8 位'
    return
  }
  try {
    const data = await http('/api/pair/claim', { method: 'POST', body: { code } })
    status.textContent = `已提交，等待「${data.desktop?.name || '电脑'}」确认…`
    clearInterval(state.pollTimer)
    state.pollTimer = setInterval(async () => {
      try {
        const st = await http(`/api/pair/status?code=${encodeURIComponent(code)}`)
        if (st.state === 'confirmed') {
          clearInterval(state.pollTimer)
          status.textContent = '配对成功'
          await loadMe()
          toast('配对成功')
          show('devices', { title: '远程 DSH', subtitle: state.handle })
          renderDevices()
        } else if (st.state === 'cancelled' || st.state === 'expired') {
          clearInterval(state.pollTimer)
          status.textContent = '配对被拒绝或已过期，请重新生成配对码'
        }
      } catch {
        /* 忽略轮询错误 */
      }
    }, 2000)
  } catch (err) {
    status.textContent = err.message
  }
}

async function loadAppDownload() {
  const a = document.querySelector('.btn-download')
  if (!a) return
  try {
    const r = await fetch('/app/latest.json', { cache: 'no-store' })
    if (!r.ok) return
    const j = await r.json()
    if (!j || !j.url) return
    a.href = j.url
    a.download = String(j.url).split('/').pop()
    const label = a.querySelector('.dl-label')
    if (label) {
      const mb = j.size ? `${Math.round(Number(j.size) / 1048576)} MB` : ''
      label.textContent = `下载 Android 安装包 ${j.versionName || ''}${mb ? `（${mb}）` : ''}`
    }
  } catch {
    /* 离线时保留静态链接 */
  }
}

async function openSettings() {
  show('settings', { title: '设置', back: true })
  $('#set-server').textContent = state.base
  $('#set-handle').textContent = state.handle || '-'
  $('#set-device').textContent = state.device?.name || '-'
  loadAppDownload()
  const box = $('#set-devices')
  box.innerHTML = ''
  try {
    const me = await http('/api/me')
    state.devices = me.devices || []
    for (const d of state.devices) {
      const row = document.createElement('div')
      row.className = 'row'
      const self = d.id === state.device?.id
      row.innerHTML = `
        <div class="grow">
          <div class="name">${escapeHtml(d.name)}${self ? '（本机）' : ''}</div>
          <div class="meta">${escapeHtml(d.kind)} · ${d.online ? '在线' : '离线'} · ${timeAgo(d.lastSeenAt)}</div>
        </div>`
      if (!self) {
        const btn = document.createElement('button')
        btn.className = 'ghost small danger-text'
        btn.textContent = '撤销'
        btn.onclick = async () => {
          if (!confirm(`撤销设备「${d.name}」？`)) return
          try {
            await http(`/api/devices/${d.id}/revoke`, { method: 'POST' })
            toast('已撤销')
            openSettings()
          } catch (err) {
            toast(err.message)
          }
        }
        row.appendChild(btn)
      }
      box.appendChild(row)
    }
  } catch (err) {
    box.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`
  }
}

// ---------------- 看电脑屏幕 ----------------
function setViewMeta(text) {
  state.viewMeta = text || ''
  const zoom = state.viewZoom > 1 ? ` · ${state.viewZoom}×` : ''
  $('#view-meta').textContent = state.viewMeta + zoom
}

async function fetchBlob(blobId) {
  const res = await fetch(`${state.base}/api/blob/${blobId}`, {
    headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
  })
  if (!res.ok) throw new Error(`读取画面失败 ${res.status}`)
  return res.blob()
}

function dropBlob(blobId) {
  fetch(`${state.base}/api/blob/${blobId}`, {
    method: 'DELETE',
    headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
  }).catch(() => {})
}

async function refreshView({ silent = false } = {}) {
  if (state.viewBusy) return
  if (!state.target) return setViewMeta('还没有选择执行电脑')
  state.viewBusy = true
  if (!silent) setViewMeta('抓取中…')
  const t0 = performance.now()
  try {
    const maxWidth = Number($('#view-quality').value) || 2560
    const target = $('#view-screens')?.value || 'primary'
    const r = await ask('screen.capture', { maxWidth, quality: 90, target }, 40_000)
    const blob = await fetchBlob(r.blobId)
    dropBlob(r.blobId)
    const url = URL.createObjectURL(blob)
    try {
      const bmp = await createImageBitmap(blob)
      state.viewShot = bmp
      paintShot(bmp)
    } catch {
      // 老浏览器没有 createImageBitmap：退回 <img> 解码
      const img = new Image()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error('画面解码失败'))
        img.src = url
      })
      state.viewShot = img
      paintShot(img)
    }
    URL.revokeObjectURL(url)
    const ms = Math.round(performance.now() - t0)
    setViewMeta(`${r.width}×${r.height} · ${(r.size / 1024).toFixed(0)}KB · ${ms}ms · ${new Date(r.ts).toLocaleTimeString()}`)
    applyScreens(r.screens)
  } catch (err) {
    if (!silent) setViewMeta(`失败：${err.message}`)
  } finally {
    state.viewBusy = false
  }
}

// 根据电脑回报的屏幕数量，启用/禁用「副屏」
function applyScreens(screens) {
  const sel = $('#view-screens')
  if (!sel || !Array.isArray(screens) || !screens.length) return
  const secondary = screens.find((s) => !s.primary)
  sel.options[0].textContent = '主屏'
  sel.options[1].textContent = secondary ? '副屏' : '副屏（无）'
  sel.options[1].disabled = !secondary
  sel.options[2].textContent = '全部'
  state.screens = screens
  if (!secondary && sel.value === 'secondary') {
    sel.value = 'primary'
    localStorage.setItem('dsh.screen', 'primary')
  }
}

// 把一帧画到 canvas 上：横屏 = 原样，竖屏 = 顺时针转 90°，让宽屏画面竖着铺满手机
function paintShot(source) {
  const cv = $('#view-shot')
  const iw = source.width
  const ih = source.height
  if (!iw || !ih) return
  const rot = state.viewRot
  cv.width = rot ? ih : iw
  cv.height = rot ? iw : ih
  const ctx = cv.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, cv.width, cv.height)
  if (rot) {
    ctx.translate(ih, 0)
    ctx.rotate(Math.PI / 2)
  }
  ctx.drawImage(source, 0, 0)
  cv.hidden = false
  $('#view-empty').hidden = true
  fitShot()
}

// 按容器大小等比缩放（可 2× 放大后拖动）
function fitShot() {
  const cv = $('#view-shot')
  const stage = $('#view-stage')
  if (!cv || cv.hidden || !cv.width) return
  const W = Math.max(40, stage.clientWidth - 4)
  const H = Math.max(40, stage.clientHeight - 4)
  const ar = cv.width / cv.height
  let w = Math.min(W, H * ar)
  if (state.viewZoom > 1) w *= state.viewZoom
  cv.style.width = `${Math.round(w)}px`
  cv.style.height = `${Math.round(w / ar)}px`
  setViewMeta(state.viewMeta)
}

function setOrient(rot) {
  state.viewRot = !!rot
  localStorage.setItem('dsh.orient', state.viewRot ? 'port' : 'land')
  for (const b of document.querySelectorAll('#view-orient button')) {
    b.classList.toggle('on', (b.dataset.orient === 'port') === state.viewRot)
  }
  if (!$('#view-shot').hidden && state.viewShot) {
    // 已有画面：直接用缓存的那一帧重画，不必再抓
    paintShot(state.viewShot)
  } else {
    fitShot()
  }
}

function toggleFull() {
  const el = $('#screen-view')
  const on = !document.body.classList.contains('fs')
  document.body.classList.toggle('fs', on)
  if (on) {
    el.requestFullscreen?.().catch(() => {})
  } else if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {})
  }
  setTimeout(fitShot, 60)
}

function exitFull() {
  if (!document.body.classList.contains('fs')) return
  document.body.classList.remove('fs')
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  setTimeout(fitShot, 60)
}

function stopAutoView() {
  state.viewAuto = false
  const btn = $('#view-auto')
  if (btn) btn.setAttribute('aria-pressed', 'false')
  clearInterval(state.viewTimer)
  state.viewTimer = null
}

function toggleAutoView() {
  if (state.viewAuto) return stopAutoView()
  state.viewAuto = true
  $('#view-auto').setAttribute('aria-pressed', 'true')
  refreshView()
  state.viewTimer = setInterval(() => refreshView({ silent: true }), 2500)
}

function openView() {
  if (!state.target) return toast('先在会话里选择执行电脑')
  state.viewFrom = state.screen
  stopAutoView()
  show('view', { title: '电脑屏幕', subtitle: state.target.name || '', back: true })
  refreshView()
}

// ---------------- 事件绑定 ----------------
function bind() {
  $('#login-btn').onclick = doLogin
  $('#login-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin()
  })
  $('#pair-open').onclick = () => {
    $('#pair-code').value = ''
    $('#pair-status').textContent = ''
    show('pair', { title: '配对电脑', back: true })
  }
  $('#pair-claim').onclick = claimPair
  $('#refresh-sessions').onclick = refreshSessions
  $('#new-session').onclick = createSession
  $('#send').onclick = sendMessage
  $('#stop').onclick = stopRun

  // 附件：微信式「+」→ 底部选择面板
  $('#attach').onclick = openAttachSheet
  $('#attach-sheet').addEventListener('click', (e) => {
    const mask = e.target.classList.contains('sheet-mask')
    const item = e.target.closest('[data-pick]')
    if (mask || (item && item.dataset.pick === 'cancel')) return closeAttachSheet()
    if (!item) return
    const pick = item.dataset.pick
    closeAttachSheet()
    if (pick === 'image') $('#image-input').click()
    else if (pick === 'camera') $('#camera-input').click()
    else if (pick === 'file') $('#file-input').click()
  })
  for (const id of ['#file-input', '#image-input', '#camera-input']) {
    $(id).addEventListener('change', (e) => {
      addFiles(e.target.files)
      e.target.value = ''
    })
  }
  $('#menu').onclick = openSettings
  $('#screen-btn').onclick = openView
  $('#view-refresh').onclick = () => refreshView()
  $('#view-auto').onclick = toggleAutoView
  $('#view-quality').onchange = () => refreshView()
  const screenSel = $('#view-screens')
  if (screenSel) {
    const saved = localStorage.getItem('dsh.screen') || 'primary'
    if ([...screenSel.options].some((o) => o.value === saved)) screenSel.value = saved
    screenSel.onchange = () => {
      localStorage.setItem('dsh.screen', screenSel.value)
      refreshView()
    }
  }
  $('#view-orient').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-orient]')
    if (b) setOrient(b.dataset.orient === 'port')
  })
  $('#view-full').onclick = toggleFull
  const ctrlBar = $('#view-controls')
  if (ctrlBar) {
    ctrlBar.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]')
      if (!b) return
      const action = b.dataset.act
      b.disabled = true
      try {
        await ask('screen.control', { action })
        if (['alt_tab', 'alt_tab_back', 'win', 'win_d', 'esc'].includes(action)) {
          setTimeout(() => refreshView({ silent: true }), 450)
        }
      } catch (err) {
        toast(err?.message || '按键失败')
      } finally {
        b.disabled = false
      }
    })
  }
  const exitBtn = $('#view-exit')
  if (exitBtn) exitBtn.onclick = exitFull
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('fs')) {
      document.body.classList.remove('fs')
      setTimeout(fitShot, 60)
    }
  })
  $('#view-stage').onclick = (e) => {
    if (e.target.id !== 'view-shot' && e.target.id !== 'view-stage') return
    state.viewZoom = state.viewZoom >= 3 ? 1 : state.viewZoom + 1
    fitShot()
  }
  window.addEventListener('resize', () => {
    if (state.screen === 'view') fitShot()
  })
  $('#logout').onclick = () => {
    if (confirm('退出登录？')) logout()
  }
  $('#back').onclick = () => {
    if (document.body.classList.contains('fs')) {
      exitFull()
      return
    }
    if (state.screen === 'chat') {
      if (state.subId) {
        ask('sessions.unfollow', { subId: state.subId }).catch(() => {})
        state.subId = null
      }
      openSessions()
    } else if (state.screen === 'view') {
      stopAutoView()
      if (state.viewFrom === 'chat' && state.current) openSession(state.current)
      else openSessions()
    } else if (state.screen === 'sessions') {
      show('devices', { title: '远程 DSH', subtitle: state.handle })
      renderDevices()
    } else if (state.screen === 'pair' || state.screen === 'settings') {
      show('devices', { title: '远程 DSH', subtitle: state.handle })
      renderDevices()
    }
  }
  const input = $('#input')
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      sendMessage()
    }
  })
}

async function boot() {
  mountIcons()
  bind()
  for (const b of document.querySelectorAll('#view-orient button')) {
    b.classList.toggle('on', (b.dataset.orient === 'port') === state.viewRot)
  }
  $('#login-server').textContent = state.base
  $('#login-device').value = localStorage.getItem('dsh.deviceName') || '我的手机'
  if (!state.token) {
    show('login', { title: '远程 DSH' })
    return
  }
  show('devices', { title: '远程 DSH', subtitle: state.handle })
  connectWS()
  try {
    await loadMe()
    renderDevices()
  } catch (err) {
    toast(err.message)
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
}

boot()
