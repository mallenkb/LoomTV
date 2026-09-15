/**
 * Request a smaller TMDB rendition for artwork that is displayed small.
 *
 * Current cache URLs carry an opaque resourceId. The host selects the
 * rendition after resolving that capability. Legacy encoded sources and
 * direct TMDB URLs also support smaller renditions. Signed URLs stay intact.
 */

import { smallerTmdbArtwork } from '../shared/artworkRenditions';

/** TMDB rendition widths that exist for posters and backdrops. */
export type TmdbWidth = 'w92' | 'w154' | 'w185' | 'w300' | 'w342' | 'w500' | 'w780' | 'w1280';

export function artworkVariant(url: string | undefined, width: TmdbWidth): string {
  if (!url) return '';
  // The host leaves non-TMDB sources unchanged.
  try {
    const parsed = new URL(url, 'http://127.0.0.1');
    // Signed remote URLs must retain the exact query issued by the host.
    if (parsed.searchParams.has('sig')) return url;
    if (parsed.pathname === '/api/cached-artwork' && parsed.searchParams.has('resourceId')) {
      parsed.searchParams.set('width', width);
      return url.startsWith('/') ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.href;
    }
    const source = parsed.searchParams.get('source');
    const resized = smallerTmdbArtwork(source || url, width);
    if (!source) return resized;
    if (resized === source) return url;
    parsed.searchParams.set('source', resized);
    return url.startsWith('/') ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.href;
  } catch {
    return url;
  }
}
