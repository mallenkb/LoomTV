import type { LibraryData } from './appContracts.ts';

export function libraryItemIdFromPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const encodedId = pathname.slice(prefix.length);
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
}

export function libraryItemPathForId(library: LibraryData, mediaId: string): string | null {
  for (const collection of [library.movies || [], library.tvShows || [], library.animeShows || []]) {
    const item = collection.find((candidate) => candidate.id === mediaId);
    if (item?.filePath) return item.filePath;
  }
  return null;
}
