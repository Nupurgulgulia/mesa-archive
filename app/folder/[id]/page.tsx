import fs from 'fs';
import { notFound } from 'next/navigation';
import { one, PROFILE } from '@/lib/db';
import { rawHref } from '@/lib/links';
import { localPath, presignGet } from '@/lib/storage';

export const dynamic = 'force-dynamic';

type Entry = { kind: string; id: string; name: string; status: string; key?: string; bytes?: number; error?: string };

// Lists the files of an exported Google Drive folder (from its _index.json).
export default async function Folder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const l = await one<{ url: string; export_key: string; used_by: string }>(
    `select l.url, l.export_key, string_agg(distinct f.label, ', ') used_by from link_targets l
     join file_links fl on fl.link_id=l.id join files f on f.id=fl.file_id
     where l.id=$1 and l.profile_id=$2 and l.provider='gdrive_folder' and l.export_key is not null group by 1,2`, [id, PROFILE]);
  if (!l) notFound();
  const key = l.export_key + '_index.json';
  const lp = localPath(key);
  const text = lp ? fs.readFileSync(lp, 'utf8') : await (await fetch(presignGet(key, 60))).text();
  const idx = JSON.parse(text) as { exported_at: string; entries: Entry[] };
  return (
    <main className="card">
      <h1>Drive folder: {l.used_by}</h1>
      <p className="muted small">Saved {idx.exported_at.slice(0, 10)} from <a href={l.url} target="_blank" rel="noreferrer">the original folder ↗</a></p>
      <ul className="list">
        {idx.entries.map((e) => (
          <li key={e.id} className="row">
            {e.key ? <a href={rawHref(e.key)} target="_blank" rel="noreferrer">{e.name}</a> : <span>{e.name}</span>}
            {e.bytes != null && <span className="muted small">{(e.bytes / 1048576).toFixed(1)} MB</span>}
            {e.status !== 'exported' && <span className="pill warn" title={e.error}>{e.status}</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}
