// Checks every *.note.json in the bucket for stale-dialog captures:
//  - the note text's first line must equal its label (the dialog title)
//  - two notes in the same folder must not share the same link set
// Usage: node scripts/verify-notes.js
const { listObjects, getObject } = require('./lib/s3');

(async () => {
  const all = await listObjects('');
  const notes = all.filter((o) => o.key.endsWith('.note.json'));
  const bad = [];
  const byFolder = {};
  for (const o of notes) {
    let j;
    try { j = JSON.parse((await getObject(o.key)).toString('utf8')); }
    catch (e) { bad.push({ key: o.key, problem: 'unreadable: ' + e.message }); continue; }
    const first = (j.text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
    const links = [...new Set(j.links || [])].sort().join(' ');
    if (first !== (j.label || '').trim()) bad.push({ key: o.key, problem: `title "${first.slice(0, 60)}" != label "${j.label}"` });
    if (!links) bad.push({ key: o.key, problem: 'no links captured', text: (j.text || '').slice(0, 120) });
    const folder = o.key.split('/').slice(0, -1).join('/');
    (byFolder[folder] = byFolder[folder] || []).push({ key: o.key, links });
  }
  for (const [f, arr] of Object.entries(byFolder)) {
    const seen = {};
    for (const n of arr) if (n.links) (seen[n.links] = seen[n.links] || []).push(n.key.split('/').pop());
    for (const [l, ks] of Object.entries(seen)) if (ks.length > 1) bad.push({ key: f, problem: 'same links in ' + ks.join(' + '), links: l.slice(0, 120) });
  }
  console.log(JSON.stringify({ objects: all.length, notes: notes.length, issues: bad.length }, null, 0));
  for (const b of bad) console.log(JSON.stringify(b));
})().catch((e) => { console.error(e.message); process.exit(1); });
