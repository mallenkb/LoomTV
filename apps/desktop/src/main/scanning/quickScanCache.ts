import path from 'node:path';
import type { LibraryScanMode, ScanCacheEntry, ScanCacheFolderKind } from '../appContracts.ts';
import type { MediaItem } from '../metadata/types.ts';
import { cachedItemsAreComplete, createMediaItemId } from '../libraryItemHelpers.ts';
import { isMacSidecarFile, isVideoFileName } from '../fileClassification.ts';
import { withinRoot } from './inventory.ts';

/** A signature can reuse only a current, root-local catalog with fresh metadata. */
export function canCheckUnchangedRoot(options: {
  mode: LibraryScanMode; root: string; folderKind: ScanCacheFolderKind; items: MediaItem[];
  entry?: ScanCacheEntry; cacheVersion: number; providerProfile: string;
  now: number; metadataRefreshIntervalMs: number; missingMetadataRetryIntervalMs: number;
}): boolean {
  const { entry, items, root, now } = options;
  if (options.mode !== 'quick' || !entry || entry.version !== options.cacheVersion
    || entry.folderKind !== options.folderKind || entry.itemCount !== items.length
    || (entry.subtitleProfile || '') !== options.providerProfile
    || !entry.signature.startsWith(`inventory-v1:${entry.fileCount}:`)
    || now - (entry.ratingsRefreshedAt || entry.scannedAt || 0) >= options.metadataRefreshIntervalMs) return false;
  if (now - (entry.scannedAt || 0) >= options.missingMetadataRetryIntervalMs && !cachedItemsAreComplete(items)) return false;
  for (const item of items) {
    if (!item.filePath || !path.isAbsolute(item.filePath) || !withinRoot(root, item.filePath)
      || isMacSidecarFile(path.basename(item.filePath)) || item.id !== createMediaItemId(item.filePath) || !item.title) return false;
    if (item.episodeFiles) {
      if (!item.episodeFiles.length || item.episodeFiles.some((file) => !path.isAbsolute(file.filePath)
        || !withinRoot(item.filePath, file.filePath) || !isVideoFileName(path.basename(file.filePath)))) return false;
      const episodeKeys = new Set<string>();
      const seasonCounts = new Map<number, number>();
      for (const file of item.episodeFiles) {
        episodeKeys.add(`${file.season}-${file.episode}`);
        seasonCounts.set(file.season, (seasonCounts.get(file.season) || 0) + 1);
      }
      // Keep the ordinary sanitizer responsible for catalog inconsistencies.
      if (item.episodes?.some((episode) => !episodeKeys.has(`${episode.season}-${episode.number}`))
        || item.seasons?.some((season) => seasonCounts.get(season.number) !== season.episodeCount)) return false;
    } else if (!isVideoFileName(path.basename(item.filePath))) return false;
  }
  return true;
}
