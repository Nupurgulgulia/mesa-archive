import Link from 'next/link';
import { q, PROFILE } from '@/lib/db';

export const dynamic = 'force-dynamic';

type C = {
  id: string; term: string; title: string; faculty: string | null; mode: string | null;
  files: string; notes: string; links: string; recs: string; pct: string | null; items: string;
};

export default async function Courses() {
  const rows = await q<C>(
    `select c.id, c.term, c.title, c.faculty, c.mode,
       (select count(*) from files f where f.course_id=c.id and f.kind='file') files,
       (select count(*) from files f where f.course_id=c.id and f.kind='note') notes,
       (select count(*) from files f where f.course_id=c.id and f.kind='link') links,
       (select count(*) from recordings r where r.course_id=c.id) recs,
       (select pct::text from attendance a where a.course_id=c.id order by as_of desc limit 1) pct,
       (select count(*) from exam_items i where i.course_id=c.id and not i.retired) items
     from courses c where c.profile_id=$1
     order by case c.term when 'Pre-Term' then 0 when 'Term 1' then 1 else 2 end desc, c.title`, [PROFILE]);
  const terms = ['Term 2', 'Term 1', 'Pre-Term'];
  return (
    <main>
      <h1>Courses</h1>
      <p className="muted">Everything archived from Nexus, by term. Term 2 courses with nothing yet will fill in as faculty upload and the sync runs.</p>
      {terms.map((t) => (
        <section key={t}>
          <div className="section-head"><h2>{t}</h2><span className="muted small">{rows.filter((r) => r.term === t).length} courses</span></div>
          <div className="grid three">
            {rows.filter((r) => r.term === t).map((c) => {
              const empty = Number(c.files) + Number(c.notes) + Number(c.links) + Number(c.recs) === 0;
              return (
                <Link key={c.id} href={`/courses/${c.id}`} className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
                  <h3>{c.title}</h3>
                  <div className="muted small">{[c.faculty, c.mode].filter(Boolean).join(' · ')}</div>
                  <div className="row small" style={{ marginTop: 10 }}>
                    {empty ? <span className="pill">Nothing on Nexus yet</span> : <>
                      <span className="pill">{c.files} files</span>
                      {Number(c.notes) + Number(c.links) > 0 && <span className="pill">{Number(c.notes) + Number(c.links)} notes/links</span>}
                      {Number(c.recs) > 0 && <span className="pill">{c.recs} recordings</span>}
                    </>}
                    {c.pct && <span className={`pill ${Number(c.pct) < 75 ? 'bad' : 'good'}`}>{c.pct}% attendance</span>}
                    {Number(c.items) > 0 && <span className="pill accent">{c.items} practice items</span>}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}
