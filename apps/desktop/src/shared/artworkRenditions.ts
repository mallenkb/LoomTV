const widths = new Set(['w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'w780', 'w1280']);
const rendition = /\/t\/p\/(w\d+|original)\//;

export function smallerTmdbArtwork(source: string, width: string | null): string {
  if (!width || !widths.has(width)) return source;
  try {
    const url = new URL(source);
    if (url.hostname !== 'image.tmdb.org' || !['https:', 'http:'].includes(url.protocol)) return source;
    const current = url.pathname.match(rendition)?.[1];
    if (!current || (current !== 'original' && Number(current.slice(1)) <= Number(width.slice(1)))) return source;
    url.pathname = url.pathname.replace(rendition, `/t/p/${width}/`);
    return url.href;
  } catch { return source; }
}
