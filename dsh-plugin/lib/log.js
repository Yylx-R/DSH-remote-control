// 轻量日志：写 profile 目录下的 remote-control.log，同时输出到控制台
import { appendFileSync, existsSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024

function profileDir() {
  return process.env.DSH_PROFILE_DIR || process.cwd()
}

export function createLogger(tag = 'remote-control') {
  const file = join(profileDir(), `${tag}.log`)

  function write(level, message) {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
      appendFileSync(file, line)
    } catch {
      /* 日志失败不影响主流程 */
    }
    if (level === 'error') console.error(`[${tag}] ${message}`)
    else console.log(`[${tag}] ${message}`)
  }

  return {
    file,
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  }
}
