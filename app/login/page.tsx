export const metadata = { title: 'Sign in · MESA Archive' };

export default async function Login({ searchParams }: { searchParams: Promise<{ e?: string; next?: string }> }) {
  const { e, next } = await searchParams;
  return (
    <main className="login">
      <form method="post" action="/api/login" className="card login-card">
        <h1>MESA Archive</h1>
        <p className="muted">Private. Sign in to continue.</p>
        <input type="hidden" name="next" value={next || '/'} />
        <label htmlFor="pw">Password</label>
        <input id="pw" name="password" type="password" autoComplete="current-password" autoFocus required />
        {e === '1' && <p className="err">That password didn’t match.</p>}
        {e === 'nopass' && <p className="err">No password is set yet. Run <code>npm run set-password</code> in the project folder.</p>}
        <button type="submit" className="btn primary">Sign in</button>
      </form>
    </main>
  );
}
