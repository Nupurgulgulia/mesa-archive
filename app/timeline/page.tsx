import Link from 'next/link';
import { q, PROFILE } from '@/lib/db';
import { fmtDate, todayIST } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Timeline · MESA Archive' };

type Row = { date: string; time: string | null; kind: string; title: string; detail: string | null; term: string; href: string | null };

const KINDS: [string, string][] = [
  ['class', 'Classes'], ['exam', 'Exams'], ['event', 'Events'], ['self-work', 'Building / study'], ['holiday', 'Holidays'],
  ['assignment', 'Assignments'], ['notice', 'Nexus notices'], ['mrs', 'MRS'], ['recording', 'Recordings'],
];
const DEFAULT_KINDS = ['class', 'exam', 'event', 'holiday', 'assignment', 'notice', 'mrs'];

export default async function Timeline({ searchParams }: { searchParams: Promise<{ term?: string; when?: string; kind?: string | string[]; from?: string }> }) {
  const sp = await searchParams;
  const today = todayIST();
  const term = sp.term || '';
  const when = sp.when || 'all';
  const kinds = sp.kind ? (Array.isArray(sp.kind) ? sp.kind : [sp.kind]) : DEFAULT_KINDS;

  const rows = await q<Row>(
    `with t as (
       select date, start_time || '–' || end_time as time, kind, title, null::text detail, term, case when course_id is not null then '/courses/'||course_id end href
         from calendar_events where profile_id=$1
       union all
       select a.due_date, null, 'assignment', a.title, coalesce(c.short_title, a.course) || ' · ' || a.status || coalesce(' · marks ' || a.marks, ''),
              case when a.due_date < '2026-10-19' then 'Term 1' else 'Term 2' end, case when a.course_id is not null then '/courses/'||a.course_id end
         from assignments a left join courses c on c.id=a.course_id where a.profile_id=$1 and a.due_date is not null
       union all
       select posted_on, null, 'notice', title, category || ' · ' || body, case when posted_on < '2026-10-19' then 'Term 1' else 'Term 2' end, null
         from notifications where profile_id=$1 and posted_on is not null
       union all
       select as_of, null, 'mrs', sitting || coalesce(': ' || title, ''),
              case when score is not null then 'Score ' || score || '/' || out_of || ' · shown on the date it was captured; the sitting date isn’t in the archive' else status end, 'Term 2', '/recommendations'
         from mrs where profile_id=$1 and score is not null
       union all
       select (due_at at time zone 'Asia/Kolkata')::date, to_char(due_at at time zone 'Asia/Kolkata', 'HH24:MI'), 'mrs', title || ' due', note, 'Term 2', '/recommendations'
         from mrs_requirements where profile_id=$1 and due_at is not null
       union all
       select r.rec_date, null, 'recording', r.title || ' · ' || c.short_title, case when r.date_uncertain then 'date uncertain' end,
              c.term, r.url
         from recordings r join courses c on c.id=r.course_id where r.profile_id=$1 and r.rec_date is not null
     )
     select date::text, time, kind, title, detail, term, href from t
     where ($2 = '' or term = $2) and kind = any($3)
       and ($4 = 'all' or ($4 = 'upcoming' and date >= $5::date) or ($4 = 'past' and date < $5::date))
     order by date ${when === 'past' ? 'desc' : ''}, time nulls first, kind`, [PROFILE, term, kinds, when, today]);

  const days = [...new Set(rows.map((r) => r.date))];
  const counts = await q<{ kind: string; n: string }>(
    `select kind, count(*) n from calendar_events where profile_id=$1 and date < $2::date group by kind`, [PROFILE, today]);
  const past = Object.fromEntries(counts.map((c) => [c.kind, Number(c.n)]));

  return (
    <main className="stack">
      <h1>Timeline</h1>
      <p className="muted">Everything at MESA so far and what’s coming: {past.class ?? 0} classes, {past.event ?? 0} events and {past.exam ?? 0} exam slots behind you.</p>
      <form className="card" action="/timeline">
        <div className="row">
          <select name="term" defaultValue={term} style={{ width: 'auto' }}>
            <option value="">All terms</option><option>Term 1</option><option>Term 2</option>
          </select>
          <select name="when" defaultValue={when} style={{ width: 'auto' }}>
            <option value="all">Past and upcoming</option><option value="upcoming">Upcoming</option><option value="past">Past (newest first)</option>
          </select>
          <button className="btn primary small" type="submit">Apply</button>
          <a href="#today" className="btn small">Jump to today</a>
        </div>
        <div className="row small" style={{ marginTop: 10 }}>
          {KINDS.map(([k, label]) => (
            <label key={k} className="row" style={{ gap: 4, fontWeight: 400 }}>
              <input type="checkbox" name="kind" value={k} defaultChecked={kinds.includes(k)} /> {label}
            </label>
          ))}
        </div>
      </form>

      <section className="card">
        {days.length === 0 && <p className="muted">Nothing matches these filters.</p>}
        {days.map((d) => (
          <div key={d} id={d === today || (d > today && !days.includes(today) && days.find((x) => x > today) === d) ? 'today' : undefined}
            className={`tl-day ${d === today ? 'today' : ''}`}>
            <div className="tl-date">{fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' })}<div className="muted small">{d === today ? 'Today' : d < today ? '' : ''}</div></div>
            <div>
              {rows.filter((r) => r.date === d).map((r, i) => (
                <div key={i} className="tl-item">
                  <span className="tl-time">{r.time ?? ''}</span>
                  <span>
                    {r.href ? (r.href.startsWith('http') ? <a href={r.href} target="_blank" rel="noreferrer">{r.title}</a> : <Link href={r.href}>{r.title}</Link>) : r.title}
                    {r.kind !== 'class' && <span className={`pill ${r.kind === 'exam' ? 'bad' : r.kind === 'assignment' ? 'warn' : r.kind === 'holiday' ? 'good' : ''}`} style={{ marginLeft: 6 }}>{r.kind}</span>}
                    {r.detail && <div className="muted small">{r.detail}</div>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
