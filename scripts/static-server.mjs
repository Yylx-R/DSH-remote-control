import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

const ROOT = 'E:/插件设计'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

http.createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0])
  try {
    const buf = await readFile(join(ROOT, path))
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(8899, '127.0.0.1', () => console.log('serving on http://127.0.0.1:8899'))
