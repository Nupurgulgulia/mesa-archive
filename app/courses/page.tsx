import Link from 'next/link';
import { q, PROFILE } from '@/lib/db';
import { getTerm, TERMS } from '@/lib/term';
import { TermTabs } from '../nav-links';
import { Icon } from '../icons';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Courses · MESA Archive' };

type C = {
  id: string; term: string; title: string; short_title: string | null; faculty: string | null; mode: string | null;
  files: string; notes: string; links: string; recs: string; pct: string | null; attended: number | null; total: number | null; items: string;
};

export default async function Courses() {
  const term = await getTerm();
  const rows = await q<C>(
    `select c.id, c.term, c.title, c.short_title, c.faculty, c.mode,
       (select count(*) from files f where f.course_id=c.id and f.kind='file') files,
       (select count(*) from files f where f.course_id=c.id and f.kind='note') notes,
       (select count(*) from files f where f.course_id=c.id and f.kind='link') links,
       (select count(*) from recordings r where r.course_id=c.id) recs,
       a.pct::text pct, a.attended, a.total,
       (select count(*) from exam_items i where i.course_id=c.id and not i.retired) items
     from courses c
     left join lateral (select pct, attended, total from attendance a where a.course_id=c.id order by as_of desc limit 1) a on true
     where c.profile_id=$1
     order by (select count(*) from files f where f.course_id=c.id) = 0, c.title`, [PROFILE]);

  const counts: Record<string, number> = { all: rows.length };
  for (const t of TERMS) counts[t] = rows.filter((r) => r.term === t).length;
  const shown = term === 'all' ? TERMS.filter((t) => counts[t]) : [term];

  return (
    <main>
      <div className="page-head">
        <div>
          <div className="eyebrow">Library</div>
          <h1>Courses</h1>
          <p>Everything archived from Nexus. Courses without material yet fill in as faculty upload and the sync runs.</p>
        </div>
      </div>
      <TermTabs term={term} counts={counts} />
      {shown.map((t) => (
        <section key={t}>
          {term === 'all' && <div className="section-head"><h2>{t}</h2><span className="muted small">{counts[t]} courses</span></div>}
          <div className="grid three">
            {rows.filter((r) => r.term === t).map((c, i) => <CourseCard key={c.id} c={c} i={i} />)}
          </div>
        </section>
      ))}
    </main>
  );
}

function CourseCard({ c, i }: { c: C; i: number }) {
  const notes = Number(c.notes) + Number(c.links);
  const empty = Number(c.files) + notes + Number(c.recs) === 0;
  const name = c.short_title || c.title;
  const faculty = c.faculty || c.title.match(/ with (?:Prof\. )?(.+)$/)?.[1] || null;
  const pct = c.pct != null ? Number(c.pct) : null;
  return (
    <Link href={`/courses/${c.id}`} className="card course-card">
      <div className="course-top">
        <span className={`avatar c${i % 5}`}>{initials(name)}</span>
        <div style={{ minWidth: 0 }}>
          <h3>{c.title.replace(/ with (Prof\. )?.+$/, '')}</h3>
          <div className="muted small">{[faculty, c.mode].filter(Boolean).join(' · ') || c.term}</div>
        </div>
      </div>
      <div className="course-meta">
        {empty ? <span className="empty-note">Nothing on Nexus yet</span> : <>
          {Number(c.files) > 0 && <span className="pill"><Icon name="file" />{c.files}</span>}
          {notes > 0 && <span className="pill"><Icon name="note" />{notes}</span>}
          {Number(c.recs) > 0 && <span className="pill"><Icon name="video" />{c.recs}</span>}
          {Number(c.items) > 0 && <span className="pill accent"><Icon name="target" />{c.items}</span>}
        </>}
      </div>
      {pct != null && (
        <div className="course-foot">
          <span>Attendance</span>
          <div className={`bar ${pct < 75 ? 'bad' : pct < 85 ? 'warn' : 'good'}`}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
          <span style={{ color: pct < 75 ? 'var(--bad)' : 'inherit', fontWeight: 500 }}>{Math.round(pct)}%</span>
        </div>
      )}
    </Link>
  );
}

function initials(s: string) {
  const w = s.replace(/[^A-Za-z0-9 &]/g, ' ').split(/\s+/).filter((x) => x && !/^(and|of|the|with|&)$/i.test(x));
  return (w.length === 1 ? w[0].slice(0, 2) : w.slice(0, 2).map((x) => x[0]).join('')).toUpperCase();
}
