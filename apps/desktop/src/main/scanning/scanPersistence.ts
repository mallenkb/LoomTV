import { isDeepStrictEqual } from 'node:util';
import type { LibraryData } from '../appContracts.ts';
import type { MediaItem } from '../metadata/types.ts';
import { withinRoot } from './inventory.ts';

export type ScanCommit = { generation: number; roots: string[]; profileId?: string | null; aliases?: Map<string, string>; backgroundMetadataRefresh?: boolean };
export const scanCommits = new WeakMap<LibraryData, ScanCommit>();
export function isCurrentScanCommit(data: LibraryData, generation: number, profileId: string | null | undefined): boolean {
  const commit = scanCommits.get(data);
  return Boolean(commit && commit.generation === generation && commit.profileId === profileId);
}
function* items(data: LibraryData): Generator<MediaItem> {
  yield* data.movies;
  yield* data.tvShows;
  yield* data.animeShows;
}
function* paths(item: MediaItem): Generator<string> {
  if (item.filePath) yield item.filePath;
  for (const file of item.episodeFiles || []) if (file.filePath) yield file.filePath;
}
export function planScanDelta(previous: LibraryData, next: LibraryData, roots: string[]) {
  if (previous.movies === next.movies && previous.tvShows === next.tvShows && previous.animeShows === next.animeShows) {
    return { changed: [] as MediaItem[], removed: [] as string[], removedFilePaths: [] as string[], published: next };
  }
  const old = new Map<string, MediaItem>();
  for (const item of items(previous)) old.set(item.id, item);
  const fresh = new Set<string>();
  const configured = (Object.values(previous.libraryFolderGroups || {}).flat() as string[]).sort((a, b) => b.length - a.length);
  const completed = new Set(roots);
  const covered = (item: MediaItem) => {
    let firstOwner: string | undefined;
    for (const file of paths(item)) {
      const owner = configured.find((root) => withinRoot(root, file)) || roots.find((root) => withinRoot(root, file));
      // A root-local result cannot prove changes to a graph shared by several roots.
      if (!owner || !completed.has(owner) || (firstOwner && owner !== firstOwner)) return false;
      firstOwner = owner;
    }
    return firstOwner !== undefined;
  };
  const changed: MediaItem[] = [];
  const changedById = new Map<string, MediaItem>();
  for (const item of items(next)) {
    fresh.add(item.id);
    if (!isDeepStrictEqual(old.get(item.id), item) && covered(item)) {
      changed.push(item);
      changedById.set(item.id, item);
    }
  }
  const removed: string[] = [];
  const removedFilePaths = new Set<string>();
  const retained: MediaItem[] = [];
  for (const item of items(previous)) {
    if (!fresh.has(item.id)) {
      if (covered(item)) {
        removed.push(item.id);
        for (const file of paths(item)) removedFilePaths.add(file);
      } else retained.push(item);
    } else {
      const replacement = changedById.get(item.id);
      if (replacement) {
        const retainedPaths = new Set(paths(replacement));
        for (const file of paths(item)) if (!retainedPaths.has(file)) removedFilePaths.add(file);
      }
    }
  }
  const published = { ...next, movies: [] as MediaItem[], tvShows: [] as MediaItem[], animeShows: [] as MediaItem[] };
  // Never publish a changed cross-root item that was not persisted.
  for (const key of ['movies', 'tvShows', 'animeShows'] as const) {
    for (const item of next[key]) {
      const approved = changedById.has(item.id) ? item : old.get(item.id);
      if (approved) published[key].push(approved);
    }
  }
  // Cross-root items that cannot be proven absent retain their child records.
  for (const item of retained) (item.type === 'movie' ? published.movies : item.type === 'anime' ? published.animeShows : published.tvShows).push(item);
  return { changed, removed, removedFilePaths: [...removedFilePaths], published };
}
