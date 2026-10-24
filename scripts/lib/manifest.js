// Shared logic for Nexus manifests (from scripts/nexus-capture.js): bucket key naming for notes,
// and matching file items to bucket objects.
const fs = require('fs');
const path = require('path');

const slug = (s) => String(s).replace(/[\\/:*?"<>|#%]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
const UNIT = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toSize = (num, unit) => ({ bytes: +num * UNIT[unit], tol: 0.051 * UNIT[unit] + 1024 });
const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'mesa_data.json'), 'utf8'));

function noteKey(it) {
  return `${it.path}/${it.dup_index ? it.dup_index + '_' : ''}${slug(it.label)}.note.json`;
}

function noteBody(it, courseId) {
  const text = it.kind === 'link' ? `${it.label}\n\n${it.links.join('\n')}` : it.text;
  return JSON.stringify({ label: it.label, kind: it.kind, text, links: it.links, url: `https://students.mesaschool.co.in/student/lms/courses/${courseId}`, source: 'nexus-capture' });
}

// The recorded "card" text can span sibling items, e.g.
// "PPT Session 1 PPTX · 19.2 MB PPT Session 2 PPTX · 7.1 MB ...". Take the size that follows this
// item's own label (the dup_index-th occurrence). Fall back to the listed size in mesa_data.json.
function itemSize(it, courseId) {
  const re = new RegExp(esc(it.label) + '\\s+[A-Z]{2,5}\\s*·\\s*(\\d+(?:\\.\\d+)?)\\s*(KB|MB|GB|B)\\b', 'g');
  const hits = [...String(it.card || '').matchAll(re)];
  const h = hits[it.dup_index || 0];
  if (h) return toSize(h[1], h[2]);
  const c = dataset.courses.find((x) => x.id === courseId);
  const folder = it.path.split('/').pop();
  const listed = (c?.folders || []).filter((f) => slug(f.name) === folder).flatMap((f) => f.files).filter((f) => f.name === it.label && f.size);
  const l = listed[it.dup_index || 0] || listed[0];
  const m = l && l.size.match(/(\d+(?:\.\d+)?)\s*(KB|MB|GB|B)/);
  return m ? toSize(m[1], m[2]) : null;
}

// Returns { keyOf: Map(item -> storage key), missing: [items], used: Set(keys) }.
// Notes/links map to their note key. Files map to the bucket object in the same folder whose size is
// within Nexus's display rounding, preferring matching extension and filename overlap.
function matchManifest(manifest, objects) {
  const keyOf = new Map();
  const used = new Set();
  const missing = [];
  const folderObjs = {};
  for (const o of objects) {
    if (o.key.endsWith('.note.json')) continue;
    const f = o.key.split('/').slice(0, -1).join('/');
    (folderObjs[f] = folderObjs[f] || []).push(o);
  }
  for (const course of manifest) {
    for (const it of course.items) {
      if (it.kind === 'note' || it.kind === 'link') { const k = noteKey(it); keyOf.set(it, k); used.add(k); }
    }
    for (const it of course.items.filter((i) => i.kind === 'file')) {
      const want = itemSize(it, course.id);
      const words = it.label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
      let best = null;
      for (const o of (folderObjs[it.path] || []).filter((o) => !used.has(o.key))) {
        const d = want ? Math.abs(o.size - want.bytes) : 0;
        if (want && d > want.tol) continue;
        const extOk = !it.ext || o.key.toLowerCase().endsWith('.' + it.ext.toLowerCase());
        const base = o.key.split('/').pop().toLowerCase();
        const nameHits = words.filter((w) => base.includes(w)).length;
        if (!want && nameHits === 0) continue; // no size to go on: require some name overlap
        const score = d + (extOk ? 0 : 1e12) - nameHits; // name overlap breaks ties between equal sizes
        if (!best || score < best.score) best = { o, score };
      }
      if (best && best.score < 1e12) { used.add(best.o.key); keyOf.set(it, best.o.key); }
      else missing.push({ course, it });
    }
  }
  return { keyOf, used, missing };
}

module.exports = { slug, noteKey, noteBody, itemSize, matchManifest, dataset };
