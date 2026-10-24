// Checks a typed password against APP_PASSWORD_HASH in .env.local (input hidden, nothing stored or printed).
// Usage: node scripts/check-password.js
require('./lib/env');
const crypto = require('crypto');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const prompt = 'Password to check: ';
rl._writeToOutput = (s) => rl.output.write(s.includes(prompt) ? s : s.replace(/[^\r\n]/g, '*'));
rl.question(prompt, (pw) => {
  rl.close();
  const [alg, salt, hash] = (process.env.APP_PASSWORD_HASH || '').split(':');
  if (alg !== 'scrypt' || !salt || !hash) { console.log('\nNo valid APP_PASSWORD_HASH in .env.local.'); process.exit(1); }
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  const ok = crypto.timingSafeEqual(got, want);
  console.log(ok ? '\nMATCH: this is the password the app expects.' : `\nNO MATCH (you typed ${pw.length} characters).`);
  process.exit(ok ? 0 : 2);
});
