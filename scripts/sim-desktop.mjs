import { secrets } from './_secrets.mjs'
const S = secrets()

// 联调用的「假电脑」：加载真实插件代码 + 假会话服务，连生产 relay。
// 用途：在没有重启 DSH 的情况下验证手机端 ↔ relay ↔ 插件 全链路。
// 运行：node scripts/sim-desktop.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.env.SIM_SERVER || S.server
const HANDLE = process.env.SIM_HANDLE || S.handle
const PASSWORD = process.env.SIM_PASSWORD || S.password
const PROFILE = process.env.SIM_PROFILE_DIR || join(tmpdir(), 'sim-dsh')
mkdirSync(PROFILE, { recursive: true })
process.env.DSH_PROFILE_DIR = PROFILE

const cfgPath = join(PROFILE, 'remote-control.json')
if (!process.env.SIM_PROFILE_DIR) {
  let prev = {}
  try {
    prev = JSON.parse(readFileSync(cfgPath, 'utf8'))
  } catch {}
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        enabled: true,
        serverUrl: BASE,
        handle: HANDLE,
        password: PASSWORD,
        deviceName: '模拟电脑',
        token: prev.token || '',
        deviceId: prev.deviceId || '',
      },
      null,
      2,
    ),
  )
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const listeners = new Set()
const captured = []

const TITLES = (process.env.SIM_TITLES || '联调会话：测试手机端,另一个会话').split(',').map(s => s.trim())
const GREETING = process.env.SIM_GREETING || '我是模拟电脑，收到指令会立刻回显。'
const sessions = [
  {
    sessionId: 'sim-1',
    running: false,
    blank: false,
    updatedAt: Date.now() - 60_000,
    cwd: process.cwd(),
    agentAvailable: true,
    projections: { values: { title: TITLES[0] } },
  },
  {
    sessionId: 'sim-2',
    running: false,
    blank: true,
    updatedAt: Date.now() - 3_600_000,
    cwd: process.cwd(),
    agentAvailable: true,
    projections: { values: { title: TITLES[1] || '另一个会话' } },
  },
]

const fakeController = {
  async list() {
    return { items: sessions }
  },
  async create() {
    const s = {
      sessionId: 'sim-' + Math.random().toString(36).slice(2, 8),
      running: false,
      blank: true,
      updatedAt: Date.now(),
      cwd: process.cwd(),
      agentAvailable: true,
      projections: { values: { title: '新会话' } },
    }
    sessions.unshift(s)
    return { sessionId: s.sessionId }
  },
  async prompt(req) {
    captured.push(req)
    for (const fn of listeners) fn(req)
    return { accepted: true }
  },
  async cancel() {
    return undefined
  },
  async page() {
    return {
      records: [
        { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: '帮我把这周的截图整理一下，按日期建文件夹' }] } } },
        {
          type: 'assistant/message',
          seq: 2,
          data: { message: { content: [{ type: 'text', text: '好的，已按日期归到 screenshots/ 下：10-21 三张、10-22 五张，重复的已跳过。' }] } },
        },
      ],
      hasMore: false,
    }
  },
  follow() {
    return (async function* () {
      yield {
        type: 'snapshot',
        cursor: 0,
        records: [
          { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: '帮我把这周的截图整理一下，按日期建文件夹' }] } } },
          {
            type: 'assistant/message',
            seq: 2,
            data: { message: { content: [{ type: 'text', text: '好的，已按日期归到 screenshots/ 下：10-21 三张、10-22 五张，重复的已跳过。' }] } },
          },
        ],
        hasMore: false,
        projections: {},
      }
      const queue = []
      const onPrompt = (r) => {
        const text = (r.content || []).map((b) => b.text || '').join('')
        queue.push(text)
      }
      listeners.add(onPrompt)
      try {
        for (;;) {
          if (queue.length) {
            const text = queue.shift()
            const reply = `收到：${text}`
            for (const piece of [reply.slice(0, 4), reply.slice(4)]) {
              await sleep(180)
              yield { type: 'assistant-stream', frame: { type: 'text-delta', index: 0, text: piece } }
            }
            yield {
              type: 'event',
              event: { type: 'assistant/message', seq: 10, time: Date.now(), data: { message: { content: [{ type: 'text', text: reply }] } } },
            }
          }
          await sleep(250)
        }
      } finally {
        listeners.delete(onPrompt)
      }
    })()
  },
}

const hostCtx = {
  sessionController: fakeController,
  workspaceRegistry: { list: async () => [{ id: 'w1', path: process.cwd(), title: '工作区' }] },
}
const ctx = {
  inject(_s, cb) {
    cb(hostCtx)
  },
  effect(fn) {
    fn()
    return () => {}
  },
  get(n) {
    return hostCtx[n]
  },
}

const plugin = await import('../dsh-plugin/lib/index.js')
plugin.apply(ctx, {})

let token = ''
for (let i = 0; i < 80; i += 1) {
  try {
    token = JSON.parse(readFileSync(cfgPath, 'utf8')).token || ''
  } catch {}
  if (token) break
  await sleep(250)
}
if (!token) {
  console.error('模拟电脑登录失败')
  process.exit(1)
}
console.log('[sim] 已登录 relay，等待配对码…')

const startRes = await fetch(BASE + '/api/pair/start', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: '{}',
})
const start = await startRes.json()
console.log(`[sim] 配对码：${start.code}`)

for (;;) {
  const st = await fetch(`${BASE}/api/pair/status?code=${start.code}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json())
  if (st.state === 'claimed') {
    const c = await fetch(BASE + '/api/pair/confirm', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code: start.code, allow: true }),
    }).then((r) => r.json())
    console.log('[sim] 已自动确认配对', c)
    break
  }
  if (st.state === 'confirmed') break
  await sleep(1000)
}
console.log('[sim] 就绪，保持在线')
setInterval(() => {}, 60_000)
