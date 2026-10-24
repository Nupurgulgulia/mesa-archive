// Everything is in India time (IST, UTC+5:30): MESA's calendar, deadlines and "today".
export const TZ = 'Asia/Kolkata';

export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(toISO + 'T00:00:00Z') - Date.parse(fromISO + 'T00:00:00Z')) / 86_400_000);
}

export function fmtDate(d: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d.length === 10 ? d + 'T00:00:00+05:30' : d) : d;
  return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...opts }).format(date);
}

export function fmtDay(d: string | Date | null | undefined) {
  return fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function relDays(n: number): string {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

export function termOf(dateISO: string): string {
  if (dateISO < '2026-08-10') return 'Pre-Term';
  return dateISO < '2026-10-19' ? 'Term 1' : 'Term 2';
}
