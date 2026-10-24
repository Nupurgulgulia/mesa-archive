// OCR for image-only documents (doc_extractions.status = 'empty'): scanned PDFs are rendered page by
// page; image-only PPTX decks are OCR'd from their embedded slide images. Text goes into doc_chunks
// (is_ocr = true) and a sidecar copy is saved to the bucket at _ocr/<original key>.txt.
// Reads from the local archive when present (faster), else from the bucket.
// Usage: node scripts/ocr-docs.js [--key <storage key>] [--force]
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

// Scans are often sideways. If a page reads poorly, retry rotated and keep the most confident result.
async function rotate(png, deg) {
  const img = await loadImage(png);
  const swap = deg % 180 !== 0;
  const c = createCanvas(swap ? img.height : img.width, swap ? img.width : img.height);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return c.toBuffer('image/png');
}
async function recognizeBest(worker, png) {
  let best = (await worker.recognize(png)).data;
  best.rotation = 0;
  if (best.confidence >= 60) return best;
  for (const deg of [90, 270, 180]) {
    const d = (await worker.recognize(await rotate(png, deg))).data;
    if (d.confidence > best.confidence) { best = d; best.rotation = deg; }
    if (best.confidence >= 75) break;
  }
  return best;
}
const { createWorker } = require('tesseract.js');
const { pool, q } = require('./lib/db');
const { getObject, putObject } = require('./lib/s3');
const { retry } = require('./lib/retry');
const crypto = require('crypto');

// Per-page OCR cache on disk, so a crash or network drop never loses finished pages.
const CACHE = path.join(__dirname, '..', '.cache', 'ocr');
const cacheDir = (key) => path.join(CACHE, crypto.createHash('md5').update(key).digest('hex'));

const PROFILE = 'nupur';
const ROOT = process.env.ARCHIVE_DIR || 'C:\\Users\\NUPUR\\Documents\\MESA-Archive';
const SCALE = 2.2; // ~160 dpi for A4-ish pages: good accuracy/speed balance for Tesseract
const args = process.argv.slice(2);
const onlyKey = args.includes('--key') ? args[args.indexOf('--key') + 1] : null;
const force = args.includes('--force');
const winSafe = (seg) => seg.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));

class CanvasFactory {
  create(w, h) { const canvas = createCanvas(Math.ceil(w), Math.ceil(h)); return { canvas, context: canvas.getContext('2d') }; }
  reset(cc, w, h) { cc.canvas.width = Math.ceil(w); cc.canvas.height = Math.ceil(h); }
  destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; }
}

async function load(key) {
  const lp = path.join(ROOT, ...key.split('/').map(winSafe));
  return fs.existsSync(lp) ? fs.readFileSync(lp) : retry(() => getObject(key), { label: 'download ' + key });
}

async function* pdfImages(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0, CanvasFactory, canvasFactory: new CanvasFactory() }).promise;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: SCALE });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvasFactory: new CanvasFactory() }).promise;
    yield { page: i, image: canvas.toBuffer('image/png'), of: doc.numPages };
    page.cleanup();
  }
  await doc.destroy();
}
async function* pptxImages(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  for (const s of slides) {
    const num = +s.match(/slide(\d+)/)[1];
    const rels = await zip.file(`ppt/slides/_rels/slide${num}.xml.rels`)?.async('string') || '';
    const media = [...rels.matchAll(/Target="\.\.\/media\/([^"]+\.(png|jpe?g))"/gi)].map((m) => `ppt/media/${m[1]}`);
    for (const m of media) if (zip.file(m)) yield { page: num, image: await zip.file(m).async('nodebuffer'), of: slides.length };
  }
}

function split(text, max = 1500) {
  const out = []; let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if ((cur + '\n\n' + para).length > max && cur) { out.push(cur); cur = para; } else cur = cur ? cur + '\n\n' + para : para;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 20);
}

