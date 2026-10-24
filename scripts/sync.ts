// Nexus sync, local half. The browser half is scripts/nexus-sync.js (see docs/SYNC.md for the runbook).
//
//   npm run sync -- prepare            start a run; prints {runId, snapshotPutUrl}
//   npm run sync -- plan <runId>       read the snapshot, write new/changed notes & links, list new files
//                                      (prints the items to download, each with a one-time upload URL)
//   npm run sync -- apply <runId>      verify downloaded files (size + checksum dedupe), import announcements,
//                                      assignments, notifications, calendar, attendance, MRS, recordings,
//                                      then export links, extract text, OCR, mirror; writes sync_log
//   npm run sync -- status             recent runs
//
// Rules: only NEW or CHANGED items are added. Nothing archived is ever overwritten or deleted; a changed
// file is stored next to the old one, and an item that disappears from Nexus is only marked removed.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { pool, q, one, PROFILE } from '../lib/db';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const s3 = require('./lib/s3') as {
  getObject(k: string): Promise<Buffer>; putObject(k: string, b: Buffer, t?: string): Promise<number>;
  deleteObject(k: string): Promise<number>; listObjects(p: string): Promise<{ key: string; size: number; etag: string }[]>;
  presignPut(k: string, t: string, s?: number): string;
};

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'sync');
const slug = (s: string) => String(s).replace(/[\\/:*?"<>|#%]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
const TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', mp4: 'video/mp4', zip: 'application/zip',
};
const ctype = (name: string) => TYPES[(name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()] || 'application/octet-stream';
const istDate = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : null);
const istTime = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

// Fuzzy title match for rows captured by hand on 20 Oct vs Nexus's own titles: ignores case, punctuation,
// dashes, extra spaces, an "Important:" prefix and small typos ("BOYB" vs "BYOB", "Chathurti" vs "Chaturthi").
const normTitle = (s: string) => String(s || '').toLowerCase().replace(/\(\d+ comments?\)/g, '').replace(/^[<\s]*important\s*:\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Numbers must agree exactly ("Session 3" is never "Session 5"). Then either a small edit distance, or (when
// allowed) every word of the shorter title appears in the longer one: the 20 Oct capture often dropped the
// course name ("Pre-read for Session 3" vs "Business Reader: Pre-read for Session 3").
const nums = (s: string) => (normTitle(s).match(/\d+/g) || []).join(',');
function sameTitle(a: string, b: string, opts: { subset?: boolean } = { subset: true }) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y || nums(a) !== nums(b)) return false;
  if (x === y) return true;
  if (opts.subset !== false) {
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    const lw = new Set(long.split(' '));
    if (short.split(' ').every((w) => lw.has(w))) return true;
  }
  return 1 - lev(x, y) / Math.max(x.length, y.length) >= 0.85;
}

type ArchivedItem ={ id: string; storage_key: string; path: string; label: string; kind: string; size_bytes: string | null; note_text: string | null; links: string[] | null };

// Does an archived note hold the same content as what Nexus serves now? Compares link sets (normalised) and
// words, tolerating formatting differences between the 20 Oct dialog capture and the data feed.
const normUrl = (u: string) => u.replace(/&amp;/g, '&').replace(/\/+$/, '').replace(/^http:\/\//, 'https://');
const words = (t: string | null | undefined) => new Set(String(t || '').toLowerCase().replace(/https?:\S+/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 2));
function sameContent(old: ArchivedItem, apiLinks: string[], apiText: string): boolean {
  const lo = new Set((old.links || []).map(normUrl));
  const oldText = old.note_text || '';
  for (const u of apiLinks.filter((x) => !/students\.mesaschool/.test(x)).map(normUrl)) {
    if (!lo.has(u) && !oldText.includes(u.replace(/^https?:\/\//, '').slice(0, 40))) return false;
  }
  const wa = words(apiText);
  if (!wa.size) return true;
  const wo = words(oldText);
  let hit = 0;
  for (const w of wa) if (wo.has(w)) hit++;
  return hit / wa.size >= 0.85;
}

function htmlToText(h: string | null | undefined): { text: string; links: string[] } {
  if (!h) return { text: '', links: [] };
  const links = [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const text = h.replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const bare = text.match(/https?:\/\/[^\s)]+/g) || [];
  return { text, links: [...new Set([...links, ...bare])] };
}

// Same classification the original calendar import used (scripts/build.py), so kinds stay consistent.
function eventKind(t: string) {
  const tl = t.toLowerCase();
  if (/end term exam|mid term exam|mid term exams|final exam|viva|end-term|exam prep|end prep|baseline assessment/.test(tl)) return 'exam';
  if (/holiday|vacation|term break/.test(tl)) return 'holiday';
  if (/building time|study block|office hours|doubt clearing|working session|flea prep/.test(tl)) return 'self-work';
  if (/startup leader|start-up leader|what is|panel|life @ mesa|life@mesa|byob|hackathon|demo day|orientation|awards|spotlight|primer|mrs by|cracking|crack case|garba|talent|mixer/.test(tl)) return 'event';
  return 'class';
}

type Snap = { capturedAt: string; responses: Record<string, { data?: Record<string, unknown> } & Record<string, unknown>> };
type Mat = {
  id: string; kind: string; title: string; content: string | null; url: string | null; fileName: string | null; fileType: string | null;
  sizeBytes: number | null; updatedAt: string; resourceSessionId: string | null; topicId: string; isPublished?: boolean;
};

const get = <T>(snap: Snap, prefix: string, field: string): T[] => {
  const out: T[] = [];
  for (const [k, v] of Object.entries(snap.responses)) if (k.startsWith(prefix)) out.push(...(((v?.data as Record<string, unknown>)?.[field] as T[]) || []));
  return out;
};

async function loadSnapshot(runId: string): Promise<Snap> {
  const local = path.join(CACHE, runId, 'snapshot.json');
  if (!fs.existsSync(local)) {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, await s3.getObject(`_meta/sync/${runId}/snapshot.json`));
  }
  return JSON.parse(fs.readFileSync(local, 'utf8'));
}

// ------------------------------------------------------------------ prepare
async function prepare() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  await q(`insert into sync_log (profile_id, run_id, ran_at, status, notes) values ($1,$2,now(),'running','prepared')`, [PROFILE, runId]);
  const snapshotPutUrl = s3.presignPut(`_meta/sync/${runId}/snapshot.json`, 'application/json', 7200);
  console.log(JSON.stringify({ runId, snapshotPutUrl }));
}

// ------------------------------------------------------------------ plan
async function plan(runId: string) {
  const snap = await loadSnapshot(runId);
  const out = { runId, coursesNew: [] as string[], notesWritten: 0, notesUnchanged: 0, filesMatched: 0, filesKnown: 0, removed: 0, downloads: [] as Record<string, unknown>[] };

  // Courses and terms
  const terms = new Map<string, string>();
  for (const t of get<{ id: string; name?: string; title?: string }>(snap, '/api/v1/curriculum/terms', 'terms')) terms.set(t.id, t.name || t.title || '');
  const apiCourses = new Map<string, Record<string, string>>();
  for (const c of get<Record<string, string>>(snap, '/api/v1/curriculum/courses?', 'courses')) apiCourses.set(c.id, c);
  for (const [k, v] of Object.entries(snap.responses)) {
    const m = k.match(/^\/api\/v1\/curriculum\/courses\/([0-9a-f-]{36})$/);
    if (m && (v.data as { course?: Record<string, string> })?.course) apiCourses.set(m[1], { ...apiCourses.get(m[1]), ...(v.data as { course: Record<string, string> }).course });
  }
  const dbCourses = new Map((await q<{ id: string; prefix: string }>('select id, prefix from courses where profile_id=$1', [PROFILE])).map((c) => [c.id, c.prefix]));
  for (const [id, c] of apiCourses) {
    const termName = terms.get(c.termId) || (c.termId ? 'Term ?' : 'Pre-Term');
    if (!dbCourses.has(id)) {
      const short = slug(c.title.replace(/\s+(with|by)\s+.*$/i, '').replace(/\s+-\s+.*$/, ''));
      let prefix = `${termName}/${short}`;
      if ([...dbCourses.values()].includes(prefix)) prefix += ` (${id.slice(0, 4)})`;
      await q(`insert into courses (id, profile_id, term, title, faculty, prefix, short_title, nexus_term_id, start_date, end_date, data)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (id) do nothing`,
        [id, PROFILE, termName, c.title, c.instructorName || null, prefix, short, c.termId || null, c.startDate || null, c.endDate || null, JSON.stringify({ source: 'nexus-sync' })]);
      dbCourses.set(id, prefix);
      out.coursesNew.push(c.title);
    } else {
      await q(`update courses set faculty=coalesce($2, faculty), nexus_term_id=$3, start_date=$4, end_date=$5, last_seen=now() where id=$1`,
        [id, c.instructorName || null, c.termId || null, c.startDate || null, c.endDate || null]);
    }
  }

  // Topics (course tabs) and sessions (folders)
  const topicInfo = new Map<string, { courseId: string; title: string }>();
  for (const [k, v] of Object.entries(snap.responses)) {
    const m = k.match(/^\/api\/v1\/curriculum\/topics\?courseId=([0-9a-f-]{36})$/);
    if (m) for (const t of ((v.data as { topics?: { id: string; title: string }[] })?.topics || [])) topicInfo.set(t.id, { courseId: m[1], title: t.title });
  }
  const sessions = new Map<string, { name: string; sessionDate: string | null }>();
  const topicHasSessions = new Set<string>();
  for (const [k, v] of Object.entries(snap.responses)) {
    const m = k.match(/^\/api\/v1\/content\/topics\/([0-9a-f-]{36})\/resource-sessions$/);
    if (!m) continue;
    const list = ((v.data as { sessions?: { id: string; name: string; sessionDate: string | null }[] })?.sessions) || [];
    if (list.length) topicHasSessions.add(m[1]);
    for (const s of list) sessions.set(s.id, s);
  }

  // Materials
  const mats: Mat[] = [];
  const seenTopics = new Set<string>();
  for (const [k, v] of Object.entries(snap.responses)) {
    const m = k.match(/^\/api\/v1\/content\/topics\/([0-9a-f-]{36})\/materials$/);
    if (m) { seenTopics.add(m[1]); mats.push(...(((v.data as { materials?: Mat[] })?.materials) || []).map((x) => ({ ...x, topicId: x.topicId || m[1] }))); }
  }
  const objects = await s3.listObjects('');
  const keys = new Map(objects.map((o) => [o.key, o]));
  const known = new Map((await q<{ material_id: string; storage_key: string | null; nexus_updated_at: string | null; size_bytes: string | null; content: string | null; url: string | null }>(
    'select material_id, storage_key, nexus_updated_at::text, size_bytes::text, content, url from nexus_materials where profile_id=$1', [PROFILE])).map((r) => [r.material_id, r]));
  const filesByCourse = new Map<string, ArchivedItem[]>();
  for (const f of await q<ArchivedItem & { course_id: string }>(
    'select id, course_id, storage_key, path, label, kind, size_bytes::text, note_text, links from files where profile_id=$1', [PROFILE])) {
    filesByCourse.set(f.course_id, [...(filesByCourse.get(f.course_id) || []), f]);
  }
  const claimed = new Set([...known.values()].map((k) => k.storage_key).filter(Boolean) as string[]);
  const freeKey = (base: string) => {
    if (!keys.has(base) && !claimed.has(base)) return base;
    const dir = base.slice(0, base.lastIndexOf('/') + 1); const name = base.slice(dir.length);
    for (let n = 1; ; n++) { const k = `${dir}${n}_${name}`; if (!keys.has(k) && !claimed.has(k)) return k; }
  };

  for (const mt of mats) {
    if (mt.isPublished === false) continue;
    const tp = topicInfo.get(mt.topicId);
    if (!tp) continue;
    const prefix = dbCourses.get(tp.courseId);
    if (!prefix) continue;
    const sess = mt.resourceSessionId ? sessions.get(mt.resourceSessionId) : null;
    // Where this item lives in the archive. Items in a session folder: <tab>/<session>. Items outside any
    // session were stored by the 20 Oct capture either directly in the tab, or under "Other files" when the
    // tab also has session folders (that's how Nexus shows them). Look in both; write where Nexus shows it.
    const base = `${prefix}/${slug(tp.title)}`;
    const candFolders = sess ? [`${base}/${slug(sess.name)}`] : [base, `${base}/Other files`];
    const writeFolder = sess ? candFolders[0] : topicHasSessions.has(mt.topicId) ? `${base}/Other files` : base;
    const prev = known.get(mt.id);
    const changed = !prev || (prev.nexus_updated_at && new Date(prev.nexus_updated_at).getTime() !== new Date(mt.updatedAt).getTime());
    const upsertMat = async (storageKey: string | null, fileId: string | null) => {
      await q(`insert into nexus_materials (material_id, profile_id, course_id, topic_id, topic_title, session_id, session_name, session_date, kind, title,
                 file_name, size_bytes, url, content, nexus_updated_at, storage_key, file_id, last_seen, removed_at)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),null)
               on conflict (material_id) do update set course_id=$3, topic_id=$4, topic_title=$5, session_id=$6, session_name=$7, session_date=$8, kind=$9,
                 title=$10, file_name=$11, size_bytes=$12, url=$13, content=$14, nexus_updated_at=$15,
                 storage_key=coalesce($16, nexus_materials.storage_key), file_id=coalesce($17, nexus_materials.file_id), last_seen=now(), removed_at=null`,
        [mt.id, PROFILE, tp.courseId, mt.topicId, tp.title, mt.resourceSessionId, sess?.name ?? null, sess?.sessionDate ?? null, mt.kind, mt.title,
          mt.fileName, mt.sizeBytes, mt.url, mt.content, mt.updatedAt, storageKey, fileId]);
    };

    if (mt.kind === 'file') {
      if (prev?.storage_key && !changed) { out.filesKnown++; await upsertMat(null, null); continue; }
      // First sighting: is it already archived (from the 20 Oct capture)? Same course, exact size, same name/label.
      if (!prev) {
        const cands = (filesByCourse.get(tp.courseId) || []).filter((f) => f.kind === 'file' && Number(f.size_bytes) === Number(mt.sizeBytes) && !claimed.has(f.storage_key));
        const best = cands.find((f) => candFolders.includes(f.path) && (f.storage_key.endsWith('/' + slug(mt.fileName || '')) || f.label === mt.title))
          || cands.find((f) => f.storage_key.endsWith('/' + slug(mt.fileName || '')) || f.label === mt.title) || (cands.length === 1 ? cands[0] : undefined);
        if (best) { claimed.add(best.storage_key); out.filesMatched++; await upsertMat(best.storage_key, best.id); continue; }
      }
      // New, or changed on Nexus: download to a new key (never overwrite the archived version)
      const name = slug(mt.fileName || `${mt.title}.${mt.fileType || 'bin'}`);
      let key = `${writeFolder}/${name}`;
      if (prev?.storage_key) key = key.replace(/(\.[^./]+)?$/, ` (updated ${istDate(mt.updatedAt)})$1`);
      key = freeKey(key);
      claimed.add(key);
      await upsertMat(null, null);
      out.downloads.push({
        materialId: mt.id, courseId: tp.courseId, topicTitle: tp.title, sessionName: sess?.name || null, title: mt.title,
        key, contentType: ctype(name), sizeBytes: mt.sizeBytes, putUrl: s3.presignPut(key, ctype(name), 7200),
      });
      continue;
    }

    // Notes (text) and links: written straight from the data, no browser needed.
    // An archived note is recognised by its CONTENT (links / words), never by title alone, and an existing
    // key is never written again: a note whose content changed gets a new "(updated <date>)" file.
    const { text, links } = mt.kind === 'text' ? htmlToText(mt.content) : { text: `${mt.title}\n\n${mt.url || ''}`, links: mt.url ? [mt.url] : [] };
    const body = JSON.stringify({ label: mt.title, kind: mt.kind === 'text' ? 'note' : 'link', text: mt.kind === 'text' ? `${mt.title}\n\n${text}` : text, links,
      url: `https://students.mesaschool.co.in/student/lms/courses/${tp.courseId}`, source: 'nexus-sync', materialId: mt.id, updatedAt: mt.updatedAt });
    const courseNotes = (filesByCourse.get(tp.courseId) || []).filter((f) => f.kind !== 'file');
    let key: string | null = null;
    if (prev?.storage_key) {
      const was = courseNotes.find((f) => f.storage_key === prev.storage_key);
      if (!changed || (was && sameContent(was, links, text))) { out.notesUnchanged++; await upsertMat(null, null); continue; }
      key = freeKey(`${writeFolder}/${slug(mt.title)} (updated ${istDate(mt.updatedAt)}).note.json`);
    } else {
      const sameLabel = courseNotes.filter((f) => candFolders.includes(f.path) && f.label === mt.title && !claimed.has(f.storage_key));
      const match = sameLabel.find((f) => sameContent(f, links, text));
      if (match) { claimed.add(match.storage_key); out.notesUnchanged++; await upsertMat(match.storage_key, match.id); continue; }
      key = sameLabel.length
        ? freeKey(`${writeFolder}/${slug(mt.title)} (updated ${istDate(mt.updatedAt)}).note.json`) // same item, different content since 20 Oct
        : freeKey(`${writeFolder}/${slug(mt.title)}.note.json`); // new item
    }
    claimed.add(key);
    if (keys.has(key)) throw new Error(`refusing to overwrite existing object ${key}`);
    await s3.putObject(key, Buffer.from(body), 'application/json');
    keys.set(key, { key, size: Buffer.byteLength(body), etag: '' });
    out.notesWritten++;
    const rel = key.slice(prefix.length + 1).split('/');
    const f = await one<{ id: string }>(
      `insert into files (profile_id, course_id, tab, folder, name, type, storage_key, status, kind, label, path, folder_date, note_text, links, etag, size_bytes, last_seen)
       values ($1,$2,$3,$4,$5,$6,$7,'archived',$8,$9,$10,$11,$12,$13,$14,$15,now())
       on conflict (profile_id, storage_key) do update set note_text=excluded.note_text, links=excluded.links, label=excluded.label, last_seen=now()
       returning id`,
      [PROFILE, tp.courseId, rel[0], rel.slice(1, -1).join('/') || null, key.split('/').pop(), mt.kind === 'text' ? 'NOTE' : 'LINK', key,
        mt.kind === 'text' ? 'note' : 'link', mt.title, key.slice(0, key.lastIndexOf('/')), sess?.sessionDate ?? null, JSON.parse(body).text, links.filter((u) => !/students\.mesaschool/.test(u)), null, Buffer.byteLength(body)]);
    for (const url of links.filter((u) => !/students\.mesaschool/.test(u))) {
      const lt = await one<{ id: string }>(
        `insert into link_targets (profile_id, url, provider, resource_id) values ($1,$2,$3,$4)
         on conflict (profile_id, url) do update set url=excluded.url returning id`, [PROFILE, url, provider(url), resourceId(url)]);
      await q('insert into file_links (file_id, link_id) values ($1,$2) on conflict do nothing', [f!.id, lt!.id]);
    }
    await upsertMat(key, f!.id);
  }

  // Materials that disappeared from topics we did see: mark removed (archive kept)
  const seenIds = new Set(mats.map((m) => m.id));
  const gone = await q<{ material_id: string }>(
    `select material_id from nexus_materials where profile_id=$1 and removed_at is null and topic_id = any($2)`, [PROFILE, [...seenTopics]]);
  for (const g of gone) if (!seenIds.has(g.material_id)) { await q('update nexus_materials set removed_at=now() where material_id=$1', [g.material_id]); out.removed++; }

  const resultsPutUrl = s3.presignPut(`_meta/sync/${runId}/fetch-results.json`, 'application/json', 7200);
  const planFile = { ...out, resultsPutUrl, createdAt: new Date().toISOString() };
  fs.mkdirSync(path.join(CACHE, runId), { recursive: true });
  fs.writeFileSync(path.join(CACHE, runId, 'plan.json'), JSON.stringify(planFile, null, 1));
  // A copy without the one-time URLs goes into the bucket as the run record
  await s3.putObject(`_meta/sync/${runId}/plan.json`, Buffer.from(JSON.stringify({ ...out, downloads: out.downloads.map(({ putUrl, ...d }) => d) }, null, 1)), 'application/json');
  await q(`update sync_log set notes=$2 where run_id=$1`, [runId, `planned: ${out.downloads.length} files to fetch, ${out.notesWritten} notes/links written`]);
  console.log(JSON.stringify({ runId, coursesNew: out.coursesNew, notesWritten: out.notesWritten, notesUnchanged: out.notesUnchanged,
    filesKnown: out.filesKnown, filesMatchedToArchive: out.filesMatched, removedOnNexus: out.removed, filesToFetch: out.downloads.length,
    planFile: path.relative(ROOT, path.join(CACHE, runId, 'plan.json')) }, null, 1));
}

function provider(url: string) {
  if (/docs\.google\.com\/document/.test(url)) return 'gdoc';
  if (/docs\.google\.com\/spreadsheets/.test(url)) return 'gsheet';
  if (/docs\.google\.com\/presentation/.test(url)) return 'gslide';
  if (/drive\.google\.com\/(file|open|uc)/.test(url)) return 'gdrive_file';
  if (/drive\.google\.com\/drive\/(u\/\d+\/)?folders/.test(url)) return 'gdrive_folder';
  if (/gamma\.app/.test(url)) return 'gamma';
  if (/youtu\.?be/.test(url)) return 'youtube';
  return 'other';
}
function resourceId(url: string) {
  return (url.match(/\/d\/([\w-]{20,})/) || url.match(/[?&]id=([\w-]{20,})/) || url.match(/folders\/([\w-]{20,})/) || url.match(/gamma\.app\/docs\/(?:.*-)?([a-z0-9]{12,})/) || [])[1] || null;
}

// ------------------------------------------------------------------ dedupe
// Rows captured by hand on 20 Oct (nexus_id is null) that describe the same thing as a row now linked to
// Nexus are merged into the Nexus row (anything only the old row had, like recorded marks, is carried over).
async function dedupe(dry = false): Promise<Record<string, number>> {
  const n: Record<string, number> = { announcements: 0, notifications: 0, assignments: 0, calendar: 0 };
  const say = (kind: string, old: string, into: string) => { if (dry) console.log(`${kind}: "${old}"  ->  "${into}"`); };
  const linkedA = await q<{ id: string; course_id: string | null; title: string }>('select id, course_id, title from announcements where profile_id=$1 and nexus_id is not null', [PROFILE]);
  for (const l of await q<{ id: string; course_id: string | null; title: string }>('select id, course_id, title from announcements where profile_id=$1 and nexus_id is null', [PROFILE])) {
    const r = linkedA.find((x) => x.course_id === l.course_id && sameTitle(x.title, l.title));
    if (r) { say('announcement', l.title, r.title); if (!dry) await q('delete from announcements where id=$1', [l.id]); n.announcements++; }
  }
  const linkedN = await q<{ id: string; title: string; posted_on: string }>('select id, title, posted_on::text from notifications where profile_id=$1 and nexus_id is not null', [PROFILE]);
  for (const l of await q<{ id: string; title: string; posted_on: string }>('select id, title, posted_on::text from notifications where profile_id=$1 and nexus_id is null', [PROFILE])) {
    const near = (d: string) => Math.abs(Date.parse(d) - Date.parse(l.posted_on)) <= 86_400_000 * 1.5;
    const r = linkedN.find((x) => near(x.posted_on) && sameTitle(x.title, l.title));
    if (r) { say('notification', l.title, r.title); if (!dry) await q('delete from notifications where id=$1', [l.id]); n.notifications++; }
  }
  const linkedS = await q<{ id: string; course_id: string | null; title: string; marks: string | null }>('select id, course_id, title, marks from assignments where profile_id=$1 and nexus_id is not null', [PROFILE]);
  for (const l of await q<{ id: string; course_id: string | null; title: string; marks: string | null }>('select id, course_id, title, marks from assignments where profile_id=$1 and nexus_id is null', [PROFILE])) {
    const r = linkedS.find((x) => x.course_id === l.course_id && sameTitle(x.title, l.title));
    if (r) { say('assignment', l.title, r.title); if (!dry) { await q('update assignments set marks=coalesce(marks,$2) where id=$1', [r.id, l.marks]); await q('delete from assignments where id=$1', [l.id]); } n.assignments++; }
  }
  const linkedE = await q<{ id: string; date: string; start_time: string; title: string; course_id: string | null }>('select id, date::text, start_time, title, course_id from calendar_events where profile_id=$1 and nexus_id is not null', [PROFILE]);
  for (const l of await q<{ id: string; date: string; start_time: string; title: string; course_id: string | null }>('select id, date::text, start_time, title, course_id from calendar_events where profile_id=$1 and nexus_id is null', [PROFILE])) {
    const r = linkedE.find((x) => x.date === l.date && ((x.start_time === l.start_time && sameTitle(x.title, l.title)) || sameTitle(x.title, l.title, { subset: false })));
    if (r) { say(`event ${l.date} ${l.start_time}`, l.title, r.title); if (!dry) { await q('update calendar_events set course_id=coalesce(course_id,$2) where id=$1', [r.id, l.course_id]); await q('delete from calendar_events where id=$1', [l.id]); } n.calendar++; }
  }
  return n;
}

// ------------------------------------------------------------------ apply
async function apply(runId: string) {
  const snap = await loadSnapshot(runId);
  const planPath = path.join(CACHE, runId, 'plan.json');
  const planned = JSON.parse(fs.readFileSync(planPath, 'utf8')) as { downloads: { materialId: string; key: string; title: string; sizeBytes: number | null; courseId: string; topicTitle: string; sessionName: string | null }[] };
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => { counts[k] = (counts[k] || 0) + n; };
  const failures: string[] = [];

  // ---- downloaded files: verify, dedupe by checksum, record
  if (planned.downloads.length) {
    let results: { materialId: string; ok: boolean; size?: number; sha256?: string; error?: string }[] = [];
    try { results = JSON.parse((await s3.getObject(`_meta/sync/${runId}/fetch-results.json`)).toString()).results; }
    catch { failures.push('no fetch-results.json: the browser download phase did not finish'); }
    const objs = new Map((await s3.listObjects('')).map((o) => [o.key, o]));
    for (const d of planned.downloads) {
      const r = results.find((x) => x.materialId === d.materialId);
      if (!r?.ok) { failures.push(`${d.title}: ${r?.error || 'not downloaded'}`); bump('files_failed'); continue; }
      const o = objs.get(d.key);
      if (!o || o.size !== r.size || (d.sizeBytes != null && Number(d.sizeBytes) !== r.size)) {
        failures.push(`${d.title}: size check failed (bucket ${o?.size}, browser ${r.size}, Nexus ${d.sizeBytes})`); bump('files_failed'); continue;
      }
      const dup = await one<{ storage_key: string; id: string }>('select storage_key, id from files where profile_id=$1 and sha256=$2 limit 1', [PROFILE, r.sha256]);
      if (dup) {
        // identical bytes already archived: keep one copy
        await s3.deleteObject(d.key);
        await q('update nexus_materials set storage_key=$2, file_id=$3 where material_id=$1', [d.materialId, dup.storage_key, dup.id]);
        bump('files_duplicate_skipped'); continue;
      }
      const prefix = (await one<{ prefix: string }>('select prefix from courses where id=$1', [d.courseId]))!.prefix;
      const rel = d.key.slice(prefix.length + 1).split('/');
      const ext = (d.key.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
      const f = await one<{ id: string }>(
        `insert into files (profile_id, course_id, tab, folder, name, type, size, storage_key, status, kind, label, path, ext, size_bytes, etag, sha256, last_seen)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'archived','file',$9,$10,$11,$12,$13,$14,now())
         on conflict (profile_id, storage_key) do update set size_bytes=excluded.size_bytes, sha256=excluded.sha256, etag=excluded.etag, last_seen=now() returning id`,
        [PROFILE, d.courseId, rel[0], rel.slice(1, -1).join('/') || null, d.key.split('/').pop(), ext.toUpperCase(),
          r.size! >= 1048576 ? (r.size! / 1048576).toFixed(1) + ' MB' : Math.round(r.size! / 1024) + ' KB',
          d.key, d.title, d.key.slice(0, d.key.lastIndexOf('/')), ext, r.size, o.etag, r.sha256]);
      await q('update nexus_materials set storage_key=$2, file_id=$3 where material_id=$1', [d.materialId, d.key, f!.id]);
      bump('files_new');
    }
  }

  // ---- announcements (with text). Programme-wide notices come back under several courses: one row per Nexus id.
  const anns = new Map<string, Record<string, unknown>>();
  for (const a of get<Record<string, unknown>>(snap, '/api/v1/announcements', 'announcements')) anns.set(a.id as string, a);
  const knownCourse = new Set((await q<{ id: string }>('select id from courses where profile_id=$1', [PROFILE])).map((c) => c.id));
  for (const a of anns.values()) {
    const { text } = htmlToText(a.body as string);
    const courseId = knownCourse.has(a.courseId as string) ? (a.courseId as string) : null;
    const title = String(a.title || '(untitled)').slice(0, 300);
    const vals = [text, istDate(a.createdAt as string), a.createdAt, a.authorName || null, JSON.stringify(a.attachments || []), a.id];
    // 1) already linked to this Nexus id, 2) a title-only row from the 20 Oct capture, 3) new
    let row = await one<{ id: string }>('select id from announcements where profile_id=$1 and nexus_id=$2', [PROFILE, a.id]);
    if (!row) {
      const legacy = await q<{ id: string; title: string }>(
        'select id, title from announcements where profile_id=$1 and nexus_id is null and course_id is not distinct from $2', [PROFILE, courseId]);
      row = legacy.find((l) => sameTitle(l.title, title));
    }
    if (row) {
      await q(`update announcements set body=$2, posted=$3, posted_at=$4, author=$5, attachments=$6, nexus_id=$7 where id=$1`, [row.id, ...vals]);
      bump('announcements_updated');
    } else {
      await q(`insert into announcements (profile_id, course_id, title, body, posted, posted_at, author, attachments, nexus_id)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               on conflict (profile_id, nexus_id) where nexus_id is not null do nothing`, [PROFILE, courseId, title, ...vals]);
      bump('announcements_new');
    }
  }

  // ---- assignments (my list + per-course lists carry descriptions)
  const asg = new Map<string, Record<string, unknown>>();
  for (const a of get<Record<string, unknown>>(snap, '/api/v1/assignments', 'assignments')) asg.set(a.id as string, { ...asg.get(a.id as string), ...a });
  const courseTitle = new Map((await q<{ id: string; title: string }>('select id, title from courses where profile_id=$1', [PROFILE])).map((c) => [c.id, c.title]));
  for (const a of asg.values()) {
    const sub = (a.mySubmissionStatus as string | null) ?? null;
    const status = sub && /submit|grade|return|complete/i.test(sub) ? 'Submitted' : 'Pending';
    const courseName = (a.courseTitle as string) || courseTitle.get(a.courseId as string) || 'Startup Leaders';
    let existing = await one<{ id: string }>('select id from assignments where profile_id=$1 and nexus_id=$2', [PROFILE, a.id]);
    if (!existing) {
      const legacy = await q<{ id: string; title: string }>(
        `select id, title from assignments where profile_id=$1 and nexus_id is null and course_id is not distinct from $2`, [PROFILE, a.courseId || null]);
      existing = legacy.find((l) => sameTitle(l.title, a.title as string));
    }
    const vals = [a.title, courseName, a.courseId || null, istDate(a.dueAt as string), a.dueAt || null, status, sub, htmlToText(a.description as string).text || null,
      htmlToText(a.instructions as string).text || null, a.maxMarks ?? null, a.isGroup ? 'Group' : 'Individual', a.id];
    if (existing) {
      await q(`update assignments set title=$2, course=$3, course_id=$4, due_date=$5::date, due=$5::text, due_at=$6, status=$7, submission_status=$8, description=$9,
               instructions=$10, max_marks=$11, kind=$12, nexus_id=$13 where id=$1`, [existing.id, ...vals]);
      bump('assignments_updated');
    } else {
      await q(`insert into assignments (title, course, course_id, due_date, due, due_at, status, submission_status, description, instructions, max_marks, kind, nexus_id, profile_id, data)
               values ($1,$2,$3,$4::date,$4::text,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}') on conflict (profile_id, nexus_id) where nexus_id is not null do nothing`, [...vals, PROFILE]);
      bump('assignments_new');
    }
  }

  // ---- notifications
  const notes = new Map<string, Record<string, unknown>>();
  for (const n of get<Record<string, unknown>>(snap, '/api/v1/notifications', 'items')) notes.set(n.id as string, n);
  for (const n of notes.values()) {
    const sub = (n.data as Record<string, string> | null)?.subtype;
    const day = istDate(n.createdAt as string);
    // 1) linked already, 2) the hand-summarised 20 Oct row for the same notice (same day ±1, similar title), 3) new
    let row = await one<{ id: string }>('select id from notifications where profile_id=$1 and nexus_id=$2', [PROFILE, n.id]);
    if (!row) {
      const legacy = await q<{ id: string; title: string }>(
        `select id, title from notifications where profile_id=$1 and nexus_id is null and posted_on between $2::date - 1 and $2::date + 1`, [PROFILE, day]);
      row = legacy.find((l) => sameTitle(l.title, n.title as string));
    }
    const vals = [n.title, n.body || '', day, (n.data && sub) || n.type, n.id, n.createdAt, n.type, JSON.stringify(n.data || {})];
    if (row) {
      await q(`update notifications set title=$2, body=$3, posted_on=$4, category=coalesce(category,$5), nexus_id=$6, created_at=$7, ntype=$8, data=$9 where id=$1`, [row.id, ...vals]);
    } else {
      await q(`insert into notifications (profile_id, title, body, posted_on, category, nexus_id, created_at, ntype, data, seen_at)
               values ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$4::text) on conflict (profile_id, nexus_id) where nexus_id is not null do nothing`, [PROFILE, ...vals]);
      bump('notifications_new');
    }
  }

  // ---- calendar
  const evs = new Map<string, Record<string, unknown>>();
  for (const e of get<Record<string, unknown>>(snap, '/api/v1/events/my', 'events')) evs.set(e.id as string, e);
  for (const e of evs.values()) {
    const date = istDate(e.startAt as string)!;
    const title = String(e.title).trim();
    const courseId = (e.courseId as string) && courseTitle.has(e.courseId as string) ? (e.courseId as string) : null;
    const vals = [date, istTime(e.startAt as string), istTime(e.endAt as string), title, e.id, e.startAt, e.endAt, e.eventType, e.status, courseId];
    // 1) already linked to this Nexus id (it may have moved), 2) the hand-captured row for the same event, 3) new
    let row = await one<{ id: string }>('select id from calendar_events where profile_id=$1 and nexus_id=$2', [PROFILE, e.id]);
    if (!row) {
      const legacy = await q<{ id: string; title: string; start_time: string }>(
        'select id, title, start_time from calendar_events where profile_id=$1 and nexus_id is null and date=$2', [PROFILE, date]);
      row = legacy.find((l) => l.start_time === vals[1] && sameTitle(l.title, title)) || legacy.find((l) => sameTitle(l.title, title, { subset: false }));
    }
    if (row) {
      await q(`update calendar_events set date=$2, start_time=$3, end_time=$4, title=$5, nexus_id=$6, start_at=$7, end_at=$8, event_type=$9, nexus_status=$10,
               course_id=coalesce($11, course_id) where id=$1`, [row.id, ...vals]);
      bump('events_seen');
    } else {
      await q(`insert into calendar_events (profile_id, date, start_time, end_time, title, nexus_id, start_at, end_at, event_type, nexus_status, course_id, term, kind)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               on conflict (profile_id, nexus_id) where nexus_id is not null do nothing`,
        [PROFILE, ...vals, (e.termName as string) || (date < '2026-10-19' ? 'Term 1' : 'Term 2'), eventKind(title)]);
      bump('events_new');
    }
  }
  // Events Nexus moved: same nexus id now on a different slot. Keep the newest row per nexus id.
  await q(`delete from calendar_events c using calendar_events d where c.profile_id=$1 and c.nexus_id is not null and c.nexus_id=d.nexus_id
           and c.id < d.id`, [PROFILE]);

  // ---- attendance (per session, then per-course summary)
  const sessionRows = snap.responses['/api/v1/attendance/student/sessions']?.data as unknown;
  for (const s of (Array.isArray(sessionRows) ? sessionRows : []) as Record<string, string>[]) {
    await q(`insert into attendance_sessions (event_id, profile_id, course_name, event_title, start_at, status, term_name, last_seen) values ($1,$2,$3,$4,$5,$6,$7,now())
             on conflict (event_id) do update set status=excluded.status, last_seen=now()`, [s.eventId, PROFILE, s.courseName, s.eventTitle, s.startAt, s.status, s.termName]);
    bump('attendance_sessions');
  }
  bump('attendance_summary_rows', await importAttendanceSummary(snap));

  // ---- MRS
  // Nexus lists e.g. "Baseline Submission" (mrsScore on the MRS scale, marks out of 40) and "Mesa Readiness Score 1..3"
  // (overall MRS out of ~100 in totalMarks once released). Map by TITLE, never by position.
  const mrs = get<Record<string, unknown>>(snap, '/api/v1/mrs/assessments', 'assessments');
  for (const m of mrs) {
    const n = String(m.title || '').match(/readiness score\s*(\d+)/i)?.[1];
    const sitting = n ? `MRS ${n}` : String(m.title || m.slug || 'MRS');
    const max = Number(m.maxMarks);
    const score = n ? (m.totalMarks != null && max > 0 ? Number(m.totalMarks) : null) : (m.mrsScore ?? null);
    const status = score != null ? 'scored' : m.status === 'locked' ? 'not yet scheduled' : String(m.status || 'not yet scheduled');
    // Nexus is the authority for titles: its blurb ("Data, AI and communication", "Where you start") unless it's a placeholder
    const blurb = (m.blurb as string) && !/not yet scheduled/i.test(m.blurb as string) ? (m.blurb as string) : null;
    const title = n ? blurb : [m.title, blurb].filter(Boolean).join(': ');
    await q(`insert into mrs (profile_id, sitting, title, score, out_of, status, as_of, slug, marks, max_marks) values ($1,$2,$3,$4,100,$5,$6,$7,$8,$9)
             on conflict (profile_id, sitting) do update set title=excluded.title, score=excluded.score, out_of=excluded.out_of, status=excluded.status,
               as_of=excluded.as_of, slug=excluded.slug, marks=excluded.marks, max_marks=excluded.max_marks`,
      [PROFILE, sitting, title, score, status, istDate(snap.capturedAt), m.slug, m.totalMarks ?? null, m.maxMarks ?? null]);
    bump('mrs');
  }

  // ---- recordings (Nexus's own recordedOn date replaces our guesses)
  const topicCourse = new Map<string, string>();
  for (const [k, v] of Object.entries(snap.responses)) {
    const m = k.match(/^\/api\/v1\/curriculum\/topics\?courseId=([0-9a-f-]{36})$/);
    if (m) for (const t of ((v.data as { topics?: { id: string }[] })?.topics || [])) topicCourse.set(t.id, m[1]);
  }
  for (const [k, v] of Object.entries(snap.responses)) {
    const m = k.match(/^\/api\/v1\/content\/topics\/([0-9a-f-]{36})\/recordings$/);
    if (!m) continue;
    const courseId = topicCourse.get(m[1]);
    if (!courseId) continue;
    for (const r of ((v.data as { recordings?: Record<string, string>[] })?.recordings || [])) {
      const yt = (r.videoUrl || r.embedUrl || '').match(/(?:youtu\.be\/|v=|embed\/|live\/|shorts\/)([\w-]{11})/)?.[1];
      if (!yt) continue;
      const res = await q(
        `insert into recordings (profile_id, course_id, title, date, youtube_id, url, rec_date, date_uncertain, nexus_id) values ($1,$2,$3,$4,$5,$6,$7,false,$8)
         on conflict (course_id, youtube_id) do update set title=excluded.title, rec_date=excluded.rec_date, date=excluded.date, date_uncertain=false, nexus_id=excluded.nexus_id
         returning (xmax = 0) inserted`,
        [PROFILE, courseId, r.title, r.recordedOn, yt, `https://www.youtube.com/watch?v=${yt}`, r.recordedOn || null, r.id]);
      bump(res[0]?.inserted ? 'recordings_new' : 'recordings_seen');
    }
  }

  // ---- merge hand-captured rows into their Nexus rows
  for (const [k, v] of Object.entries(await dedupe())) if (v) bump(`merged_${k}`, v);

  // ---- exams (derived from calendar)
  await q(`insert into exams (profile_id, course_id, title, starts_on, ends_on, source)
           select profile_id, max(course_id), title, min(date), max(date), 'calendar' from calendar_events
           where profile_id=$1 and title ~* '(end term exam|mid term exam|final exam|viva|baseline assessment)' and title !~* 'prep' and coalesce(nexus_status,'') <> 'cancelled'
           group by profile_id, title, date_trunc('month', date)
           on conflict (profile_id, title, starts_on) do update set ends_on=excluded.ends_on`, [PROFILE]);

  // ---- downstream: link exports, text, OCR, local mirror (each is incremental)
  const steps: [string, string[]][] = [
    ['export-links', ['scripts/export-links.js', '--retry-failed']],
    ['extract-text', ['scripts/extract-text.js']],
    ['ocr', ['scripts/ocr-docs.js']],
    ['mirror', ['scripts/mirror-local.js']],
  ];
  const stepOut: Record<string, string> = {};
  for (const [name, args] of steps) {
    try {
      const o = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 3_600_000, stdio: ['ignore', 'pipe', 'pipe'] });
      stepOut[name] = o.replace(/\r/g, '\n').trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) || 'ok';
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n').slice(-1)[0];
      stepOut[name] = 'FAILED: ' + msg.slice(0, 300);
      failures.push(`${name}: ${msg.slice(0, 200)}`);
    }
  }

  const newItems = (counts.files_new || 0) + (counts.announcements_new || 0) + (counts.assignments_new || 0) + (counts.notifications_new || 0) + (counts.events_new || 0) + (counts.recordings_new || 0);
  const planInfo = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const details = { counts, plan: { notesWritten: planInfo.notesWritten, filesMatched: planInfo.filesMatched, removed: planInfo.removed, coursesNew: planInfo.coursesNew }, steps: stepOut, failures, snapshotAt: snap.capturedAt };
  await q(`update sync_log set finished_at=now(), status=$2, new_items=$3, changed_items=$4, details=$5, notes=$6 where run_id=$1`,
    [runId, failures.length ? 'partial' : 'ok', newItems + (planInfo.notesWritten || 0), (counts.assignments_updated || 0) + (counts.announcements_updated || 0),
      JSON.stringify(details), failures.length ? `${failures.length} problem(s)` : 'ok']);
  await s3.putObject(`_meta/sync/${runId}/apply.json`, Buffer.from(JSON.stringify(details, null, 1)), 'application/json');
  console.log(JSON.stringify({ runId, status: failures.length ? 'partial' : 'ok', ...details }, null, 1));
}

// Nexus's summary endpoint: an array, one row per course:
// { courseId, courseName, termName, attended, total, percentage, cpEarned, cpMax, cpInClass, cpQuiz, avgCp }
// cp* = class participation points, kept in the note. "Overall" is the sum across courses.
async function importAttendanceSummary(snap: Snap): Promise<number> {
  const body = snap.responses['/api/v1/attendance/student/summary']?.data as unknown;
  if (!Array.isArray(body) || !body.length) return 0;
  const asOf = istDate(snap.capturedAt);
  const known = new Set((await q<{ id: string }>('select id from courses where profile_id=$1', [PROFILE])).map((c) => c.id));
  let n = 0, sa = 0, st = 0;
  for (const r of body as Record<string, unknown>[]) {
    const subject = String(r.courseName || '');
    const attended = Number(r.attended), total = Number(r.total);
    if (!subject || !Number.isFinite(attended) || !Number.isFinite(total)) continue;
    const label = r.termName && r.termName !== 'Term 1' ? `${subject} (${r.termName})` : subject;
    const note = r.cpMax != null ? `Class participation ${r.cpEarned ?? 0}/${r.cpMax}` : null;
    const cid = known.has(r.courseId as string) ? (r.courseId as string) : null;
    await q(`insert into attendance (profile_id, course_id, subject, attended, total, as_of, note) values ($1,$2,$3,$4,$5,$6,$7)
             on conflict (profile_id, subject, as_of) do update set attended=excluded.attended, total=excluded.total, course_id=excluded.course_id, note=excluded.note`,
      [PROFILE, cid, label, attended, total, asOf, note]);
    // the same course captured by hand under a shorter name on the same day: Nexus's row replaces it
    if (cid) await q(`delete from attendance where profile_id=$1 and course_id=$2 and as_of=$3 and subject<>$4`, [PROFILE, cid, asOf, label]);
    sa += attended; st += total; n++;
  }
  await q(`insert into attendance (profile_id, subject, attended, total, as_of, note) values ($1,'Overall',$2,$3,$4,'sum of courses, from Nexus sync')
           on conflict (profile_id, subject, as_of) do update set attended=excluded.attended, total=excluded.total, note=excluded.note`, [PROFILE, sa, st, asOf]);
  return n + 1;
}

async function status() {
  const rows = await q<Record<string, unknown>>(
    `select run_id, ran_at::text, finished_at::text, status, new_items, changed_items, notes from sync_log where profile_id=$1 and run_id is not null order by ran_at desc limit 10`, [PROFILE]);
  console.table(rows);
}

const [cmd, arg] = process.argv.slice(2);
(async () => {
  if (cmd === 'prepare') await prepare();
  else if (cmd === 'plan') await plan(arg);
  else if (cmd === 'apply') await apply(arg);
  else if (cmd === 'status') await status();
  else if (cmd === 'dedupe') console.log(JSON.stringify(await dedupe(arg === '--dry')));
  else if (cmd === 'fail') {
    // record a run that could not proceed, e.g. `fail <runId> login_required`
    const why = process.argv[4] || 'failed';
    await q(`update sync_log set status=$2, finished_at=now(), notes=$3 where run_id=$1`,
      [arg, why === 'login_required' ? 'login_required' : 'failed', why === 'login_required' ? 'Nexus was logged out; log in in the built-in browser' : why]);
    console.log(`recorded ${why} for ${arg}`);
  }
  else console.log('usage: npm run sync -- prepare | plan <runId> | apply <runId> | status | fail <runId> <reason>');
})().catch(async (e) => {
  console.error(e.stack || e.message);
  if (arg) await q(`update sync_log set status='failed', finished_at=now(), notes=$2 where run_id=$1`, [arg, String(e.message).slice(0, 300)]).catch(() => {});
  process.exitCode = 1;
}).finally(() => pool.end());
