import Link from 'next/link';
import { notFound } from 'next/navigation';
import { one, PROFILE } from '@/lib/db';
import { PERSONAS } from '@/lib/exam/aos';
import { DrillChat, type Msg } from './chat';

export const dynamic = 'force-dynamic';

export default async function Drill({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await one<{ id: string; persona: string; transcript: Msg[]; finished_at: string | null }>(
    'select id, persona, transcript, finished_at::text from drill_sessions where id=$1 and profile_id=$2', [id, PROFILE]);
  if (!d) notFound();
  const p = PERSONAS.find((x) => x.key === d.persona)!;
  return (
    <main className="stack" style={{ maxWidth: 820, margin: '0 auto' }}>
      <Link href="/exam" className="small">← Exam prep</Link>
      <div>
        <h1>Drill: {p.name}</h1>
        <p className="muted small">{p.company}. The buyer answers only what you ask and has things they won’t volunteer. Ask past-tense, specific questions; acknowledge before you answer; find who else has to be comfortable; close for an action, an owner and a date. Type <strong>END</strong> (or press End and get feedback) when you’re done.</p>
      </div>
      <DrillChat id={d.id} initial={d.transcript} ended={Boolean(d.finished_at)} buyer={p.name} />
    </main>
  );
}
