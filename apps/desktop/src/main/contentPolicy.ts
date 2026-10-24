import path from 'node:path';
import type { LibraryData } from './appContracts.ts';
import { getProfile, getProfileRestrictions, getProfileRestrictionState, createProfileCanonicalVideoAccess } from './database.ts';
import type { MediaItem } from './metadata/types.ts';
import { ProfileError } from './profileService.ts';

function canonical(candidate: string): string {
  return path.resolve(candidate);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(canonical(root), canonical(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

function profileAccess(profileId: string) {
  const profile = getProfile(profileId);
  const { restrictions, configured } = getProfileRestrictionState(profileId);
  const canonicalAllows = createProfileCanonicalVideoAccess(profileId);
  const hasAgePolicy = profile?.type === 'kid' || configured;
  const ageAllows = (ratings: MediaItem['contentRatings']): boolean => {
    if (!profile || restrictions.denyAll) return false;
    if (!hasAgePolicy) return true;
    if (profile.type === 'kid' && restrictions.maximumAge === null) return false;
    const rating = Object.entries(ratings || {}).find(([country]) => country.toUpperCase() === restrictions.country)?.[1];
    if (!rating || !Number.isFinite(rating.minimumAge) || rating.minimumAge < 0) return restrictions.allowUnrated;
    return restrictions.maximumAge === null || rating.minimumAge <= restrictions.maximumAge;
  };
  const ageRestricted = hasAgePolicy && (restrictions.maximumAge !== null || !restrictions.allowUnrated);
  return { profile, restrictions, canonicalAllows, ageAllows, ageRestricted };
}

type ProfileAccess = ReturnType<typeof profileAccess>;

function permittedMedia(item: MediaItem, access: ProfileAccess): MediaItem | null {
  if (!access.profile || !access.ageAllows(item.contentRatings) || !access.canonicalAllows(item.id)) return null;
  if (!item.episodeFiles?.length) {
    return access.canonicalAllows(item.id, item.filePath) ? item : null;
  }
  const episodeMetadata = new Map((item.episodes || []).map((episode) => [`${episode.season}:${episode.number}`, episode]));
  const episodeFiles = item.episodeFiles.filter((episode) => access.canonicalAllows(item.id, episode.filePath)
    && access.ageAllows(episodeMetadata.get(`${episode.season}:${episode.episode}`)?.contentRatings || item.contentRatings));
  if (!episodeFiles.length) return null;
  const restrictedFolders = access.restrictions.denyAll || access.restrictions.allowedFolders.length > 0;
  const partial = restrictedFolders || episodeFiles.length !== item.episodeFiles.length
    || item.episodes?.some((episode) => !access.ageAllows(episode.contentRatings || item.contentRatings));
  if (!partial) return item;
  const episodeKeys = new Set(episodeFiles.map((episode) => `${episode.season}:${episode.episode}`));
  const seasons = new Map<number, Set<number>>();
  for (const episode of episodeFiles) {
    if (!seasons.has(episode.season)) seasons.set(episode.season, new Set());
    seasons.get(episode.season)?.add(episode.episode);
  }
  const subtitleUrls = new Set(episodeFiles.flatMap((episode) => (episode.subtitles || []).map((subtitle) => subtitle.url)));
  return {
    ...item,
    filePath: access.canonicalAllows(item.id, item.filePath) ? item.filePath : path.dirname(episodeFiles[0].filePath),
    fileSize: undefined,
    localMetadata: undefined,
    episodeFiles,
    episodes: item.episodes?.filter((episode) => episodeKeys.has(`${episode.season}:${episode.number}`)),
    seasons: item.seasons?.filter((season) => seasons.has(season.number))
      .map((season) => ({ ...season, episodeCount: seasons.get(season.number)?.size || 0 })),
    seasonCount: seasons.size,
    episodeCount: episodeKeys.size,
    subtitles: item.subtitles?.filter((subtitle) => subtitleUrls.has(subtitle.url)),
  };
}

export function filterLibraryForProfile(library: LibraryData, profileId: string): LibraryData {
  const access = profileAccess(profileId);
  const filter = (items: MediaItem[]) => items.flatMap((item) => {
    const permitted = permittedMedia(item, access);
    return permitted ? [permitted] : [];
  });
  const folderRestricted = !access.profile || access.restrictions.denyAll || access.restrictions.allowedFolders.length > 0;
  const visibleFolders = (folders: string[]) => [...new Set(folders.flatMap((folder) => {
    if (!folderRestricted) return [folder];
    if (!access.profile || access.restrictions.denyAll) return [];
    return access.restrictions.allowedFolders.flatMap((allowed) => isWithin(folder, allowed) ? [allowed] : isWithin(allowed, folder) ? [folder] : []);
  }))];
  const groups = library.libraryFolderGroups;
  return {
    ...library,
    movies: filter(library.movies),
    tvShows: filter(library.tvShows),
    animeShows: filter(library.animeShows),
    libraryFolders: visibleFolders(library.libraryFolders),
    ...(groups ? { libraryFolderGroups: {
      movies: visibleFolders(groups.movies), tvShows: visibleFolders(groups.tvShows),
      anime: visibleFolders(groups.anime), others: visibleFolders(groups.others),
    } } : {}),
    libraryFolderStatuses: library.libraryFolderStatuses?.flatMap((status) =>
      visibleFolders([status.path]).map((folder) => ({ ...status, path: folder }))),
    // Scan signatures contain sibling folder names and counts from the full root.
    ...(folderRestricted || access.ageRestricted ? { scanCache: {} } : {}),
  };
}

function profileCanAccessMediaPath(item: MediaItem, candidate: string, access: ProfileAccess): boolean {
  const permitted = permittedMedia(item, access);
  const scope = permitted ? mediaScopePath(permitted, candidate) : null;
  return Boolean(scope && access.canonicalAllows(item.id, scope));
}

function mediaItemForPath(library: LibraryData, filePath: string): MediaItem | null {
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
  if (sameLocalPath(item.filePath, candidatePath)) return canonical(item.filePath);

  // TV and anime records keep an aggregate subtitle list on the series as
  // well as the episode-specific list. Resolve episodes first so an episode
  // sidecar is scoped to its video, not to the series folder.
  for (const episode of item.episodeFiles || []) {
    if (
      sameLocalPath(episode.filePath, candidatePath)
      || episode.subtitles?.some((subtitle) => subtitleMatchesPath(subtitle.url, candidatePath))
    ) return canonical(episode.filePath);
  }

  if (item.subtitles?.some((subtitle) => subtitleMatchesPath(subtitle.url, candidatePath))) {
    return canonical(item.filePath);
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
    || !profileCanAccessMediaPath(item, mediaFilePath, profileAccess(profileId))
    || !mediaScope
    || !subtitleScope
    || mediaScope !== subtitleScope
  ) {
    throw new ProfileError('content_restricted', 'This subtitle is unavailable for the selected media.');
  }
}

export function assertProfileCanAccessPath(library: LibraryData, profileId: string, filePath: string): void {
  const item = mediaItemForPath(library, filePath);
  if (!item || !profileCanAccessMediaPath(item, filePath, profileAccess(profileId))) {
    throw new ProfileError('content_restricted', 'This content is unavailable for the selected profile.');
  }
}

export function profileRestrictionIdentity(profileId: string): string {
  const profile = getProfile(profileId);
  if (!profile) return `${profileId}:missing`;
  return `${profileId}:${getProfileRestrictions(profileId).revision}`;
}
