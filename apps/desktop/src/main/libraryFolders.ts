import path from 'node:path';
import fs from 'node:fs';
import type {
  LibraryData,
  LibraryFolderGroups,
  LibraryFolderKind,
  LibraryFolderStatus,
} from './appContracts.ts';

export type { LibraryFolderStatus } from './appContracts.ts';

export function defaultLibraryFolderGroups(): LibraryFolderGroups {
  return { movies: [], tvShows: [], anime: [], others: [] };
}

export function flattenLibraryFolders(groups: LibraryFolderGroups): string[] {
  return Array.from(new Set([...groups.movies, ...groups.tvShows, ...groups.anime, ...groups.others]));
}

function normalizeFolderKindName(folderPath: string): string {
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

export function isNetworkLikePath(folderPath: string): boolean {
  const normalized = folderPath.replace(/\\/g, '/');
  return normalized.startsWith('/Volumes/')
    || normalized.startsWith('/Network/')
    || normalized.startsWith('/mnt/')
    || normalized.startsWith('/media/')
    || /^\/\/[^/]+\/[^/]+/.test(normalized);
}

export function getLibraryFolderStatus(folderPath: string, kind: LibraryFolderKind): LibraryFolderStatus {
  const checkedAt = Date.now();
  const isNetworkLike = isNetworkLikePath(folderPath);
  try {
    const stats = fs.statSync(folderPath);
    if (!stats.isDirectory()) {
      return {
        path: folderPath,
        kind,
        state: 'unavailable',
        isNetworkLike,
        checkedAt,
        message: 'This path is not a readable folder.',
      };
    }
    fs.accessSync(folderPath, fs.constants.R_OK);
    return {
      path: folderPath,
      kind,
      state: 'available',
      isNetworkLike,
      checkedAt,
      message: isNetworkLike ? 'Mounted network folder is available.' : 'Folder is available.',
    };
  } catch {
    return {
      path: folderPath,
      kind,
      state: 'unavailable',
      isNetworkLike,
      checkedAt,
      message: isNetworkLike
        ? 'Network folder is unavailable. Reconnect the share, then sync again.'
        : 'Folder is unavailable. Reconnect or choose a different folder.',
    };
  }
}

export function libraryFolderStatusesFor(groups: LibraryFolderGroups): LibraryFolderStatus[] {
  return [
    ...groups.movies.map((folder) => getLibraryFolderStatus(folder, 'movies')),
    ...groups.tvShows.map((folder) => getLibraryFolderStatus(folder, 'tvShows')),
    ...groups.anime.map((folder) => getLibraryFolderStatus(folder, 'anime')),
    ...groups.others.map((folder) => getLibraryFolderStatus(folder, 'others')),
  ];
}
