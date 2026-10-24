// Sets the app's login password. Type it in this terminal (input is hidden); only a salted scrypt
// hash is stored, in .env.local (APP_PASSWORD_HASH). Also creates SESSION_SECRET if missing.
// Changing the password signs out every existing session (the secret is rotated).
// Usage: npm run set-password
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ENV = path.join(__dirname, '..', '.env.local');

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = function (s) { if (!rl.stdoutMuted || s.includes(prompt)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

function setVar(text, name, value) {
  const line = `${name}=${value}`;
  return new RegExp(`^${name}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${name}=.*$`, 'm'), line) : text.replace(/\s*$/, '\n') + line + '\n';
}

(async () => {
  const a = await ask('New app password (min 10 characters): ');
  if (a.length < 10) { console.error('Too short. Nothing changed.'); process.exit(1); }
  const b = await ask('Type it again: ');
  if (a !== b) { console.error('The two entries did not match. Nothing changed.'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(a, salt, 32, { N: 16384, r: 8, p: 1 });
  let env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  env = setVar(env, 'APP_PASSWORD_HASH', `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`);
  env = setVar(env, 'SESSION_SECRET', crypto.randomBytes(48).toString('base64url'));
  fs.writeFileSync(ENV, env);
  console.log('Password set. Restart the app if it is running; existing sessions are signed out.');
})();
