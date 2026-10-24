// Smoke-test a running copy of the app (local or deployed) without knowing the password:
// signs a session cookie with SESSION_SECRET from .env.local, checks that pages and files load
// signed in and are refused signed out. Creates one exam session to prove writes work, then
// removes it with the owner DB account.  Usage: node scripts/smoke-test.js <baseUrl>
require('./lib/env');
const crypto = require('crypto');
const db = require('./lib/db');

const base = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const payload = `v1.${Math.floor(Date.now() / 1000) + 600}`;
const cookie = `mesa_session=${payload}.${b64url(crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest())}`;

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`); };
const get = (path, auth, init = {}) => fetch(base + path, { redirect: 'manual', ...init, headers: { ...(auth ? { cookie } : {}), ...(init.headers || {}) } });

(async () => {
  let r = await get('/', false);
  check('signed out: home redirects to login', [302, 307, 308].includes(r.status) && /\/login/.test(r.headers.get('location') || ''), r.status);
  r = await get('/api/exam', false, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  check('signed out: exam API refused', r.status === 401, r.status);
  const fd = new FormData(); fd.set('password', 'definitely-wrong-' + crypto.randomBytes(4).toString('hex'));
  r = await get('/api/login', false, { method: 'POST', body: fd });
  check('wrong password refused', /e=1/.test(r.headers.get('location') || '') && !/mesa_session=/.test(r.headers.get('set-cookie') || ''), r.status);

  for (const p of ['/', '/courses', '/search?q=pricing', '/timeline', '/recommendations', '/exam']) {
    r = await get(p, true);
    const html = await r.text();
    check(`signed in: ${p}`, r.status === 200 && !/Application error|Internal Server Error/.test(html), `${r.status}, ${html.length} bytes`);
  }

  const f = (await db.q("select storage_key, size_bytes from files where profile_id='nupur' and type='PDF' and size_bytes < 2000000 order by size_bytes desc limit 1")).rows[0];
  r = await get('/raw/' + f.storage_key.split('/').map(encodeURIComponent).join('/'), true, { redirect: 'follow' });
  const bytes = Buffer.from(await r.arrayBuffer()).length;
  check('signed in: file opens from storage', r.status === 200 && bytes === Number(f.size_bytes), `${r.status}, ${bytes}/${f.size_bytes} bytes`);

  r = await get('/api/exam', true, { method: 'POST', body: JSON.stringify({ action: 'session', mode: 'review', size: 3 }), headers: { 'content-type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  const id = j.id ?? j.sessionId ?? j.session?.id;
  check('signed in: exam session can be created (DB write)', r.status === 200 && !j.error, `${r.status} ${j.error || ''}`);
  if (id) await db.q("delete from exam_sessions where id=$1 and profile_id='nupur'", [id]);

  console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
