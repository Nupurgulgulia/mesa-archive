import Link from 'next/link';
import { notFound } from 'next/navigation';
import { one, q, PROFILE } from '@/lib/db';
import { fmtDay } from '@/lib/dates';
import { PROVIDER_LABEL, rawHref } from '@/lib/links';

export const dynamic = 'force-dynamic';

type Course = { id: string; term: string; title: string; faculty: string | null; mode: string | null; outline: string | null; data: Record<string, unknown> };
type Item = {
  id: string; kind: 'file' | 'note' | 'link'; tab: string; folder: string | null; label: string; folder_date: string | null;
  storage_key: string; ext: string | null; size: string | null; note_text: string | null; links: string[]; ocr: boolean; extracted: string | null;
};
type LinkT = { file_id: string; link_id: string; url: string; provider: string; export_status: string; export_key: string | null; error: string | null };

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await one<Course>(`select id, term, title, faculty, mode, outline, data from courses where id=$1 and profile_id=$2`, [id, PROFILE]);
  if (!c) notFound();
  const [items, links, recs, asg, ann, att, items2] = await Promise.all([
    q<Item>(`select f.id, f.kind, f.tab, f.folder, f.label, f.folder_date, f.storage_key, f.ext, f.size, f.note_text, f.links,
               coalesce(e.method='ocr', false) ocr, e.status extracted
             from files f left join doc_extractions e on e.storage_key=f.storage_key
             where f.course_id=$1 order by f.tab, f.folder nulls first, f.id`, [id]),
    q<LinkT>(`select fl.file_id, l.id link_id, l.url, l.provider, l.export_status, l.export_key, l.error from file_links fl join link_targets l on l.id=fl.link_id
              join files f on f.id=fl.file_id where f.course_id=$1`, [id]),
    q<{ title: string; rec_date: string | null; url: string; date_uncertain: boolean }>(
      `select title, rec_date::text, url, date_uncertain from recordings where course_id=$1 order by rec_date nulls last, title`, [id]),
    q<{ title: string; due_date: string | null; status: string; kind: string | null; marks: string | null }>(
      `select title, due_date::text, status, kind, marks from assignments where course_id=$1 order by due_date desc nulls last`, [id]),
    q<{ title: string }>(`select title from announcements where course_id=$1 order by id`, [id]),
    one<{ attended: number; total: number; pct: string }>(`select attended, total, pct::text from attendance where course_id=$1 order by as_of desc limit 1`, [id]),
    one<{ n: string }>(`select count(*) n from exam_items where course_id=$1 and not retired`, [id]),
  ]);

  const linksByFile = new Map<string, LinkT[]>();
  for (const l of links) linksByFile.set(l.file_id, [...(linksByFile.get(l.file_id) || []), l]);
  const tabs = [...new Set(items.map((i) => i.tab))];
  const extra = (c.data?.extra as string[] | undefined) || [];

  return (
    <main className="stack">
      <div>
        <Link href="/courses" className="small">← Courses</Link>
        <h1 style={{ marginTop: 6 }}>{c.title}</h1>
        <div className="row muted">
          <span>{c.term}</span>{c.faculty && <span>· {c.faculty}</span>}{c.mode && <span>· {c.mode}</span>}
          {att && <span className={`pill ${Number(att.pct) < 75 ? 'bad' : 'good'}`}>Attendance {att.attended}/{att.total} ({att.pct}%)</span>}
          <span className="spacer" />
          {c.outline && <a className="btn small" href={c.outline} target="_blank" rel="noreferrer">Course outline ↗</a>}
          <Link className="btn small primary" href={`/exam/${c.id}`}>Exam prep{Number(items2?.n) ? ` (${items2!.n})` : ''}</Link>
        </div>
      </div>

      {items.length === 0 && recs.length === 0 && (
        <div className="card"><p>Nothing has been posted on Nexus for this course yet (as of the last capture). New material appears here after a sync.</p></div>
      )}

      {tabs.map((tab) => {
        const inTab = items.filter((i) => i.tab === tab);
        const folders = [...new Set(inTab.map((i) => i.folder || ''))];
        return (
          <section key={tab} className="card">
            <h2>{tab}</h2>
            {folders.map((folder) => {
              const inFolder = inTab.filter((i) => (i.folder || '') === folder);
              const body = <div className="folder-body">{inFolder.map((it) => <ItemRow key={it.id} it={it} links={linksByFile.get(it.id) || []} />)}</div>;
              if (!folder) return <div key="root">{body}</div>;
              return (
                <details key={folder} className="folder" open={folders.length <= 3}>
                  <summary>{folder} {inFolder[0]?.folder_date && <span className="muted small">· {inFolder[0].folder_date}</span>} <span className="muted small">({inFolder.length})</span></summary>
                  {body}
                </details>
              );
            })}
          </section>
        );
      })}

      {recs.length > 0 && (
        <section className="card">
          <h2>Class recordings <span className="muted small">({recs.length}, YouTube links)</span></h2>
          <ul className="list">
            {recs.map((r, i) => (
              <li key={i} className="row">
                <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a>
                <span className="muted small">{r.rec_date ? fmtDay(r.rec_date) : 'undated'}</span>
                {r.date_uncertain && <span className="pill warn" title="Date or order may be swapped on Nexus">date uncertain</span>}
              </li>
            ))}
          </ul>
          <p className="muted small">Recordings are links only, as decided. If MESA removes them after you leave, they’ll stop working.</p>
        </section>
      )}

      {asg.length > 0 && (
        <section className="card">
          <h2>Assignments</h2>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Assignment</th><th>Due</th><th>Type</th><th>Status</th><th>Marks</th></tr></thead>
            <tbody>{asg.map((a, i) => (
              <tr key={i}><td>{a.title}</td><td>{a.due_date ? fmtDay(a.due_date) : '—'}</td><td>{a.kind}</td>
                <td><span className={`pill ${a.status === 'Pending' ? 'warn' : 'good'}`}>{a.status}</span></td><td>{a.marks ?? '—'}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      {(ann.length > 0 || extra.length > 0) && (
        <section className="card">
          <h2>Announcements</h2>
          <ul className="list">{ann.map((a, i) => <li key={i}>{a.title}</li>)}</ul>
          <p className="muted small">Titles only; the text of announcements wasn’t captured on 20 Oct. The sync will add it.</p>
          {extra.length > 0 && <><h3 style={{ marginTop: 12 }}>Also on Nexus</h3><ul className="list small">{extra.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
        </section>
      )}
    </main>
  );
}

function ItemRow({ it, links }: { it: Item; links: LinkT[] }) {
  const typeLabel = it.kind === 'file' ? (it.ext || 'file').toUpperCase() : it.kind.toUpperCase();
  return (
    <div className="file">
      <span className={`pill type ${it.kind === 'file' ? 'accent' : ''}`}>{typeLabel}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {it.kind === 'file' ? (
          <a href={rawHref(it.storage_key)} target="_blank" rel="noreferrer">{it.label}</a>
        ) : (
          <details>
            <summary>{it.label}</summary>
            {it.kind === 'note' && it.note_text && <div className="note-body">{it.note_text}</div>}
          </details>
        )}
        <div className="row small muted">
          {it.size && <span>{it.size}</span>}
          {it.ocr && <a href={rawHref('_ocr/' + it.storage_key + '.txt')} target="_blank" rel="noreferrer" title="Scanned document: text recognised by OCR">OCR text</a>}
          {it.kind === 'file' && it.extracted && it.extracted !== 'ok' && <span title="No searchable text">not searchable</span>}
          {links.map((l, i) => (
            <span key={i} className="row" style={{ gap: 6 }}>
              <a href={l.url} target="_blank" rel="noreferrer">{PROVIDER_LABEL[l.provider] ?? 'Link'} ↗</a>
              {l.export_key ? (
                <a href={l.export_key.endsWith('/') ? `/folder/${l.link_id}` : rawHref(l.export_key)} target="_blank" rel="noreferrer" className="pill good">saved copy</a>
              ) : l.export_status === 'needs_login' ? (
                <span className="pill warn" title={l.error ?? ''}>needs Google login</span>
              ) : null}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
