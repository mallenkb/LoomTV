export type MobileCatalogIdentity = {
  library: unknown;
  libraryEtag: string;
  catalogRevision?: number;
  catalogTransport?: 'compact' | 'legacy';
};

export function sameMobileCatalogIdentity(
  left: MobileCatalogIdentity | undefined,
  right: MobileCatalogIdentity,
): boolean {
  if (!left) return false;
  const hasRevisions = left.catalogRevision !== undefined && right.catalogRevision !== undefined;
  const sameCatalog = hasRevisions
    ? left.catalogRevision === right.catalogRevision
    : left.library === right.library;
  return sameCatalog
    && left.libraryEtag === right.libraryEtag
    && left.catalogTransport === right.catalogTransport;
}

type ProgressLibrary = {
  movies?: Array<{ filePath?: string; episodeFiles?: Array<{ filePath?: string }> }>;
  tvShows?: Array<{ filePath?: string; episodeFiles?: Array<{ filePath?: string }> }>;
  animeShows?: Array<{ filePath?: string; episodeFiles?: Array<{ filePath?: string }> }>;
  others?: Array<{ filePath?: string; episodeFiles?: Array<{ filePath?: string }> }>;
};

export function activeMobileProgressPaths(library: ProgressLibrary): Set<string> {
  const paths = new Set<string>();
  for (const item of [
    ...(library.movies || []),
    ...(library.tvShows || []),
    ...(library.animeShows || []),
    ...(library.others || []),
  ]) {
    if (item.filePath) paths.add(item.filePath);
    for (const episode of item.episodeFiles || []) if (episode.filePath) paths.add(episode.filePath);
  }
  return paths;
}

export type OfflineProgressEntry = {
  position: number;
  duration: number;
  watched: boolean;
  updatedAt: number;
};

export function mergeOfflineProgressEntry(
  local: OfflineProgressEntry | undefined,
  remote: OfflineProgressEntry | undefined,
): OfflineProgressEntry | undefined {
  if (!local) return remote;
  if (remote === undefined) return local;
  if ((remote.updatedAt || 0) > (local.updatedAt || 0) && !local.watched) return remote;
  return local;
}
