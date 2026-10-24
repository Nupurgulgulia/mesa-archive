import Link from 'next/link';
import { notFound } from 'next/navigation';
import { one, q, PROFILE } from '@/lib/db';
import { fmtDate, fmtDay } from '@/lib/dates';
import { PROVIDER_LABEL, rawHref } from '@/lib/links';
import { Icon } from '../../icons';

export const dynamic = 'force-dynamic';

type Course = { id: string; term: string; title: string; short_title: string | null; faculty: string | null; mode: string | null; outline: string | null; data: Record<string, unknown> };
type Item = {
  id: string; kind: 'file' | 'note' | 'link'; tab: string; folder: string | null; label: string; folder_date: string | null;
  storage_key: string; ext: string | null; size: string | null; note_text: string | null; links: string[]; ocr: boolean; extracted: string | null;
};
type LinkT = { file_id: string; link_id: string; url: string; provider: string; export_status: string; export_key: string | null; error: string | null };

const SUBMIT_LABEL: Record<string, string> = { submitted: 'Submitted', late: 'Late', not_submitted: 'Not submitted' };

export default async function CoursePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const c = await one<Course>(`select id, term, title, short_title, faculty, mode, outline, data from courses where id=$1 and profile_id=$2`, [id, PROFILE]);
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
    q<{ title: string; due_date: string | null; status: string; submission_status: string | null; kind: string | null; max_marks: string | null }>(
      `select title, due_date::text, status, submission_status, kind, max_marks from assignments where course_id=$1 order by due_date desc nulls last`, [id]),
    q<{ title: string; body: string | null; author: string | null; posted_at: string | null; posted: string | null }>(
      `select title, body, author, posted_at::text, posted from announcements where course_id=$1 order by posted_at desc nulls last, id desc`, [id]),
    one<{ attended: number; total: number; pct: string; note: string | null }>(`select attended, total, pct::text, note from attendance where course_id=$1 order by as_of desc limit 1`, [id]),
    one<{ n: string }>(`select count(*) n from exam_items where course_id=$1 and not retired`, [id]),
  ]);

  const linksByFile = new Map<string, LinkT[]>();
  for (const l of links) linksByFile.set(l.file_id, [...(linksByFile.get(l.file_id) || []), l]);
  const contentTabs = [...new Set(items.map((i) => i.tab))];
  const extra = (c.data?.extra as string[] | undefined) || [];

  const tabs: [string, string, number][] = [
    ...contentTabs.map((t) => [t, t, items.filter((i) => i.tab === t).length] as [string, string, number]),
    ...(recs.length ? [['recordings', 'Recordings', recs.length] as [string, string, number]] : []),
    ...(asg.length ? [['assignments', 'Assignments', asg.length] as [string, string, number]] : []),
    ...(ann.length || extra.length ? [['announcements', 'Announcements', ann.length] as [string, string, number]] : []),
  ];
  const active = tabs.find((t) => t[0] === sp.tab)?.[0] ?? tabs[0]?.[0];
  const pct = att ? Number(att.pct) : null;
  const faculty = c.faculty || c.title.match(/ with (?:Prof\. )?(.+)$/)?.[1] || null;
  const tabHref = (t: string) => `/courses/${c.id}?tab=${encodeURIComponent(t)}`;

  return (
    <main className="stack">
      <Link href="/courses" className="crumb"><Icon name="back" /> Courses · {c.term}</Link>

      <section className="card">
        <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <span className="avatar c0" style={{ width: 52, height: 52, fontSize: '1rem' }}>{(c.short_title || c.title).slice(0, 2).toUpperCase()}</span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="eyebrow">{c.term}{c.mode ? ` · ${c.mode}` : ''}</div>
            <h1 style={{ margin: 0 }}>{c.title.replace(/ with (Prof\. )?.+$/, '')}</h1>
            {faculty && <div className="muted">{faculty}</div>}
          </div>
          <div className="row">
            {c.outline && <a className="btn small" href={c.outline} target="_blank" rel="noreferrer">Course outline <Icon name="external" /></a>}
            <Link className="btn small primary" href={`/exam/${c.id}`}><Icon name="target" /> Exam prep{Number(items2?.n) ? ` · ${items2!.n}` : ''}</Link>
          </div>
        </div>
        <div className="grid four" style={{ marginTop: 18, gap: 10 }}>
          <Fact label="Attendance" value={att ? `${att.attended}/${att.total}` : '—'} sub={pct != null ? `${Math.round(pct)}%${att?.note ? ` · ${att.note.replace('Class participation', 'CP')}` : ''}` : undefined} bad={pct != null && pct < 75} />
          <Fact label="Files & notes" value={String(items.length)} sub={`${items.filter((i) => i.kind === 'file').length} files`} />
          <Fact label="Recordings" value={String(recs.length)} />
          <Fact label="Assignments" value={String(asg.length)} sub={asg.some((a) => a.status === 'Pending') ? `${asg.filter((a) => a.status === 'Pending').length} pending` : undefined} />
        </div>
      </section>

      {tabs.length === 0 ? (
        <div className="card"><p style={{ margin: 0 }}>Nothing has been posted on Nexus for this course yet. New material appears here after a sync.</p></div>
      ) : (
        <section className="card">
          <nav className="tabs" style={{ margin: '-6px -6px 16px' }}>
            {tabs.map(([key, label, n]) => (
              <Link key={key} href={tabHref(key)} className={key === active ? 'on' : ''} scroll={false}>{label}<span className="count">{n}</span></Link>
            ))}
          </nav>

          {contentTabs.includes(active!) && (() => {
            const inTab = items.filter((i) => i.tab === active);
            const folders = [...new Set(inTab.map((i) => i.folder || ''))];
            return (
              <div className="stack" style={{ gap: 8 }}>
                {folders.map((folder) => {
                  const inFolder = inTab.filter((i) => (i.folder || '') === folder);
                  const body = <div className="folder-body">{inFolder.map((it) => <ItemRow key={it.id} it={it} links={linksByFile.get(it.id) || []} />)}</div>;
                  if (!folder) return <div key="root">{body}</div>;
                  return (
                    <details key={folder} className="folder" open={folders.length <= 4}>
                      <summary>{folder} {inFolder[0]?.folder_date && <span className="muted small">· {inFolder[0].folder_date}</span>} <span className="pill" style={{ marginLeft: 6 }}>{inFolder.length}</span></summary>
                      {body}
                    </details>
                  );
                })}
              </div>
            );
          })()}

          {active === 'recordings' && (
            <>
              <ul className="list">
                {recs.map((r, i) => (
                  <li key={i} className="row">
                    <span className="icon-tile ink" style={{ width: 30, height: 30 }}><Icon name="video" /></span>
                    <a href={r.url} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 200 }}>{r.title}</a>
                    <span className="muted small">{r.rec_date ? fmtDay(r.rec_date) : 'undated'}</span>
                    {r.date_uncertain && <span className="pill warn" title="Date or order may be swapped on Nexus">date uncertain</span>}
                  </li>
                ))}
              </ul>
              <p className="muted small" style={{ marginTop: 10 }}>YouTube links only. If MESA removes them after you leave, they’ll stop working.</p>
            </>
          )}

          {active === 'assignments' && (
            <div className="table-wrap"><table className="tbl">
              <thead><tr><th>Assignment</th><th>Due</th><th>Type</th><th>Status</th><th>Max marks</th></tr></thead>
              <tbody>{asg.map((a, i) => {
                const st = (a.submission_status && SUBMIT_LABEL[a.submission_status]) || a.status;
                return (
                  <tr key={i}><td>{a.title}</td><td style={{ whiteSpace: 'nowrap' }}>{a.due_date ? fmtDay(a.due_date) : '—'}</td><td>{a.kind ?? '—'}</td>
                    <td><span className={`pill ${st === 'Submitted' ? 'good' : st === 'Pending' || st === 'Late' ? 'warn' : 'bad'}`}>{st}</span></td><td>{a.max_marks ? Number(a.max_marks) : '—'}</td></tr>
                );
              })}</tbody>
            </table></div>
          )}

          {active === 'announcements' && (
            <div>
              {ann.map((a, i) => (
                <article key={i} className="ann">
                  <div className="row" style={{ gap: 8 }}>
                    <strong style={{ fontWeight: 600 }}>{a.title}</strong><span className="spacer" />
                    <span className="muted small">{a.posted_at ? fmtDate(a.posted_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : a.posted}</span>
                  </div>
                  {a.author && <div className="muted small">{a.author}</div>}
                  {a.body ? <div className="ann-body">{a.body}</div> : <div className="muted small">Title only (captured before the sync added text).</div>}
                </article>
              ))}
              {extra.length > 0 && <><h3 style={{ marginTop: 16 }}>Also on Nexus</h3><ul className="list small">{extra.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function Fact({ label, value, sub, bad }: { label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <div className="card flat" style={{ padding: '12px 14px' }}>
      <div className="stat-label">{label}</div>
      <div className="stat" style={{ fontSize: '1.35rem', color: bad ? 'var(--bad)' : undefined }}>{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

function ItemRow({ it, links }: { it: Item; links: LinkT[] }) {
  const typeLabel = it.kind === 'file' ? (it.ext || 'file').toUpperCase() : it.kind.toUpperCase();
  return (
    <div className="file">
      <span className={`pill type ${it.kind === 'file' ? 'accent' : it.kind === 'link' ? 'lime' : ''}`}>{typeLabel}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {it.kind === 'file' ? (
          <a href={rawHref(it.storage_key)} target="_blank" rel="noreferrer" style={{ fontWeight: 500 }}>{it.label}</a>
        ) : (
          <details>
            <summary style={{ fontWeight: 500 }}>{it.label}</summary>
            {it.kind === 'note' && it.note_text && <div className="note-body">{it.note_text}</div>}
          </details>
        )}
        <div className="row small muted" style={{ gap: 12, marginTop: 2 }}>
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
