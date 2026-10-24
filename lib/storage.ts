// File access for the app: prefer the verified local archive (fast, offline), else a short-lived
// presigned GET from the Neon bucket using the app's READ-ONLY credential.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadEnv } from './env';

loadEnv();

const winSafe = (seg: string) => seg.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));

export function localPath(key: string): string | null {
  const root = process.env.ARCHIVE_DIR;
  if (!root) return null;
  const p = path.join(root, ...key.split('/').map(winSafe));
  // never escape the archive folder
  if (!path.resolve(p).startsWith(path.resolve(root))) return null;
  return fs.existsSync(p) ? p : null;
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function presignGet(key: string, expiresSeconds = 300, downloadName?: string): string {
  const endpoint = process.env.NEON_S3_ENDPOINT!;
  const region = process.env.NEON_S3_REGION || 'ap-southeast-1';
  const bucket = process.env.NEON_S3_BUCKET || 'mesa-files';
  const ak = process.env.APP_S3_ACCESS_KEY_ID!;
  const sk = process.env.APP_S3_SECRET_ACCESS_KEY!;
  const host = new URL(endpoint).host;
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const canonPath = `/${bucket}/${key.split('/').map(enc).join('/')}`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${ak}/${scope}`,
    'X-Amz-Date': now,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  if (downloadName) query['response-content-disposition'] = `inline; filename="${downloadName.replace(/"/g, '')}"`;
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const creq = ['GET', canonPath, qs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', now, scope, crypto.createHash('sha256').update(creq).digest('hex')].join('\n');
  const h = (k: crypto.BinaryLike, d: string) => crypto.createHmac('sha256', k).update(d).digest();
  const kSig = h(h(h(h('AWS4' + sk, date), region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSig).update(sts).digest('hex');
  return `${new URL(endpoint).origin}${canonPath}?${qs}&X-Amz-Signature=${sig}`;
}

const TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8', md: 'text/markdown; charset=utf-8', html: 'text/html; charset=utf-8', mp4: 'video/mp4',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', rtf: 'application/rtf',
};
export const contentType = (key: string) => TYPES[(key.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()] || 'application/octet-stream';
