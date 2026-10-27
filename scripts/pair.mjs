#!/usr/bin/env node
// 电脑端配对脚本：生成配对码，等手机输入后在本机确认。
// 只走 HTTP 轮询，不占用 WebSocket —— 因此可以和正在运行的 DSH 插件同时使用，不会互相踢下线。
// 用法：
//   node scripts/pair.mjs                 # 交互确认（y/N）
//   node scripts/pair.mjs --yes           # 自动确认（给自动化用）
//   node scripts/pair.mjs --yes 路径\remote-control.json
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname, platform, release } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const AUTO_YES = args.includes('--yes')
const CONFIG =
  args.find((a) => !a.startsWith('--')) ||
  process.env.REMOTE_CONFIG || join(homedir(), '.dsh', 'profiles', 'desktop', 'remote-control.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''))
  if (!cfg.serverUrl) throw new Error(`配置里没有 serverUrl：${CONFIG}`)
  return cfg
}

function saveConfig(cfg) {
  const out = { ...cfg }
  delete out.__path
  delete out.refresh
  writeFileSync(CONFIG, JSON.stringify(out, null, 2), 'utf8')
}

async function login(cfg) {
  const res = await fetch(cfg.serverUrl.replace(/\/+$/, '') + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      handle: cfg.handle,
      password: cfg.password,
      device: {
        kind: 'desktop',
        name: cfg.deviceName || hostname(),
        platform: `${platform()}/${release()}`,
      },
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`登录失败：${data.error || res.status}`)
  cfg.token = data.token
  cfg.deviceId = data.device.id
  saveConfig(cfg)
  return data
}

async function main() {
  const cfg = readConfig()
  const base = cfg.serverUrl.replace(/\/+$/, '')
  const rl = AUTO_YES ? null : createInterface({ input: stdin, output: stdout })

  if (!cfg.token) {
    console.log('配置里没有设备令牌，先登录…')
    const data = await login(cfg)
    console.log(`已登录：${data.device.name} (${data.device.id})`)
  }

  const headers = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }

  // 1) 生成配对码
  const startRes = await fetch(base + '/api/pair/start', { method: 'POST', headers, body: '{}' })
  const start = await startRes.json().catch(() => ({}))
  if (!startRes.ok) throw new Error(`生成配对码失败：${start.error || startRes.status}`)

  console.log('')
  console.log('  配对码：  ' + start.code)
  console.log('  CODE=' + start.code)
  console.log('  ' + '─'.repeat(24))
  console.log('  在手机上打开远程 DSH → 配对电脑 → 输入上面的配对码')
  console.log('  有效期 5 分钟，等待中…（Ctrl+C 取消）')
  console.log('')

  // 2) 轮询状态（纯 HTTP，不抢 WebSocket）
  let claimed = false
  let mobileName = ''
  for (;;) {
    await sleep(1000)
    const st = await fetch(`${base}/api/pair/status?code=${encodeURIComponent(start.code)}`, {
      headers: { authorization: `Bearer ${cfg.token}` },
    })
      .then((r) => r.json())
      .catch(() => ({}))
    if (st.state === 'expired') throw new Error('配对码已过期，请重新生成')
    if (st.state === 'confirmed') {
      console.log(`\n配对成功，pairId=${st.pairId || ''}\n现在可以用手机打开会话了。`)
      rl?.close()
      return
    }
    if (st.state === 'rejected') throw new Error('配对已被拒绝')
    if (st.state === 'claimed' && !claimed) {
      claimed = true
      mobileName = st.mobile?.name || st.mobile?.id || '未知设备'
      console.log(`收到配对请求：${mobileName}（${st.mobile?.platform || ''}）`)
      const answer = AUTO_YES ? 'y' : (await rl.question('允许这台设备控制本机吗？(y/N) ')).trim().toLowerCase()
      const allow = answer === 'y' || answer === 'yes'
      const res = await fetch(base + '/api/pair/confirm', {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: start.code, allow }),
      })
      const data = await res.json().catch(() => ({}))
      if (!allow) {
        console.log('已拒绝配对')
        rl?.close()
        process.exit(0)
      }
      if (!res.ok) throw new Error(`确认失败：${data.error || res.status}`)
      console.log(`\n配对成功，pairId=${data.pairId || ''}\n现在可以用手机打开会话了。`)
      rl?.close()
      return
    }
  }
}

main().catch((err) => {
  console.error('配对失败：', err.message)
  process.exit(1)
})
