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

// Other providers have no smaller renditions, so the host resizes its cached
// copy. The fragment never reaches a provider; it only names the cache row.
const variantMarker = '#loom-width=';

/** Pixel width for a requested rendition, or 0 when none applies. */
export function artworkRenditionPixels(width: string | null): number {
  return width && widths.has(width) ? Number(width.slice(1)) : 0;
}

export function resizedArtworkCacheKey(source: string, pixels: number): string {
  return `${source}${variantMarker}${pixels}`;
}

/**
 * The library source a cache row belongs to. Smaller TMDB renditions and
 * host-resized copies share their original's key, so pruning the cache to the
 * library's sources keeps them instead of deleting them on every sync.
 */
export function artworkCacheOwner(key: string): string {
  const index = key.lastIndexOf(variantMarker);
  const source = index === -1 ? key : key.slice(0, index);
  try {
    const url = new URL(source);
    if (url.hostname !== 'image.tmdb.org' || !rendition.test(url.pathname)) return source;
    url.pathname = url.pathname.replace(rendition, '/t/p/*/');
    return url.href;
  } catch { return source; }
}
