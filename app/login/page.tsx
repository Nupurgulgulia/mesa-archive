export const metadata = { title: 'Sign in · MESA Archive' };

export default async function Login({ searchParams }: { searchParams: Promise<{ e?: string; next?: string }> }) {
  const { e, next } = await searchParams;
  return (
    <main className="login">
      <div>
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">M</span>
          <h1 style={{ margin: 0 }}>MESA Archive</h1>
          <div className="eyebrow" style={{ margin: 0 }}>PGP Cohort IV · private</div>
        </div>
        <form method="post" action="/api/login" className="card login-card">
          <div>
            <h2 style={{ margin: 0, fontSize: '1.3rem' }}>Sign in</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>Your courses, notes, exam prep and timeline.</p>
          </div>
          <input type="hidden" name="next" value={next || '/'} />
          <label htmlFor="pw">Password</label>
          <input id="pw" name="password" type="password" autoComplete="current-password" autoFocus required />
          {e === '1' && <p className="err small" style={{ margin: 0 }}>That password didn’t match.</p>}
          {e === 'nopass' && <p className="err small" style={{ margin: 0 }}>No password is set yet. Run <code>npm run set-password</code> in the project folder.</p>}
          <button type="submit" className="btn mint" style={{ padding: '10px 15px' }}>Sign in →</button>
        </form>
      </div>
    </main>
  );
}
