import path from 'node:path';
import type { LibraryData, LibraryFolderGroups } from '../main';

export function defaultLibraryFolderGroups(): LibraryFolderGroups {
  return { movies: [], tvShows: [], anime: [], others: [] };
}

export function flattenLibraryFolders(groups: LibraryFolderGroups): string[] {
  return Array.from(new Set([...groups.movies, ...groups.tvShows, ...groups.anime, ...groups.others]));
}

export function normalizeFolderKindName(folderPath: string): string {
  return path.basename(folderPath).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function detectLibraryFolderKind(folderPath: string): 'movies' | 'tv' | 'anime' | undefined {
  const name = normalizeFolderKindName(folderPath);
  if (/^(movies?|films?|cinema)$/.test(name)) return 'movies';
  if (/^(tv|tv shows?|television|shows?|series)$/.test(name)) return 'tv';
  if (/^(anime|animes|donghua)$/.test(name)) return 'anime';
  return undefined;
}

export function normalizeLibraryFolderGroups(data?: Partial<LibraryData>): LibraryFolderGroups {
  const normalized = defaultLibraryFolderGroups();
  const groups = data?.libraryFolderGroups;
  if (groups) {
    normalized.movies = [...(groups.movies || [])];
    normalized.tvShows = [...(groups.tvShows || [])];
    normalized.anime = [...(groups.anime || [])];
    normalized.others = [...(groups.others || [])];
  }

  for (const folder of data?.libraryFolders || []) {
    if (flattenLibraryFolders(normalized).includes(folder)) continue;
    const detected = detectLibraryFolderKind(folder);
    if (detected === 'movies') normalized.movies.push(folder);
    else if (detected === 'tv') normalized.tvShows.push(folder);
    else if (detected === 'anime') normalized.anime.push(folder);
    else normalized.others.push(folder);
  }

  return {
    movies: Array.from(new Set(normalized.movies)),
    tvShows: Array.from(new Set(normalized.tvShows)),
    anime: Array.from(new Set(normalized.anime)),
    others: Array.from(new Set(normalized.others)),
  };
}
