// Batch question generation from the command line (same code as the app's Generate button).
// Usage:
//   npm run generate -- list                    # courses with material and their question counts
//   npm run generate -- <course id | name part> [--rebuild-topics] [--mcq 8 --flashcard 8 --short 3]
//   npm run generate -- all                     # every course that has material
import { pool, q, PROFILE } from '../lib/db';
import { buildTopics, generateItems } from '../lib/exam/generate';

const args = process.argv.slice(2);
const flag = (name: string, d: number) => (args.includes(`--${name}`) ? Number(args[args.indexOf(`--${name}`) + 1]) : d);

(async () => {
  const courses = await q<{ id: string; title: string; chunks: string; items: string }>(
    `select c.id, c.title, (select count(*) from doc_chunks d where d.course_id=c.id)::text chunks,
            (select count(*) from exam_items i where i.course_id=c.id and not i.retired)::text items
     from courses c where c.profile_id=$1 order by c.term desc, c.title`, [PROFILE]);
  const target = args[0];
  if (!target || target === 'list') {
    for (const c of courses) console.log(`${c.id}  ${c.title}  (${c.chunks} passages, ${c.items} questions)`);
    return;
  }
  const chosen = target === 'all'
    ? courses.filter((c) => Number(c.chunks) > 0)
    : courses.filter((c) => c.id === target || c.title.toLowerCase().includes(target.toLowerCase()));
  if (!chosen.length) throw new Error('No course matches ' + target);
  const counts = { mcq: flag('mcq', 8), flashcard: flag('flashcard', 8), short: flag('short', 3) };

  for (const c of chosen) {
    console.log(`\n== ${c.title}`);
    const n = await buildTopics(c.id, args.includes('--rebuild-topics'));
    let topics = await q<{ id: string; name: string }>('select id, name from topics where course_id=$1 and profile_id=$2 order by id', [c.id, PROFILE]);
    // --missing-only: only topics with no questions yet (e.g. after a network failure)
    if (args.includes('--missing-only')) {
      const have = new Set((await q<{ topic_id: string }>('select distinct topic_id from exam_items where course_id=$1', [c.id])).map((r) => String(r.topic_id)));
      topics = topics.filter((t) => !have.has(String(t.id)));
    }
    console.log(`${topics.length} topics${n !== topics.length ? '' : ''}`);
    let total = 0;
    for (const t of topics) {
      try {
        const k = await generateItems(c.id, t.id, counts);
        total += k;
        console.log(`  ${t.name}: +${k}`);
      } catch (e) {
        console.log(`  ${t.name}: FAILED ${(e as Error).message}`);
      }
    }
    console.log(`  total +${total}`);
  }
})()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end());
