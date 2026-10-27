// 入口：HTTP + WebSocket + 静态 PWA
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.mjs'
import { createHub } from './ws.mjs'
import { createHttp } from './http.mjs'

const PORT = Number(process.env.PORT || 8787)
const DATA_DIR = process.env.DATA_DIR || '/data'
const BLOB_MAX_MB = Number(process.env.BLOB_MAX_MB || 50)
const PUBLIC_DIR = process.env.PUBLIC_DIR || fileURLToPath(new URL('../public/', import.meta.url))

const cfg = {
  dataDir: DATA_DIR,
  blobDir: join(DATA_DIR, 'blobs'),
  blobMaxMb: BLOB_MAX_MB,
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(PUBLIC_DIR, rel)
  try {
    const info = await stat(file)
    if (info.isDirectory()) file = join(file, 'index.html')
  } catch {
    // SPA 回退
    try {
      file = join(PUBLIC_DIR, 'index.html')
      await stat(file)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
  }
  const info = await stat(file).catch(() => null)
  if (!info) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  })
  createReadStream(file).pipe(res)
}

async function main() {
  await mkdir(cfg.dataDir, { recursive: true })
  await mkdir(cfg.blobDir, { recursive: true })

  const db = openDb(join(cfg.dataDir, 'relay.db'))
  const hub = createHub({ db, cfg })
  const api = createHttp({ db, hub, cfg })

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (pathname.startsWith('/api/') || pathname === '/healthz') {
      return api(req, res)
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname)
    res.writeHead(405)
    res.end()
  })

  hub.attach(server)

  server.listen(PORT, () => {
    console.log(`[relay] listening on :${PORT} data=${DATA_DIR} blobMax=${BLOB_MAX_MB}MB`)
  })

  const shutdown = (sig) => {
    console.log(`[relay] ${sig}, shutting down`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('[relay] fatal', err)
  process.exit(1)
})
