import { NextResponse } from 'next/server';
import { COOKIE, makeSession } from '@/lib/auth';
import { verifyPassword } from '@/lib/password';

export const runtime = 'nodejs';

// Slow down guessing: one attempt per second per process, plus a fixed delay on failure.
let lastAttempt = 0;

export async function POST(req: Request) {
  const now = Date.now();
  if (now - lastAttempt < 1000) await new Promise((r) => setTimeout(r, 1000));
  lastAttempt = Date.now();

  const form = await req.formData();
  const password = String(form.get('password') || '');
  const next = String(form.get('next') || '/');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';

  if (!process.env.APP_PASSWORD_HASH) {
    return NextResponse.redirect(new URL('/login?e=nopass', req.url), 303);
  }
  if (!verifyPassword(password)) {
    await new Promise((r) => setTimeout(r, 1500));
    return NextResponse.redirect(new URL(`/login?e=1&next=${encodeURIComponent(safeNext)}`, req.url), 303);
  }
  const s = await makeSession();
  const res = NextResponse.redirect(new URL(safeNext, req.url), 303);
  res.cookies.set(COOKIE, s.value, { httpOnly: true, sameSite: 'lax', secure: new URL(req.url).protocol === 'https:', path: '/', maxAge: s.maxAge });
  return res;
}
