// Exports the content behind external links (Google Docs/Sheets/Slides, Drive files and folders) into
// the bucket under _links/, so the archive survives losing Nexus/Google access. Works only for links
// shared as "anyone with the link"; anything that answers with a login page is marked needs_login.
// Gamma decks block scripted access and are captured via the browser (see reports).
// Usage: node scripts/export-links.js [--retry-failed]
const { q, pool } = require('./lib/db');
const { putObject } = require('./lib/s3');

const PROFILE = 'nupur';
const MAX_BYTES = 300 * 1024 * 1024;
const safe = (s) => String(s).replace(/[\\/:*?"<>|#%]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 150);

function exportUrl(provider, id) {
  return {
    gdoc: `https://docs.google.com/document/d/${id}/export?format=pdf`,
    gsheet: `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
    gslide: `https://docs.google.com/presentation/d/${id}/export/pdf`,
    gdrive_file: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
  }[provider];
}
const EXT = { gdoc: '.pdf', gsheet: '.xlsx', gslide: '.pdf' };

async function download(url) {
  const r = await fetch(url, { redirect: 'follow' });
  const type = (r.headers.get('content-type') || '').split(';')[0];
  if (!r.ok) return { err: `http ${r.status}`, status: r.status === 401 || r.status === 403 ? 'needs_login' : 'failed' };
  if (type === 'text/html') {
    const host = new URL(r.url).host;
    return { err: `got an HTML page from ${host} (not shared publicly, or deleted)`, status: /accounts\.google/.test(host) ? 'needs_login' : 'failed' };
  }
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return { err: `too large (${len} bytes)`, status: 'failed' };
  const buf = Buffer.from(await r.arrayBuffer());
  const cd = r.headers.get('content-disposition') || '';
  const fname = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1] || '') || (cd.match(/filename="([^"]+)"/i) || [])[1] || null;
  return { buf, type: type || 'application/octet-stream', fname };
}

async function exportOne(l) {
  if (l.provider === 'gdrive_folder') {
    const r = await fetch(`https://drive.google.com/embeddedfolderview?id=${l.resource_id}`);
    const html = await r.text();
    if (!r.ok || /accounts\.google\.com/.test(r.url)) return { status: 'needs_login', error: `folder listing http ${r.status}` };
    const entries = [...html.matchAll(/<a href="https:\/\/drive\.google\.com\/(file|drive\/folders)\/(?:d\/)?([\w-]{20,})[^"]*"[\s\S]*?flip-entry-title">([^<]+)/g)]
      .map((m) => ({ kind: m[1] === 'file' ? 'file' : 'folder', id: m[2], name: m[3].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }));
    const base = `_links/gdrive_folder/${l.resource_id}`;
    const index = [];
    let bytes = 0;
    for (const e of entries) {
      if (e.kind === 'folder') { index.push({ ...e, status: 'subfolder not exported' }); continue; }
      const d = await download(exportUrl('gdrive_file', e.id));
      if (d.err) { index.push({ ...e, status: d.status, error: d.err }); continue; }
      const key = `${base}/${safe(d.fname || e.name)}`;
      await putObject(key, d.buf, d.type);
      bytes += d.buf.length;
      index.push({ ...e, status: 'exported', key, bytes: d.buf.length });
    }
    await putObject(`${base}/_index.json`, Buffer.from(JSON.stringify({ url: l.url, exported_at: new Date().toISOString(), entries: index }, null, 1)), 'application/json');
    const bad = index.filter((x) => x.status !== 'exported');
    return { status: entries.length === 0 ? 'failed' : bad.length ? 'partial' : 'exported', key: `${base}/`, bytes, error: entries.length === 0 ? 'empty or unreadable folder' : bad.length ? `${bad.length}/${index.length} entries not exported` : null };
  }
  const url = exportUrl(l.provider, l.resource_id);
  if (!url || !l.resource_id) return { status: 'unsupported', error: 'no export route for this link' };
  const d = await download(url);
  if (d.err) return { status: d.status, error: d.err };
  const key = l.provider === 'gdrive_file'
    ? `_links/gdrive_file/${l.resource_id}/${safe(d.fname || l.resource_id)}`
    : `_links/${l.provider}/${l.resource_id}${EXT[l.provider]}`;
  await putObject(key, d.buf, d.type);
  return { status: 'exported', key, bytes: d.buf.length };
}

(async () => {
  const retry = process.argv.includes('--retry-failed');
  const statuses = retry ? ['pending', 'failed', 'partial'] : ['pending'];
  const rows = (await q(
    `select id, url, provider, resource_id from link_targets
     where profile_id=$1 and export_status = any($2) and provider in ('gdoc','gsheet','gslide','gdrive_file','gdrive_folder')
     order by id`, [PROFILE, statuses])).rows;
  // Several URLs can point at the same resource (e.g. ?usp=sharing variants): export once, reuse.
  const done = new Map();
  const tally = {};
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const l = rows[i++];
      const rk = l.provider + ':' + l.resource_id;
      let res;
      try {
        if (done.has(rk)) res = await done.get(rk);
        else { const p = exportOne(l); done.set(rk, p); res = await p; }
      } catch (e) { res = { status: 'failed', error: String(e.message || e).slice(0, 300) }; }
      await q(`update link_targets set export_status=$2, export_key=$3, export_bytes=$4, error=$5,
               exported_at=case when $2 in ('exported','partial') then now() else exported_at end where id=$1`,
        [l.id, res.status, res.key || null, res.bytes || null, res.error || null]);
      tally[res.status] = (tally[res.status] || 0) + 1;
      process.stdout.write(`\r${i}/${rows.length} ${JSON.stringify(tally)}   `);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log('\n' + JSON.stringify(tally));
  await pool.end();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
