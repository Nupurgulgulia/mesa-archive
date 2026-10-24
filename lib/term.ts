// The term the app is showing. Chosen in the sidebar and kept in a cookie; defaults to the current term.
import { cookies } from 'next/headers';
import { termOf, todayIST } from './dates';

export const TERMS = ['Term 2', 'Term 1', 'Pre-Term'] as const;
export type TermChoice = (typeof TERMS)[number] | 'all';
export const TERM_COOKIE = 'mesa_term';

export function currentTerm(): TermChoice {
  return termOf(todayIST()) as TermChoice;
}

export function parseTerm(v: string | undefined | null): TermChoice | null {
  if (v === 'all') return 'all';
  return (TERMS as readonly string[]).includes(v || '') ? (v as TermChoice) : null;
}

export async function getTerm(): Promise<TermChoice> {
  return parseTerm((await cookies()).get(TERM_COOKIE)?.value) ?? currentTerm();
}

/** SQL helper: '' means every term. */
export const termParam = (t: TermChoice) => (t === 'all' ? '' : t);
export const termLabel = (t: TermChoice) => (t === 'all' ? 'All terms' : t);
