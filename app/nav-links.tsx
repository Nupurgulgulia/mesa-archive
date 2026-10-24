'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  ['/', 'Home'],
  ['/courses', 'Courses'],
  ['/search', 'Search'],
  ['/exam', 'Exam prep'],
  ['/timeline', 'Timeline'],
  ['/recommendations', 'Recommendations'],
] as const;

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map(([href, label]) => {
        const active = href === '/' ? path === '/' : path.startsWith(href);
        return (
          <Link key={href} href={href} className={active ? 'active' : ''}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
