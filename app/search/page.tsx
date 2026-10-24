import Link from 'next/link';
import { q, PROFILE } from '@/lib/db';
import { fmtDay } from '@/lib/dates';
import { pageHref } from '@/lib/links';
import { getTerm, parseTerm, termParam, TERMS } from '@/lib/term';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Search · MESA Archive' };

type Hit = {
  storage_key: string; course_id: string; short_title: string; doc: string; source_kind: string; is_ocr: boolean;
  page: number | null; rank: number; snip: string; hits: string;
};

export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string; course?: string; term?: string }> }) {
  const sp = await searchParams;
  const query = (sp.q || '').trim().slice(0, 200);
  const course = sp.course || '';
  const choice = parseTerm(sp.term) ?? (await getTerm());
  const T = termParam(choice);
  const courses = await q<{ id: string; short_title: string; term: string }>(
    `select id, short_title, term from courses c where profile_id=$1 and exists (select 1 from doc_chunks d where d.course_id=c.id) order by term desc, short_title`, [PROFILE]);

  let hits: Hit[] = [];
  let broader: Hit[] = [];
  let other: { type: string; title: string; sub: string; href: string }[] = [];
  if (query) {
    hits = await docSearch(query, course, T);
    // Few strict (all-words) matches: also show documents matching any of the words.
    const words = query.replace(/["()]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^(or|and|-.*)$/i.test(w));
    if (hits.length < 5 && words.length > 1) {
      const seen = new Set(hits.map((h) => h.storage_key));
      broader = (await docSearch(words.join(' or '), course, T)).filter((h) => !seen.has(h.storage_key)).slice(0, 20);
    }
    const like = `%${query.replace(/[%_]/g, '')}%`;
    other = await q<{ type: string; title: string; sub: string; href: string }>(
      `select 'Recording' type, r.title || ' · ' || c.short_title title, coalesce(r.rec_date::text,'') sub, r.url href
         from recordings r join courses c on c.id=r.course_id where r.profile_id=$1 and (r.title ilike $2 or c.title ilike $2) and ($3='' or r.course_id=$3) and ($4='' or c.term=$4)
       union all
       select 'Assignment', a.title, coalesce(a.due_date::text,'') || ' · ' || a.status, coalesce('/courses/'||a.course_id,'/timeline')
         from assignments a left join courses c on c.id=a.course_id where a.profile_id=$1 and a.title ilike $2 and ($3='' or a.course_id=$3) and ($4='' or coalesce(c.term,'Term 1')=$4)
       union all
       select 'Calendar', e.title, e.date::text || ' ' || e.start_time, '/timeline?from=' || e.date::text
         from calendar_events e where e.profile_id=$1 and e.title ilike $2 and ($3='' or e.course_id=$3) and ($4='' or e.term=$4)
       union all
       select 'Item', f.label || ' · ' || c.short_title, f.kind, '/courses/' || f.course_id
         from files f join courses c on c.id=f.course_id where f.profile_id=$1 and f.label ilike $2 and ($3='' or f.course_id=$3) and ($4='' or c.term=$4)
       limit 25`, [PROFILE, like, course, T]);
  }

  return (
    <main className="stack">
      <div className="page-head"><div><div className="eyebrow">Full text</div><h1>Search</h1>
        <p>Every archived PDF, deck, document, sheet and note, OCR text of scans, and saved copies of linked Google files and Gamma decks.</p></div></div>
      <form className="card searchbar" action="/search">
        <input type="search" name="q" defaultValue={query} placeholder='Try: mom test discovery, "contribution margin", deferred tax' style={{ flex: 3, minWidth: 220 }} autoFocus />
        <select name="term" defaultValue={choice} style={{ flex: 1, minWidth: 130 }}>
          {TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
          <option value="all">All terms</option>
        </select>
        <select name="course" defaultValue={course} style={{ flex: 1, minWidth: 160 }}>
          <option value="">All courses</option>
          {courses.filter((c) => !T || c.term === T).map((c) => <option key={c.id} value={c.id}>{c.short_title}{T ? '' : ` (${c.term})`}</option>)}
        </select>
        <button className="btn primary" type="submit">Search</button>
      </form>
      <p className="muted small">Use quotes for exact phrases, <code>-word</code> to exclude, <code>or</code> for either.</p>

      {query && (
        <section className="card">
          <h2>{hits.length ? `${hits.length} document${hits.length === 1 ? '' : 's'}` : 'No document text matches'}</h2>
          {hits.map((h) => <HitRow key={h.storage_key} h={h} />)}
        </section>
      )}

      {broader.length > 0 && (
        <section className="card">
          <h2>Broader matches <span className="muted small">(some of the words)</span></h2>
          {broader.map((h) => <HitRow key={h.storage_key} h={h} />)}
        </section>
      )}

      {query && other.length > 0 && (
        <section className="card">
          <h2>Titles</h2>
          <ul className="list">
            {other.map((o, i) => (
              <li key={i} className="row"><span className="pill">{o.type}</span>
                {o.href.startsWith('http') ? <a href={o.href} target="_blank" rel="noreferrer">{o.title}</a> : <Link href={o.href}>{o.title}</Link>}
                <span className="muted small">{/^\d{4}-\d\d-\d\d/.test(o.sub) ? fmtDay(o.sub.slice(0, 10)) + o.sub.slice(10) : o.sub}</span></li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

async function docSearch(query: string, course: string, term: string) {
  return q<Hit>(
    `with qq as (select websearch_to_tsquery('english', $2) tq),
     ranked as (
       select d.*, ts_rank_cd(d.tsv, qq.tq, 32) rank,
              row_number() over (partition by d.storage_key order by ts_rank_cd(d.tsv, qq.tq, 32) desc) rn,
              count(*) over (partition by d.storage_key) hits
       from doc_chunks d, qq where d.profile_id=$1 and d.tsv @@ qq.tq and ($3 = '' or d.course_id = $3))
     select r.storage_key, r.course_id, c.short_title, coalesce(f.label, r.heading, split_part(r.storage_key,'/',-1)) doc,
            r.source_kind, r.is_ocr, r.page, r.rank, r.hits::text,
            ts_headline('english', r.content, (select tq from qq), 'MaxFragments=2,MaxWords=28,MinWords=12,FragmentDelimiter= … ,StartSel=<mark>,StopSel=</mark>') snip
     from ranked r join courses c on c.id=r.course_id left join files f on f.id=r.file_id
     where r.rn=1 and ($4 = '' or c.term = $4) order by r.rank desc limit 40`, [PROFILE, query, course, term]);
}

function HitRow({ h }: { h: Hit }) {
  return (
    <div className="hit">
      <div className="row">
        <a href={pageHref(h.storage_key, h.page)} target="_blank" rel="noreferrer"><strong>{h.doc}</strong></a>
        <Link href={`/courses/${h.course_id}`} className="pill accent">{h.short_title}</Link>
        {h.page && <span className="pill">p. {h.page}</span>}
        {h.source_kind === 'link_export' && <span className="pill">saved link</span>}
        {h.is_ocr && <span className="pill warn" title="Text recognised from a scan; may contain errors">OCR</span>}
        {Number(h.hits) > 1 && <span className="muted small">{h.hits} matching passages</span>}
      </div>
      {/* ts_headline output: only <mark> tags are added; source text is escaped below */}
      <div className="snippet" dangerouslySetInnerHTML={{ __html: safeSnippet(h.snip) }} />
    </div>
  );
}

// Escape everything, then restore only the <mark> tags ts_headline inserted.
function safeSnippet(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>').replace(/\n+/g, ' ');
}
