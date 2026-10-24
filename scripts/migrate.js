// Applies db/migrations/*.sql in name order, once each, inside a transaction per file.
const fs = require('fs');
const path = require('path');
const { pool } = require('./lib/db');

(async () => {
  const c = await pool.connect();
  try {
    await c.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())');
    const done = new Set((await c.query('select name from schema_migrations')).rows.map((r) => r.name));
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) { console.log('skip', f); continue; }
      await c.query('begin');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('insert into schema_migrations(name) values ($1)', [f]);
        await c.query('commit');
        console.log('applied', f);
      } catch (e) { await c.query('rollback'); throw new Error(f + ': ' + e.message); }
    }
  } finally { c.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
