const MAX_CACHED_CANDIDATES_PER_KIND = 2;
const MAX_CACHED_EPISODE_STILLS_PER_ITEM = 6;

type ArtworkCacheItem = {
  poster?: string;
  backdrop?: string;
  logo?: string;
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logoCandidates?: string[];
  episodes?: Array<{ still?: string }>;
};

type ArtworkCacheLibrary = {
  movies?: ArtworkCacheItem[];
  tvShows?: ArtworkCacheItem[];
  animeShows?: ArtworkCacheItem[];
};

function isCacheableArtworkSource(source: string): boolean {
  try {
    const parsed = new URL(source);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    return false;
  }
}

export function collectArtworkSourcesForCache(data: ArtworkCacheLibrary): string[] {
  const sources = new Set<string>();
  const add = (source?: string) => {
    if (source && isCacheableArtworkSource(source)) sources.add(source);
  };
  const addCandidates = (candidates?: string[]) => {
    (candidates || []).slice(0, MAX_CACHED_CANDIDATES_PER_KIND).forEach(add);
  };

  for (const item of [...(data.movies || []), ...(data.tvShows || []), ...(data.animeShows || [])]) {
    add(item.poster);
    add(item.backdrop);
    add(item.logo);
    addCandidates(item.posterCandidates);
    addCandidates(item.backdropCandidates);
    addCandidates(item.logoCandidates);
    (item.episodes || []).slice(0, MAX_CACHED_EPISODE_STILLS_PER_ITEM).forEach((episode) => add(episode.still));
  }

  return Array.from(sources);
}

export function cachedArtworkResponseHeaders(mimeType: string, byteLength: number): Record<string, string | number> {
  return {
    'Content-Type': mimeType,
    'Cache-Control': 'no-store',
    'Content-Length': byteLength,
  };
}
