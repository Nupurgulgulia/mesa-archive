// Extracts text from archived documents into doc_chunks (Postgres full-text search).
// Sources: course files (files.kind='file'), notes (files.kind='note', text already in DB),
//          exported link targets under _links/ (PDF/XLSX/DOCX/PPTX/TXT/RTF/MD).
// Re-runs skip anything whose etag has not changed since the last successful extraction.
// Usage: node scripts/extract-text.js [--force]
const JSZip = require('jszip');
const mammoth = require('mammoth');
const { pool, q } = require('./lib/db');
const { getObject, listObjects } = require('./lib/s3');

const PROFILE = 'nupur';
const CHUNK = 1500; // characters per chunk (split on paragraph/sentence boundaries)
const force = process.argv.includes('--force');

const clean = (s) => String(s || '').replace(/\u0000/g, '').replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*\n\s*/g, '\n\n').trim();
const xmlText = (xml) => xml.replace(/<a:br\/>/g, '\n').replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

function split(text, max = CHUNK) {
  const out = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    const pieces = para.length > max ? para.match(new RegExp(`[\\s\\S]{1,${max}}(?=\\s|$)`, 'g')) || [para] : [para];
    for (const p of pieces) {
      if ((cur + '\n\n' + p).length > max && cur) { out.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 20);
}

let pdfjs;
async function pdfPages(buf) {
  pdfjs = pdfjs || (await import('pdfjs-dist/legacy/build/pdf.mjs'));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    let s = '';
    for (const it of tc.items) s += it.str + (it.hasEOL ? '\n' : ' ');
    pages.push({ page: i, text: clean(s) });
  }
  await doc.destroy();
  return pages;
}
async function pptxSlides(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  const out = [];
  for (const n of names) {
    const num = +n.match(/slide(\d+)/)[1];
    let t = xmlText(await zip.file(n).async('string'));
    const notes = zip.file(`ppt/notesSlides/notesSlide${num}.xml`);
    if (notes) { const nt = clean(xmlText(await notes.async('string'))); if (nt.length > 10) t += '\n\nSpeaker notes: ' + nt; }
    out.push({ page: num, text: clean(t) });
  }
  return out;
}
async function xlsxSheets(buf) {
  const zip = await JSZip.loadAsync(buf);
  const ss = zip.file('xl/sharedStrings.xml');
  const shared = ss ? [...(await ss.async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1])) : [];
  const wb = await zip.file('xl/workbook.xml')?.async('string') || '';
  const sheetNames = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => xmlText(m[1]));
  const files = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  const out = [];
  for (const [i, n] of files.entries()) {
    const xml = await zip.file(n).async('string');
    const rows = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]; const inner = c[2] || '';
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const is = (inner.match(/<is>([\s\S]*?)<\/is>/) || [])[1];
        let val = /t="s"/.test(attrs) && v != null ? shared[+v] : is ? xmlText(is) : v != null ? xmlText(v) : '';
        if (val !== '' && val != null) cells.push(String(val).trim());
      }
      if (cells.length) rows.push(cells.join(' | '));
      if (rows.length >= 400) { rows.push('[sheet truncated at 400 rows]'); break; }
    }
    out.push({ page: i + 1, heading: sheetNames[i] || `Sheet ${i + 1}`, text: rows.join('\n') });
  }
  return out;
}
function rtfText(s) {
  return clean(s.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^{}]*\}/g, '').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, ''));
}

async function extract(key, buf) {
  const ext = (key.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (ext === 'pdf') return pdfPages(buf);
  if (ext === 'pptx') return pptxSlides(buf);
  if (ext === 'xlsx') return xlsxSheets(buf);
  if (ext === 'docx') return [{ page: null, text: clean((await mammoth.extractRawText({ buffer: buf })).value) }];
  if (ext === 'rtf') return [{ page: null, text: rtfText(buf.toString('latin1')) }];
  if (['txt', 'md', 'csv'].includes(ext)) return [{ page: null, text: clean(buf.toString('utf8')) }];
  if (ext === 'html' || ext === 'htm') {
    const h = buf.toString('utf8').replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>|<br\s*\/?>/gi, '\n\n').replace(/<[^>]+>/g, ' ');
    return [{ page: null, text: clean(xmlText(h).replace(/&nbsp;/g, ' ')) }];
  }
  return null; // images, video, html, json, keynote: no text extraction
}

