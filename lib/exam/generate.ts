// Builds topics and practice items for a course from its archived text (doc_chunks), using Gemini.
// Every item cites the chunk ids it was written from (source_chunk_ids / source_refs).
import { one, q, PROFILE } from '../db';
import { generateJSON, MODEL } from '../llm';
import { AOS_COURSE_ID, AOS_RUBRICS, BANNED_WORDS } from './aos';

type Doc = { storage_key: string; label: string; folder: string | null; chars: number; excerpt: string };

const SKIP_DOC = /quiz (link|code|tool)|feedback form|invite codes|google form|^form-|drive link|cheat sheet reference$/i;

export async function buildTopics(courseId: string, force = false) {
  const existing = await q<{ id: string }>('select id from topics where profile_id=$1 and course_id=$2', [PROFILE, courseId]);
  if (existing.length && !force) return existing.length;
  const course = await one<{ title: string; term: string }>('select title, term from courses where id=$1', [courseId]);
  if (!course) throw new Error('unknown course');
  const docs = await q<Doc>(
    `select d.storage_key, coalesce(f.label, max(d.heading), split_part(d.storage_key,'/',-1)) label, f.folder,
            sum(length(d.content))::int chars,
            left(string_agg(d.content, ' ' order by d.seq) filter (where d.seq < 3), 400) excerpt
     from doc_chunks d left join files f on f.id=d.file_id
     where d.profile_id=$1 and d.course_id=$2 group by d.storage_key, f.label, f.folder order by d.storage_key`, [PROFILE, courseId]);
  const usable = docs.filter((d) => !SKIP_DOC.test(d.label) && d.chars > 150);
  if (!usable.length) throw new Error('This course has no archived text yet, so there is nothing to build topics from.');

  const list = usable.map((d, i) => `[D${i + 1}] ${d.label}${d.folder ? ` (folder: ${d.folder})` : ''}, ${d.chars} chars\n    ${d.excerpt.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const res = await generateJSON<{ topics: { name: string; summary: string; session_label?: string; docs: string[] }[] }>({
    system: 'You design revision syllabuses for MBA courses. Output strict JSON only.',
    prompt: `Course: "${course.title}" (${course.term}, Mesa School of Business, PGP).
Below are the course's archived documents with an excerpt of each. Group the teachable content into 4 to 12 exam topics a student should revise.
Rules:
- A topic is a concept area that exam questions could test (a framework, a method, a case, a set of formulas), not a document type.
- Every useful document belongs to at least one topic; a document may belong to several. Ignore purely administrative documents (setup guides with no concepts, invite codes, schedules).
- Name topics the way the course does where possible. Keep names under 8 words.
Return {"topics":[{"name":"...","summary":"one or two sentences","session_label":"e.g. Session 3 or Sessions 4-5, if clear","docs":["D1","D4"]}]}.

DOCUMENTS
${list}`,
    temperature: 0.2,
  });

  let n = 0;
  for (const t of res.topics || []) {
    const keys = [...new Set((t.docs || []).map((d) => usable[Number(String(d).replace(/\D/g, '')) - 1]?.storage_key).filter(Boolean))];
    if (!t.name || !keys.length) continue;
    await q(`insert into topics (profile_id, course_id, name, summary, session_label, source_keys) values ($1,$2,$3,$4,$5,$6)
             on conflict (profile_id, course_id, name) do update set summary=excluded.summary, session_label=excluded.session_label, source_keys=excluded.source_keys`,
      [PROFILE, courseId, t.name.trim().slice(0, 120), t.summary ?? null, t.session_label ?? null, keys]);
    n++;
  }
  return n;
}

type GenItem = {
  kind: string; prompt: string; choices?: string[]; answer?: string | number; explanation?: string;
  rubric?: string[]; difficulty?: string; sources?: (number | string)[];
};

export async function generateItems(courseId: string, topicId: string, counts = { mcq: 8, flashcard: 8, short: 3 }) {
  const topic = await one<{ name: string; summary: string | null; source_keys: string[] }>(
    'select name, summary, source_keys from topics where id=$1 and course_id=$2 and profile_id=$3', [topicId, courseId, PROFILE]);
  if (!topic) throw new Error('unknown topic');
  const course = await one<{ title: string }>('select title from courses where id=$1', [courseId]);

  // Source text: chunks of the topic's documents, sampled evenly to ~45k characters.
  const chunks = await q<{ id: string; storage_key: string; page: number | null; label: string; content: string }>(
    `select d.id, d.storage_key, d.page, coalesce(f.label, d.heading) label, d.content from doc_chunks d left join files f on f.id=d.file_id
     where d.profile_id=$1 and d.storage_key = any($2) order by d.storage_key, d.seq`, [PROFILE, topic.source_keys]);
  if (!chunks.length) throw new Error('No text found for this topic’s documents.');
  // Round-robin across documents so every document contributes, until the budget is reached.
  const BUDGET = 45_000;
  const byDoc = new Map<string, typeof chunks>();
  for (const c of chunks) byDoc.set(c.storage_key, [...(byDoc.get(c.storage_key) || []), c]);
  const queues = [...byDoc.values()];
  const chosen = new Set<string>();
  let used = 0;
  for (let round = 0; used < BUDGET && queues.some((qq) => qq.length > round); round++) {
    for (const qq of queues) {
      const c = qq[round];
      if (!c || used + c.content.length > BUDGET) continue;
      chosen.add(c.id);
      used += c.content.length;
    }
  }
  const picked = chunks.filter((c) => chosen.has(c.id));
  const source = picked.map((c) => `[C${c.id}] (${c.label}${c.page ? `, p.${c.page}` : ''})\n${c.content}`).join('\n\n');

  // Avoid repeating existing questions for this topic
  const existing = await q<{ prompt: string }>('select prompt from exam_items where topic_id=$1 and not retired order by id desc limit 60', [topicId]);
  const isAos = courseId === AOS_COURSE_ID;
  const aosExtra = isAos ? `
ALSO, because this is The Art of Selling, create 1 item of each of these kinds, each a short realistic scenario (a clearly fictional Indian B2B or D2C buyer) built from this topic's frameworks:
- "discovery": give the scenario and ask for six discovery questions. answer = a model set. rubric = ${JSON.stringify(AOS_RUBRICS.discovery)}
- "pitch": give a short discovery transcript excerpt with real numbers and ask for a pitch in PSBA (Problem, Solution, Proof, Ask). answer = a model pitch in spoken words. rubric = ${JSON.stringify(AOS_RUBRICS.pitch)}
- "objection": give one objection exactly as a buyer says it, with context; ask for type, free/specificity test, and an Acknowledge-Probe-Reframe-Respond response. answer = model response. rubric = ${JSON.stringify(AOS_RUBRICS.objection)}
- "negotiation": give a two-sided deal with 3 to 5 issues and the student's point schedule; ask for the prep sheet. answer = model prep sheet. rubric = ${JSON.stringify(AOS_RUBRICS.negotiation)}
Course frameworks beat generic sales advice. Never use these words in model answers: ${BANNED_WORDS.join(', ')}. Model answers that would be spoken must sound like a person talking, no em dashes.` : '';

  const res = await generateJSON<{ items: GenItem[] }>({
    system: 'You write rigorous, fair exam practice questions for an MBA student, grounded ONLY in the source material given. Output strict JSON only.',
    prompt: `Course: "${course?.title}". Topic: "${topic.name}"${topic.summary ? ` (${topic.summary})` : ''}.

Write:
- ${counts.mcq} "mcq": a question with exactly 4 options, one correct. Test understanding and application (scenarios, "which is the best next step", calculations when the source has numbers), not trivia about document titles. Distractors must be plausible mistakes a student would make. No "all/none of the above". answer = index 0-3 of the correct option. explanation = why it's right and why the most tempting wrong option is wrong.
- ${counts.flashcard} "flashcard": prompt = a term, formula or "what is/when do you" question; answer = a precise answer in 1-3 sentences.
- ${counts.short} "short": an open question needing a 3-8 sentence answer (explain, apply to a case, compare, calculate and interpret). answer = a model answer. rubric = 3 to 5 checkable points a grader would look for.
${aosExtra}
Rules:
- Use only facts, numbers, frameworks and cases that appear in the SOURCE. If the source says it, you may use it; if not, don't.
- Every item lists "sources": the C-numbers of the chunks it relies on (e.g. [123, 456]).
- difficulty: "easy" | "medium" | "hard". Mix them.
- Don't repeat these existing questions: ${existing.map((e) => JSON.stringify(e.prompt.slice(0, 90))).join('; ') || 'none'}.

Return {"items":[{"kind":"mcq","prompt":"...","choices":["...","...","...","..."],"answer":2,"explanation":"...","difficulty":"medium","sources":[123]}, ...]}

SOURCE
${source}`,
    temperature: 0.5,
    maxTokens: 16000,
  });

  const byId = new Map(chunks.map((c) => [c.id, c]));
  let created = 0;
  for (const it of res.items || []) {
    if (!it.prompt || !it.kind) continue;
    if (it.kind === 'mcq' && (!Array.isArray(it.choices) || it.choices.length !== 4 || !(Number(it.answer) >= 0 && Number(it.answer) <= 3))) continue;
    // Models favour B/C for the right answer; shuffle options so position carries no signal.
    if (it.kind === 'mcq' && it.choices) {
      const correctText = it.choices[Number(it.answer)];
      const shuffled = [...it.choices];
      for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
      it.choices = shuffled;
      it.answer = shuffled.indexOf(correctText);
    }
    const ids = (it.sources || []).map((s) => String(s).replace(/\D/g, '')).filter((s) => byId.has(s));
    const refs = ids.map((id) => ({ key: byId.get(id)!.storage_key, page: byId.get(id)!.page, label: byId.get(id)!.label }));
    const r = await q(
      `insert into exam_items (profile_id, course_id, topic_id, kind, prompt, choices, answer, explanation, rubric, source_chunk_ids, source_refs, difficulty, generator)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict do nothing returning id`,
      [PROFILE, courseId, topicId, it.kind, it.prompt.trim(), it.choices ? JSON.stringify(it.choices) : null,
        it.answer == null ? null : String(it.answer), it.explanation ?? null, it.rubric ? JSON.stringify(it.rubric) : null,
        ids, JSON.stringify(refs), it.difficulty ?? null, MODEL()]);
    created += r.length;
  }
  await q(`insert into generation_runs (profile_id, course_id, topic_id, model, items_created, chars_in) values ($1,$2,$3,$4,$5,$6)`,
    [PROFILE, courseId, topicId, MODEL(), created, source.length]);
  return created;
}
