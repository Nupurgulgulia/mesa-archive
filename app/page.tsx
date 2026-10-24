import Link from 'next/link';
import { q, PROFILE } from '@/lib/db';
import { daysBetween, fmtDate, fmtDay, relDays, todayIST } from '@/lib/dates';
import { currentTerm, getTerm, termLabel, termParam } from '@/lib/term';
import { Icon } from './icons';

export const dynamic = 'force-dynamic';

type Exam = { id: string; title: string; starts_on: string; ends_on: string | null; course_id: string | null; short_title: string | null };
type Due = { kind: string; title: string; course: string | null; due: string | null; status: string; href: string | null };
type Ev = { date: string; start_time: string; end_time: string; title: string; kind: string; course_id: string | null };
type Att = { subject: string; attended: number; total: number; pct: string; course_id: string; short_title: string | null };

// Term of a row: its course's term, else the term its date falls in.
const TERM_OF = (courseTerm: string, date: string) =>
  `coalesce(${courseTerm}, case when ${date} < '2026-08-10' then 'Pre-Term' when ${date} < '2026-10-19' then 'Term 1' else 'Term 2' end)`;

export default async function Home() {
  const today = todayIST();
  const term = await getTerm();
  const T = termParam(term);
  const isNow = term === 'all' || term === currentTerm();

  const [exams, dues, week, srs, weak, att, notes, sync, asgStats, recCount, recap] = await Promise.all([
    q<Exam>(`select e.id, e.title, e.starts_on::text, e.ends_on::text, e.course_id, c.short_title
             from exams e left join courses c on c.id=e.course_id
             where e.profile_id=$1 and ($2='' or ${TERM_OF('c.term', 'e.starts_on')}=$2)
               and (not $3 or coalesce(e.ends_on,e.starts_on) >= $4::date)
             order by e.starts_on limit 6`, [PROFILE, T, isNow, today]),
    q<Due>(`select 'MRS' kind, title, null course, to_char(due_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') due, coalesce(status,'') status, null href
              from mrs_requirements where profile_id=$1 and $3 and (due_at is null or due_at >= now() - interval '1 day')
            union all
            select 'Assignment', a.title, coalesce(c.short_title, a.course), a.due_date::text, a.status, case when a.course_id is not null then '/courses/'||a.course_id end
              from assignments a left join courses c on c.id=a.course_id
              where a.profile_id=$1 and a.status='Pending' and ($2='' or ${TERM_OF('c.term', "coalesce(a.due_date,'2026-10-19')")}=$2)
            order by 4 nulls last`, [PROFILE, T, isNow]),
    q<Ev>(`select date::text, start_time, end_time, title, kind, course_id from calendar_events
           where profile_id=$1 and date between $2::date and $2::date + 6 order by date, start_time`, [PROFILE, today]),
    q<{ due: string; total: string }>(`select count(*) filter (where s.due_at <= now()) due, count(*) total from srs_state s
           join exam_items i on i.id=s.item_id join courses c on c.id=i.course_id where s.profile_id=$1 and ($2='' or c.term=$2)`, [PROFILE, T]),
    q<{ course_id: string; short_title: string; topic: string; accuracy: string; attempts: string }>(
      `select m.course_id, c.short_title, m.topic, m.accuracy::text, m.attempts::text from topic_mastery m join courses c on c.id=m.course_id
       where m.profile_id=$1 and ($2='' or c.term=$2) and m.attempts >= 3 and m.accuracy < 0.7 order by m.accuracy limit 5`, [PROFILE, T]),
    q<Att>(`select * from (select distinct on (a.course_id) a.subject, a.attended, a.total, a.pct::text, a.course_id, c.short_title
             from attendance a join courses c on c.id=a.course_id
             where a.profile_id=$1 and ($2='' or c.term=$2) order by a.course_id, a.as_of desc) x order by pct::numeric`, [PROFILE, T]),
    q<{ title: string; body: string; category: string; posted_on: string }>(
      `select title, body, category, posted_on::text from notifications
       where profile_id=$1 and ($2='' or ${TERM_OF('null', 'posted_on')}=$2) order by posted_on desc nulls last, id limit 5`, [PROFILE, T]),
    q<{ ran_at: string; status: string; new_items: number }>(`select ran_at::text, status, new_items from sync_log where profile_id=$1 and status='ok' order by ran_at desc limit 1`, [PROFILE]),
    q<{ total: string; done: string; pending: string }>(
      `select count(*) total, count(*) filter (where a.status<>'Pending') done, count(*) filter (where a.status='Pending') pending
       from assignments a left join courses c on c.id=a.course_id
       where a.profile_id=$1 and ($2='' or ${TERM_OF('c.term', "coalesce(a.due_date,'2026-10-19')")}=$2)`, [PROFILE, T]),
    q<{ n: string }>(`select count(*) n from recordings r join courses c on c.id=r.course_id where r.profile_id=$1 and ($2='' or c.term=$2)`, [PROFILE, T]),
    q<{ kind: string; n: string }>(`select kind, count(*) n from calendar_events where profile_id=$1 and ($2='' or term=$2) and date < $3::date group by kind`, [PROFILE, T, today]),
  ]);

  // Weekly MRS requirement: show the next Sunday. Then: upcoming (soonest first), overdue (most recent first), undated.
  const sunday = (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7)); return d.toISOString().slice(0, 10); })();
  for (const d of dues) if (d.kind === 'MRS' && !d.due) { d.due = `${sunday} 23:59`; d.status = 'weekly, every Sunday'; }
  const rank = (d: Due) => { const date = d.due?.slice(0, 10); if (!date) return [2, 0]; const n = daysBetween(today, date); return n >= 0 ? [0, n] : [1, -n]; };
  dues.sort((a, b) => { const ra = rank(a), rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1]; });

  const sum = att.reduce((s, a) => ({ a: s.a + a.attended, t: s.t + a.total }), { a: 0, t: 0 });
  const attPct = sum.t ? Math.round((sum.a / sum.t) * 1000) / 10 : null;
  const days = [...new Set(week.map((e) => e.date))];
  const stats = asgStats[0];
  const held = Object.fromEntries(recap.map((r) => [r.kind, Number(r.n)]));

  return (
    <main className="stack">
      <section className="hero">
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="row" style={{ gap: 6, marginBottom: 8 }}>
            <span className="pill mint">{termLabel(term)}</span>
            {!isNow && <span className="pill">Past term · archive view</span>}
            <span className="pill">{sync[0] ? `Synced ${fmtDate(sync[0].ran_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Not synced yet'}</span>
          </div>
          <h1>Good {greeting()}, Nupur</h1>
          <p>{fmtDate(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
        {isNow && exams.slice(0, 2).map((e) => {
          const d = daysBetween(today, e.starts_on);
          return (
            <Link key={e.id} href={e.course_id ? `/exam/${e.course_id}` : '/exam'} className="countdown" style={{ color: 'inherit', minWidth: 150 }}>
              <span className="stat">{d < 0 ? `${-d}d ago` : d === 0 ? 'Today' : `${d} days`}</span>
              <span className="small" style={{ color: '#e3ebe8' }}>{e.title}</span>
              <span className="small" style={{ color: '#9fb0aa' }}>{fmtDay(e.starts_on)}{e.ends_on && e.ends_on !== e.starts_on ? ` – ${fmtDay(e.ends_on)}` : ''}</span>
            </Link>
          );
        })}
      </section>

      <div className="grid four">
        <Kpi icon="users" tone={attPct != null && attPct < 75 ? 'bad' : ''} value={attPct != null ? `${attPct}%` : '—'} label={`attendance · ${sum.a}/${sum.t} sessions`} />
        <Kpi icon="check" tone="lime" value={`${stats?.done ?? 0}/${stats?.total ?? 0}`} label={`assignments done${Number(stats?.pending) ? ` · ${stats!.pending} pending` : ''}`} />
        <Kpi icon="video" tone="ink" value={recCount[0]?.n ?? '0'} label="class recordings" href="/courses" />
        <Kpi icon="target" value={srs[0]?.due ?? '0'} label={`review cards due · ${srs[0]?.total ?? 0} in rotation`} href="/exam" />
      </div>

      <div className="grid two">
        <section className="card">
          <div className="card-head"><h2>{isNow ? 'What’s due' : 'Left pending'}</h2><span className="spacer" /><Link href="/recommendations">Recommendations →</Link></div>
          {dues.length === 0 && <p className="muted small">Nothing pending for {termLabel(term)}.</p>}
          <ul className="list">
            {dues.map((d, i) => {
              const date = d.due?.slice(0, 10);
              const n = date ? daysBetween(today, date) : null;
              const tone = n != null && n < 0 ? 'warn' : n != null && n <= 7 ? 'bad' : '';
              return (
                <li key={i} className="due-row">
                  <div className={`due-date ${tone}`}>
                    {date ? <><b>{fmtDate(date, { day: 'numeric' })}</b><span>{fmtDate(date, { month: 'short' })}</span></> : <><b>—</b><span>no date</span></>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {d.href ? <Link href={d.href}>{d.title}</Link> : <strong style={{ fontWeight: 500 }}>{d.title}</strong>}
                    <div className="muted small">
                      {d.kind === 'MRS' ? 'MRS' : d.course}{date ? ` · ${relDays(n!)}${d.due && d.due.length > 10 ? ' at ' + d.due.slice(11) : ''}` : ' · no due date on Nexus'}
                      {d.status && d.kind === 'MRS' ? ` · ${d.status}` : ''}
                    </div>
                  </div>
                  {n != null && n < 0 && <span className="pill warn">Overdue</span>}
                </li>
              );
            })}
          </ul>
        </section>

        {isNow ? (
          <section className="card">
            <div className="card-head"><h2>This week</h2><span className="spacer" /><Link href="/timeline">Timeline →</Link></div>
            {days.length === 0 && <p className="muted">Nothing on the calendar.</p>}
            {days.map((day) => (
              <div key={day} style={{ marginBottom: 12 }}>
                <div className="small" style={{ fontWeight: 600, marginBottom: 2 }}>{day === today ? 'Today' : fmtDay(day)}</div>
                {week.filter((e) => e.date === day).map((e, i) => (
                  <div key={i} className="tl-item small">
                    <span className="tl-time">{e.start_time}–{e.end_time}</span>
                    <span>{e.course_id ? <Link href={`/courses/${e.course_id}`}>{e.title}</Link> : e.title}</span>
                    {e.kind !== 'class' && <span className={`pill ${e.kind === 'exam' ? 'bad' : ''}`}>{e.kind}</span>}
                  </div>
                ))}
              </div>
            ))}
          </section>
        ) : (
          <section className="card">
            <div className="card-head"><h2>{term} at a glance</h2><span className="spacer" /><Link href="/timeline">Timeline →</Link></div>
            <div className="grid" style={{ gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
              <Mini value={held.class ?? 0} label="classes held" />
              <Mini value={held.exam ?? 0} label="exam slots" />
              <Mini value={held.event ?? 0} label="events" />
              <Mini value={held['self-work'] ?? 0} label="building / study blocks" />
            </div>
            {exams.length > 0 && <>
              <h3 style={{ marginTop: 16 }}>Exams</h3>
              <ul className="list small">{exams.map((e) => <li key={e.id}>{e.title} <span className="muted">· {fmtDay(e.starts_on)}</span></li>)}</ul>
            </>}
          </section>
        )}
      </div>

      <div className="grid two">
        <section className="card">
          <div className="card-head"><h2>Attendance by course</h2><span className="spacer" /><span className="muted small">latest from Nexus</span></div>
          {att.length === 0 && <p className="muted small">No attendance recorded for {termLabel(term)}.</p>}
          {att.map((a) => {
            const p = Number(a.pct);
            return (
              <div key={a.course_id} className="att-row">
                <Link href={`/courses/${a.course_id}`} className="name" style={{ color: 'inherit' }} title={a.subject}>{a.short_title ?? a.subject}</Link>
                <div className={`bar ${p < 75 ? 'bad' : p < 85 ? 'warn' : 'good'}`}><i style={{ width: `${Math.min(100, p)}%` }} /></div>
                <b className={p < 75 ? 'err' : ''}>{Math.round(p)}%</b>
              </div>
            );
          })}
          <p className="muted small" style={{ marginTop: 8 }}>Below 75% is shown in red.</p>
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>Weak topics</h2><span className="spacer" /><Link href="/exam">Exam prep →</Link></div>
            {weak.length === 0 ? <p className="muted small" style={{ margin: 0 }}>None yet. Topics show up here once you’ve tried a few questions on them and are scoring under 70%.</p> : (
              <ul className="list small">
                {weak.map((w, i) => (
                  <li key={i} className="row"><Link href={`/exam/${w.course_id}`}>{w.topic}</Link><span className="muted">{w.short_title}</span>
                    <span className="spacer" /><span className="pill bad">{Math.round(Number(w.accuracy) * 100)}%</span></li>
                ))}
              </ul>
            )}
          </section>
          <section className="card">
            <div className="card-head"><Icon name="bell" /><h2>Latest from Nexus</h2></div>
            {notes.length === 0 && <p className="muted small">No notices for {termLabel(term)}.</p>}
            <ul className="list">
              {notes.map((n, i) => (
                <li key={i}>
                  <div className="row" style={{ gap: 8 }}><strong style={{ fontWeight: 500 }}>{n.title}</strong><span className="spacer" /><span className="muted small">{fmtDay(n.posted_on)}</span></div>
                  <div className="small muted">{n.body}</div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}

function Kpi({ icon, value, label, tone = '', href }: { icon: Parameters<typeof Icon>[0]['name']; value: string; label: string; tone?: string; href?: string }) {
  const body = (<><span className={`icon-tile ${tone}`}><Icon name={icon} /></span><span className="stat">{value}</span><span className="stat-label">{label}</span></>);
  return href ? <Link href={href} className="card kpi">{body}</Link> : <div className="card kpi">{body}</div>;
}

function Mini({ value, label }: { value: number; label: string }) {
  return <div className="card flat" style={{ padding: '12px 14px' }}><div className="stat" style={{ fontSize: '1.4rem' }}>{value}</div><div className="stat-label">{label}</div></div>;
}

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date()));
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}
