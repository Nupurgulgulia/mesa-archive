import Link from 'next/link';
import { q, PROFILE } from '@/lib/db';
import { daysBetween, fmtDate, fmtDay, relDays, todayIST } from '@/lib/dates';

export const dynamic = 'force-dynamic';

type Exam = { id: string; title: string; starts_on: string; ends_on: string | null; course_id: string | null; short_title: string | null };
type Due = { kind: string; title: string; course: string | null; due: string | null; status: string; href: string | null };
type Ev = { date: string; start_time: string; end_time: string; title: string; kind: string; course_id: string | null };

export default async function Home() {
  const today = todayIST();
  const [exams, dues, week, srs, weak, att, notes, sync] = await Promise.all([
    q<Exam>(`select e.id, e.title, e.starts_on::text, e.ends_on::text, e.course_id, c.short_title
             from exams e left join courses c on c.id=e.course_id where e.profile_id=$1 and coalesce(e.ends_on,e.starts_on) >= $2::date
             order by e.starts_on limit 6`, [PROFILE, today]),
    q<Due>(`select 'MRS' kind, title, null course, to_char(due_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') due, coalesce(status,'') status, null href
              from mrs_requirements where profile_id=$1 and (due_at is null or due_at >= now() - interval '1 day')
            union all
            select 'Assignment', a.title, coalesce(c.short_title, a.course), a.due_date::text, a.status, case when a.course_id is not null then '/courses/'||a.course_id end
              from assignments a left join courses c on c.id=a.course_id where a.profile_id=$1 and a.status='Pending'
            order by 4 nulls last`, [PROFILE]),
    q<Ev>(`select date::text, start_time, end_time, title, kind, course_id from calendar_events
           where profile_id=$1 and date between $2::date and $2::date + 6 order by date, start_time`, [PROFILE, today]),
    q<{ due: string; total: string }>(`select count(*) filter (where due_at <= now()) due, count(*) total from srs_state where profile_id=$1`, [PROFILE]),
    q<{ course_id: string; short_title: string; topic: string; accuracy: string; attempts: string }>(
      `select m.course_id, c.short_title, m.topic, m.accuracy::text, m.attempts::text from topic_mastery m join courses c on c.id=m.course_id
       where m.profile_id=$1 and m.attempts >= 3 and m.accuracy < 0.7 order by m.accuracy limit 5`, [PROFILE]),
    q<{ subject: string; attended: number; total: number; pct: string; course_id: string | null }>(
      `select subject, attended, total, pct::text, course_id from attendance where profile_id=$1 and as_of=(select max(as_of) from attendance where profile_id=$1) order by pct`, [PROFILE]),
    q<{ title: string; body: string; category: string; posted_on: string }>(
      `select title, body, category, posted_on::text from notifications where profile_id=$1 order by posted_on desc nulls last, id limit 5`, [PROFILE]),
    q<{ ran_at: string; status: string; new_items: number }>(`select ran_at::text, status, new_items from sync_log where profile_id=$1 order by ran_at desc limit 1`, [PROFILE]),
  ]);

  // Weekly MRS requirement: show the next Sunday. Then order: upcoming (soonest first),
  // overdue (most recent first), then items Nexus shows without a date.
  const sunday = (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7)); return d.toISOString().slice(0, 10); })();
  for (const d of dues) if (d.kind === 'MRS' && !d.due) { d.due = `${sunday} 23:59`; d.status = 'weekly, every Sunday'; }
  const rank = (d: Due) => { const date = d.due?.slice(0, 10); if (!date) return [2, 0]; const n = daysBetween(today, date); return n >= 0 ? [0, n] : [1, -n]; };
  dues.sort((a, b) => { const ra = rank(a), rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1]; });

  const overall = att.find((a) => a.subject === 'Overall');
  const days = [...new Set(week.map((e) => e.date))];

  return (
    <main className="stack">
      <div className="row">
        <div>
          <h1>Good {greeting()}, Nupur</h1>
          <p className="muted">{fmtDate(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · Term 2</p>
        </div>
        <span className="spacer" />
        <span className="pill">{sync[0] ? `Last sync ${fmtDate(sync[0].ran_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Archive captured 20 Oct; no sync yet'}</span>
      </div>

      <div className="grid three">
        {exams.slice(0, 3).map((e) => {
          const d = daysBetween(today, e.starts_on);
          return (
            <Link key={e.id} href={e.course_id ? `/exam/${e.course_id}` : '/exam'} className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="stat-label">{e.short_title ? 'Exam' : 'Exam window'}</div>
              <div className="stat">{d <= 0 ? 'Today' : `${d} days`}</div>
              <div><strong>{e.title}</strong></div>
              <div className="muted small">{fmtDay(e.starts_on)}{e.ends_on && e.ends_on !== e.starts_on ? ` – ${fmtDay(e.ends_on)}` : ''}</div>
            </Link>
          );
        })}
      </div>

      <div className="grid two">
        <section className="card">
          <div className="row"><h2>What’s due</h2><span className="spacer" /><Link href="/recommendations" className="small">All recommendations →</Link></div>
          <ul className="list">
            {dues.map((d, i) => {
              const date = d.due?.slice(0, 10);
              const n = date ? daysBetween(today, date) : null;
              return (
                <li key={i} className="row">
                  <span className={`pill ${n != null && n >= 0 && n <= 7 ? 'bad' : n != null && n < 0 ? 'warn' : ''}`}>{n != null && n < 0 ? 'Overdue' : d.kind}</span>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    {d.href ? <Link href={d.href}>{d.title}</Link> : d.title}
                    <div className="muted small">{d.course ?? ''}{d.course && ' · '}{date ? `${fmtDay(date)}${d.due && d.due.length > 10 ? ' ' + d.due.slice(11) : ''} (${relDays(n!)})` : 'no due date on Nexus'}{d.status && d.kind === 'MRS' ? ` · ${d.status}` : ''}</div>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="muted small">Pending = still marked pending on Nexus on 20 Oct. Past-due items may or may not still be accepted; check with the course team.</p>
        </section>

        <section className="card">
          <h2>This week</h2>
          {days.length === 0 && <p className="muted">Nothing on the calendar.</p>}
          {days.map((day) => (
            <div key={day} style={{ marginBottom: 10 }}>
              <div className="small" style={{ fontWeight: 700 }}>{day === today ? 'Today' : fmtDay(day)}</div>
              {week.filter((e) => e.date === day).map((e, i) => (
                <div key={i} className="tl-item small">
                  <span className="tl-time">{e.start_time}–{e.end_time}</span>
                  <span>{e.course_id ? <Link href={`/courses/${e.course_id}`}>{e.title}</Link> : e.title}</span>
                  {e.kind !== 'class' && <span className="pill">{e.kind}</span>}
                </div>
              ))}
            </div>
          ))}
          <Link href="/timeline" className="small">Full timeline →</Link>
        </section>
      </div>

      <div className="grid three">
        <section className="card">
          <h2>Review queue</h2>
          <div className="stat">{srs[0]?.due ?? 0}</div>
          <div className="stat-label">cards due now, of {srs[0]?.total ?? 0} in rotation</div>
          <p style={{ marginTop: 10 }}><Link href="/exam" className="btn small">Open exam prep</Link></p>
        </section>
        <section className="card">
          <h2>Weak topics</h2>
          {weak.length === 0 ? <p className="muted small">None yet. Weak topics appear after a few attempts per topic.</p> : (
            <ul className="list small">
              {weak.map((w, i) => (
                <li key={i}><Link href={`/exam/${w.course_id}`}>{w.topic}</Link> <span className="muted">· {w.short_title}</span>
                  <span className="pill bad" style={{ marginLeft: 6 }}>{Math.round(Number(w.accuracy) * 100)}%</span></li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2>Attendance</h2>
          {overall && <><div className="stat">{Math.round(Number(overall.pct))}%</div><div className="stat-label">{overall.attended}/{overall.total} overall (Nexus, 20 Oct)</div></>}
          <ul className="list small" style={{ marginTop: 8 }}>
            {att.filter((a) => a.subject !== 'Overall' && Number(a.pct) < 75).map((a) => (
              <li key={a.subject}>{a.subject} <span className="pill bad">{a.pct}%</span> <span className="muted">{a.attended}/{a.total}</span></li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card">
        <h2>Latest from Nexus</h2>
        <ul className="list">
          {notes.map((n, i) => (
            <li key={i}><span className="pill">{n.category}</span> <strong>{n.title}</strong> <span className="muted small">· {fmtDay(n.posted_on)}</span><div className="small">{n.body}</div></li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date()));
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}
