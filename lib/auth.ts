// Single-user auth: one password (scrypt hash in APP_PASSWORD_HASH), a signed session cookie.
// Uses Web Crypto for the cookie so the same code runs in middleware (edge) and route handlers.
export const COOKIE = 'mesa_session';
const MAX_AGE_S = 60 * 60 * 24 * 14; // 14 days

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(data: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET missing or too short (run npm run set-password)');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function makeSession(): Promise<{ value: string; maxAge: number }> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const payload = `v1.${exp}`;
  return { value: `${payload}.${await hmac(payload)}`, maxAge: MAX_AGE_S };
}

export async function verifySession(value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = await hmac(`${parts[0]}.${parts[1]}`);
  // constant-time compare
  if (expected.length !== parts[2].length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  return diff === 0;
}

// Second check inside route handlers, so a middleware bypass can't reach data or writes.
export async function isSignedIn(req: Request): Promise<boolean> {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\s*)${COOKIE}=([^;]+)`));
  return verifySession(m ? decodeURIComponent(m[1]) : undefined).catch(() => false);
}
