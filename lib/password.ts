// Password check against APP_PASSWORD_HASH ("scrypt:<salt b64>:<hash b64>"; ':' because Next.js expands '$' in .env files), Node runtime only.
import crypto from 'crypto';

export function verifyPassword(password: string): boolean {
  const stored = process.env.APP_PASSWORD_HASH || '';
  const [alg, saltB64, hashB64] = stored.split(':');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
