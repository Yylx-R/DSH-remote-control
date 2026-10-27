// 配置：优先读取 profile 目录下的 remote-control.json；loader 传入的 config 覆盖文件
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULTS = {
  enabled: true,
  serverUrl: '',
  handle: '',
  password: '',
  deviceName: '',
  token: '',
  deviceId: '',
}

export function configPath() {
  const dir = process.env.DSH_PROFILE_DIR || process.cwd()
  return join(dir, 'remote-control.json')
}

export function loadConfig(overrides = {}) {
  const file = configPath()
  let fromFile = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    } catch (err) {
      console.error(`[remote-control] 配置文件解析失败：${err.message}`)
    }
  } else {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(DEFAULTS, null, 2), 'utf8')
    } catch {
      /* 忽略 */
    }
  }
  const cfg = { ...DEFAULTS, ...fromFile, ...(overrides && typeof overrides === 'object' ? overrides : {}) }
  cfg.__path = file
  return cfg
}

export function saveConfig(cfg) {
  const file = cfg.__path || configPath()
  try {
    const out = { ...cfg }
    delete out.__path
    writeFileSync(file, JSON.stringify(out, null, 2), 'utf8')
    return true
  } catch (err) {
    console.error(`[remote-control] 保存配置失败：${err.message}`)
    return false
  }
}
