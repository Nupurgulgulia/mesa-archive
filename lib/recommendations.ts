// Rules that turn the archive into "what should I do" items. Every item says why it is there.
// Assumptions that are guesses are labelled as such in the text.
import { q, PROFILE } from './db';
import { daysBetween, fmtDay, relDays, todayIST } from './dates';

export type Reco = {
  priority: 'high' | 'medium' | 'low';
  area: string;
  title: string;
  why: string;
  action?: string;
  href?: string;
  date?: string;
};

const nextSunday = (today: string) => {
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7 || 7) % 7);
  return d.toISOString().slice(0, 10);
};

export async function buildRecommendations(): Promise<Reco[]> {
  const today = todayIST();
  const out: Reco[] = [];

  const [mrsReq, mrs, pending, att, exams, cal, notes, gaps, prep, recs] = await Promise.all([
    q<{ title: string; due: string | null; recurring: string | null; note: string | null }>(
      `select title, to_char(due_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') due, recurring, note from mrs_requirements where profile_id=$1`, [PROFILE]),
    q<{ sitting: string; title: string | null; score: string | null; status: string | null }>(`select sitting, title, score::text, status from mrs where profile_id=$1 order by sitting`, [PROFILE]),
    q<{ title: string; course: string; course_id: string | null; due_date: string | null; marks: string | null }>(
      `select a.title, coalesce(c.short_title, a.course) course, a.course_id, a.due_date::text, a.marks from assignments a left join courses c on c.id=a.course_id
       where a.profile_id=$1 and a.status='Pending' order by a.due_date desc nulls last`, [PROFILE]),
    q<{ subject: string; course_id: string | null; attended: number; total: number; pct: string; term: string | null; recs: string }>(
      `select a.subject, a.course_id, a.attended, a.total, a.pct::text, c.term, (select count(*) from recordings r where r.course_id=a.course_id)::text recs
       from attendance a left join courses c on c.id=a.course_id where a.profile_id=$1 and a.subject<>'Overall' and a.as_of=(select max(as_of) from attendance where profile_id=$1)`, [PROFILE]),
    q<{ title: string; starts_on: string; course_id: string | null }>(
      `select title, starts_on::text, course_id from exams where profile_id=$1 and starts_on >= $2::date order by starts_on`, [PROFILE, today]),
    q<{ date: string; start_time: string; title: string }>(
      `select date::text, start_time, title from calendar_events where profile_id=$1 and date >= $2::date order by date, start_time`, [PROFILE, today]),
    q<{ title: string; body: string; posted_on: string }>(`select title, body, posted_on::text from notifications where profile_id=$1`, [PROFILE]),
    q<{ needs_login: string; anns: string; last_sync: string | null }>(
      `select (select count(*) from link_targets where profile_id=$1 and export_status='needs_login')::text needs_login,
              (select count(*) from announcements where profile_id=$1 and body is null)::text anns,
              (select max(ran_at)::text from sync_log where profile_id=$1 and status in ('ok','partial')) last_sync`, [PROFILE]),
    q<{ id: string; short_title: string; chunks: string; items: string; attempts: string }>(
      `select c.id, c.short_title, (select count(*) from doc_chunks d where d.course_id=c.id)::text chunks,
              (select count(*) from exam_items i where i.course_id=c.id and not i.retired)::text items,
              (select count(*) from attempts a join exam_items i on i.id=a.item_id where i.course_id=c.id)::text attempts
       from courses c where c.profile_id=$1 and c.term='Term 2' order by c.title`, [PROFILE]),
    q<{ due: string }>(`select count(*)::text due from srs_state where profile_id=$1 and due_at <= now()`, [PROFILE]),
  ]);

  // ---------- MRS ----------
  for (const r of mrsReq) {
    if (r.due) {
      const n = daysBetween(today, r.due.slice(0, 10));
      if (n >= -1) out.push({
        priority: n <= 7 ? 'high' : 'medium', area: 'MRS', date: r.due.slice(0, 10),
        title: `${r.title}: due ${fmtDay(r.due.slice(0, 10))} ${r.due.slice(11)} (${relDays(n)})`,
        why: r.note || 'Current MRS assignment.', action: 'Do it on the MRS Practice Lab well before the deadline.',
      });
    } else if (r.recurring) {
      const sun = nextSunday(today);
      out.push({
        priority: 'high', area: 'MRS', date: sun,
        title: `${r.title}: next one by ${fmtDay(sun)} 23:59`,
        why: `${r.note ?? ''} Eligibility for MRS depends on doing it every week.`.trim(),
        action: 'Set a weekly reminder for Sunday afternoon.',
      });
    }
  }
  // "MRS n" rows are the overall scores; other rows (e.g. "Baseline Submission") are components.
  const sittings = mrs.filter((m) => /^MRS \d/.test(m.sitting));
  const m1 = [...sittings].reverse().find((m) => m.score);
  const nextMrs = sittings.find((m) => !m.score);
  const baseline = mrs.find((m) => /baseline/i.test(m.sitting) && m.score);
  if (m1) out.push({
    priority: 'medium', area: 'MRS',
    title: `Prepare for ${nextMrs?.sitting ?? 'the next MRS'}${nextMrs?.title && !/^mesa readiness score/i.test(nextMrs.title) ? `: ${nextMrs.title}` : ''}`,
    why: `${m1.sitting} is ${m1.score}/100${baseline ? ` (your baseline submission scored ${baseline.score} on the MRS scale)` : ''}. ${/locked|not yet scheduled/i.test(nextMrs?.status ?? '') ? 'The next sitting isn’t open yet, so there is time to move the number.' : ''}`,
    action: 'Use the MRS Practice Lab’s AI interviewer (live since 13 Oct) for practice interviews, and look at what MRS 1 marked you down on.',
  });

  // ---------- assignments ----------
  for (const a of pending) {
    const n = a.due_date ? daysBetween(today, a.due_date) : null;
    const marked = a.marks != null && a.marks !== '' && a.marks !== '0';
    out.push({
      priority: n != null && n >= -2 && n <= 7 ? 'high' : n != null && n < -2 ? 'medium' : 'low',
      area: 'Assignments', date: a.due_date ?? undefined, href: a.course_id ? `/courses/${a.course_id}` : undefined,
      title: `${a.title} (${a.course})`,
      why: a.due_date
        ? (n! < 0 ? `Marked pending on Nexus and its due date (${fmtDay(a.due_date)}) has passed.` : `Due ${fmtDay(a.due_date)} (${relDays(n!)}).`)
        : marked
          ? `Marked pending on Nexus with no due date, but it already shows marks (${a.marks}), so it was probably sat in class and “pending” only means nothing was uploaded. This is a guess.`
          : 'Marked pending on Nexus with no due date shown.',
      action: n != null && n < 0 ? 'Check on Nexus whether it can still be submitted, or ask the course team whether it counts.'
        : marked ? 'Nothing to do unless the course team asks for an upload; check the marks are what you expected.'
        : n == null ? 'Check on Nexus whether it still needs anything from you.' : 'Submit on Nexus under Assignments.',
    });
  }

  // ---------- attendance ----------
  // MESA's attendance rule is not in the archive; 75% is a common threshold and is used here as a GUESS.
  for (const a of att.filter((x) => Number(x.pct) < 75)) {
    const ended = a.term === 'Term 1';
    out.push({
      priority: ended ? 'medium' : 'high', area: 'Attendance', href: a.course_id ? `/courses/${a.course_id}` : undefined,
      title: `${a.subject}: ${a.pct}% (${a.attended}/${a.total})`,
      why: `Below 75%. That threshold is a guess; MESA’s actual attendance rule isn’t in the archive.${ended ? ' The course has ended, so this can’t be improved by attending.' : ''}`,
      action: ended
        ? `Ask the programme office whether this affects your grade or eligibility (a leave ticket fixed attendance once before, TKT-1505/1506). Watch the ${a.recs} class recordings for the sessions you missed.`
        : 'Don’t miss the next sessions; raise a leave ticket for any genuine absence.',
    });
  }
  const t2 = att.filter((x) => x.term === 'Term 2');
  if (t2.length) out.push({
    priority: 'low', area: 'Attendance', title: 'Term 2 attendance is on track so far',
    why: t2.map((x) => `${x.subject} ${x.attended}/${x.total}`).join(', ') + '. Term 1 ended with two courses below 75%; the pattern to avoid is missing back-to-back sessions of one course.',
  });

  // ---------- exams + prep ----------
  const thin = prep.filter((p) => Number(p.chunks) < 50).map((p) => p.short_title);
  const noItems = prep.filter((p) => Number(p.chunks) > 0 && Number(p.items) === 0).map((p) => p.short_title);
  const practised = prep.filter((p) => Number(p.attempts) > 0).map((p) => p.short_title);
  exams.slice(0, 3).forEach((e, i) => {
    const n = daysBetween(today, e.starts_on);
    out.push({
      priority: n <= 21 ? 'high' : 'medium', area: 'Exams', date: e.starts_on, href: e.course_id ? `/exam/${e.course_id}` : '/exam',
      title: `${e.title}: ${fmtDay(e.starts_on)} (${relDays(n)})`,
      why: i > 0 ? 'Same Term 2 preparation as above.' : [
        noItems.length ? `No practice questions yet for: ${noItems.join(', ')}.` : 'Practice questions exist for every Term 2 course with material.',
        thin.length ? `Little or no material archived yet for: ${thin.join(', ')} (Term 2 uploads will come in through the sync).` : '',
        practised.length ? `Practised so far: ${practised.join(', ')}.` : 'No Term 2 practice attempts yet.',
      ].filter(Boolean).join(' '),
      action: i > 0 ? undefined : 'Generate questions per course in Exam prep, then take a mock and work the weak topics.',
    });
  });
  if (Number(recs[0]?.due) > 0) out.push({ priority: 'medium', area: 'Exams', href: '/exam', title: `${recs[0].due} review cards are due`, why: 'Spaced repetition only works if you review on the day cards come due.' });

  // ---------- programme opportunities from the calendar ----------
  const find = (re: RegExp) => cal.filter((c) => re.test(c.title));
  const primer = find(/Specialisation Primer/i);
  if (primer.length) out.push({
    priority: 'medium', area: 'Specialisation', date: primer[0].date,
    title: `Specialisation Primer: ${primer.map((p) => fmtDay(p.date)).join(', ')}`,
    why: 'These sessions come before you choose a specialisation; the choice shapes Term 3 onwards.',
    action: 'Attend all of them and write down two questions per session about the career paths you’re weighing.',
  });
  const ils = find(/ILS|BSL/);
  if (ils.length) {
    const bsl = find(/BSL Presentation/);
    out.push({
      priority: 'medium', area: 'ILS / BSL', date: ils[0].date,
      title: `ILS/BSL: ${ils.length} building blocks scheduled${bsl.length ? `; BSL presentations ${fmtDay(bsl[0].date)}–${fmtDay(bsl[bsl.length - 1].date)}` : ''}`,
      why: 'The ILS/BSL opt-in closed on 16 Oct. The archive doesn’t record whether or which track you opted into.',
      action: 'Confirm your track on Nexus, then treat the building-time blocks as real working sessions with a weekly target.',
    });
  }
  const parth = notes.find((n) => /office-hour|1:1 slots|101 with Parth/i.test(n.title + ' ' + n.body));
  const doubt = find(/Doubt Clearing|Office Hours/i);
  out.push({
    priority: 'medium', area: 'Office hours',
    title: 'Use office hours and doubt-clearing sessions',
    why: [
      parth ? `Parth opened office-hour slots (“${parth.title}”), bookable on Nexus.` : '',
      doubt.length ? `Next doubt-clearing/office-hour slot on the calendar: ${fmtDay(doubt[0].date)} ${doubt[0].start_time}.` : 'No doubt-clearing slots on the calendar yet for Term 2.',
    ].join(' '),
    action: 'Book one 1:1 in the next two weeks with a specific question (MRS feedback, specialisation, or a weak exam topic).',
  });
  const leaders = find(/Startup Leader|Start-up Leader/i);
  if (leaders.length) out.push({
    priority: 'low', area: 'Events', date: leaders[0].date,
    title: `Startup Leader sessions: ${leaders.slice(0, 5).map((l) => fmtDay(l.date)).join(', ')}`,
    why: 'Founder sessions are the closest thing to a network at MESA; one Startup Leader submission is still marked pending.',
    action: 'Prepare one question per speaker in advance and follow up on LinkedIn the same day.',
  });
  const big = find(/Demo Day|Hackathon|What is/i);
  if (big.length) out.push({
    priority: 'low', area: 'Events', date: big[0].date,
    title: `Also coming up: ${[...new Set(big.map((b) => `${b.title} (${fmtDay(b.date)})`))].slice(0, 4).join(', ')}`,
    why: 'Things that end up on a CV or in an interview story.',
  });

  // ---------- archive health ----------
  if (Number(gaps[0]?.needs_login) > 0) out.push({
    priority: 'medium', area: 'Archive', title: `${gaps[0].needs_login} linked Google files need your login to be saved`,
    why: 'They are restricted to your MESA Google account (Orientation Hand Book; Entrepreneurship 101 Session 3 and 4 decks).',
    action: 'Sign in to Google in the browser pane and ask Claude to fetch them; access ends when you leave MESA.',
  });
  out.push({
    priority: gaps[0]?.last_sync ? 'low' : 'medium', area: 'Archive',
    title: gaps[0]?.last_sync ? `Last sync ${gaps[0].last_sync.slice(0, 16)}` : 'No sync has run since the 20 Oct capture',
    why: `Term 2 material, announcement text (${gaps[0]?.anns ?? 0} announcements are titles only) and new assignments only arrive through the sync.`,
    action: 'Keep the sync running while you still have Nexus access (it needs this computer on and you logged in).',
  });

  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.priority] - order[b.priority] || (a.date ?? '9999').localeCompare(b.date ?? '9999'));
}
