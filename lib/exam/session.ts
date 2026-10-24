// Chooses items for a practice session. Unseen items and items you got wrong come first, spread
// across topics, with some randomness so repeated mocks differ.
import { one, q, PROFILE } from '../db';
import { AOS_COURSE_ID, AOS_PAPER } from './aos';

export type Mode = 'mock' | 'flashcards' | 'weak' | 'review' | 'aos-paper';

async function pick(courseId: string | null, kinds: string[], n: number, filter = 'true') {
  if (n <= 0) return [] as string[];
  const rows = await q<{ id: string }>(
    `with st as (
       select a.item_id, count(*) n, avg(coalesce(a.score, case when a.correct then 1 else 0 end)) acc
       from attempts a where a.profile_id=$1 group by a.item_id),
     tm as (select topic_id, accuracy from topic_mastery where profile_id=$1),
     scored as (
       select i.id, i.topic_id,
              (case when st.n is null then 0.9 else 1 - st.acc end) + coalesce(1 - tm.accuracy, 0.3) * 0.5 + random() * 0.6 as w
       from exam_items i left join st on st.item_id=i.id left join tm on tm.topic_id=i.topic_id
       where i.profile_id=$1 and not i.retired and ($2::text is null or i.course_id=$2) and i.kind = any($3) and ${filter}),
     spread as (select id, w, row_number() over (partition by topic_id order by w desc) rn from scored)
     select id from spread order by rn, w desc limit $4`, [PROFILE, courseId, kinds, n]);
  return rows.map((r) => r.id);
}

export async function createSession(courseId: string | null, mode: Mode, size?: number): Promise<{ id: string; count: number }> {
  let ids: string[] = [];
  let title = '';
  let timeLimit: number | null = null;
  const course = courseId ? await one<{ short_title: string }>('select short_title from courses where id=$1', [courseId]) : null;
  const name = course?.short_title ?? 'All courses';

  if (mode === 'mock') {
    const n = size ?? 15;
    ids = [...(await pick(courseId, ['mcq'], n)), ...(await pick(courseId, ['short'], Math.max(2, Math.round(n / 5))))];
    title = `Mock test · ${name}`;
    timeLimit = Math.round(n * 1.5 + 6);
  } else if (mode === 'aos-paper') {
    for (const p of AOS_PAPER) if (p.count) ids.push(...(await pick(AOS_COURSE_ID, [p.kind], p.count)));
    title = 'Art of Selling mock paper (written parts)';
    timeLimit = 90;
  } else if (mode === 'flashcards') {
    const due = await q<{ id: string }>(
      `select i.id from srs_state s join exam_items i on i.id=s.item_id where s.profile_id=$1 and s.due_at <= now() and i.kind='flashcard'
       and ($2::text is null or i.course_id=$2) and not i.retired order by s.due_at limit $3`, [PROFILE, courseId, size ?? 20]);
    ids = due.map((r) => r.id);
    ids.push(...(await pick(courseId, ['flashcard'], (size ?? 20) - ids.length, 'not exists (select 1 from srs_state s where s.item_id=i.id)')));
    title = `Flashcards · ${name}`;
  } else if (mode === 'weak') {
    ids = await pick(courseId, ['mcq', 'short', 'flashcard'], size ?? 15,
      `(i.topic_id in (select topic_id from topic_mastery where profile_id='${PROFILE}' and accuracy < 0.7)
        or i.id in (select item_id from attempts where profile_id='${PROFILE}' and coalesce(score, case when correct then 1 else 0 end) < 0.7))`);
    title = `Weak topics · ${name}`;
  } else if (mode === 'review') {
    const due = await q<{ id: string }>(
      `select i.id from srs_state s join exam_items i on i.id=s.item_id where s.profile_id=$1 and s.due_at <= now() and not i.retired
       and ($2::text is null or i.course_id=$2) order by s.due_at limit $3`, [PROFILE, courseId, size ?? 30]);
    ids = due.map((r) => r.id);
    title = `Review due cards · ${name}`;
  }
  if (!ids.length) return { id: '', count: 0 };
  const s = await one<{ id: string }>(
    `insert into exam_sessions (profile_id, course_id, mode, item_ids, time_limit_min, title) values ($1,$2,$3,$4,$5,$6) returning id`,
    [PROFILE, mode === 'aos-paper' ? AOS_COURSE_ID : courseId, mode, ids, timeLimit, title]);
  return { id: s!.id, count: ids.length };
}
