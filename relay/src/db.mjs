// SQLite（node:sqlite，WAL）+ 表结构
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { now, uid } from './util.mjs'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  handle        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    INTEGER NOT NULL,
  disabled_at   INTEGER
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  used       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL,
  platform     TEXT,
  pubkey       TEXT,
  token_hash   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);

CREATE TABLE IF NOT EXISTS pairings (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  desktop_id TEXT NOT NULL,
  mobile_id  TEXT,
  state      TEXT NOT NULL DEFAULT 'open',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS pairs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  a          TEXT NOT NULL,
  b          TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pairs_ab ON pairs(a, b);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  from_device  TEXT NOT NULL,
  to_device    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'dsh',
  body         TEXT NOT NULL,
  blobs        TEXT,
  delivered    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_device, delivered);

CREATE TABLE IF NOT EXISTS seqs (
  user_id  TEXT NOT NULL,
  scope    TEXT NOT NULL,
  next_seq INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope)
);

CREATE TABLE IF NOT EXISTS blobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT,
  name        TEXT,
  storage_key TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  device_id  TEXT,
  action     TEXT,
  target     TEXT,
  result     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit(user_id, created_at);
`

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL;')
  db.exec('PRAGMA synchronous=NORMAL;')
  db.exec('PRAGMA busy_timeout=5000;')
  db.exec(SCHEMA)
  return db
}

export function audit(db, { userId = null, deviceId = null, action, target = null, result = 'ok' }) {
  db.prepare(
    'INSERT INTO audit(user_id, device_id, action, target, result, created_at) VALUES (?,?,?,?,?,?)',
  ).run(userId, deviceId, action, target, result, now())
}

// 同一用户内单调递增的 seq
export function nextSeq(db, userId, scope = 'msg') {
  const row = db.prepare('SELECT next_seq FROM seqs WHERE user_id=? AND scope=?').get(userId, scope)
  const seq = row ? row.next_seq : 1
  db.prepare(
    `INSERT INTO seqs(user_id, scope, next_seq) VALUES (?,?,?)
     ON CONFLICT(user_id, scope) DO UPDATE SET next_seq=excluded.next_seq`,
  ).run(userId, scope, seq + 1)
  return seq
}

export function arePaired(db, a, b) {
  return !!db
    .prepare(
      `SELECT 1 AS ok FROM pairs
       WHERE revoked_at IS NULL AND ((a=? AND b=?) OR (a=? AND b=?)) LIMIT 1`,
    )
    .get(a, b, b, a)
}

export function createPair(db, userId, a, b) {
  const existing = db
    .prepare('SELECT * FROM pairs WHERE ((a=? AND b=?) OR (a=? AND b=?)) LIMIT 1')
    .get(a, b, b, a)
  if (existing && !existing.revoked_at) return existing
  if (existing) {
    db.prepare('UPDATE pairs SET revoked_at=NULL, created_at=? WHERE id=?').run(now(), existing.id)
    return { ...existing, revoked_at: null }
  }
  const row = { id: uid('pair'), user_id: userId, a, b, created_at: now() }
  db.prepare('INSERT INTO pairs(id, user_id, a, b, created_at) VALUES (?,?,?,?,?)').run(
    row.id, row.user_id, row.a, row.b, row.created_at,
  )
  return row
}
