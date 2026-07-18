import path from 'node:path';
import type { LibraryData } from './appContracts.ts';
import { getProfile, getProfileRestrictions } from './database.ts';
import type { MediaItem } from './metadata/types.ts';
import { ProfileError } from './profileService.ts';

function canonical(candidate: string): string {
  return path.resolve(candidate);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(canonical(root), canonical(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function profileCanAccessMedia(profileId: string, item: MediaItem): boolean {
  const profile = getProfile(profileId);
  if (!profile) return false;
  if (profile.type !== 'kid') return true;

  const restrictions = getProfileRestrictions(profileId);
  if (restrictions.maximumAge === null) return false;
  if (
    restrictions.allowedFolders.length > 0
    && !restrictions.allowedFolders.some((folder) => isWithin(folder, item.filePath))
  ) return false;

  const rating = item.contentRatings?.[restrictions.country];
  return rating
    ? rating.minimumAge <= restrictions.maximumAge
    : restrictions.allowUnrated;
}

export function filterLibraryForProfile(library: LibraryData, profileId: string): LibraryData {
  const allowed = (item: MediaItem) => profileCanAccessMedia(profileId, item);
  return {
    ...library,
    movies: library.movies.filter(allowed),
    tvShows: library.tvShows.filter(allowed),
    animeShows: library.animeShows.filter(allowed),
  };
}

export function mediaItemForPath(library: LibraryData, filePath: string): MediaItem | null {
  return [...library.movies, ...library.tvShows, ...library.animeShows].find((item) =>
    item.filePath === filePath
    || item.subtitles?.some((subtitle) => subtitle.url === filePath)
    || item.episodeFiles?.some((episode) =>
      episode.filePath === filePath || episode.subtitles?.some((subtitle) => subtitle.url === filePath),
    ),
  ) || null;
}

export function assertProfileCanAccessPath(library: LibraryData, profileId: string, filePath: string): void {
  const item = mediaItemForPath(library, filePath);
  if (!item || !profileCanAccessMedia(profileId, item)) {
    throw new ProfileError('content_restricted', 'This content is unavailable for the selected profile.');
  }
}

export function profileRestrictionIdentity(profileId: string): string {
  const profile = getProfile(profileId);
  if (!profile) return `${profileId}:missing`;
  return `${profileId}:${getProfileRestrictions(profileId).revision}`;
}
