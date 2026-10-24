'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../actions';

export type Msg = { role: 'student' | 'buyer' | 'feedback'; text: string; at: string };

export function DrillChat({ id, initial, ended: endedInitial, buyer }: { id: string; initial: Msg[]; ended: boolean; buyer: string }) {
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(endedInitial);
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  async function send(action: 'say' | 'end') {
    const message = action === 'end' ? 'END' : text.trim();
    if (!message) return;
    setBusy(true); setError('');
    if (action === 'say') setMsgs((m) => [...m, { role: 'student', text: message, at: new Date().toISOString() }]);
    setText('');
    try {
      const r = await api<{ transcript: Msg[]; ended?: boolean }>('/api/drill', { action, id, message });
      setMsgs(r.transcript);
      if (r.ended) setEnded(true);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  return (
    <section className="card">
      <div className="chat">
        {msgs.map((m, i) => m.role === 'feedback' ? (
          <div key={i} className="feedback"><strong>Feedback</strong>{'\n'}{m.text}</div>
        ) : (
          <div key={i} className={`bubble ${m.role}`}>
            <div className="muted small">{m.role === 'buyer' ? buyer : 'You'}</div>{m.text}
          </div>
        ))}
        {busy && <div className="bubble buyer muted">…</div>}
        <div ref={bottom} />
      </div>
      {!ended && (
        <div style={{ marginTop: 14 }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Say what you’d say on the call…" style={{ minHeight: 80 }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) send(/^end\.?$/i.test(text.trim()) ? 'end' : 'say'); } }} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy || !text.trim()} onClick={() => send(/^end\.?$/i.test(text.trim()) ? 'end' : 'say')}>Send</button>
            <span className="muted small">Enter to send, Shift+Enter for a new line</span>
            <span className="spacer" />
            <button className="btn" disabled={busy || msgs.filter((m) => m.role === 'student').length === 0} onClick={() => send('end')}>End and get feedback</button>
          </div>
        </div>
      )}
      {error && <p className="err small">{error}</p>}
    </section>
  );
}
