import fs from 'fs';
import path from 'path';

// Next.js loads .env.local itself. Scripts run with tsx do not, so load it here (never overriding).
let loaded = false;
export function loadEnv() {
  if (loaded || process.env.NEXT_RUNTIME) return;
  loaded = true;
  const p = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
