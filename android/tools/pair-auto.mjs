// 自动配对（不重新登录，直接复用插件已有的设备令牌，避免把插件顶掉）
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG =
  process.env.DSH_REMOTE_CONFIG ||
  join(process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop'), 'remote-control.json')
const cfg = JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''))
const base = cfg.serverUrl.replace(/\/+$/, '')
const headers = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const start = await fetch(base + '/api/pair/start', { method: 'POST', headers, body: '{}' }).then((r) => r.json())
if (!start.code) {
  console.log('START_FAILED', JSON.stringify(start))
  process.exit(1)
}
console.log('CODE=' + start.code)

for (let i = 0; i < 120; i++) {
  await sleep(1000)
  const st = await fetch(`${base}/api/pair/status?code=${start.code}`, { headers }).then((r) => r.json())
  console.log('state=' + st.state)
  if (st.state === 'claimed') {
    const res = await fetch(base + '/api/pair/confirm', {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: start.code, allow: true }),
    }).then((r) => r.json())
    console.log('CONFIRM=' + JSON.stringify(res))
    process.exit(0)
  }
  if (st.state === 'expired') {
    console.log('EXPIRED')
    process.exit(1)
  }
}
console.log('TIMEOUT')
