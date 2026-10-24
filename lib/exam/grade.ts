// Grading and scheduling: MCQs are checked exactly; open answers are graded by Gemini against the
// item's rubric, model answer and source text; every attempt updates spaced repetition (SM-2).
import { one, q, PROFILE } from '../db';
import { generateJSON } from '../llm';
import { AOS_COURSE_ID, bannedHits } from './aos';

export type Item = {
  id: string; course_id: string; topic_id: string | null; kind: string; prompt: string; choices: string[] | null;
  answer: string | null; explanation: string | null; rubric: string[] | null; source_chunk_ids: string[];
};

export type Result = { correct: boolean | null; score: number; feedback: string; answer?: string | null; explanation?: string | null };

export async function gradeAttempt(item: Item, response: string, selfRating?: number): Promise<Result> {
  if (item.kind === 'mcq') {
    const correct = String(response) === String(item.answer);
    return { correct, score: correct ? 1 : 0, feedback: '', answer: item.answer, explanation: item.explanation };
  }
  if (item.kind === 'flashcard') {
    // self-rated: 1 again, 3 hard, 4 good, 5 easy
    const r = selfRating ?? 3;
    return { correct: r >= 3, score: r >= 4 ? 1 : r === 3 ? 0.6 : 0, feedback: '', answer: item.answer };
  }
  if (selfRating != null) {
    // self-graded open answer (used when AI grading is unavailable): 1 again … 5 easy
    const score = selfRating >= 5 ? 1 : selfRating >= 4 ? 0.8 : selfRating >= 3 ? 0.5 : 0;
    return { correct: score >= 0.7, score, feedback: 'Self-graded against the model answer.', answer: item.answer };
  }
  if (!response.trim()) return { correct: false, score: 0, feedback: 'No answer given.', answer: item.answer };

  const src = item.source_chunk_ids.length
    ? (await q<{ content: string }>('select content from doc_chunks where id = any($1::bigint[])', [item.source_chunk_ids])).map((c) => c.content).join('\n---\n').slice(0, 12000)
    : '';
  const isAos = item.course_id === AOS_COURSE_ID;
  const banned = isAos ? bannedHits(response) : [];
  const g = await generateJSON<{ score: number; verdict: string; met: string[]; missed: string[]; feedback: string }>({
    system: `You are a strict, fair examiner for an MBA course. Grade only against the rubric and the source material. Quote the student's actual words when pointing out problems. Name the single biggest failure first. No encouragement padding. Output JSON only.`,
    prompt: `QUESTION
${item.prompt}

RUBRIC (each point is pass/fail)
${(item.rubric || []).map((r, i) => `${i + 1}. ${r}`).join('\n') || '(none: judge against the model answer)'}

MODEL ANSWER
${item.answer ?? '(none)'}

SOURCE MATERIAL
${src || '(not available)'}

STUDENT ANSWER
${response}
${isAos ? `\nThis is The Art of Selling: course frameworks beat generic sales advice. Deduct for invented facts or numbers not in the question, generic objections, and these banned words: ${banned.length ? 'FOUND ' + banned.join(', ') : 'none found'}.` : ''}

Return {"score": number 0..1 (share of rubric met, minus deductions), "verdict": "pass" | "partial" | "fail", "met": ["rubric points met"], "missed": ["rubric points missed, each with a quote from the answer or what was absent"], "feedback": "3-6 sentences: biggest failure first, then what a better answer would do"}`,
    temperature: 0.1,
  });
  const score = Math.max(0, Math.min(1, Number(g.score) || 0));
  const feedback = [g.feedback, g.missed?.length ? `Missed:\n- ${g.missed.join('\n- ')}` : '', banned.length ? `Banned words: ${banned.join(', ')}` : ''].filter(Boolean).join('\n\n');
  return { correct: score >= 0.7, score, feedback, answer: item.answer };
}

// SM-2 spaced repetition. quality 0..5.
export async function schedule(itemId: string, quality: number) {
  const s = await one<{ ease: string; interval_days: string; reps: number; lapses: number }>(
    'select ease, interval_days, reps, lapses from srs_state where profile_id=$1 and item_id=$2', [PROFILE, itemId]);
  let ease = s ? Number(s.ease) : 2.5;
  let interval = s ? Number(s.interval_days) : 0;
  let reps = s?.reps ?? 0;
  let lapses = s?.lapses ?? 0;
  if (quality < 3) {
    reps = 0; lapses += 1; interval = 10 / 1440; // back in 10 minutes
  } else {
    reps += 1;
    interval = reps === 1 ? 1 : reps === 2 ? 4 : Math.round(interval * ease);
    if (quality === 3) interval = Math.max(1, Math.round(interval * 0.6));
  }
  ease = Math.max(1.3, ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  interval = Math.min(interval, 45);
  await q(`insert into srs_state (profile_id, item_id, ease, interval_days, reps, lapses, due_at, last_reviewed)
           values ($1,$2,$3::numeric,$4::numeric,$5,$6, now() + $4::numeric * interval '1 day', now())
           on conflict (profile_id, item_id) do update set ease=$3::numeric, interval_days=$4::numeric, reps=$5, lapses=$6,
             due_at = now() + $4::numeric * interval '1 day', last_reviewed=now()`,
    [PROFILE, itemId, ease.toFixed(2), interval.toFixed(4), reps, lapses]);
  return { interval, ease };
}

export function qualityFrom(kind: string, r: Result, selfRating?: number) {
  if (kind === 'flashcard') return selfRating ?? 3;
  if (kind === 'mcq') return r.correct ? 4 : 1;
  return r.score >= 0.85 ? 5 : r.score >= 0.7 ? 4 : r.score >= 0.5 ? 3 : 1;
}
