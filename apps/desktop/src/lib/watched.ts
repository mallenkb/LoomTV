import type { MediaItem } from '@/contexts/LibraryContext';
import type { StremioPluginCatalogItem } from '@/shared/desktopProtocol';
import { parseStoredValue, stremioCatalogItemSchema } from '@/lib/desktopDecoders';

const WATCHED_DISCOVER_CACHE_PREFIX = 'loomtv:watched-discover-item-v1:';

export function localWatchedKey(mediaId: string): string {
  return `local:${encodeURIComponent(mediaId)}`;
}

export function localEpisodeWatchedKey(mediaId: string, season: number, episode: number): string {
  return `local:${encodeURIComponent(mediaId)}:s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
}

export function discoverWatchedKey(item: Pick<StremioPluginCatalogItem, 'id' | 'type' | 'source'>): string {
  const source = item.source?.trim() || 'catalog';
  return `discover:${encodeURIComponent(source)}:${encodeURIComponent(item.type)}:${encodeURIComponent(item.id)}`;
}

export function localWatchedKeysForItem(item: Pick<MediaItem, 'id' | 'type' | 'episodeFiles'>): string[] {
  if (item.type === 'movie') return [localWatchedKey(item.id)];
  const episodeKeys = (item.episodeFiles || [])
    .filter((episode) => Boolean(episode.filePath))
    .map((episode) => localEpisodeWatchedKey(item.id, episode.season, episode.episode));
  return episodeKeys.length > 0 ? episodeKeys : [localWatchedKey(item.id)];
}

export function localProgressPathsForItem(item: Pick<MediaItem, 'filePath' | 'type' | 'episodeFiles'>): string[] {
  const paths = item.type === 'movie'
    ? [item.filePath]
    : (item.episodeFiles || []).map((episode) => episode.filePath);
  return [...new Set(paths.filter(Boolean))];
}

export function isLocalItemWatched(
  item: Pick<MediaItem, 'id' | 'type' | 'episodeFiles'>,
  watchedKeys: ReadonlySet<string>,
): boolean {
  const keys = localWatchedKeysForItem(item);
  return keys.length > 0 && keys.every((key) => watchedKeys.has(key));
}

export function parseDiscoverWatchedKey(key: string): { source: string; type: string; id: string } | null {
  const parts = key.split(':');
  if (parts.length !== 4 || parts[0] !== 'discover') return null;
  try {
    const [, source, type, id] = parts;
    if (!source || !type || !id) return null;
    return {
      source: decodeURIComponent(source),
      type: decodeURIComponent(type),
      id: decodeURIComponent(id),
    };
  } catch {
    return null;
  }
}

export function cacheWatchedDiscoverItem(item: StremioPluginCatalogItem): void {
  if (typeof window === 'undefined' || !item.id || !item.type) return;
  try {
    window.localStorage.setItem(
      `${WATCHED_DISCOVER_CACHE_PREFIX}${discoverWatchedKey(item)}`,
      JSON.stringify(item),
    );
  } catch {
    // Watched state itself is authoritative; cached metadata is only for My List.
  }
}

export function getCachedWatchedDiscoverItem(key: string): StremioPluginCatalogItem | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${WATCHED_DISCOVER_CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const item = parseStoredValue(raw, stremioCatalogItemSchema.nullable(), null);
    const parsed = parseDiscoverWatchedKey(key);
    return item && parsed && item.id === parsed.id && item.type === parsed.type ? item : null;
  } catch {
    return null;
  }
}
