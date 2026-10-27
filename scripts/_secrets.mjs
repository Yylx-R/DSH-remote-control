// 本地凭据读取：优先环境变量，其次 .secrets.local.json（不进版本库、不随项目分享）
// 复制 .secrets.local.example.json 为 .secrets.local.json 后填写。
import { readFileSync } from 'node:fs'

const FILE = new URL('../.secrets.local.json', import.meta.url)

export function secrets() {
  let file = {}
  try {
    file = JSON.parse(readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    /* 没有本地文件时靠环境变量 */
  }
  const server = process.env.DSH_SERVER || file.server
  const handle = process.env.DSH_HANDLE || file.handle
  const password = process.env.DSH_PASSWORD || file.password
  const sshKey = process.env.DSH_SSH_KEY || file.sshKey
  if (!server) {
    console.error('缺少服务器地址：请把 .secrets.local.example.json 复制成 .secrets.local.json 并填写 server / handle / password，')
    console.error('或者设置环境变量 DSH_SERVER / DSH_HANDLE / DSH_PASSWORD。')
    process.exit(1)
  }
  return { server, handle, password, sshKey }
}
