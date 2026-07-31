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

function sameLocalPath(left: string, right: string): boolean {
  if (!left || !right || /^[a-z]+:\/\//i.test(left) || /^[a-z]+:\/\//i.test(right)) return false;
  return canonical(left) === canonical(right);
}

function subtitlePath(source: string): string | null {
  if (!source) return null;
  try {
    const parsed = new URL(source, 'http://127.0.0.1');
    if (parsed.pathname === '/subtitle') return parsed.searchParams.get('path');
  } catch {
    // A plain filesystem path is handled below.
  }
  return /^[a-z]+:\/\//i.test(source) ? null : source;
}

function subtitleMatchesPath(source: string, candidate: string): boolean {
  const resolved = subtitlePath(source);
  return Boolean(resolved && sameLocalPath(resolved, candidate));
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
    sameLocalPath(item.filePath, filePath)
    || item.subtitles?.some((subtitle) => subtitleMatchesPath(subtitle.url, filePath))
    || item.episodeFiles?.some((episode) =>
      sameLocalPath(episode.filePath, filePath)
      || episode.subtitles?.some((subtitle) => subtitleMatchesPath(subtitle.url, filePath)),
    ),
  ) || null;
}

function mediaScopePath(item: MediaItem, candidatePath: string): string | null {
  if (
    sameLocalPath(item.filePath, candidatePath)
    || item.subtitles?.some((subtitle) => subtitleMatchesPath(subtitle.url, candidatePath))
  ) return canonical(item.filePath);

  for (const episode of item.episodeFiles || []) {
    if (
      sameLocalPath(episode.filePath, candidatePath)
      || episode.subtitles?.some((subtitle) => subtitleMatchesPath(subtitle.url, candidatePath))
    ) return canonical(episode.filePath);
  }
  return null;
}

export function assertSubtitleCanAccessMediaPath(
  library: LibraryData,
  profileId: string,
  mediaFilePath: string,
  subtitleFilePath: string,
): void {
  const item = mediaItemForPath(library, mediaFilePath);
  const mediaScope = item ? mediaScopePath(item, mediaFilePath) : null;
  const subtitleScope = item ? mediaScopePath(item, subtitleFilePath) : null;
  if (
    !item
    || !profileCanAccessMedia(profileId, item)
    || !mediaScope
    || !subtitleScope
    || mediaScope !== subtitleScope
  ) {
    throw new ProfileError('content_restricted', 'This subtitle is unavailable for the selected media.');
  }
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
