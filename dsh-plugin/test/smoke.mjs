// 端到端冒烟测试：真实 relay + 真实插件代码（用假的 sessionController 顶替 DSH 宿主）
// 运行：node test/smoke.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELAY_ENTRY = fileURLToPath(new URL('../../relay/src/index.mjs', import.meta.url))
const PORT = 8899
const BASE = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/ws`

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function http(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function waitHealth(timeoutMs = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(BASE + '/healthz')
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  return false
}

function connectWs(token) {
  const ws = new WebSocket(WS_URL)
  const frames = []
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', token }))
      resolve()
    })
    ws.addEventListener('error', reject)
  })
  ws.addEventListener('message', (ev) => {
    try {
      frames.push(JSON.parse(ev.data))
    } catch {
      /* ignore */
    }
  })
  const waitFor = async (pred, timeoutMs = 8000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const hit = frames.find(pred)
      if (hit) return hit
      await sleep(50)
    }
    return null
  }
  return { ws, frames, opened, waitFor, close: () => ws.close() }
}

// ---------- 假的 DSH 会话服务 ----------
const sessions = [
  {
    sessionId: 's1',
    running: true,
    blank: false,
    updatedAt: Date.now(),
    cwd: 'E:\\work',
    agentAvailable: true,
    projections: { values: { title: '修复登录 bug' } },
  },
]
const captured = []
const fakeController = {
  async list() {
    return { items: sessions }
  },
  async create() {
    return { sessionId: 's2' }
  },
  async prompt(req) {
    captured.push(req)
    return { accepted: true }
  },
  async cancel() {
    return undefined
  },
  follow() {
    return (async function* () {
      yield {
        type: 'snapshot',
        cursor: 2,
        records: [
          { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: '你好' }] } } },
          {
            type: 'assistant/message',
            seq: 2,
            data: { message: { content: [{ type: 'text', text: '你好，有什么可以帮你？' }] } },
          },
        ],
        hasMore: false,
        projections: {},
      }
      await sleep(50)
      yield { type: 'assistant-stream', frame: { type: 'text-delta', index: 0, text: '继续' } }
    })()
  },
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-data-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
  const relay = spawn(process.execPath, [RELAY_ENTRY], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, BLOB_MAX_MB: '10' },
    stdio: 'ignore',
  })

  const cleanup = async () => {
    try {
      relay.kill()
    } catch {}
    // Windows 上 sqlite 句柄释放有延迟，等一下再删
    await sleep(600)
    for (const dir of [dataDir, profileDir]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 临时目录残留不影响结果 */
      }
    }
  }

  try {
    const healthy = await waitHealth()
    check('relay /healthz 可用', healthy)
    if (!healthy) return

    const reg = await http('/api/register', { method: 'POST', body: { handle: 'owner', password: 'password123' } })
    check('注册首个用户（admin）', reg.status === 200, JSON.stringify(reg.data))

    writeFileSync(
      join(profileDir, 'remote-control.json'),
      JSON.stringify(
        {
          enabled: true,
          serverUrl: BASE,
          handle: 'owner',
          password: 'password123',
          deviceName: '测试电脑',
          token: '',
          deviceId: '',
        },
        null,
        2,
      ),
    )
    process.env.DSH_PROFILE_DIR = profileDir

    const hostCtx = {
      sessionController: fakeController,
      workspaceRegistry: { list: async () => [{ id: 'w1', path: 'E:\\work', title: '工作区' }] },
    }
    const ctx = {
      inject(_services, cb) {
        cb(hostCtx)
      },
      effect(fn) {
        const d = fn()
        return typeof d === 'function' ? d : () => {}
      },
      get(name) {
        return hostCtx[name]
      },
    }

    const plugin = await import('../lib/index.js')
    plugin.apply(ctx, {})

    // 等插件完成登录并把 token 写回配置
    let desktopToken = ''
    for (let i = 0; i < 60; i += 1) {
      try {
        desktopToken = JSON.parse(readFileSync(join(profileDir, 'remote-control.json'), 'utf8')).token || ''
      } catch {}
      if (desktopToken) break
      await sleep(250)
    }
    check('插件登录中继并保存 token', !!desktopToken)

    const health = await http('/healthz')
    check('插件 WS 已上线', health.data.online === 1, `online=${health.data.online}`)

    // 手机登录 + 配对
    const mob = await http('/api/login', {
      method: 'POST',
      body: { handle: 'owner', password: 'password123', device: { kind: 'mobile', name: '测试手机' } },
    })
    check('手机登录', mob.status === 200 && !!mob.data.token)
    const mobileToken = mob.data.token

    const start = await http('/api/pair/start', { method: 'POST', token: desktopToken, body: {} })
    check('电脑生成配对码', start.status === 200 && !!start.data.code, JSON.stringify(start.data))
    const code = start.data.code
    const claim = await http('/api/pair/claim', { method: 'POST', token: mobileToken, body: { code } })
    check('手机认领配对码', claim.status === 200 && claim.data.state === 'claimed')
    const confirm = await http('/api/pair/confirm', { method: 'POST', token: desktopToken, body: { code } })
    check('电脑确认配对', confirm.status === 200 && confirm.data.ok === true)

    // 手机 WS 连接
    const m = connectWs(mobileToken)
    await m.opened
    const welcome = await m.waitFor((f) => f.t === 'welcome')
    check('手机收到 welcome', !!welcome)
    check('welcome 带 1 个配对设备', (welcome?.pairs || []).length === 1)

    const desktopId = welcome.pairs[0].id
    const ask = async (op, body = {}) => {
      const rid = `r${Math.random().toString(36).slice(2, 8)}`
      m.ws.send(JSON.stringify({ t: 'msg', id: rid, to: desktopId, kind: 'dsh', body: { op, rid, ...body } }))
      const frame = await m.waitFor((f) => f.t === 'msg' && f.body?.rid === rid)
      return frame?.body
    }

    const ping = await ask('ping')
    check('ping 往返', ping?.ok === true && typeof ping.data.now === 'number')

    const info = await ask('device.info')
    check('device.info 返回设备信息', info?.ok === true && !!info.data.deviceId, JSON.stringify(info?.data))

    const list = await ask('sessions.list')
    check(
      'sessions.list 返回会话',
      list?.ok === true && list.data.items[0]?.title === '修复登录 bug',
      JSON.stringify(list?.data?.items?.[0]),
    )

    const prompt = await ask('sessions.prompt', { sessionId: 's1', text: '帮我看下登录接口' })
    check('sessions.prompt 被接受', prompt?.ok === true && prompt.data.accepted === true)
    check(
      'prompt 内容结构正确',
      captured[0]?.content?.[0]?.type === 'text' && captured[0].content[0].text === '帮我看下登录接口',
    )
    check('prompt 带 requestId 与 queue 模式', typeof captured[0]?.requestId === 'string' && captured[0].mode === 'queue')

    const snap = await ask('sessions.snapshot', { sessionId: 's1' })
    check(
      'sessions.snapshot 归一化消息',
      snap?.ok === true && snap.data.records.length === 2 && snap.data.records[1].role === 'assistant',
      JSON.stringify(snap?.data?.records),
    )

    const created = await ask('sessions.create', {})
    check('sessions.create 返回新会话', created?.ok === true && created.data.sessionId === 's2')

    const sub = await ask('sessions.follow', { sessionId: 's1', subId: 'sub1' })
    check('sessions.follow 已订阅', sub?.ok === true)
    const streamSnap = await m.waitFor(
      (f) => f.body?.op === 'stream' && f.body.subId === 'sub1' && f.body.frame?.type === 'snapshot',
    )
    check('收到 snapshot 流帧', !!streamSnap)
    const delta = await m.waitFor(
      (f) => f.body?.op === 'stream' && f.body.subId === 'sub1' && f.body.frame?.type === 'assistant-stream',
    )
    check('收到 assistant-stream 流帧', !!delta)
    const done = await m.waitFor((f) => f.body?.op === 'stream' && f.body.subId === 'sub1' && f.body.done === true)
    check('订阅结束通知', !!done)

    const unfollow = await ask('sessions.unfollow', { subId: 'sub1' })
    check('sessions.unfollow 返回', unfollow?.ok === true)

    const ws = await ask('workspaces.list')
    check('workspaces.list 返回工作区', ws?.ok === true && ws.data.items[0]?.title === '工作区')

    const pairCode = await ask('pair.code')
    check('pair.code 走 HTTP 配对', pairCode?.ok === true && typeof pairCode.data.code === 'string')

    m.close()
  } finally {
    await cleanup()
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('测试异常', err)
  process.exit(1)
})
