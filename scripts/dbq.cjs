const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync('/data/relay.db')
for (const r of db.prepare('select handle, substr(password_hash,1,20) h, created_at from users').all()) console.log(JSON.stringify(r))
for (const t of ['devices','pairings','messages','blobs','audit','invites']) {
  try { console.log(t, db.prepare(`select count(*) c from ${t}`).get().c) } catch (e) { console.log(t, 'n/a') }
}
