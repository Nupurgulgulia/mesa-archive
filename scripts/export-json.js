// Rebuild data/mesa_data_<date>.json from the database, in the same shape as the
// hand-captured data/mesa_data.json (20 Oct), with the richer fields the sync added.
// Usage: node scripts/export-json.js [outFile]
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');

const P = 'nupur';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const out = process.argv[2] || path.join(__dirname, '..', 'data', `mesa_data_${today}.json`);
const rows = async (sql, params = [P]) => (await db.q(sql, params)).rows;
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)));
const ist = (col) => `to_char(${col} at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI')`;

(async () => {
  const [profile] = await rows('select name, program, lms from profiles where id = $1');
  const orig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'mesa_data.json'), 'utf8'));

  const courses = await rows(`select id, term, title, short_title, faculty, mode, outline, category,
      to_char(start_date,'YYYY-MM-DD') start_date, to_char(end_date,'YYYY-MM-DD') end_date
    from courses where profile_id = $1 order by term, title`);
  const files = await rows(`select course_id, tab, folder, folder_date, coalesce(label, name) label, name, type, size,
      size_bytes, storage_key, sha256, links, ${ist('first_seen')} first_seen
    from files where profile_id = $1 and status = 'archived' order by course_id, path, dup_index`);
  const recs = await rows(`select course_id, title, coalesce(to_char(rec_date,'YYYY-MM-DD'), date) date, youtube_id, url
    from recordings where profile_id = $1 order by course_id, rec_date nulls last, title`);
  const anns = await rows(`select course_id, title, body, author, ${ist('posted_at')} posted, posted posted_text
    from announcements where profile_id = $1 order by posted_at nulls last, id`);
  const exams = await rows(`select course_id, title, to_char(starts_on,'YYYY-MM-DD') starts_on, to_char(ends_on,'YYYY-MM-DD') ends_on
    from exams where profile_id = $1 order by starts_on`);

  const by = (list) => list.reduce((m, r) => ((m[r.course_id] ||= []).push(r), m), {});
  const fBy = by(files), rBy = by(recs), aBy = by(anns);

  const courseOut = courses.map((c) => {
    const folders = [];
    for (const f of fBy[c.id] || []) {
      let fo = folders.find((x) => x.tab === f.tab && x.name === f.folder);
      if (!fo) folders.push((fo = strip({ tab: f.tab, name: f.folder, date: f.folder_date, files: [] })));
      fo.files ||= [];
      fo.files.push(strip({ name: f.label, type: f.type, size: f.size || '', bytes: f.size_bytes ? Number(f.size_bytes) : null,
        archive_key: f.storage_key, sha256: f.sha256, links: f.links, first_seen: f.first_seen }));
    }
    return strip({
      id: c.id, term: c.term, title: c.title, short_title: c.short_title, faculty: c.faculty, mode: c.mode,
      category: c.category, start_date: c.start_date, end_date: c.end_date, outline: c.outline,
      folders,
      announcements: (aBy[c.id] || []).map((a) => strip({ title: a.title, posted: a.posted || a.posted_text, author: a.author, text: a.body })),
      recordings: (rBy[c.id] || []).map((r) => strip({ title: r.title, date: r.date, youtube_id: r.youtube_id, url: r.url })),
      exams: exams.filter((e) => e.course_id === c.id).map((e) => strip({ title: e.title, starts_on: e.starts_on, ends_on: e.ends_on })),
    });
  });

  // Calendar status is recomputed for today; the stored value is from capture time.
  const calendar = (await rows(`select to_char(date,'YYYY-MM-DD') date, start_time, end_time, title, term, kind, event_type
    from calendar_events where profile_id = $1 order by date, start_time nulls first, title`)).map((e) =>
    strip({ date: e.date, start: e.start_time, end: e.end_time, title: e.title, term: e.term, kind: e.kind,
      status: e.date < today ? 'past' : e.date === today ? 'today' : 'upcoming' }));

  const subLabel = { submitted: 'Submitted', late: 'Late', not_submitted: 'Not submitted' };
  const assignments = (await rows(`select coalesce(to_char(due_date,'YYYY-MM-DD'), due) due, ${ist('due_at')} due_at, title, kind, course,
      status, submission_status, max_marks from assignments where profile_id = $1 order by due_date nulls last, title`)).map((a) =>
    strip({ due: a.due, due_at: a.due_at, title: a.title, type: a.kind, course: a.course,
      status: subLabel[a.submission_status] || a.status, max_marks: a.max_marks }));

  const notifications = (await rows(`select coalesce(to_char(posted_on,'YYYY-MM-DD'), seen_at) "when", ${ist('created_at')} at,
      category, title, body from notifications where profile_id = $1 order by created_at desc nulls last, posted_on desc nulls last`)).map((n) =>
    strip({ when: n.when, at: n.at, category: n.category, title: n.title, text: n.body }));

  // Attendance: latest snapshot per subject.
  const att = await rows(`select distinct on (subject) subject, attended, total, pct, note, to_char(as_of,'YYYY-MM-DD') as_of
    from attendance where profile_id = $1 order by subject, as_of desc`);
  const overall = att.find((a) => a.subject === 'Overall');
  const sessions = await rows(`select course_name course, event_title title, ${ist('start_at')} start, status, term_name term
    from attendance_sessions where profile_id = $1 order by start_at`);

  const mrs = await rows(`select sitting, title, score, out_of, marks, max_marks, status, to_char(as_of,'YYYY-MM-DD') as_of
    from mrs where profile_id = $1 order by case when slug = 'baseline' then 0 else 1 end, slug`);
  const mrsReq = await rows(`select title, ${ist('due_at')} due, recurring, status, note from mrs_requirements where profile_id = $1 order by id`);
  const mrs1 = mrs.find((m) => m.sitting === 'MRS 1');

  const [lastSync] = await rows(`select run_id, status, ${ist('finished_at')} finished from sync_log
    where profile_id = $1 and status = 'ok' order by finished_at desc limit 1`);

  const data = {
    student: profile?.name || orig.student,
    program: profile?.program || orig.program,
    lms: profile?.lms || orig.lms,
    captured: today,
    source: `Exported from the MESA Archive database (Neon). Last successful Nexus sync: ${lastSync ? `${lastSync.finished} IST (run ${lastSync.run_id})` : 'none'}. Supersedes the hand-captured data/mesa_data.json of ${orig.captured}.`,
    grades: 'No grade values are captured. Nexus sent 5 "grade is now available" notifications on 10 Oct (mid-terms); the sync does not read the scores. assignments[].max_marks is the maximum, not your score.',
    terms: orig.terms,
    courses: courseOut,
    calendar,
    assignments,
    notifications,
    attendance: {
      overall: overall ? `${overall.attended}/${overall.total} (${Number(overall.pct)}%)` : null,
      as_of: overall?.as_of,
      subjects: att.filter((a) => a.subject !== 'Overall').map((a) => [a.subject, `${a.attended}/${a.total}`, `${Number(a.pct)}%`, a.note || '']),
      subjects_columns: ['course', 'attended/total', 'percent', 'class participation'],
      sessions,
    },
    mrs: {
      score: mrs1?.score != null ? Number(mrs1.score) : null,
      out_of: 100,
      sittings: mrs.map((m) => strip({ sitting: m.sitting, title: m.title, score: m.score != null ? Number(m.score) : null,
        marks: m.marks != null ? `${Number(m.marks)}/${Number(m.max_marks)}` : null, status: m.status, as_of: m.as_of })),
      requirements: mrsReq.map(strip),
    },
    counts: {
      courses: courseOut.length,
      items: files.length,
      files: files.filter((f) => !['LINK', 'NOTE'].includes(f.type)).length,
      notes_links: files.filter((f) => ['LINK', 'NOTE'].includes(f.type)).length,
      recordings: recs.length,
      announcements: anns.length,
      calendar: calendar.length,
      assignments: assignments.length,
      notifications: notifications.length,
      attendance_sessions: sessions.length,
    },
  };

  fs.writeFileSync(out, JSON.stringify(data, null, 1));
  console.log(out, fs.statSync(out).size, 'bytes');
  console.log(data.counts);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
