import { NextResponse } from 'next/server';
import { isSignedIn } from '@/lib/auth';
import { one, q, PROFILE } from '@/lib/db';
import { buildTopics, generateItems } from '@/lib/exam/generate';
import { gradeAttempt, qualityFrom, schedule, type Item } from '@/lib/exam/grade';
import { createSession, type Mode } from '@/lib/exam/session';
import { llmConfigured } from '@/lib/llm';

export const runtime = 'nodejs';
export const maxDuration = 300;

// One endpoint, dispatched on "action", so the client stays simple.
export async function POST(req: Request) {
  if (!(await isSignedIn(req))) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'topics': {
        if (!llmConfigured()) return err('AI is not configured (GEMINI_API_KEY).');
        const n = await buildTopics(String(body.courseId), Boolean(body.force));
        return NextResponse.json({ topics: n });
      }
      case 'generate': {
        if (!llmConfigured()) return err('AI is not configured (GEMINI_API_KEY).');
        const created = await generateItems(String(body.courseId), String(body.topicId), body.counts);
        return NextResponse.json({ created });
      }
      case 'session': {
        const s = await createSession(body.courseId || null, body.mode as Mode, body.size ? Number(body.size) : undefined);
        if (!s.count) return err('No questions match yet. Generate questions first, or there is nothing due.');
        return NextResponse.json(s);
      }
      case 'answer': {
        const sess = await one<{ id: string; item_ids: string[]; finished_at: string | null }>(
          'select id, item_ids, finished_at from exam_sessions where id=$1 and profile_id=$2', [body.sessionId, PROFILE]);
        if (!sess || !sess.item_ids.map(String).includes(String(body.itemId))) return err('Unknown session or item.');
        const item = await one<Item>(
          `select id, course_id, topic_id, kind, prompt, choices, answer, explanation, rubric, source_chunk_ids from exam_items where id=$1 and profile_id=$2`,
          [body.itemId, PROFILE]);
        if (!item) return err('Unknown item.');
        if (!['mcq', 'flashcard'].includes(item.kind) && body.selfRating == null && !llmConfigured()) return err('AI grading is not configured; compare with the model answer instead.');
        const started = Date.now();
        const res = await gradeAttempt(item, String(body.response ?? ''), body.selfRating ? Number(body.selfRating) : undefined);
        await q(`insert into attempts (profile_id, session_id, item_id, response, correct, score, feedback, time_ms) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [PROFILE, sess.id, item.id, String(body.response ?? ''), res.correct, res.score, res.feedback || null, Number(body.timeMs) || Date.now() - started]);
        const sched = await schedule(item.id, qualityFrom(item.kind, res, body.selfRating ? Number(body.selfRating) : undefined));
        return NextResponse.json({ ...res, nextReviewDays: sched.interval });
      }
      case 'finish': {
        const r = await one<{ score: string; max: string }>(
          `select coalesce(sum(coalesce(a.score, case when a.correct then 1 else 0 end)),0) score, count(*) max from attempts a
           where a.session_id=$1 and a.profile_id=$2 and a.id in (select max(id) from attempts where session_id=$1 group by item_id)`, [body.sessionId, PROFILE]);
        await q('update exam_sessions set finished_at=now(), score=$2, max_score=$3 where id=$1 and profile_id=$4', [body.sessionId, r?.score ?? 0, r?.max ?? 0, PROFILE]);
        return NextResponse.json({ score: Number(r?.score ?? 0), max: Number(r?.max ?? 0) });
      }
      case 'reveal': {
        // Model answer for a flashcard (before self-rating) or an open item being self-graded.
        const sess = await one<{ item_ids: string[] }>('select item_ids from exam_sessions where id=$1 and profile_id=$2', [body.sessionId, PROFILE]);
        if (!sess || !sess.item_ids.map(String).includes(String(body.itemId))) return err('Unknown session or item.');
        const it = await one<{ kind: string; answer: string | null; explanation: string | null; rubric: string[] | null }>(
          'select kind, answer, explanation, rubric from exam_items where id=$1 and profile_id=$2', [body.itemId, PROFILE]);
        if (!it || it.kind === 'mcq') return err('Not available for this item.');
        return NextResponse.json({ answer: it.answer, explanation: it.explanation, rubric: it.rubric });
      }
      case 'retire': {
        await q('update exam_items set retired=true where id=$1 and profile_id=$2', [body.itemId, PROFILE]);
        return NextResponse.json({ ok: true });
      }
      default:
        return err('Unknown action.');
    }
  } catch (e) {
    console.error('[exam]', e);
    return err((e as Error).message || 'Something went wrong.', 500);
  }
}

function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
