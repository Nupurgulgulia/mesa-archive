'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../actions';

export type RunItem = {
  id: string; kind: string; prompt: string; choices: string[] | null; difficulty: string | null;
  source_refs: { key: string; page: number | null; label: string }[] | null; topic: string | null; course: string | null;
};
export type PrevAttempt = { item_id: string; response: string; correct: boolean | null; score: number; feedback: string | null };
type Result = { correct: boolean | null; score: number; feedback: string; answer?: string | null; explanation?: string | null; nextReviewDays?: number };

const OPEN_KINDS = ['short', 'discovery', 'pitch', 'objection', 'negotiation'];
const KIND_LABEL: Record<string, string> = { mcq: 'Multiple choice', flashcard: 'Flashcard', short: 'Short answer', discovery: 'B1 · Discovery questions', pitch: 'B3 · PSBA pitch', objection: 'B4 · Objection', negotiation: 'B5 · Negotiation prep' };
const rawHref = (key: string, page?: number | null) => '/raw/' + key.split('/').map(encodeURIComponent).join('/') + (page && /\.pdf$/i.test(key) ? `#page=${page}` : '');

export function Runner({ sessionId, items, prev, timeLimitMin, startedAt, finished, aiGrading, paper }: {
  sessionId: string; items: RunItem[]; prev: PrevAttempt[]; timeLimitMin: number | null; startedAt: string; finished: boolean; aiGrading: boolean;
  paper: { part: string; label: string; marks: number; kind: string }[] | null;
}) {
  const initial = useMemo(() => Object.fromEntries(prev.map((p) => [p.item_id, { correct: p.correct, score: p.score, feedback: p.feedback ?? '' } as Result])), [prev]);
  const [results, setResults] = useState<Record<string, Result>>(initial);
  const firstOpen = items.findIndex((i) => !initial[i.id]);
  const [idx, setIdx] = useState(finished ? items.length : Math.max(0, firstOpen === -1 ? items.length : firstOpen));
  const [done, setDone] = useState<{ score: number; max: number } | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    if (!timeLimitMin || finished) return;
    const end = Date.parse(startedAt) + timeLimitMin * 60_000;
    const t = setInterval(() => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [timeLimitMin, startedAt, finished]);
  useEffect(() => { shownAt.current = Date.now(); }, [idx]);

  async function finish() {
    const r = await api<{ score: number; max: number }>('/api/exam', { action: 'finish', sessionId });
    setDone(r); setIdx(items.length);
  }

  const answered = Object.keys(results).length;
  if (idx >= items.length || done) {
    return <Summary items={items} results={results} done={done} onFinish={finish} finished={finished} paper={paper} />;
  }
  const it = items[idx];
  return (
    <>
      <div className="row small">
        <span className="pill accent">{idx + 1} / {items.length}</span>
        <span className="pill">{KIND_LABEL[it.kind] ?? it.kind}</span>
        {it.topic && <span className="pill">{it.topic}</span>}
        {it.difficulty && <span className="pill">{it.difficulty}</span>}
        <span className="spacer" />
        {left != null && <span className={`pill ${left < 300 ? 'bad' : ''}`}>{left === 0 ? 'Time’s up: finish when ready' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`}</span>}
        <span className="muted">{answered} answered</span>
      </div>
      <div className="bar"><i style={{ width: `${(answered / items.length) * 100}%` }} /></div>
      <ItemView key={it.id} it={it} sessionId={sessionId} prior={results[it.id]} aiGrading={aiGrading} shownAt={shownAt}
        onResult={(r) => setResults((x) => ({ ...x, [it.id]: r }))} />
      <div className="row">
        <button className="btn" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>← Previous</button>
        <span className="spacer" />
        <button className="btn ghost" onClick={finish}>Finish now</button>
        <button className="btn primary" onClick={() => setIdx(idx + 1)}>{idx === items.length - 1 ? 'See results' : results[it.id] ? 'Next →' : 'Skip →'}</button>
      </div>
    </>
  );
}

function ItemView({ it, sessionId, prior, aiGrading, onResult, shownAt }: {
  it: RunItem; sessionId: string; prior?: Result; aiGrading: boolean; onResult: (r: Result) => void; shownAt: React.RefObject<number>;
}) {
  const [res, setRes] = useState<Result | undefined>(prior);
  const [choice, setChoice] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [flipped, setFlipped] = useState<{ answer: string | null; explanation?: string | null; rubric?: string[] | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(response: string, selfRating?: number) {
    setBusy(true); setError('');
    try {
      const r = await api<Result>('/api/exam', { action: 'answer', sessionId, itemId: it.id, response, selfRating, timeMs: Date.now() - (shownAt.current ?? Date.now()) });
      setRes(r); onResult(r);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  async function reveal() {
    setBusy(true); setError('');
    try { setFlipped(await api('/api/exam', { action: 'reveal', sessionId, itemId: it.id })); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  async function retire() {
    if (!confirm('Remove this question from future practice? (Use for wrong or badly written questions.)')) return;
    await api('/api/exam', { action: 'retire', itemId: it.id }).catch(() => {});
    setError('Removed from future sessions.');
  }

  return (
    <section className="card">
      {it.kind === 'flashcard' ? (
        <>
          <div className="flashcard card" style={{ boxShadow: 'none' }} onClick={() => !flipped && !res && reveal()}>
            <div>
              <div>{it.prompt}</div>
              {flipped && <div style={{ marginTop: 18, fontSize: '1rem' }} className="feedback">{flipped.answer}</div>}
              {!flipped && !res && <div className="muted small" style={{ marginTop: 14 }}>Think of the answer, then click to flip</div>}
            </div>
          </div>
          {flipped && !res && (
            <div className="row" style={{ marginTop: 12 }}>
              <span className="muted small">How well did you know it?</span>
              {[[1, 'Again'], [3, 'Hard'], [4, 'Good'], [5, 'Easy']].map(([v, l]) => (
                <button key={v} className="btn small" disabled={busy} onClick={() => submit('', Number(v))}>{l}</button>
              ))}
            </div>
          )}
          {res && <p className="muted small">Saved. Next review in {fmtInterval(res.nextReviewDays)}.</p>}
        </>
      ) : (
        <>
          <p style={{ whiteSpace: 'pre-wrap', fontSize: '1.02rem' }}>{it.prompt}</p>
          {it.kind === 'mcq' && it.choices?.map((c, i) => {
            const isAnswer = res && res.answer != null && String(i) === String(res.answer);
            const picked = choice === i;
            return (
              <button key={i} className={`choice ${res ? (isAnswer ? 'correct' : picked ? 'wrong' : '') : ''}`} disabled={Boolean(res) || busy}
                onClick={() => { setChoice(i); submit(String(i)); }}>
                <span className="letter">{'ABCD'[i]}</span><span>{c}</span>
              </button>
            );
          })}
          {OPEN_KINDS.includes(it.kind) && !res && (
            <>
              <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Write your answer the way you would in the exam…" style={{ minHeight: it.kind === 'short' ? 140 : 220 }} />
              <div className="row" style={{ marginTop: 10 }}>
                {aiGrading && <button className="btn primary" disabled={busy || !text.trim()} onClick={() => submit(text)}>{busy ? 'Grading…' : 'Submit for grading'}</button>}
                {!flipped && <button className="btn" disabled={busy} onClick={reveal}>{aiGrading ? 'Show model answer and self-grade' : 'Show model answer'}</button>}
              </div>
              {flipped && (
                <>
                  <div className="feedback"><strong>Model answer</strong>{'\n'}{flipped.answer}{flipped.rubric?.length ? `\n\nWhat graders look for:\n- ${flipped.rubric.join('\n- ')}` : ''}</div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <span className="muted small">How close was yours?</span>
                    {[[1, 'Missed it'], [3, 'Partly'], [4, 'Mostly'], [5, 'Fully']].map(([v, l]) => (
                      <button key={v} className="btn small" disabled={busy} onClick={() => submit(text, Number(v))}>{l}</button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {res && it.kind !== 'mcq' && (
            <div className={`feedback ${res.score >= 0.7 ? 'good' : 'bad'}`}>
              <strong>{Math.round(res.score * 100)}%</strong>{res.feedback ? `\n${res.feedback}` : ''}
              {res.answer && `\n\nModel answer:\n${res.answer}`}
            </div>
          )}
          {res && it.kind === 'mcq' && (
            <div className={`feedback ${res.correct ? 'good' : 'bad'}`}>
              <strong>{res.answer == null ? `${res.correct ? 'Correct' : 'Incorrect'} (answered earlier in this session).` : res.correct ? 'Correct.' : `Not quite. The answer is ${'ABCD'[Number(res.answer)]}.`}</strong>{res.explanation ? `\n${res.explanation}` : ''}
            </div>
          )}
        </>
      )}
      {error && <p className="err small">{error}</p>}
      <div className="row small muted" style={{ marginTop: 12 }}>
        {(it.source_refs || []).length > 0 && <span>Source:</span>}
        {(it.source_refs || []).slice(0, 4).map((s, i) => (
          <a key={i} href={rawHref(s.key, s.page)} target="_blank" rel="noreferrer">{s.label}{s.page ? ` p.${s.page}` : ''}</a>
        ))}
        <span className="spacer" />
        <button className="btn ghost small" onClick={retire} title="Flag a wrong or badly written question">Bad question?</button>
      </div>
    </section>
  );
}

function Summary({ items, results, done, onFinish, finished, paper }: {
  items: RunItem[]; results: Record<string, Result>; done: { score: number; max: number } | null; onFinish: () => void; finished: boolean;
  paper: { part: string; label: string; marks: number; kind: string }[] | null;
}) {
  const answered = items.filter((i) => results[i.id]);
  const score = answered.reduce((a, i) => a + (results[i.id].score ?? 0), 0);
  const byTopic = new Map<string, { n: number; s: number }>();
  for (const i of answered) {
    const k = i.topic ?? 'Other';
    const v = byTopic.get(k) ?? { n: 0, s: 0 };
    byTopic.set(k, { n: v.n + 1, s: v.s + results[i.id].score });
  }
  return (
    <section className="card">
      <h2>Results</h2>
      <div className="stat">{answered.length ? Math.round((score / answered.length) * 100) : 0}%</div>
      <div className="stat-label">{score.toFixed(1)} out of {answered.length} answered ({items.length - answered.length} skipped)</div>
      {paper && (
        <div className="table-wrap" style={{ marginTop: 14 }}><table className="tbl">
          <thead><tr><th>Part</th><th>What</th><th>Marks (scaled)</th></tr></thead>
          <tbody>
            {paper.map((p) => {
              const its = items.filter((i) => i.kind === p.kind);
              const got = its.filter((i) => results[i.id]).reduce((a, i) => a + results[i.id].score, 0);
              return <tr key={p.part}><td>{p.part}</td><td>{p.label}</td><td>{p.kind === 'drill' ? <a href="/exam">practise as a drill</a> : its.length ? `${((got / its.length) * p.marks).toFixed(1)} / ${p.marks}` : '—'}</td></tr>;
            })}
          </tbody>
        </table></div>
      )}
      <h3 style={{ marginTop: 16 }}>By topic</h3>
      <ul className="list small">
        {[...byTopic.entries()].sort((a, b) => a[1].s / a[1].n - b[1].s / b[1].n).map(([t, v]) => (
          <li key={t} className="row">{t}<span className="spacer" /><span className={`pill ${v.s / v.n >= 0.75 ? 'good' : v.s / v.n >= 0.5 ? 'warn' : 'bad'}`}>{Math.round((v.s / v.n) * 100)}%</span><span className="muted">{v.n} answered</span></li>
        ))}
      </ul>
      <div className="row" style={{ marginTop: 14 }}>
        {!finished && !done && <button className="btn primary" onClick={onFinish}>Save and finish</button>}
        {(finished || done) && <span className="pill good">Saved</span>}
        <a className="btn" href="/exam">Back to exam prep</a>
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>Everything you got wrong is scheduled to come back in your review queue.</p>
    </section>
  );
}

function fmtInterval(days?: number) {
  if (days == null) return 'a while';
  if (days < 1) return `${Math.round(days * 1440)} minutes`;
  return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
}
