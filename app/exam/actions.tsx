'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export async function api<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j as T;
}

export function StartButton({ mode, label, courseId, size, primary, disabled }: { mode: string; label: string; courseId?: string; size?: number; primary?: boolean; disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <span>
      <button className={`btn ${primary ? 'primary' : ''}`} disabled={busy || disabled} onClick={async () => {
        setBusy(true); setError('');
        try { const s = await api<{ id: string }>('/api/exam', { action: 'session', mode, courseId, size }); router.push(`/exam/s/${s.id}`); }
        catch (e) { setError((e as Error).message); setBusy(false); }
      }}>{busy ? 'Preparing…' : label}</button>
      {error && <div className="err small">{error}</div>}
    </span>
  );
}

export function StartDrill({ persona }: { persona: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <span>
      <button className="btn small" disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { const s = await api<{ id: string }>('/api/drill', { action: 'start', persona }); router.push(`/exam/drill/${s.id}`); }
        catch (e) { setError((e as Error).message); setBusy(false); }
      }}>{busy ? 'Connecting…' : 'Start drill'}</button>
      {error && <div className="err small">{error}</div>}
    </span>
  );
}

// Builds topics (if needed) and generates questions topic by topic, showing progress.
export function Generator({ courseId, topics, hasTopics }: { courseId: string; topics: { id: string; name: string }[]; hasTopics: boolean }) {
  const router = useRouter();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const add = (s: string) => setLog((l) => [...l, s]);

  async function run(only?: string) {
    setBusy(true); setLog([]);
    try {
      let list = topics;
      if (!hasTopics) {
        add('Reading the course material and building topics…');
        await api('/api/exam', { action: 'topics', courseId });
        router.refresh();
        add('Topics built. Now generate questions for them.');
        setBusy(false);
        return;
      }
      if (only) list = topics.filter((t) => t.id === only);
      let total = 0;
      for (const t of list) {
        add(`Writing questions for “${t.name}”…`);
        try {
          const r = await api<{ created: number }>('/api/exam', { action: 'generate', courseId, topicId: t.id });
          total += r.created;
          add(`  ${r.created} new questions.`);
        } catch (e) { add(`  failed: ${(e as Error).message}`); }
      }
      add(`Done: ${total} new questions.`);
      router.refresh();
    } catch (e) { add('Error: ' + (e as Error).message); }
    setBusy(false);
  }

  return (
    <div>
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => run()}>{hasTopics ? (busy ? 'Generating…' : 'Generate questions for all topics') : (busy ? 'Building…' : 'Build topics from course material')}</button>
        {hasTopics && <span className="muted small">About 30–60 seconds per topic. Each run adds new questions without repeating old ones.</span>}
      </div>
      {log.length > 0 && <pre className="note-body small">{log.join('\n')}</pre>}
      {hasTopics && <GenerateOne run={run} busy={busy} topics={topics} />}
    </div>
  );
}

function GenerateOne({ run, busy, topics }: { run: (id?: string) => void; busy: boolean; topics: { id: string; name: string }[] }) {
  const [id, setId] = useState(topics[0]?.id ?? '');
  return (
    <div className="row small" style={{ marginTop: 8 }}>
      <select value={id} onChange={(e) => setId(e.target.value)} style={{ width: 'auto', maxWidth: 320 }}>
        {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <button className="btn small" disabled={busy || !id} onClick={() => run(id)}>Generate for this topic only</button>
    </div>
  );
}
