// 电脑端配置（命令行版）：不改代码、不重启 DSH，直接写插件配置文件。
// 插件每次重连都会重读该文件，所以保存后几秒内生效。
//
// 用法：
//   node scripts/setup-pc.mjs                      交互式填写
//   node scripts/setup-pc.mjs --server https://x.com --handle owner --password xxx --name 我的电脑
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_PATH = process.env.REMOTE_CONFIG || join(homedir(), '.dsh', 'profiles', 'desktop', 'remote-control.json')

const args = process.argv.slice(2)
const opt = (k) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : undefined
}

const rl = createInterface({ input: stdin, output: stdout })
const ask = async (q, def = '') => {
  const v = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim()
  return v || def
}

const serverUrl = opt('server') ?? (await ask('中转服务器地址（如 https://abc.example.com）'))
const handle = opt('handle') ?? (await ask('账号'))
const password = opt('password') ?? (await ask('密码'))
const deviceName = opt('name') ?? (await ask('这台电脑的名称', '我的电脑'))
rl.close()

if (!serverUrl || !handle || !password) {
  console.error('服务器地址、账号、密码都必须填写')
  process.exit(1)
}

const { loadConfig, saveConfig } = await import(new URL('../dsh-plugin/lib/config.js', import.meta.url).href)
const cfg = loadConfig({})
cfg.serverUrl = serverUrl.trim().replace(/\/+$/, '')
cfg.handle = handle.trim()
cfg.password = password
cfg.deviceName = deviceName.trim()
cfg.enabled = true
saveConfig(cfg)

console.log(`\n已保存到 ${CONFIG_PATH}`)
console.log('插件会在下一次重连（约 5 秒内）读取新配置，无需重启 DSH。')
console.log('手机上用同一个账号登录，然后在「电脑」页输入配对码即可。')
