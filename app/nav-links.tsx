'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Icon, type IconName } from './icons';

const LINKS: [string, string, IconName][] = [
  ['/', 'Dashboard', 'home'],
  ['/courses', 'Courses', 'book'],
  ['/exam', 'Exam prep', 'target'],
  ['/timeline', 'Timeline', 'calendar'],
  ['/search', 'Search', 'search'],
  ['/recommendations', 'Recommendations', 'spark'],
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map(([href, label, icon]) => {
        const active = href === '/' ? path === '/' : path.startsWith(href);
        return (
          <Link key={href} href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
            <Icon name={icon} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

const CHOICES = [['Term 2', 'Term 2'], ['Term 1', 'Term 1'], ['Pre-Term', 'Pre'], ['all', 'All']] as const;

export function TermSwitch({ term, current }: { term: string; current: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const pick = (v: string) => {
    document.cookie = `mesa_term=${encodeURIComponent(v)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    start(() => router.refresh());
  };
  return (
    <div className={`term-switch ${pending ? 'pending' : ''}`} role="radiogroup" aria-label="Term">
      {CHOICES.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={term === v} className={term === v ? 'on' : ''} onClick={() => pick(v)}
          title={v === current ? `${v} (current)` : v === 'all' ? 'All terms' : v}>
          {label}{v === current && <i className="dot" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

/** Term tabs at the top of a page; same choice as the sidebar switch. */
export function TermTabs({ term, counts }: { term: string; counts: Record<string, number> }) {
  const router = useRouter();
  const [, start] = useTransition();
  const pick = (v: string) => {
    document.cookie = `mesa_term=${encodeURIComponent(v)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    start(() => router.refresh());
  };
  return (
    <div className="tabs" role="tablist">
      {CHOICES.map(([v]) => (
        <a key={v} href="#" role="tab" aria-selected={term === v} className={term === v ? 'on' : ''}
          onClick={(e) => { e.preventDefault(); pick(v); }}>
          {v === 'all' ? 'All terms' : v}<span className="count">{counts[v] ?? 0}</span>
        </a>
      ))}
    </div>
  );
}
