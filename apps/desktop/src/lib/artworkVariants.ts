/**
 * Request a smaller TMDB rendition for artwork that is displayed small.
 *
 * Artwork reaches the renderer as `/api/cached-artwork?source=<tmdb url>`, and
 * the rendition is a path segment inside that source (`/t/p/w500/abc.jpg`).
 * Rewriting the segment yields a distinct cache key, so the desktop caches and
 * serves the smaller asset instead of the full-size one.
 *
 * This matters because Chromium decodes to raw RGBA regardless of display size:
 * a w500 poster costs 500x750x4 = 1.5MB of resident memory even when it is
 * painted into a 150x225 box. Sizes must still account for device pixel ratio —
 * a 150px box needs 300 device pixels on a 2x display — so only shrink where
 * there is real headroom.
 */

const TMDB_RENDITION = /\/t\/p\/(w\d+|original)\//;

/** TMDB rendition widths that exist for posters and backdrops. */
export type TmdbWidth = 'w92' | 'w154' | 'w185' | 'w300' | 'w342' | 'w500' | 'w780' | 'w1280';

export function artworkVariant(url: string | undefined, width: TmdbWidth): string {
  if (!url) return '';
  // Only proxied TMDB sources carry a rewritable rendition; local images,
  // custom artwork, and thumbnails are returned untouched.
  if (!TMDB_RENDITION.test(url)) return url;
  try {
    const parsed = new URL(url, 'http://127.0.0.1');
    const source = parsed.searchParams.get('source');
    if (!source || !TMDB_RENDITION.test(source)) return url;
    parsed.searchParams.set('source', source.replace(TMDB_RENDITION, `/t/p/${width}/`));
    return `${parsed.origin}${parsed.pathname}?${parsed.searchParams.toString()}`;
  } catch {
    return url;
  }
}
