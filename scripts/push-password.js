// After `npm run set-password`: copy the new APP_PASSWORD_HASH and SESSION_SECRET from .env.local
// to Vercel (values are piped, never printed) and redeploy production so they take effect.
// Usage: npm run push-password
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
  .split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const vercel = (args, input) => spawnSync('npx.cmd', ['--yes', 'vercel@65.2.0', ...args], { input, encoding: 'utf8', shell: true });

for (const name of ['APP_PASSWORD_HASH', 'SESSION_SECRET']) {
  if (!env[name]) { console.error(`${name} missing in .env.local: run npm run set-password first.`); process.exit(1); }
  vercel(['env', 'rm', name, 'production', '--yes']);
  const r = vercel(['env', 'add', name, 'production'], env[name]);
  console.log(`${name}: ${r.status === 0 ? 'uploaded' : 'FAILED'}`);
  if (r.status !== 0) process.exit(1);
}
console.log('Redeploying production (about a minute)...');
const r = spawnSync('npx.cmd', ['--yes', 'vercel@65.2.0', 'deploy', '--prod', '--yes'], { stdio: 'inherit', shell: true });
console.log(r.status === 0 ? 'Done. Log in with the new password.' : 'Redeploy failed; see the output above.');
process.exit(r.status || 0);