async function store(c, job, parts) {
  await c.query('begin');
  try {
    await c.query('delete from doc_chunks where profile_id=$1 and storage_key=$2', [PROFILE, job.key]);
    let seq = 0;
    let chars = 0;
    for (const p of parts) {
      for (const piece of split(p.text)) {
        await c.query(
          `insert into doc_chunks (profile_id, course_id, file_id, link_id, storage_key, source_kind, page, seq, heading, content)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [PROFILE, job.course_id, job.file_id || null, job.link_id || null, job.key, job.source_kind, p.page ?? null, seq++, p.heading || job.title, piece]);
        chars += piece.length;
      }
    }
    await c.query(
      `insert into doc_extractions (profile_id, storage_key, etag, status, pages, chars, error, extracted_at) values ($1,$2,$3,$4,$5,$6,null,now())
       on conflict (profile_id, storage_key) do update set etag=excluded.etag, status=excluded.status, pages=excluded.pages, chars=excluded.chars, error=null, extracted_at=now()`,
      [PROFILE, job.key, job.etag, seq ? 'ok' : 'empty', parts.length, chars]);
    await c.query('commit');
    return seq;
  } catch (e) { await c.query('rollback'); throw e; }
}
async function mark(job, status, error) {
  await q(`insert into doc_extractions (profile_id, storage_key, etag, status, error, extracted_at) values ($1,$2,$3,$4,$5,now())
           on conflict (profile_id, storage_key) do update set etag=excluded.etag, status=excluded.status, error=excluded.error, extracted_at=now()`,
    [PROFILE, job.key, job.etag, status, error]);
}

(async () => {
  const jobs = [];
  // course files + notes
  for (const f of (await q(`select id, course_id, kind, label, storage_key, etag, note_text from files where profile_id=$1 and kind in ('file','note')`, [PROFILE])).rows) {
    jobs.push({ key: f.storage_key, etag: f.etag, course_id: f.course_id, file_id: f.id, title: f.label, source_kind: f.kind, note_text: f.kind === 'note' ? f.note_text : null });
  }
  // exported link targets: one job per object (folders expand to their files)
  const linkObjs = await listObjects('_links/');
  const links = (await q(
    `select distinct on (l.export_key) l.id, l.export_key, l.provider, f.course_id, f.label
     from link_targets l join file_links fl on fl.link_id=l.id join files f on f.id=fl.file_id
     where l.profile_id=$1 and l.export_status in ('exported','partial') and l.export_key is not null order by l.export_key, l.id`, [PROFILE])).rows;
  for (const l of links) {
    const objs = l.export_key.endsWith('/') ? linkObjs.filter((o) => o.key.startsWith(l.export_key) && !o.key.endsWith('_index.json')) : linkObjs.filter((o) => o.key === l.export_key);
    for (const o of objs) jobs.push({ key: o.key, etag: o.etag, course_id: l.course_id, link_id: l.id, title: l.label, source_kind: 'link_export' });
  }

  const prev = new Map((await q('select storage_key, etag, status from doc_extractions where profile_id=$1', [PROFILE])).rows.map((r) => [r.storage_key, r]));
  const todo = jobs.filter((j) => force || !prev.get(j.key) || prev.get(j.key).etag !== j.etag || ['failed', 'unsupported'].includes(prev.get(j.key).status));
  console.log(`${jobs.length} documents, ${todo.length} to extract`);

  const tally = {};
  const c = await pool.connect();
  try {
    for (const [i, job] of todo.entries()) {
      let status;
      try {
        let parts;
        if (job.source_kind === 'note') parts = [{ page: null, text: clean(job.note_text) }];
        else {
          const ext = (job.key.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
          if (['png', 'jpg', 'jpeg', 'gif', 'mp4', 'mov', 'key', 'json'].includes(ext) || !ext) parts = null;
          else parts = await extract(job.key, await getObject(job.key));
        }
        if (!parts) { await mark(job, 'unsupported', 'no text layer for this file type'); status = 'unsupported'; }
        else { const n = await store(c, job, parts); status = n ? 'ok' : 'empty'; }
      } catch (e) { await mark(job, 'failed', String(e.message || e).slice(0, 300)); status = 'failed'; }
      tally[status] = (tally[status] || 0) + 1;
      process.stdout.write(`\r${i + 1}/${todo.length} ${JSON.stringify(tally)}   `);
    }
  } finally { c.release(); }
  console.log('\n' + JSON.stringify(tally));
  await pool.end();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
