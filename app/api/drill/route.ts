import { NextResponse } from 'next/server';
import { one, q, PROFILE } from '@/lib/db';
import { AOS_COURSE_ID, DRILL_FEEDBACK_FORMAT, PERSONAS } from '@/lib/exam/aos';
import { generate, llmConfigured, type Turn } from '@/lib/llm';

export const runtime = 'nodejs';
export const maxDuration = 120;

type Msg = { role: 'student' | 'buyer' | 'feedback'; text: string; at: string };

export async function POST(req: Request) {
  if (!llmConfigured()) return NextResponse.json({ error: 'AI is not configured (GEMINI_API_KEY).' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === 'start') {
      const p = PERSONAS.find((x) => x.key === body.persona);
      if (!p) return NextResponse.json({ error: 'Unknown buyer.' }, { status: 400 });
      const transcript: Msg[] = [{ role: 'buyer', text: p.opening, at: new Date().toISOString() }];
      const s = await one<{ id: string }>(
        `insert into drill_sessions (profile_id, course_id, persona, transcript) values ($1,$2,$3,$4) returning id`,
        [PROFILE, AOS_COURSE_ID, p.key, JSON.stringify(transcript)]);
      return NextResponse.json({ id: s!.id });
    }

    const s = await one<{ id: string; persona: string; transcript: Msg[]; finished_at: string | null }>(
      'select id, persona, transcript, finished_at from drill_sessions where id=$1 and profile_id=$2', [body.id, PROFILE]);
    if (!s) return NextResponse.json({ error: 'Unknown drill.' }, { status: 404 });
    if (s.finished_at) return NextResponse.json({ error: 'This drill has ended.' }, { status: 400 });
    const p = PERSONAS.find((x) => x.key === s.persona)!;
    const text = String(body.message || '').trim().slice(0, 2000);
    const ending = body.action === 'end' || /^end\.?$/i.test(text);
    const transcript: Msg[] = [...s.transcript];
    if (text && !/^end\.?$/i.test(text)) transcript.push({ role: 'student', text, at: new Date().toISOString() });

    const turns: Turn[] = transcript.filter((m) => m.role !== 'feedback').map((m) => ({ role: m.role === 'student' ? 'user' : 'model', text: m.text }));
    // Gemini needs the conversation to start with a user turn
    turns.unshift({ role: 'user', text: '(The call connects.)' });

    if (ending) {
      turns.push({ role: 'user', text: 'END' });
      const fb = await generate({
        system: `${p.brief}\n\nThe student is practising a sales conversation from MESA's The Art of Selling with you as the buyer.\n${DRILL_FEEDBACK_FORMAT}`,
        turns, temperature: 0.2, maxTokens: 3000,
      });
      transcript.push({ role: 'feedback', text: fb, at: new Date().toISOString() });
      const score = Number(fb.match(/(\d{1,2})\s*\/\s*30/)?.[1]);
      await q('update drill_sessions set transcript=$2, feedback=$3, score=$4, finished_at=now() where id=$1',
        [s.id, JSON.stringify(transcript), fb, Number.isFinite(score) ? score : null]);
      return NextResponse.json({ transcript, ended: true });
    }

    const reply = await generate({
      system: `${p.brief}

You are role-playing this buyer for a student practising MESA's The Art of Selling. Stay in character at all times; reply only as the buyer, in plain spoken sentences (1-3 sentences unless the student asked something that needs more). Never coach, never break character, never reveal hidden facts unless the student's question unlocks them. If the student types END you will give feedback instead (handled separately).`,
      turns, temperature: 0.7, maxTokens: 400,
    });
    transcript.push({ role: 'buyer', text: reply.trim(), at: new Date().toISOString() });
    await q('update drill_sessions set transcript=$2 where id=$1', [s.id, JSON.stringify(transcript)]);
    return NextResponse.json({ transcript });
  } catch (e) {
    console.error('[drill]', e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
