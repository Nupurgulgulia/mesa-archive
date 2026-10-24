// Helpers for linking to archived objects and external targets.
export const rawHref = (key: string) => '/raw/' + key.split('/').map(encodeURIComponent).join('/');

export function ytId(url: string): string | null {
  return url.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/)?.[1] ?? null;
}

export const PROVIDER_LABEL: Record<string, string> = {
  gdoc: 'Google Doc', gsheet: 'Google Sheet', gslide: 'Google Slides', gdrive_file: 'Drive file',
  gdrive_folder: 'Drive folder', gamma: 'Gamma deck', youtube: 'YouTube', other: 'Web link',
};

export function pageHref(key: string, page: number | null | undefined) {
  return rawHref(key) + (page && /\.pdf$/i.test(key) ? `#page=${page}` : '');
}
