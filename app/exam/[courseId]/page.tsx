import Link from 'next/link';
import { notFound } from 'next/navigation';
import { one, q, PROFILE } from '@/lib/db';
import { AOS_COURSE_ID } from '@/lib/exam/aos';
import { Generator, StartButton } from '../actions';

export const dynamic = 'force-dynamic';

type T = { id: string; name: string; summary: string | null; session_label: string | null; docs: number; items: string; attempts: string; acc: string | null };

export default async function CourseExam({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const c = await one<{ id: string; title: string; term: string }>('select id, title, term from courses where id=$1 and profile_id=$2', [courseId, PROFILE]);
  if (!c) notFound();
  const [topics, counts, chunks] = await Promise.all([
    q<T>(`select t.id, t.name, t.summary, t.session_label, cardinality(t.source_keys) docs,
            (select count(*) from exam_items i where i.topic_id=t.id and not i.retired)::text items,
            coalesce(m.attempts, 0)::text attempts, m.accuracy::text acc
          from topics t left join topic_mastery m on m.topic_id=t.id and m.profile_id=t.profile_id
          where t.course_id=$1 and t.profile_id=$2 order by t.session_label nulls last, t.id`, [courseId, PROFILE]),
    q<{ kind: string; n: string }>(`select kind, count(*)::text n from exam_items where course_id=$1 and not retired group by kind order by kind`, [courseId]),
    one<{ n: string; ocr: string }>(`select count(*)::text n, count(*) filter (where is_ocr)::text ocr from doc_chunks where course_id=$1`, [courseId]),
  ]);
  const total = counts.reduce((a, k) => a + Number(k.n), 0);
  const isAos = courseId === AOS_COURSE_ID;

  return (
    <main className="stack">
      <div>
        <Link href="/exam" className="small">← Exam prep</Link>
        <h1 style={{ marginTop: 6 }}>{c.title}</h1>
        <p className="muted">{c.term} · {chunks?.n ?? 0} passages of archived text{Number(chunks?.ocr) ? ` (${chunks!.ocr} from OCR)` : ''} · {total} practice questions
          {counts.length > 0 && ` (${counts.map((k) => `${k.n} ${k.kind}`).join(', ')})`}</p>
      </div>

      {Number(chunks?.n) === 0 ? (
        <div className="card">No text from this course has been archived yet, so there’s nothing to build questions from. When faculty upload material and the sync runs, come back here.</div>
      ) : (
        <>
          <section className="card">
            <h2>Practise</h2>
            <div className="row">
              <StartButton mode="mock" courseId={courseId} label="Mock test (15 MCQs + short answers)" primary disabled={!total} />
              <StartButton mode="flashcards" courseId={courseId} label="Flashcards" disabled={!total} />
              <StartButton mode="weak" courseId={courseId} label="Weak topics" disabled={!total} />
              <StartButton mode="review" courseId={courseId} label="Review due" disabled={!total} />
              {isAos && <StartButton mode="aos-paper" courseId={courseId} label="Mock paper (A, B1, B3, B4, B5)" />}
            </div>
            {isAos && <p className="small muted" style={{ marginTop: 8 }}>Role-play drills (B2-style calls) are on the <Link href="/exam">Exam prep page</Link>.</p>}
          </section>

          <section className="card">
            <h2>Topics</h2>
            {topics.length === 0 && <p className="muted small">No topics yet. Building them reads the course material and groups it into exam topics.</p>}
            {topics.length > 0 && (
              <div className="table-wrap"><table className="tbl">
                <thead><tr><th>Topic</th><th>Sessions</th><th>Questions</th><th style={{ width: 180 }}>Mastery</th></tr></thead>
                <tbody>
                  {topics.map((t) => (
                    <tr key={t.id}>
                      <td><strong>{t.name}</strong>{t.summary && <div className="muted small">{t.summary}</div>}<div className="muted small">{t.docs} source documents</div></td>
                      <td className="small">{t.session_label ?? ''}</td>
                      <td>{t.items}</td>
                      <td>{t.acc ? (
                        <><div className={`bar ${Number(t.acc) >= 0.75 ? 'good' : Number(t.acc) >= 0.5 ? 'warn' : 'bad'}`}><i style={{ width: `${Number(t.acc) * 100}%` }} /></div>
                          <span className="small muted">{Math.round(Number(t.acc) * 100)}% · {t.attempts} attempts</span></>
                      ) : <span className="muted small">not practised</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
            <div style={{ marginTop: 14 }}><Generator courseId={courseId} hasTopics={topics.length > 0} topics={topics.map((t) => ({ id: t.id, name: t.name }))} /></div>
          </section>
        </>
      )}
    </main>
  );
}
