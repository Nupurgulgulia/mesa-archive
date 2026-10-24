// Minimal SigV4 client for the Neon `mesa-files` bucket (no dependencies).
// Reads credentials from .env.local in the repo root. Never log the secret.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const p = path.join(__dirname, '..', '..', '.env.local');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  const e = process.env;
  for (const k of ['NEON_S3_ENDPOINT', 'NEON_S3_REGION', 'NEON_S3_BUCKET', 'NEON_S3_ACCESS_KEY_ID', 'NEON_S3_SECRET_ACCESS_KEY'])
    if (!e[k]) throw new Error('missing ' + k + ' in .env.local');
  return { endpoint: e.NEON_S3_ENDPOINT, region: e.NEON_S3_REGION, bucket: e.NEON_S3_BUCKET, ak: e.NEON_S3_ACCESS_KEY_ID, sk: e.NEON_S3_SECRET_ACCESS_KEY };
}
const cfg = loadEnv();

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encKey = (k) => k.split('/').map(enc).join('/');

function sign(method, key, query = {}, body = '', headers = {}) {
  const u = new URL(cfg.endpoint);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const canonPath = '/' + cfg.bucket + (key ? '/' + encKey(key) : '');
  const qs = Object.keys(query).sort().map((k) => enc(k) + '=' + enc(query[k])).join('&');
  const payloadHash = typeof body === 'string' && body === '' ? sha256('') : sha256(body);
  const h = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': now, ...headers };
  const names = Object.keys(h).map((x) => x.toLowerCase()).sort();
  const canonHeaders = names.map((n) => n + ':' + String(h[Object.keys(h).find((x) => x.toLowerCase() === n)]).trim() + '\n').join('');
  const signed = names.join(';');
  const creq = [method, canonPath, qs, canonHeaders, signed, payloadHash].join('\n');
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', now, scope, sha256(creq)].join('\n');
  const kSig = hmac(hmac(hmac(hmac('AWS4' + cfg.sk, date), cfg.region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSig).update(sts).digest('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.ak}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  delete h.host;
  return { url: u.origin + canonPath + (qs ? '?' + qs : ''), headers: h };
}

// fetch with retries for her intermittent connection (DNS drops, connect timeouts, 5xx)
const { retry } = require('./retry');
async function rfetch(url, opts, label) {
  return retry(async () => {
    const r = await fetch(url, opts);
    if (r.status >= 500) throw new Error(`${label}: ${r.status} timeout`);
    return r;
  }, { label });
}

async function getObject(key) {
  const { url, headers } = sign('GET', key);
  const r = await rfetch(url, { headers }, 'GET ' + key);
  if (!r.ok) throw new Error(`GET ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function putObject(key, body, contentType = 'application/octet-stream') {
  const { url, headers } = sign('PUT', key, {}, body, { 'content-type': contentType });
  const r = await rfetch(url, { method: 'PUT', headers, body }, 'PUT ' + key);
  if (!r.ok) throw new Error(`PUT ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status;
}

// Presigned PUT URL (query-string SigV4) so a browser page can upload one object without credentials.
function presignPut(key, contentType, expiresSeconds = 3600) {
  const u = new URL(cfg.endpoint);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const canonPath = '/' + cfg.bucket + '/' + encKey(key);
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${cfg.ak}/${scope}`, 'X-Amz-Date': now,
    'X-Amz-Expires': String(expiresSeconds), 'X-Amz-SignedHeaders': 'content-type;host',
  };
  const qs = Object.keys(query).sort().map((k) => enc(k) + '=' + enc(query[k])).join('&');
  const creq = ['PUT', canonPath, qs, `content-type:${contentType}\nhost:${u.host}\n`, 'content-type;host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', now, scope, sha256(creq)].join('\n');
  const kSig = hmac(hmac(hmac(hmac('AWS4' + cfg.sk, date), cfg.region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSig).update(sts).digest('hex');
  return `${u.origin}${canonPath}?${qs}&X-Amz-Signature=${sig}`;
}

async function deleteObject(key) {
  const { url, headers } = sign('DELETE', key);
  const r = await rfetch(url, { method: 'DELETE', headers }, 'DELETE ' + key);
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status;
}

const xmlDecode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');

async function listObjects(prefix = '') {
  const out = [];
  let token;
  do {
    const q = { 'list-type': '2', prefix };
    if (token) q['continuation-token'] = token;
    const { url, headers } = sign('GET', '', q);
    const r = await rfetch(url, { headers }, 'LIST');
    const x = await r.text();
    if (!r.ok) throw new Error(`LIST: ${r.status} ${x.slice(0, 200)}`);
    for (const m of x.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const g = (t) => (m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1];
      out.push({ key: xmlDecode(g('Key')), size: +g('Size'), etag: xmlDecode(g('ETag') || '').replace(/"/g, ''), last_modified: g('LastModified') });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(x) ? xmlDecode((x.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] || '') : null;
  } while (token);
  return out;
}

module.exports = { getObject, putObject, deleteObject, listObjects, presignPut, cfg:{ endpoint: cfg.endpoint, bucket: cfg.bucket } };
