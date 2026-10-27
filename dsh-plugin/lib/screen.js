// 截屏：调用 PowerShell + System.Drawing 抓取整个虚拟屏幕，缩放到目标宽度后存 JPEG。
import { spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PS1 = fileURLToPath(new URL('./capture.ps1', import.meta.url))

function run(shell, args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('截屏超时'))
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `exit ${code}`))
    })
  })
}

/**
 * @returns {Promise<{buffer: Buffer, width: number, height: number, screens: Array<{primary: boolean, width: number, height: number}>, ts: number}>}
 */
export async function captureScreen({ maxWidth = 3840, quality = 88, target = 'primary' } = {}) {
  const width = Math.max(320, Math.min(4096, Number(maxWidth) || 3840))
  const q = Math.max(30, Math.min(95, Number(quality) || 88))
  const which = ['primary', 'secondary', 'all'].includes(target) ? target : 'primary'
  const out = join(tmpdir(), `dsh-screen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`)
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Out', out, '-MaxWidth', String(width), '-Quality', String(q), '-Target', which]
  let lastErr
  for (const shell of ['pwsh', 'powershell']) {
    try {
      const res = await run(shell, args)
      const info = JSON.parse(String(res).split('\n').filter(Boolean).pop())
      const buffer = await readFile(out)
      await unlink(out).catch(() => {})
      if (!buffer.length) throw new Error('截屏结果为空')
      return {
        buffer,
        width: Number(info.width) || 0,
        height: Number(info.height) || 0,
        screens: Array.isArray(info.screens) ? info.screens : [],
        ts: Date.now(),
      }
    } catch (err) {
      lastErr = err
      await unlink(out).catch(() => {})
      if (String(err?.message || err).includes('NO_SECONDARY')) {
        throw Object.assign(new Error('这台电脑只有一块屏幕'), { code: 'screen/no-secondary' })
      }
    }
  }
  throw Object.assign(new Error(`截屏失败：${lastErr?.message || lastErr}`), { code: 'screen/failed' })
}

const CONTROL_PS1 = fileURLToPath(new URL('./control.ps1', import.meta.url))

/** 允许的远程按键动作（白名单，避免任意键注入） */
export const CONTROL_ACTIONS = [
  'alt_tab', 'alt_tab_back', 'win', 'win_d', 'win_e', 'esc', 'enter', 'space',
  'backspace', 'delete', 'up', 'down', 'left', 'right', 'pageup', 'pagedown',
  'home', 'end', 'ctrl_w', 'ctrl_c', 'ctrl_v', 'ctrl_t', 'alt_f4',
  'volume_up', 'volume_down', 'mute', 'media_play',
]

/**
 * 发送一次按键动作到电脑（模拟键鼠），用于手机远程控制。
 * @param {string} action
 */
export async function controlScreen(action = 'alt_tab') {
  const act = String(action || '').trim()
  if (!CONTROL_ACTIONS.includes(act)) {
    throw Object.assign(new Error(`不支持的按键动作：${act}`), { code: 'control/unknown' })
  }
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CONTROL_PS1, '-Action', act]
  let lastErr
  for (const shell of ['pwsh', 'powershell']) {
    try {
      const out = await run(shell, args, 10_000)
      return { action: act, ok: true, output: out }
    } catch (err) {
      lastErr = err
    }
  }
  throw Object.assign(new Error(`按键失败：${lastErr?.message || lastErr}`), { code: 'control/failed' })
}
