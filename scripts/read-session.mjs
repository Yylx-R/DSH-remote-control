// 读取 DSH 会话 .jsonl.zstd（多帧拼接）并导出为文本
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const src = process.argv[2]
const out = process.argv[3]
const buf = readFileSync(src)

const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
let i = 0
while (true) {
  const idx = buf.indexOf(magic, i)
  if (idx < 0) break
  starts.push(idx)
  i = idx + 4
}
starts.push(buf.length)

let text = ''
let ok = 0
let bad = 0
for (let k = 0; k < starts.length - 1; k++) {
  const frame = buf.subarray(starts[k], starts[k + 1])
  try {
    text += zstdDecompressSync(frame).toString('utf8')
    ok++
  } catch {
    bad++
  }
}
writeFileSync(out, text, 'utf8')
const lines = text.split('\n').filter(Boolean)
const types = {}
for (const l of lines) {
  try {
    const r = JSON.parse(l)
    types[r.type] = (types[r.type] || 0) + 1
  } catch {}
}
console.log(JSON.stringify({ frames: starts.length - 1, ok, bad, bytes: text.length, lines: lines.length, types }))
