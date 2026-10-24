// Loads .env.local (repo root) into process.env without overriding existing values.
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', '..', '.env.local');
if (fs.existsSync(p)) {
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
