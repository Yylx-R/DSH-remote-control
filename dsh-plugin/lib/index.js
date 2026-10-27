// dsh-remote-control 插件入口
// 把本机 DSH 的会话/工作区能力通过自建中继服务器暴露给已配对的手机。
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createLogger } from './log.js'
import { loadConfig } from './config.js'
import { createRelayClient } from './relay-client.js'
import { registerSetup } from './setup.js'

export const name = 'dsh-remote-control'

const COMMANDS_URL = new URL('./commands.js', import.meta.url)
const COMMANDS_PATH = fileURLToPath(COMMANDS_URL)

/**
 * @param ctx Cordis host context
 * @param config loader 中该行的 config（可选，覆盖配置文件）
 */
export function apply(ctx, config) {
  const log = createLogger()
  const cfg = loadConfig(config)

  // 每次重连前重读配置文件：改配置后不必重启 DSH
  cfg.refresh = () => {
    const fresh = loadConfig(config)
    if (!fresh.token && cfg.token) fresh.token = cfg.token
    if (!fresh.deviceId && cfg.deviceId) fresh.deviceId = cfg.deviceId
    Object.assign(cfg, fresh)
    return cfg
  }

  if (!cfg.enabled) {
    log.info(`插件未启用（enabled=false），配置：${cfg.__path}`)
    return
  }

  ctx.inject(['sessionController'], (hostCtx) => {
    // 指令模块按文件修改时间热加载：改 lib/commands.js 后无需重启 DSH
    let cachedVer = ''
    let cachedMod = null
    const loadCommands = async () => {
      const ver = String(statSync(COMMANDS_PATH).mtimeMs)
      if (ver !== cachedVer || !cachedMod) {
        cachedMod = await import(`${COMMANDS_URL.href}?v=${ver}`)
        cachedVer = ver
        log.info(`指令模块已加载 v=${ver}`)
      }
      return cachedMod
    }

    const follows = new Map()
    let client = null
    const handle = async (body, frame) => {
      if (!body || typeof body !== 'object') return
      try {
        const mod = await loadCommands()
        const router = mod.createCommandRouter({ ctx: hostCtx, log, client, cfg, follows })
        await router.handle(body, frame)
      } catch (err) {
        log.error(`加载指令模块失败：${err?.message || err}`)
      }
    }

    client = createRelayClient({ cfg, log, onBody: handle })

    // 电脑端配置页：/remote-control（挂在本机 DSH Web 服务上）
    try {
      registerSetup(hostCtx, { cfg, log, client })
    } catch (err) {
      log.warn(`配置页注册失败：${err?.message || err}`)
    }

    ctx.effect(() => {
      client.start()
      return () => {
        for (const ac of follows.values()) {
          try {
            ac.abort()
          } catch {}
        }
        follows.clear()
        client.stop()
      }
    })

    log.info(`已挂载，配置文件：${cfg.__path}`)
  })
}

