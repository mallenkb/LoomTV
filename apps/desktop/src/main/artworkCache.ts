import { createHash } from 'node:crypto';

const MAX_CACHED_CANDIDATES_PER_KIND = 2;
const CUSTOM_ARTWORK_PROTOCOL = 'loomtv-custom-artwork:';

type ArtworkCacheItem = {
  poster?: string;
  backdrop?: string;
  logo?: string;
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logoCandidates?: string[];
  cast?: Array<{ image?: string; characterImage?: string; voiceActorImage?: string }>;
  episodes?: Array<{ still?: string }>;
  episodeFiles?: Array<{ still?: string; thumbnail?: string }>;
};

type ArtworkCacheLibrary = {
  movies?: ArtworkCacheItem[];
  tvShows?: ArtworkCacheItem[];
  animeShows?: ArtworkCacheItem[];
};

export type CustomArtworkReference = {
  mediaId: string;
  target: string;
};

export function customArtworkReference(mediaId: string, target: string): string {
  const normalizedMediaId = encodeURIComponent(mediaId.trim());
  const normalizedTarget = encodeURIComponent(target.trim());
  return normalizedMediaId && normalizedTarget
    ? `${CUSTOM_ARTWORK_PROTOCOL}//artwork/${normalizedMediaId}/${normalizedTarget}`
    : '';
}

export function parseCustomArtworkReference(source?: string | null): CustomArtworkReference | null {
  const value = (source || '').trim();
  if (!value.startsWith(`${CUSTOM_ARTWORK_PROTOCOL}//`)) return null;

  try {
    const parsed = new URL(value);
    if (parsed.hostname !== 'artwork') return null;
    const [mediaIdPart, targetPart] = parsed.pathname.replace(/^\/+/, '').split('/');
    const mediaId = decodeURIComponent(mediaIdPart || '');
    const target = decodeURIComponent(targetPart || '');
    return mediaId && target ? { mediaId, target } : null;
  } catch {
    return null;
  }
}

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
    for (const credit of item.cast || []) {
      add(credit.image);
      add(credit.characterImage);
      add(credit.voiceActorImage);
    }
    for (const episode of item.episodes || []) add(episode.still);
    for (const episodeFile of item.episodeFiles || []) {
      add(episodeFile.still);
      add(episodeFile.thumbnail);
    }
  }

  return Array.from(sources);
}

export function cachedArtworkResponseHeaders(
  mimeType: string,
  byteLength: number,
  cacheControl = 'no-store',
): Record<string, string | number> {
  return {
    'Content-Type': mimeType,
    'Cache-Control': cacheControl,
    'Content-Length': byteLength,
  };
}

function artworkExtensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(';')[0].trim();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/avif') return '.avif';
  if (normalized === 'image/gif') return '.gif';
  return '.jpg';
}

export function artworkCacheFileName(sourceUrl: string, mimeType: string): string {
  const digest = createHash('sha256').update(sourceUrl).digest('hex');
  return `${digest}${artworkExtensionForMimeType(mimeType)}`;
}
