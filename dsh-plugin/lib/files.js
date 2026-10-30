// 工作区文件：列出会话目录里的文件，供手机端取回交付物（表格、文档等）
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep, extname, resolve, isAbsolute } from 'node:path'

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.dsh', '.cache',
  'dist', 'build', '.next', '.nuxt', '.idea', '.gradle', '.mypy_cache',
  '.pytest_cache', 'target', 'coverage', '.turbo',
])

const MIME = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.html': 'text/html',
}

export function guessMime(name) {
  return MIME[extname(String(name || '')).toLowerCase()] || 'application/octet-stream'
}

// 递归列出文件（默认两层），按修改时间倒序 —— 刚生成的交付物排在最前
export async function listFiles(root, { depth = 2, max = 300 } = {}) {
  const base = resolve(String(root || '.'))
  const out = []
  async function walk(dir, level) {
    if (out.length >= max) return
    let ents
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (out.length >= max) return
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || level >= depth) continue
        await walk(full, level + 1)
      } else if (e.isFile()) {
        try {
          const st = await stat(full)
          out.push({
            path: relative(base, full).split(sep).join('/'),
            name: e.name,
            size: st.size,
            mtime: Math.round(st.mtimeMs),
            mime: guessMime(e.name),
          })
        } catch {}
      }
    }
  }
  await walk(base, 0)
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

// 把手机传来的相对路径安全地拼到会话目录下，拒绝跳出目录
export function resolveInside(root, relPath) {
  const base = resolve(String(root || '.'))
  const rel = String(relPath || '').replace(/\\/g, '/')
  if (!rel || rel.startsWith('/') || isAbsolute(rel)) {
    throw Object.assign(new Error('路径不合法'), { code: 'files/bad-path' })
  }
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) {
    throw Object.assign(new Error('路径越界'), { code: 'files/bad-path' })
  }
  return full
}
