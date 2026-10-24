import fs from 'fs';
import { Readable } from 'stream';
import { NextResponse } from 'next/server';
import { isSignedIn } from '@/lib/auth';
import { one, PROFILE } from '@/lib/db';
import { contentType, localPath, presignGet } from '@/lib/storage';

export const runtime = 'nodejs';

// Serves one archived object. Only keys the database knows about are allowed:
// course items (files.storage_key), extracted documents incl. link exports (doc_extractions),
// their OCR sidecars (_ocr/<key>.txt), and Drive-folder _index.json files of exported links.
async function allowed(key: string): Promise<boolean> {
  const base = key.startsWith('_ocr/') && key.endsWith('.txt') ? key.slice(5, -4) : key;
  const hit = await one(
    `select 1 from files where profile_id=$1 and storage_key=$2
     union all select 1 from doc_extractions where profile_id=$1 and storage_key=$2
     union all select 1 from link_targets where profile_id=$1 and (export_key=$2 or ($2 like export_key || '%' and export_key like '%/'))
     limit 1`, [PROFILE, base]);
  return Boolean(hit);
}

export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  if (!(await isSignedIn(req))) return new NextResponse('not signed in', { status: 401 });
  const key = (await params).key.map(decodeURIComponent).join('/');
  if (key.includes('..') || !(await allowed(key))) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const name = key.split('/').pop() || 'file';
  const type = contentType(key);
  const headers: Record<string, string> = {
    'content-type': type,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=3600',
  };
  // Archived web pages run no scripts in our origin
  if (type.startsWith('text/html')) headers['content-security-policy'] = 'sandbox';

  const lp = localPath(key);
  if (!lp) return NextResponse.redirect(presignGet(key, 600, name), 302);

  const size = fs.statSync(lp).size;
  const range = req.headers.get('range')?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    const stream = Readable.toWeb(fs.createReadStream(lp, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
  }
  const stream = Readable.toWeb(fs.createReadStream(lp)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, 'accept-ranges': 'bytes', 'content-length': String(size) } });
}
