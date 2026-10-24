import Link from 'next/link';
import { q, PROFILE } from '@/lib/db';
import { daysBetween, fmtDay, relDays, todayIST } from '@/lib/dates';
import { AOS_COURSE_ID, PERSONAS } from '@/lib/exam/aos';
import { llmConfigured } from '@/lib/llm';
import { StartButton, StartDrill } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Exam prep · MESA Archive' };

type C = { id: string; short_title: string; term: string; chunks: string; topics: string; items: string; attempts: string; acc: string | null; due: string };

export default async function ExamHome() {
  const today = todayIST();
  const [exams, courses, due, sessions, drills] = await Promise.all([
    q<{ title: string; starts_on: string; course_id: string | null }>(
      `select title, starts_on::text, course_id from exams where profile_id=$1 and starts_on >= $2::date order by starts_on limit 5`, [PROFILE, today]),
    q<C>(`select c.id, c.short_title, c.term,
            (select count(*) from doc_chunks d where d.course_id=c.id)::text chunks,
            (select count(*) from topics t where t.course_id=c.id)::text topics,
            (select count(*) from exam_items i where i.course_id=c.id and not i.retired)::text items,
            (select count(*) from attempts a join exam_items i on i.id=a.item_id where i.course_id=c.id)::text attempts,
            (select avg(coalesce(a.score, case when a.correct then 1 else 0 end))::numeric(4,2)::text from attempts a join exam_items i on i.id=a.item_id where i.course_id=c.id) acc,
            (select count(*) from srs_state s join exam_items i on i.id=s.item_id where i.course_id=c.id and s.due_at <= now())::text due
          from courses c where c.profile_id=$1 and exists (select 1 from doc_chunks d where d.course_id=c.id)
          order by case c.term when 'Term 2' then 0 when 'Term 1' then 1 else 2 end, c.short_title`, [PROFILE]),
    q<{ n: string }>(`select count(*)::text n from srs_state where profile_id=$1 and due_at <= now()`, [PROFILE]),
    q<{ id: string; title: string; score: string | null; max_score: string | null; started_at: string; finished_at: string | null }>(
      `select id, title, score::text, max_score::text, started_at::text, finished_at::text from exam_sessions where profile_id=$1 order by started_at desc limit 6`, [PROFILE]),
    q<{ id: string; persona: string; score: string | null; started_at: string; finished_at: string | null }>(
      `select id, persona, score::text, started_at::text, finished_at::text from drill_sessions where profile_id=$1 order by started_at desc limit 5`, [PROFILE]),
  ]);
  const terms = ['Term 2', 'Term 1', 'Pre-Term'];

  return (
    <main className="stack">
      <div className="row">
        <div><h1>Exam prep</h1><p className="muted">Questions are generated from each course’s own archived material and cite their sources. Spaced repetition brings back what you get wrong.</p></div>
        <span className="spacer" />
        <StartButton mode="review" label={`Review due cards (${due[0]?.n ?? 0})`} primary disabled={!Number(due[0]?.n)} />
      </div>
      {!llmConfigured() && <div className="card"><strong>AI isn’t configured.</strong> Add GEMINI_API_KEY to .env.local to generate and grade questions. Existing questions still work.</div>}

      {exams.length > 0 && (
        <div className="grid three">
          {exams.slice(0, 3).map((e) => (
            <div key={e.title + e.starts_on} className="card">
              <div className="stat">{daysBetween(today, e.starts_on)}<span className="stat-label"> days</span></div>
              <strong>{e.title}</strong><div className="muted small">{fmtDay(e.starts_on)} ({relDays(daysBetween(today, e.starts_on))})</div>
            </div>
          ))}
        </div>
      )}

      {terms.map((t) => courses.some((c) => c.term === t) && (
        <section key={t}>
          <div className="section-head"><h2>{t}</h2></div>
          <div className="grid three">
            {courses.filter((c) => c.term === t).map((c) => (
              <Link key={c.id} href={`/exam/${c.id}`} className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
                <h3>{c.short_title}</h3>
                <div className="row small">
                  {Number(c.items) ? <span className="pill accent">{c.items} questions</span> : <span className="pill">no questions yet</span>}
                  <span className="pill">{c.topics} topics</span>
                  {Number(c.due) > 0 && <span className="pill warn">{c.due} due</span>}
                </div>
                {c.acc && (
                  <div style={{ marginTop: 10 }}>
                    <div className={`bar ${Number(c.acc) >= 0.75 ? 'good' : Number(c.acc) >= 0.5 ? 'warn' : 'bad'}`}><i style={{ width: `${Number(c.acc) * 100}%` }} /></div>
                    <div className="muted small">{Math.round(Number(c.acc) * 100)}% across {c.attempts} attempts</div>
                  </div>
                )}
                {Number(c.chunks) < 60 && <div className="muted small" style={{ marginTop: 6 }}>Little material archived yet ({c.chunks} passages).</div>}
              </Link>
            ))}
          </div>
        </section>
      ))}

      <section className="card">
        <h2>The Art of Selling: paper and role-play drills</h2>
        <p className="small">Built on the course exam skill. The <strong>mock paper</strong> mirrors the SquadStack end-term’s written parts: concept MCQs (Part A), discovery questions (B1), a PSBA pitch (B3), two objections (B4) and a negotiation prep sheet (B5), graded against the course’s own tests and banned-word list. The 25-minute call (B2) is practised in a <strong>drill</strong>: the AI plays a buyer with hidden pains and a hidden blocker, and stays in character until you type END.</p>
        <div className="row">
          <StartButton mode="aos-paper" label="Start mock paper" courseId={AOS_COURSE_ID} primary />
          <Link href={`/exam/${AOS_COURSE_ID}`} className="btn">Art of Selling topics</Link>
        </div>
        <div className="grid two" style={{ marginTop: 14 }}>
          {PERSONAS.map((p) => (
            <div key={p.key} className="card" style={{ boxShadow: 'none' }}>
              <strong>{p.name}</strong><div className="muted small">{p.company}</div>
              <div style={{ marginTop: 8 }}><StartDrill persona={p.key} /></div>
            </div>
          ))}
        </div>
      </section>

      {(sessions.length > 0 || drills.length > 0) && (
        <section className="card">
          <h2>Recent practice</h2>
          <ul className="list small">
            {sessions.map((s) => (
              <li key={s.id} className="row"><Link href={`/exam/s/${s.id}`}>{s.title}</Link><span className="muted">{fmtDay(s.started_at)}</span>
                {s.finished_at ? <span className="pill">{Number(s.score).toFixed(1)} / {s.max_score}</span> : <span className="pill warn">unfinished</span>}</li>
            ))}
            {drills.map((d) => (
              <li key={'d' + d.id} className="row"><Link href={`/exam/drill/${d.id}`}>Drill: {PERSONAS.find((p) => p.key === d.persona)?.name}</Link><span className="muted">{fmtDay(d.started_at)}</span>
                {d.score ? <span className="pill">{d.score}/30</span> : <span className="pill warn">{d.finished_at ? 'ended' : 'in progress'}</span>}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
