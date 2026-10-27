// 通用工具：ID、密码哈希、token、配对码
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto'

export const now = () => Date.now()
export const uid = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`
export const sha256 = (s) => createHash('sha256').update(s).digest('hex')
export const token = () => randomBytes(32).toString('base64url')

export function hashPassword(pw) {
  const salt = randomBytes(16)
  const key = scryptSync(String(pw), salt, 64)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export function verifyPassword(pw, stored) {
  try {
    const [alg, saltB64, keyB64] = String(stored).split('$')
    if (alg !== 'scrypt') return false
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(keyB64, 'base64')
    const actual = scryptSync(String(pw), salt, expected.length)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function pairCode(len = 8) {
  let s = ''
  for (const b of randomBytes(len)) s += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return s
}

export function readJson(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'body/too-large' }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 'body/invalid-json' }))
      }
    })
    req.on('error', reject)
  })
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
