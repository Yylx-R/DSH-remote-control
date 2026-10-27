import { secrets } from './_secrets.mjs'
const S = secrets()

// 打印真实会话 snapshot 的记录类型统计与可疑注入消息的原始结构
import { readFileSync } from 'node:fs'
const BASE = process.env.PHONE_SERVER || S.server
const tok = readFileSync(new URL('./.phone-token', import.meta.url), 'utf8').trim()
const sessionId = process.argv[2]
if (!sessionId) {
  console.error('用法: node scripts/inspect-records.mjs <sessionId>')
  process.exit(1)
}
const me = await fetch(BASE + '/api/me', { headers: { authorization: 'Bearer ' + tok } }).then((r) => r.json())
const desk = (me.pairs || []).map((p) => p.peer || p).find((p) => p.kind === 'desktop')
const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws')
await new Promise((r) => ws.addEventListener('open', r))
ws.send(JSON.stringify({ t: 'hello', token: tok }))
ws.addEventListener('message', (ev) => {
  const f = JSON.parse(ev.data)
  if (f.t === 'msg' && f.body?.op === 'stream' && f.body.frame?.type === 'snapshot') {
    const recs = f.body.frame.records
    const counts = {}
    for (const r of recs) counts[r.type] = (counts[r.type] || 0) + 1
    console.log('types', JSON.stringify(counts))
    for (const r of recs) {
      if (r.type !== 'user/message' && r.type !== 'assistant/message') continue
      const t = String(r.text || '')
      console.log('---', r.type, 'seq=' + r.seq, 'keys=' + Object.keys(r).join(','))
      console.log(JSON.stringify({ ...r, text: t.slice(0, 80) }))
    }
    process.exit(0)
  }
})
ws.send(
  JSON.stringify({
    t: 'msg',
    id: 'x1',
    to: desk.id,
    kind: 'dsh',
    body: { op: 'sessions.follow', rid: 'x1', sessionId, subId: 'sx' },
  }),
)
setTimeout(() => {
  console.log('timeout')
  process.exit(1)
}, 8000)
