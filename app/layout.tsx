import './globals.css';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Poppins } from 'next/font/google';
import { COOKIE, verifySession } from '@/lib/auth';
import { currentTerm, getTerm } from '@/lib/term';
import { Icon } from './icons';
import { NavLinks, TermSwitch } from './nav-links';

const poppins = Poppins({ subsets: ['latin'], weight: ['400', '500', '600', '700'], display: 'swap', variable: '--font-sans' });

export const metadata = { title: 'MESA Archive', description: 'Nupur’s MESA repository, exam prep and timeline' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = await verifySession((await cookies()).get(COOKIE)?.value).catch(() => false);
  const term = signedIn ? await getTerm() : 'all';
  return (
    <html lang="en" className={poppins.variable}>
      <head>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      </head>
      <body>
        {signedIn ? (
          <div className="shell">
            <aside className="sidebar">
              <Link href="/" className="brand">
                <span className="brand-mark" aria-hidden="true">M</span>
                <span className="brand-text"><strong>MESA Archive</strong><small>PGP Cohort IV</small></span>
              </Link>
              <div className="side-label">Showing</div>
              <TermSwitch term={term} current={currentTerm()} />
              <NavLinks />
              <form action="/api/logout" method="post" className="side-foot">
                <button className="nav-btn" type="submit"><Icon name="logout" /><span>Sign out</span></button>
              </form>
            </aside>
            <div className="main"><div className="page">{children}</div></div>
          </div>
        ) : (
          <div className="page">{children}</div>
        )}
      </body>
    </html>
  );
}
