// Mirrors the whole mesa-files bucket to a local folder (same key paths) and verifies every file.
//   - MD5 is checked against the bucket ETag (single-part uploads; multipart ETags contain '-')
//   - after writing, the file is read back from disk and its SHA-256 compared with the downloaded bytes
//   - writes _archive_index.json and SHA256SUMS.txt at the folder root; stores sha256 in files.sha256
// Incremental: files already present with the same size and recorded ETag are skipped.
// Usage: node scripts/mirror-local.js [targetDir]   (default C:\Users\NUPUR\Documents\MESA-Archive)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listObjects, getObject } = require('./lib/s3');
const { pool, q } = require('./lib/db');

const ROOT = process.argv[2] || process.env.ARCHIVE_DIR || 'C:\\Users\\NUPUR\\Documents\\MESA-Archive';
const INDEX = path.join(ROOT, '_archive_index.json');
const hash = (alg, buf) => crypto.createHash(alg).update(buf).digest('hex');

// Windows forbids <>:"|?* and trailing dots/spaces in path segments. Map them, and record the mapping.
const winSafe = (seg) => seg.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
const localPath = (key) => path.join(ROOT, ...key.split('/').map(winSafe));

(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  const prev = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')).objects : {};
  const objects = await listObjects('');
  const index = {};
  const tally = { downloaded: 0, skipped: 0, failed: 0, md5_checked: 0, md5_mismatch: 0, renamed_for_windows: 0 };
  const failures = [];
  let i = 0;
  let bytes = 0;

  async function worker() {
    while (i < objects.length) {
      const o = objects[i++];
      const lp = localPath(o.key);
      const rel = path.relative(ROOT, lp).split(path.sep).join('/');
      if (rel !== o.key) tally.renamed_for_windows++;
      const p = prev[o.key];
      if (p && p.etag === o.etag && p.verified && fs.existsSync(lp) && fs.statSync(lp).size === o.size) {
        index[o.key] = p; tally.skipped++; continue;
      }
      try {
        const buf = await getObject(o.key);
        if (buf.length !== o.size) throw new Error(`size ${buf.length} != listed ${o.size}`);
        const md5 = hash('md5', buf);
        const multipart = o.etag.includes('-');
        if (!multipart) { tally.md5_checked++; if (md5 !== o.etag) { tally.md5_mismatch++; throw new Error(`md5 ${md5} != etag ${o.etag}`); } }
        const sha256 = hash('sha256', buf);
        fs.mkdirSync(path.dirname(lp), { recursive: true });
        fs.writeFileSync(lp, buf);
        const back = hash('sha256', fs.readFileSync(lp));
        if (back !== sha256) throw new Error('read-back sha256 mismatch');
        index[o.key] = { path: rel, size: o.size, etag: o.etag, md5, sha256, md5_vs_etag: multipart ? 'multipart (size+sha256 only)' : 'ok', verified: true, at: new Date().toISOString() };
        tally.downloaded++; bytes += o.size;
      } catch (e) {
        tally.failed++; failures.push({ key: o.key, error: String(e.message || e) });
        index[o.key] = { path: rel, size: o.size, etag: o.etag, verified: false, error: String(e.message || e) };
      }
      process.stdout.write(`\r${i}/${objects.length} ${JSON.stringify(tally)}   `);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);

  // Index + SHA256SUMS (sha256sum -c compatible, relative paths)
  fs.writeFileSync(INDEX, JSON.stringify({ bucket: 'mesa-files', generated: new Date().toISOString(), count: objects.length, objects: index }, null, 1));
  fs.writeFileSync(path.join(ROOT, 'SHA256SUMS.txt'),
    Object.values(index).filter((x) => x.sha256).map((x) => `${x.sha256}  ${x.path}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join('\n') + '\n');

  // Independent check: walk the folder and compare with the bucket listing
  const onDisk = new Set();
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else onDisk.add(path.relative(ROOT, p).split(path.sep).join('/')); } })(ROOT);
  onDisk.delete('_archive_index.json'); onDisk.delete('SHA256SUMS.txt'); onDisk.delete('README.txt');
  const expected = new Set(Object.values(index).map((x) => x.path));
  const missingLocal = [...expected].filter((p) => !onDisk.has(p));
  const extraLocal = [...onDisk].filter((p) => !expected.has(p));

  // Record sha256 for course files in the DB
  let dbUpdated = 0;
  for (const [key, x] of Object.entries(index)) {
    if (!x.sha256) continue;
    const r = await q('update files set sha256=$2 where storage_key=$1 and (sha256 is distinct from $2)', [key, x.sha256]);
    dbUpdated += r.rowCount;
  }

  console.log('\n' + JSON.stringify({ root: ROOT, bucket_objects: objects.length, files_on_disk: onDisk.size, missing_locally: missingLocal, extra_locally: extraLocal, ...tally, downloaded_mb: +(bytes / 1048576).toFixed(1), db_sha256_updated: dbUpdated, failures }, null, 1));
  await pool.end();
  if (tally.failed || missingLocal.length) process.exit(2);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
