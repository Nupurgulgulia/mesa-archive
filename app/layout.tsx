import './globals.css';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { COOKIE, verifySession } from '@/lib/auth';
import { NavLinks } from './nav-links';

export const metadata = { title: 'MESA Archive', description: 'Nupur’s MESA repository, exam prep and timeline' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = await verifySession((await cookies()).get(COOKIE)?.value).catch(() => false);
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      </head>
      <body>
        {signedIn && (
          <header className="topbar">
            <Link href="/" className="brand">MESA<span>archive</span></Link>
            <NavLinks />
            <form action="/api/logout" method="post"><button className="btn ghost small" type="submit">Sign out</button></form>
          </header>
        )}
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