(async () => {
  const targets = (await q(
    `select storage_key from doc_extractions
     where profile_id=$1 and ((status='empty' and method<>'ocr') or ($2 and method='ocr')) and storage_key ~* '\\.(pdf|pptx)$' ${onlyKey ? 'and storage_key=$3' : ''}`,
    onlyKey ? [PROFILE, force, onlyKey] : [PROFILE, force])).rows;
  // Attach course + source: a course file, or else the link export that contains this key
  for (const t of targets) {
    const f = (await q('select id, course_id, label from files where profile_id=$1 and storage_key=$2', [PROFILE, t.storage_key])).rows[0];
    if (f) { Object.assign(t, { course_id: f.course_id, file_id: f.id, source_kind: 'file', title: f.label }); continue; }
    const l = (await q(`select l.id, f.course_id, f.label from link_targets l join file_links fl on fl.link_id=l.id join files f on f.id=fl.file_id
                        where $1 like l.export_key || '%' order by length(l.export_key) desc limit 1`, [t.storage_key])).rows[0];
    if (l) Object.assign(t, { course_id: l.course_id, link_id: l.id, source_kind: 'link_export', title: l.label });
  }
  console.log(`${targets.length} documents to OCR`);

  // Neon closes idle connections during long OCR jobs: never hold a client while OCR runs,
  // and don't let a dropped idle client crash the process.
  pool.on('error', (e) => console.error('(pool) idle client dropped:', e.message));
  const worker = await createWorker('eng');
  try {
    for (const t of targets) {
      const started = Date.now();
      const buf = await load(t.storage_key);
      const gen = /\.pdf$/i.test(t.storage_key) ? pdfImages(buf) : pptxImages(buf);
      const pages = [];
      const conf = [];
      const dir = cacheDir(t.storage_key);
      if (force) fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      let n = 0;
      for await (const img of gen) {
        const cf = path.join(dir, `${String(n++).padStart(4, '0')}.json`);
        let data;
        if (fs.existsSync(cf)) data = JSON.parse(fs.readFileSync(cf, 'utf8'));
        else {
          const d = await recognizeBest(worker, img.image);
          data = { text: d.text, confidence: d.confidence, rotation: d.rotation };
          fs.writeFileSync(cf, JSON.stringify(data));
        }
        const text = data.text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        if (text) { pages.push({ page: img.page, text }); conf.push(data.confidence); }
        process.stdout.write(`\r${t.storage_key.split('/').pop().slice(0, 50)}: page ${img.page}/${img.of}   `);
      }
      const meanConf = conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null;
      // sidecar text in the bucket (permanent, human-readable)
      const sidecar = pages.map((p) => `=== page ${p.page} ===\n${p.text}`).join('\n\n');
      await retry(() => putObject(`_ocr/${t.storage_key}.txt`, Buffer.from(`OCR (Tesseract, mean confidence ${meanConf?.toFixed(1)}) of ${t.storage_key}\n\n${sidecar}`), 'text/plain; charset=utf-8'), { label: 'upload OCR text' });
      await retry(async () => {
      const c = await pool.connect();
      await c.query('begin');
      try {
        await c.query('delete from doc_chunks where profile_id=$1 and storage_key=$2', [PROFILE, t.storage_key]);
        let seq = 0;
        for (const p of pages) for (const piece of split(p.text)) {
          await c.query(`insert into doc_chunks (profile_id, course_id, file_id, link_id, storage_key, source_kind, page, seq, heading, content, is_ocr)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
            [PROFILE, t.course_id, t.file_id || null, t.link_id || null, t.storage_key, t.source_kind || 'file', p.page, seq++, t.title, piece]);
        }
        await c.query(`update doc_extractions set status=$3, method='ocr', ocr_confidence=$4, pages=$5, chars=$6, error=null, extracted_at=now()
                       where profile_id=$1 and storage_key=$2`,
          [PROFILE, t.storage_key, seq ? 'ok' : 'empty', meanConf, pages.length, pages.reduce((a, p) => a + p.text.length, 0)]);
        await c.query('commit');
        console.log(`\n${t.storage_key}: ${pages.length} pages, ${seq} chunks, confidence ${meanConf?.toFixed(1)}, ${((Date.now() - started) / 1000).toFixed(0)}s`);
      } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
      }, { label: 'save chunks' });
    }
  } finally { await worker.terminate(); await pool.end(); }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
