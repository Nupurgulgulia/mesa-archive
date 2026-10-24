import Link from 'next/link';
import { notFound } from 'next/navigation';
import { one, q, PROFILE } from '@/lib/db';
import { llmConfigured } from '@/lib/llm';
import { AOS_PAPER } from '@/lib/exam/aos';
import { Runner, type RunItem, type PrevAttempt } from './runner';

export const dynamic = 'force-dynamic';

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await one<{ id: string; title: string; mode: string; course_id: string | null; item_ids: string[]; time_limit_min: number | null; started_at: string; finished_at: string | null }>(
    `select id, title, mode, course_id, item_ids, time_limit_min, started_at::text, finished_at::text from exam_sessions where id=$1 and profile_id=$2`, [id, PROFILE]);
  if (!s) notFound();
  // Answers are NOT sent to the browser; they come back only after answering (or revealing a flashcard).
  const rows = await q<RunItem & { ord: number }>(
    `select i.id, i.kind, i.prompt, i.choices, i.difficulty, i.source_refs, t.name topic, c.short_title course, x.ord
     from unnest($1::bigint[]) with ordinality x(item_id, ord) join exam_items i on i.id=x.item_id
     left join topics t on t.id=i.topic_id left join courses c on c.id=i.course_id order by x.ord`, [s.item_ids]);
  const prev = await q<PrevAttempt>(
    `select distinct on (item_id) item_id::text, response, correct, score::float, feedback from attempts where session_id=$1 order by item_id, id desc`, [id]);
  const paper = s.mode === 'aos-paper' ? AOS_PAPER.map((p) => ({ part: p.part, label: p.label, marks: p.marks, kind: p.kind })) : null;
  return (
    <main className="stack" style={{ maxWidth: 820, margin: '0 auto' }}>
      <div className="row">
        <Link href={s.course_id ? `/exam/${s.course_id}` : '/exam'} className="small">← Back</Link>
        <span className="spacer" />
        <span className="muted small">{rows.length} items{s.time_limit_min ? ` · ${s.time_limit_min} min` : ''}</span>
      </div>
      <h1>{s.title}</h1>
      <Runner sessionId={s.id} items={rows} prev={prev} timeLimitMin={s.time_limit_min} startedAt={s.started_at}
        finished={Boolean(s.finished_at)} aiGrading={llmConfigured()} paper={paper} />
    </main>
  );
}
