// Reconciles a Nexus manifest (from scripts/nexus-capture.js) against the mesa-files bucket.
//   - note/link items: (re)writes <path>/<n_><label>.note.json when missing or different
//   - file items: matched to bucket objects in the same folder by size (Nexus shows KiB/MiB, 1 decimal)
//   - reports file items with no matching object, and bucket objects matched by no Nexus item
// Usage: node scripts/apply-capture.js data/nexus_manifest_YYYY-MM-DD.json [--apply]
// Without --apply nothing is written. A JSON report goes to reports/.
const fs = require('fs');
const path = require('path');
const { listObjects, getObject, putObject } = require('./lib/s3');
const { noteBody, matchManifest } = require('./lib/manifest');

(async () => {
  const [file, flag] = process.argv.slice(2);
  const apply = flag === '--apply';
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const objects = await listObjects('');
  const byKey = new Map(objects.map((o) => [o.key, o]));
  const { keyOf, used, missing } = matchManifest(manifest, objects);
  const rep = { generated: new Date().toISOString(), apply, notes: { unchanged: 0, written: [], would_write: [] }, files: { matched: 0, missing: [] }, errors: [], unmatched_objects: [] };

  for (const course of manifest) {
    for (const it of course.items.filter((i) => i.kind === 'error')) rep.errors.push({ course: course.prefix, ...it });
    for (const it of course.items.filter((i) => i.kind === 'note' || i.kind === 'link')) {
      const key = keyOf.get(it);
      const body = noteBody(it, course.id);
      const want = JSON.parse(body);
      let same = false;
      if (byKey.has(key)) {
        try {
          const cur = JSON.parse((await getObject(key)).toString('utf8'));
          same = (cur.text || '').trim() === (want.text || '').trim()
            && JSON.stringify((cur.links || []).slice().sort()) === JSON.stringify(want.links.slice().sort());
        } catch { same = false; }
      }
      if (same) { rep.notes.unchanged++; continue; }
      if (apply) { await putObject(key, Buffer.from(body), 'application/json'); rep.notes.written.push(key); }
      else rep.notes.would_write.push({ key, existed: byKey.has(key) });
    }
    rep.files.matched += course.items.filter((i) => i.kind === 'file' && keyOf.has(i)).length;
  }
  for (const { it } of missing) rep.files.missing.push({ path: it.path, label: it.label, dup_index: it.dup_index, card: it.card, material: it.material, ext: it.ext });

  const prefixes = manifest.map((c) => c.prefix + '/');
  for (const o of objects) {
    if (used.has(o.key)) continue;
    if (!prefixes.some((p) => o.key.startsWith(p)) && !o.key.startsWith('_meta/')) continue;
    rep.unmatched_objects.push({ key: o.key, size: o.size, etag: o.etag });
  }

  const out = path.join(__dirname, '..', 'reports', `apply-capture-${apply ? 'applied' : 'dryrun'}.json`);
  fs.writeFileSync(out, JSON.stringify(rep, null, 2));
  console.log(JSON.stringify({
    notes_unchanged: rep.notes.unchanged,
    notes_written: rep.notes.written.length,
    notes_to_write: rep.notes.would_write.length,
    files_matched: rep.files.matched,
    files_missing: rep.files.missing.length,
    capture_errors: rep.errors.length,
    unmatched_objects: rep.unmatched_objects.length,
    report: path.relative(process.cwd(), out),
  }, null, 1));
})().catch((e) => { console.error(e.message); process.exit(1); });
