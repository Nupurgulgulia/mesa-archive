// Loads the archive into Neon Postgres. Idempotent: every write is an upsert.
// Sources: data/mesa_data.json (course metadata, recordings, attendance, MRS, announcements),
//          data/nexus_manifest_*.json (every Nexus item) + live bucket listing (storage keys).
// Usage: node scripts/load-db.js [data/nexus_manifest_2026-10-20.json]
const fs = require('fs');
const path = require('path');
const { pool } = require('./lib/db');
const { listObjects } = require('./lib/s3');
const { matchManifest, dataset, itemSize } = require('./lib/manifest');

const PROFILE = 'nupur';
const AS_OF = dataset.captured; // '2026-10-20'
const manifestFile = process.argv[2] || 'data/nexus_manifest_2026-10-20.json';
const coursesMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'courses_map.json'), 'utf8'));

// Course detection for free-text titles (calendar, assignments, attendance). Order matters:
// "Power of Communication | Personal Branding with Ananya" is a Personal Branding session.
const COURSE_RULES = [
  [/Personal Branding/i, '42e8b02f-e1e2-4bb2-9ddf-d4c9256c7bfb'],
  [/^Power of Communication/i, 'dd9ee2d4-0f42-4aa7-87b3-70deccd1bafc'],
  [/^AI and its Application/i, 'ac9a4adc-af63-43b3-824d-51a7280e77d6'],
  [/^AI (MRS|Implementation)/i, 'ac9a4adc-af63-43b3-824d-51a7280e77d6'],
  [/^AI with Mihirr/i, '4ae1dbe1-595b-4bae-9985-4a64ea96bc17'],
  [/^BYOB/i, '87b852db-ff22-4be3-a719-b0f83602da9c'],
  [/^Business Frameworks/i, '41e90532-d355-4d05-903d-df8dff2ccaa7'],
  [/^Business Reader/i, '6845bc3e-7aa5-4277-a52e-6618e2e68a2b'],
  [/^Career Readiness/i, '4a448342-1f2e-4d49-8b47-93f5f48dbb4f'],
  [/^Crafting Marketing/i, '22afcf18-9929-4ea9-ba57-d97038fcbce4'],
  [/^Data Driven Decision/i, 'f2395447-6636-4fec-a2dc-a776310e893f'],
  [/^Entrepreneurship 101/i, '5cb000ec-8fc0-4b58-806c-faf348b1e9c8'],
  [/^Fundamentals of Finance/i, 'dd9636d1-be40-462d-b5b0-6f9ede886dcc'],
  [/^The Art of Selling/i, '0fac4693-281a-4980-ae96-77e779f5de03'],
  [/^B2B Sales/i, '1d406da8-cda1-4446-b071-f17a9715be57'],
  [/^Business Metrics and Mindset/i, '8d8fb4e3-b46e-48ce-b053-e450f939668e'],
  [/^Data 102/i, 'a34bf443-fda9-40d2-ae58-d7e849d98a36'],
  [/^Economics/i, 'e4c6aaec-490a-4381-a3b8-603d5558c55e'],
  [/^First Principles Lab/i, '25353a5a-1e9a-42c6-9ee1-fffa79e59806'],
  [/^Growth with/i, 'f40ec8ff-c93e-44ef-a8da-7523e21d82eb'],
  [/^Operations and Supply Chain/i, '6c7ebdf4-5fb3-452b-bd89-38be5dd54ed1'],
  [/^SQL with/i, 'a4a68bbe-5c91-47a1-8e45-fa59fc68ebe0'],
];
const courseFor = (t) => (COURSE_RULES.find(([re]) => re.test(String(t || '').trim())) || [])[1] || null;

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function parseDay(s, year = 2026) {
  const m = String(s || '').match(/(\d{1,2})\s+([A-Za-z]{3,4})[a-z]*(?:\s+(\d{4}))?/);
  if (!m || !MON[m[2].toLowerCase()]) return null;
  return `${m[3] || year}-${String(MON[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function provider(url) {
  if (/docs\.google\.com\/document/.test(url)) return 'gdoc';
  if (/docs\.google\.com\/spreadsheets/.test(url)) return 'gsheet';
  if (/docs\.google\.com\/presentation/.test(url)) return 'gslide';
  if (/drive\.google\.com\/(file|open|uc)/.test(url)) return 'gdrive_file';
  if (/drive\.google\.com\/drive\/(u\/\d+\/)?folders/.test(url)) return 'gdrive_folder';
  if (/gamma\.app/.test(url)) return 'gamma';
  if (/youtu\.?be/.test(url)) return 'youtube';
  return 'other';
}
function resourceId(url) {
  return (url.match(/\/d\/([\w-]{20,})/) || url.match(/[?&]id=([\w-]{20,})/) || url.match(/folders\/([\w-]{20,})/) || url.match(/gamma\.app\/docs\/(?:.*-)?([a-z0-9]{12,})/) || [])[1] || null;
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const objects = await listObjects('');
  const byKey = new Map(objects.map((o) => [o.key, o]));
  const { keyOf, missing } = matchManifest(manifest, objects);
  if (missing.length) throw new Error(`${missing.length} manifest files have no bucket object; run apply-capture first`);

  const c = await pool.connect();
  const counts = {};
  const bump = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };
  try {
    await c.query('begin');

    // ---- courses
    for (const m of coursesMap) {
      const d = dataset.courses.find((x) => x.id === m.id);
      if (!d) throw new Error('course missing from mesa_data: ' + m.prefix);
      const { folders, recordings, ...rest } = d;
      await c.query(
        `insert into courses (id, profile_id, term, title, faculty, mode, outline, data, prefix, short_title, category, last_seen)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
         on conflict (id) do update set term=excluded.term, title=excluded.title, faculty=excluded.faculty, mode=excluded.mode,
           outline=excluded.outline, data=excluded.data, prefix=excluded.prefix, short_title=excluded.short_title,
           category=excluded.category, last_seen=now()`,
        [m.id, PROFILE, d.term, d.title, d.faculty || null, d.mode || null, d.outline || null, rest, m.prefix, m.prefix.split('/').pop(), d.category || null]);
      bump('courses');
    }

    // ---- files (every Nexus item) + link targets
    for (const course of manifest) {
      const folderDates = Object.fromEntries(course.items.filter((i) => i.kind === 'folder').map((i) => [i.path, i.date && i.date !== 'No date set' ? i.date : null]));
      for (const it of course.items.filter((i) => ['file', 'note', 'link'].includes(i.kind))) {
        const key = keyOf.get(it);
        const obj = byKey.get(key);
        const rel = it.path.slice(course.prefix.length + 1).split('/');
        const size = it.kind === 'file' ? itemSize(it, course.id) : null;
        const links = (it.links || []).filter((u) => !/students\.mesaschool\.co\.in/.test(u));
        const r = await c.query(
          `insert into files (profile_id, course_id, tab, folder, name, type, size, storage_key, status, kind, label, dup_index, path,
                              folder_date, material_id, ext, size_bytes, etag, note_text, links, last_seen)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'archived',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
           on conflict (profile_id, storage_key) do update set course_id=excluded.course_id, tab=excluded.tab, folder=excluded.folder,
             name=excluded.name, type=excluded.type, size=excluded.size, status='archived', kind=excluded.kind, label=excluded.label,
             dup_index=excluded.dup_index, path=excluded.path, folder_date=excluded.folder_date, material_id=excluded.material_id,
             ext=excluded.ext, size_bytes=excluded.size_bytes, etag=excluded.etag, note_text=excluded.note_text, links=excluded.links,
             last_seen=now()
           returning id`,
          [PROFILE, course.id, rel[0], rel.slice(1).join('/') || null, key.split('/').pop(),
            it.kind === 'file' ? (it.ext || '').toUpperCase() : it.kind.toUpperCase(),
            size ? (size.bytes >= 1048576 ? (size.bytes / 1048576).toFixed(1) + ' MB' : Math.round(size.bytes / 1024) + ' KB') : null,
            key, it.kind, it.label, it.dup_index || 0, it.path, folderDates[it.path] || null,
            it.material || null, it.ext || (it.kind === 'file' ? null : 'json'), obj.size, obj.etag,
            it.kind === 'note' ? it.text : it.kind === 'link' ? `${it.label}\n\n${links.join('\n')}` : null, links]);
        bump('files_' + it.kind);
        for (const url of links) {
          const lt = await c.query(
            `insert into link_targets (profile_id, url, provider, resource_id) values ($1,$2,$3,$4)
             on conflict (profile_id, url) do update set provider=excluded.provider returning id`,
            [PROFILE, url, provider(url), resourceId(url)]);
          await c.query('insert into file_links (file_id, link_id) values ($1,$2) on conflict do nothing', [r.rows[0].id, lt.rows[0].id]);
          bump('file_links');
        }
      }
    }

    // ---- recordings
    const UNCERTAIN = [['5cb000ec-8fc0-4b58-806c-faf348b1e9c8', /Session 5 \(part 2\)/], ['f2395447-6636-4fec-a2dc-a776310e893f', /^Session [89]$/], ['dd9636d1-be40-462d-b5b0-6f9ede886dcc', /^Session 5$/]];
    for (const d of dataset.courses) {
      for (const rec of d.recordings || []) {
        const unsure = UNCERTAIN.some(([id, re]) => id === d.id && re.test(rec.title)) || !rec.date;
        await c.query(
          `insert into recordings (profile_id, course_id, title, date, youtube_id, url, rec_date, date_uncertain) values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (course_id, youtube_id) do update set title=excluded.title, date=excluded.date, url=excluded.url,
             rec_date=excluded.rec_date, date_uncertain=excluded.date_uncertain, profile_id=excluded.profile_id`,
          [PROFILE, d.id, rec.title, rec.date || null, rec.youtube_id, rec.url, parseDay(rec.date), unsure]);
        bump('recordings');
      }
    }

    // ---- announcements (titles only; bodies were not captured)
    for (const d of dataset.courses) {
      for (const a of d.announcements || []) {
        await c.query(`insert into announcements (profile_id, course_id, title) values ($1,$2,$3) on conflict do nothing`, [PROFILE, d.id, a]);
        bump('announcements');
      }
    }

    // ---- attendance
    const att = dataset.attendance;
    const [oa, ot] = att.overall.match(/(\d+)\/(\d+)/).slice(1).map(Number);
    await c.query(`insert into attendance (profile_id, subject, attended, total, as_of, note) values ($1,'Overall',$2,$3,$4,$5)
                   on conflict (profile_id, subject, as_of) do update set attended=excluded.attended, total=excluded.total, note=excluded.note`,
      [PROFILE, oa, ot, AS_OF, att.note]);
    bump('attendance');
    for (const [subject, frac] of att.subjects) {
      const [a, t] = frac.split('/').map(Number);
      await c.query(`insert into attendance (profile_id, course_id, subject, attended, total, as_of) values ($1,$2,$3,$4,$5,$6)
                     on conflict (profile_id, subject, as_of) do update set course_id=excluded.course_id, attended=excluded.attended, total=excluded.total`,
        [PROFILE, courseFor(subject), subject, a, t, AS_OF]);
      bump('attendance');
    }

    // ---- MRS
    for (const s of dataset.mrs.sittings) {
      const m = s.match(/^(MRS \d+)(?::\s*(.*?))?\s+-\s+(.*)$/);
      const score = m && /^\d+(\.\d+)?$/.test(m[3]) ? Number(m[3]) : null;
      await c.query(`insert into mrs (profile_id, sitting, title, score, out_of, status, as_of) values ($1,$2,$3,$4,$5,$6,$7)
                     on conflict (profile_id, sitting) do update set title=excluded.title, score=excluded.score, status=excluded.status, as_of=excluded.as_of`,
        [PROFILE, m[1], m[2] || null, score, dataset.mrs.out_of, score != null ? 'scored' : m[3], AS_OF]);
      bump('mrs');
    }
    const reqs = [
      ['Weekly "Tell Me About Yourself" on MRS Practice Lab', null, 'weekly, by Sun 23:59', 'required to stay MRS-eligible', 'Missing it puts MRS eligibility at risk (3 reminders received by 18 Oct).'],
      ['Resume Stress Test', '2026-10-25T23:59:00+05:30', null, 'pending', 'Current MRS assignment.'],
    ];
    for (const [title, due, recurring, status, note] of reqs) {
      await c.query(`insert into mrs_requirements (profile_id, title, due_at, recurring, status, note) values ($1,$2,$3,$4,$5,$6)
                     on conflict (profile_id, title) do update set due_at=excluded.due_at, recurring=excluded.recurring, status=excluded.status, note=excluded.note`,
        [PROFILE, title, due, recurring, status, note]);
      bump('mrs_requirements');
    }

    // ---- backfill existing tables
    for (const a of (await c.query('select id, course, due, data from assignments where profile_id=$1', [PROFILE])).rows) {
      await c.query('update assignments set due_date=$2, course_id=$3, kind=$4, marks=$5 where id=$1',
        [a.id, /^\d{4}-\d{2}-\d{2}$/.test(a.due || '') ? a.due : null, courseFor(a.course), a.data?.type || null, a.data?.marks || null]);
      bump('assignments_backfilled');
    }
    for (const n of (await c.query('select id, seen_at, data from notifications where profile_id=$1', [PROFILE])).rows) {
      await c.query('update notifications set category=$2, posted_on=$3 where id=$1', [n.id, n.data?.category || null, parseDay(n.seen_at)]);
      bump('notifications_backfilled');
    }
    for (const e of (await c.query('select id, title from calendar_events where profile_id=$1', [PROFILE])).rows) {
      await c.query('update calendar_events set course_id=$2 where id=$1', [e.id, courseFor(e.title)]);
      bump('calendar_backfilled');
    }

    // ---- exams (from calendar; consecutive days with the same title are merged)
    const ex = (await c.query(
      `select title, min(date) as starts_on, max(date) as ends_on from calendar_events
       where profile_id=$1 and (title ~* '(end term exam|mid term exam|final exam|viva|baseline assessment)') and title !~* 'prep'
       group by title, date_trunc('month', date) order by 2`, [PROFILE])).rows;
    for (const e of ex) {
      await c.query(`insert into exams (profile_id, course_id, title, starts_on, ends_on, source) values ($1,$2,$3,$4,$5,'calendar')
                     on conflict (profile_id, title, starts_on) do update set course_id=excluded.course_id, ends_on=excluded.ends_on`,
        [PROFILE, courseFor(e.title), e.title, e.starts_on, e.ends_on]);
      bump('exams');
    }

    await c.query('commit');
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  console.log(JSON.stringify(counts, null, 1));
  await pool.end();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
