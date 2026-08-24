import path from 'node:path';
import { mergeProviderIds } from './mediaTags';
import type { LibraryData } from './appContracts.ts';
import { createMediaItemId } from './libraryItemHelpers.ts';
import { seasonNumberFromDirectoryName } from './libraryScanFiles.ts';
import { cleanMediaTitle, isGenericGroupingFolderTitle } from './metadata/helpers.ts';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './metadata/types';
import { normalizeAnimeCast } from '../shared/animeCast';

function episodeKey(episode: Pick<EpisodeMeta, 'season' | 'number'>): string {
  return `${episode.season}-${episode.number}`;
}

function episodeFileKey(episodeFile: Pick<EpisodeFile, 'season' | 'episode'>): string {
  return `${episodeFile.season}-${episodeFile.episode}`;
}

function hasStructuredAnimeCast(cast: MediaItem['cast'] | undefined): boolean {
  return Boolean(cast?.some((credit) => (
    credit.characterName || credit.characterImage || credit.voiceActorName
  )));
}

function hasValues(value: Record<string, unknown> | undefined): boolean {
  return Object.keys(value || {}).length > 0;
}

function uniqueValues(existing: string[] | undefined, fresh: string[] | undefined): string[] | undefined {
  const values = [...new Set([...(existing || []), ...(fresh || [])].filter(Boolean))];
  return values.length > 0 ? values : undefined;
}

function isGenericEpisodeTitle(title: string | undefined, episodeNumber: number): boolean {
  const normalized = title?.trim().toLowerCase() || '';
  return !normalized
    || normalized === `episode ${episodeNumber}`
    || normalized === `ep ${episodeNumber}`
    || normalized === `episode ${String(episodeNumber).padStart(2, '0')}`
    || normalized === `ep ${String(episodeNumber).padStart(2, '0')}`;
}

function isGenericSeasonTitle(title: string | undefined, seasonNumber: number): boolean {
  const normalized = title?.trim() || '';
  return !normalized || new RegExp(`^(?:season|series|s)\\s*0*${seasonNumber}$`, 'i').test(normalized);
}

function isCanonicalSeasonTitle(title: string | undefined, seasonNumber: number): boolean {
  const normalized = title?.trim() || '';
  return new RegExp(`^season\\s+0*${seasonNumber}\\s*:\\s*\\S`, 'i').test(normalized);
}

function seasonTitleForScan(
  existingTitle: string | undefined,
  freshTitle: string | undefined,
  seasonNumber: number,
): string {
  const existing = existingTitle?.trim() || '';
  const fresh = freshTitle?.trim() || '';

  if (!existing) return fresh || `Season ${String(seasonNumber).padStart(2, '0')}`;
  if (!fresh || isGenericSeasonTitle(fresh, seasonNumber)) return existing;
  if (isCanonicalSeasonTitle(fresh, seasonNumber) || isGenericSeasonTitle(existing, seasonNumber)) return fresh;
  return existing;
}

function animeCastKey(credit: MediaItem['cast'][number]): string {
  return (credit.characterName || credit.name || credit.character || '').trim().toLowerCase();
}

function mergeAnimeCast(existing: MediaItem['cast'], fresh: MediaItem['cast']): MediaItem['cast'] {
  if (!existing.length) return fresh;
  if (!fresh.length) return existing;

  const freshByCharacter = new Map(fresh.map((credit) => [animeCastKey(credit), credit]));
  const existingKeys = new Set(existing.map(animeCastKey));
  const mergeCredit = (current: MediaItem['cast'][number], incoming?: MediaItem['cast'][number]) => {
    if (!incoming) return current;
    const currentRole = current.characterRole?.trim().toLowerCase();
    const incomingRole = incoming.characterRole?.trim().toLowerCase();
    const role = currentRole === 'main' || currentRole === 'supporting' || currentRole === 'background'
      ? current.characterRole
      : incomingRole === 'main' || incomingRole === 'supporting' || incomingRole === 'background'
        ? incoming.characterRole
        : current.characterRole || incoming.characterRole || current.character || incoming.character;
    return {
      ...incoming,
      ...current,
      name: current.name || incoming.name,
      character: role || '',
      image: current.image || incoming.image,
      characterName: current.characterName || incoming.characterName,
      characterRole: role,
      characterImage: current.characterImage || incoming.characterImage,
      voiceActorName: current.voiceActorName || incoming.voiceActorName,
      voiceActorImage: current.voiceActorImage || incoming.voiceActorImage,
      voiceActorLanguage: current.voiceActorLanguage || incoming.voiceActorLanguage,
    };
  };

  return [
    ...existing.map((credit) => mergeCredit(credit, freshByCharacter.get(animeCastKey(credit)))),
    ...fresh.filter((credit) => !existingKeys.has(animeCastKey(credit))),
  ];
}

function genericCastKey(credit: MediaItem['cast'][number]): string {
  return `${credit.name || ''}\u0000${credit.character || ''}`.trim().toLowerCase();
}

function mergeGenericCast(existing: MediaItem['cast'], fresh: MediaItem['cast']): MediaItem['cast'] {
  if (!existing.length) return fresh;
  const existingKeys = new Set(existing.map(genericCastKey));
  return [...existing, ...fresh.filter((credit) => !existingKeys.has(genericCastKey(credit)))];
}

const TMDB_ARTWORK_RENDITION = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(?:w\d+|original)(\/.*)$/i;

function tmdbArtworkIdentity(value?: string): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const source = parsed.pathname === '/api/cached-artwork'
      ? parsed.searchParams.get('source') || value
      : value;
    return source.match(TMDB_ARTWORK_RENDITION)?.[2] || '';
  } catch {
    return '';
  }
}

function preserveArtworkSelection(existing?: string, fresh?: string): string {
  if (!existing) return fresh || '';
  if (!fresh) return existing;
  const existingTmdb = tmdbArtworkIdentity(existing);
  const freshTmdb = tmdbArtworkIdentity(fresh);
  // Upgrade the rendition only when both URLs refer to the exact same TMDB
  // image. Different paths may represent a user's explicit artwork choice.
  return existingTmdb && freshTmdb && existingTmdb === freshTmdb
    ? fresh
    : existing;
}

export function preserveExistingItemDuringScan(
  fresh: MediaItem,
  existing?: MediaItem,
  options: { refreshRatings?: boolean } = {},
): MediaItem {
  if (!existing) return fresh;

  const episodeFiles = new Map<string, EpisodeFile>();
  for (const episodeFile of fresh.episodeFiles || []) {
    const key = episodeFileKey(episodeFile);
    // Full scans own filesystem-derived episode data. User-facing episode
    // metadata is preserved separately below, so stale probes/subtitle lists
    // must not overwrite a freshly scanned file record.
    episodeFiles.set(key, episodeFile);
  }

  const localEpisodeKeys = new Set(episodeFiles.keys());
  const existingEpisodes = new Map((existing.episodes || []).map((episode) => [episodeKey(episode), episode]));
  const episodes = new Map<string, EpisodeMeta>();
  for (const episode of fresh.episodes || []) {
    const key = episodeKey(episode);
    if (localEpisodeKeys.size > 0 && !localEpisodeKeys.has(key)) continue;
    const current = existingEpisodes.get(key);
    const keepCurrentTitle = current && !isGenericEpisodeTitle(current.title, episode.number);
    episodes.set(key, {
      ...episode,
      title: keepCurrentTitle ? current.title : episode.title || current?.title || '',
      summary: current?.summary || episode.summary || '',
      still: current?.still || episode.still || '',
      rating: options.refreshRatings && episode.rating > 0
        ? episode.rating
        : current?.rating || episode.rating || 0,
      airDate: current?.airDate || episode.airDate || '',
      localMetadata: episode.localMetadata || current?.localMetadata,
    });
  }
  for (const episode of existing.episodes || []) {
    const key = episodeKey(episode);
    if (!episodes.has(key) && (localEpisodeKeys.size === 0 || localEpisodeKeys.has(key))) {
      episodes.set(key, episode);
    }
  }

  const seasonCounts = new Map<number, number>();
  for (const episodeFile of episodeFiles.values()) {
    seasonCounts.set(episodeFile.season, (seasonCounts.get(episodeFile.season) || 0) + 1);
  }
  const existingSeasonsByNumber = new Map((existing.seasons || []).map((season) => [season.number, season]));
  const freshSeasonsByNumber = new Map((fresh.seasons || []).map((season) => [season.number, season]));
  const seasons = new Map<number, NonNullable<MediaItem['seasons']>[number]>();
  for (const season of existing.seasons || []) {
    if (seasonCounts.has(season.number)) seasons.set(season.number, season);
  }
  for (const season of fresh.seasons || []) {
    if (!seasons.has(season.number)) seasons.set(season.number, season);
  }
  for (const [number, count] of seasonCounts) {
    const existingSeason = existingSeasonsByNumber.get(number);
    const freshSeason = freshSeasonsByNumber.get(number);
    const season = seasons.get(number);
    seasons.set(number, {
      number,
      title: seasonTitleForScan(existingSeason?.title || season?.title, freshSeason?.title, number),
      episodeCount: count,
    });
  }

  // A scan owns filesystem-derived fields, but an existing library record owns
  // its chosen metadata and artwork. In particular, keep the complete artwork
  // candidate lists so cache pruning cannot discard a user's selected image.
  const freshCast = fresh.type === 'anime' ? normalizeAnimeCast(fresh.cast) : fresh.cast;
  const existingCast = fresh.type === 'anime' ? normalizeAnimeCast(existing.cast) : existing.cast;
  const cast = fresh.type === 'anime'
    ? mergeAnimeCast(existingCast || [], hasStructuredAnimeCast(freshCast) ? freshCast || [] : [])
    : mergeGenericCast(existingCast || [], freshCast || []);
  const refreshRating = options.refreshRatings && fresh.rating > 0;

  return {
    ...fresh,
    format: existing.format || fresh.format,
    title: existing.title || fresh.title,
    year: existing.year || fresh.year,
    poster: preserveArtworkSelection(existing.poster, fresh.poster),
    backdrop: preserveArtworkSelection(existing.backdrop, fresh.backdrop),
    logo: preserveArtworkSelection(existing.logo, fresh.logo),
    posterCandidates: uniqueValues(existing.posterCandidates, fresh.posterCandidates),
    backdropCandidates: uniqueValues(existing.backdropCandidates, fresh.backdropCandidates),
    logoCandidates: uniqueValues(existing.logoCandidates, fresh.logoCandidates),
    summary: existing.summary || fresh.summary,
    rating: refreshRating ? fresh.rating : existing.rating || fresh.rating,
    providerRatings: options.refreshRatings && Object.keys(fresh.providerRatings || {}).length > 0
      ? fresh.providerRatings
      : hasValues(existing.providerRatings)
        ? existing.providerRatings
        : fresh.providerRatings,
    genres: existing.genres?.length ? existing.genres : fresh.genres,
    cast,
    contentRatings: hasValues(existing.contentRatings)
      ? { ...(fresh.contentRatings || {}), ...existing.contentRatings }
      : fresh.contentRatings,
    streamingProviders: existing.streamingProviders?.length
      ? existing.streamingProviders
      : fresh.streamingProviders,
    originPlatform: existing.originPlatform || fresh.originPlatform,
    providerIds: mergeProviderIds(existing.providerIds || {}, fresh.providerIds || {}),
    seasons: seasons.size > 0
      ? [...seasons.values()].sort((left, right) => left.number - right.number)
      : fresh.seasons,
    episodes: episodes.size > 0
      ? [...episodes.values()].sort((left, right) => left.season - right.season || left.number - right.number)
      : fresh.episodes,
    episodeFiles: episodeFiles.size > 0
      ? [...episodeFiles.values()].sort((left, right) => left.season - right.season || left.episode - right.episode)
      : fresh.episodeFiles,
  };
}

type LibraryCollection = 'movies' | 'tvShows' | 'animeShows';
type LibraryItemEntry = { collection: LibraryCollection; item: MediaItem };
type SeasonFolderCandidate = LibraryItemEntry & { parentPath: string; seasonNumber: number };

export interface SeasonFolderRepairResult {
  data: LibraryData;
  mediaIdAliases: Map<string, string>;
  changed: boolean;
}

function resolvedPath(value: string): string {
  return path.resolve(value);
}

function pathIsInsideFolder(folderPath: string, candidatePath?: string): boolean {
  if (!candidatePath) return false;
  const relative = path.relative(resolvedPath(folderPath), resolvedPath(candidatePath));
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function itemBelongsToFolder(item: MediaItem, folderPath: string): boolean {
  return pathIsInsideFolder(folderPath, item.filePath)
    || Boolean(item.episodeFiles?.some((episodeFile) => pathIsInsideFolder(folderPath, episodeFile.filePath)));
}

function configuredLibraryFolders(data: LibraryData): Set<string> {
  const folders = new Set<string>();
  for (const folder of data.libraryFolders || []) folders.add(resolvedPath(folder));
  for (const group of Object.values(data.libraryFolderGroups || {})) {
    for (const folder of group) folders.add(resolvedPath(folder));
  }
  return folders;
}

function isSafeSeasonParent(data: LibraryData, parentPath: string): boolean {
  const parentName = path.basename(parentPath);
  return Boolean(parentName)
    && !configuredLibraryFolders(data).has(parentPath)
    && !isGenericGroupingFolderTitle(parentName)
    && seasonNumberFromDirectoryName(parentName) === null;
}

function seasonFolderCandidate(entry: LibraryItemEntry): SeasonFolderCandidate | null {
  if (entry.item.type === 'movie' || !entry.item.filePath || !entry.item.episodeFiles?.length) return null;

  const seasonNumber = seasonNumberFromDirectoryName(path.basename(entry.item.filePath));
  if (seasonNumber === null) return null;

  const parentPath = path.dirname(resolvedPath(entry.item.filePath));
  if (seasonNumberFromDirectoryName(path.basename(parentPath)) !== null) return null;

  return { ...entry, parentPath, seasonNumber };
}

function seasonFolderTitle(item: MediaItem, seasonNumber: number): string {
  const folderTitle = path.basename(item.filePath).trim();
  return folderTitle || item.seasons?.find((season) => season.number === seasonNumber)?.title
    || `Season ${String(seasonNumber).padStart(2, '0')}`;
}

function rebaseSeasonFolderItem(candidate: SeasonFolderCandidate): MediaItem {
  const { item, seasonNumber } = candidate;
  const title = seasonFolderTitle(item, seasonNumber);
  const episodeFiles = (item.episodeFiles || []).map((episodeFile) => ({
    ...episodeFile,
    season: seasonNumber,
  }));
  const episodes = (item.episodes || []).map((episode) => ({
    ...episode,
    season: seasonNumber,
  }));
  const episodeCount = episodeFiles.filter((episodeFile) => episodeFile.season === seasonNumber).length;

  return {
    ...item,
    episodes: episodes.length > 0 ? episodes : undefined,
    seasons: [{
      number: seasonNumber,
      title,
      episodeCount,
    }],
    episodeFiles,
  };
}

function mergeSubtitleRecords(
  existing: MediaItem['subtitles'] | undefined,
  incoming: MediaItem['subtitles'] | undefined,
): MediaItem['subtitles'] | undefined {
  const records = new Map<string, NonNullable<MediaItem['subtitles']>[number]>();
  for (const record of [...(existing || []), ...(incoming || [])]) {
    const key = record.url || `${record.lang}\u0000${record.label}`;
    if (!records.has(key)) records.set(key, record);
  }
  return records.size > 0 ? [...records.values()] : undefined;
}

function mergeEpisodeFiles(existing: EpisodeFile[], incoming: EpisodeFile[]): EpisodeFile[] {
  const files = new Map<string, EpisodeFile>();
  for (const episodeFile of existing) files.set(resolvedPath(episodeFile.filePath), episodeFile);
  for (const episodeFile of incoming) {
    const key = resolvedPath(episodeFile.filePath);
    const current = files.get(key);
    files.set(key, current
      ? {
        ...episodeFile,
        ...current,
        title: current.title || episodeFile.title,
        thumbnail: current.thumbnail || episodeFile.thumbnail,
        still: current.still || episodeFile.still,
        subtitles: current.subtitles?.length ? current.subtitles : episodeFile.subtitles,
        localMetadata: current.localMetadata || episodeFile.localMetadata,
      }
      : episodeFile);
  }
  return [...files.values()].sort((left, right) => left.season - right.season || left.episode - right.episode);
}

function mergeEpisodes(existing: EpisodeMeta[], incoming: EpisodeMeta[]): EpisodeMeta[] {
  const episodes = new Map<string, EpisodeMeta>();
  for (const episode of existing) episodes.set(episodeKey(episode), episode);
  for (const episode of incoming) {
    const key = episodeKey(episode);
    const current = episodes.get(key);
    episodes.set(key, current
      ? {
        ...episode,
        ...current,
        title: current.title || episode.title,
        summary: current.summary || episode.summary,
        still: current.still || episode.still,
        rating: current.rating || episode.rating,
        airDate: current.airDate || episode.airDate,
        localMetadata: current.localMetadata || episode.localMetadata,
      }
      : episode);
  }
  return [...episodes.values()].sort((left, right) => left.season - right.season || left.number - right.number);
}

function mergeSeasons(
  existing: NonNullable<MediaItem['seasons']>,
  incoming: NonNullable<MediaItem['seasons']>,
  episodeFiles: EpisodeFile[],
): NonNullable<MediaItem['seasons']> {
  const seasons = new Map<number, NonNullable<MediaItem['seasons']>[number]>();
  for (const season of existing) seasons.set(season.number, season);
  for (const season of incoming) {
    const current = seasons.get(season.number);
    seasons.set(season.number, current
      ? {
        ...season,
        ...current,
        title: current.title || season.title,
      }
      : season);
  }

  const episodeCounts = new Map<number, number>();
  for (const episodeFile of episodeFiles) {
    episodeCounts.set(episodeFile.season, (episodeCounts.get(episodeFile.season) || 0) + 1);
  }
  return [...seasons.values()]
    .map((season) => ({
      ...season,
      episodeCount: episodeCounts.get(season.number) || season.episodeCount,
    }))
    .sort((left, right) => left.number - right.number);
}

function mergeSeasonFolderItem(
  existing: MediaItem,
  incoming: MediaItem,
  parentPath: string,
): MediaItem {
  const episodeFiles = mergeEpisodeFiles(existing.episodeFiles || [], incoming.episodeFiles || []);
  const episodes = mergeEpisodes(existing.episodes || [], incoming.episodes || []);
  const seasons = mergeSeasons(existing.seasons || [], incoming.seasons || [], episodeFiles);
  const cast = existing.type === 'anime'
    ? mergeAnimeCast(existing.cast || [], incoming.cast || [])
    : mergeGenericCast(existing.cast || [], incoming.cast || []);

  return {
    ...existing,
    id: existing.id,
    filePath: parentPath,
    format: existing.format || incoming.format,
    title: existing.title || incoming.title,
    year: existing.year || incoming.year,
    poster: existing.poster || incoming.poster,
    backdrop: existing.backdrop || incoming.backdrop,
    logo: existing.logo || incoming.logo,
    posterCandidates: uniqueValues(existing.posterCandidates, incoming.posterCandidates),
    backdropCandidates: uniqueValues(existing.backdropCandidates, incoming.backdropCandidates),
    logoCandidates: uniqueValues(existing.logoCandidates, incoming.logoCandidates),
    summary: existing.summary || incoming.summary,
    rating: existing.rating || incoming.rating,
    providerRatings: hasValues(existing.providerRatings)
      ? existing.providerRatings
      : incoming.providerRatings,
    contentRatings: hasValues(existing.contentRatings)
      ? { ...(incoming.contentRatings || {}), ...existing.contentRatings }
      : incoming.contentRatings,
    streamingProviders: existing.streamingProviders?.length
      ? existing.streamingProviders
      : incoming.streamingProviders,
    originPlatform: existing.originPlatform || incoming.originPlatform,
    genres: existing.genres?.length ? existing.genres : incoming.genres,
    cast,
    subtitles: mergeSubtitleRecords(existing.subtitles, incoming.subtitles),
    localMetadata: existing.localMetadata || incoming.localMetadata,
    fileSize: existing.fileSize || incoming.fileSize,
    lastPlayed: existing.lastPlayed || incoming.lastPlayed,
    runtime: existing.runtime || incoming.runtime,
    providerIds: mergeProviderIds(existing.providerIds || {}, incoming.providerIds || {}),
    seasons: seasons.length > 0 ? seasons : undefined,
    episodes: episodes.length > 0 ? episodes : undefined,
    episodeFiles,
  };
}

function parentTitleForPath(parentPath: string): string {
  return cleanMediaTitle(path.basename(parentPath)).title || path.basename(parentPath);
}

function updateScanCacheItemCounts(data: LibraryData, items: MediaItem[]): { scanCache: LibraryData['scanCache']; changed: boolean } {
  if (!data.scanCache) return { scanCache: data.scanCache, changed: false };

  let changed = false;
  const scanCache = Object.fromEntries(Object.entries(data.scanCache).map(([folder, entry]) => {
    const itemCount = items.filter((item) => itemBelongsToFolder(item, folder)).length;
    if (itemCount === entry.itemCount) return [folder, entry];
    changed = true;
    return [folder, { ...entry, itemCount }];
  }));
  return { scanCache, changed };
}

/**
 * Older scans could persist each decorated season directory as its own show.
 * Reconcile those records whenever the library is loaded or scanned so the
 * filesystem structure remains the source of truth without leaving stale
 * season cards behind in the database.
 */
export function repairSeasonFolderItems(data: LibraryData): SeasonFolderRepairResult {
  const entries: LibraryItemEntry[] = [
    ...(data.movies || []).map((item) => ({ collection: 'movies' as const, item })),
    ...(data.tvShows || []).map((item) => ({ collection: 'tvShows' as const, item })),
    ...(data.animeShows || []).map((item) => ({ collection: 'animeShows' as const, item })),
  ];
  const itemByPathAndType = new Map<string, LibraryItemEntry>();
  const seasonGroups = new Map<string, SeasonFolderCandidate[]>();

  for (const entry of entries) {
    if (entry.item.filePath) {
      itemByPathAndType.set(`${resolvedPath(entry.item.filePath)}\u0000${entry.item.type}`, entry);
    }
    const candidate = seasonFolderCandidate(entry);
    if (!candidate || !isSafeSeasonParent(data, candidate.parentPath)) continue;
    const key = `${candidate.parentPath}\u0000${candidate.item.type}`;
    const group = seasonGroups.get(key);
    if (group) group.push(candidate);
    else seasonGroups.set(key, [candidate]);
  }

  const removedIds = new Set<string>();
  const replacements = new Map<string, LibraryItemEntry>();
  const syntheticEntries: LibraryItemEntry[] = [];
  const mediaIdAliases = new Map<string, string>();

  for (const [key, candidates] of seasonGroups) {
    const parentPath = key.slice(0, key.lastIndexOf('\u0000'));
    const parentEntry = itemByPathAndType.get(key);
    if (!parentEntry && candidates.length < 2) continue;

    const sortedCandidates = [...candidates].sort((left, right) => (
      left.seasonNumber - right.seasonNumber || left.item.id.localeCompare(right.item.id)
    ));
    const targetId = parentEntry?.item.id || createMediaItemId(parentPath);
    const targetCollection = parentEntry?.collection || sortedCandidates[0].collection;
    const parentTitle = parentTitleForPath(parentPath);
    let merged = parentEntry?.item || {
      ...rebaseSeasonFolderItem(sortedCandidates[0]),
      id: targetId,
      title: parentTitle,
      filePath: parentPath,
    };

    for (const candidate of sortedCandidates) {
      const incoming = rebaseSeasonFolderItem(candidate);
      merged = mergeSeasonFolderItem(merged, incoming, parentPath);
      if (candidate.item.id !== targetId) {
        removedIds.add(candidate.item.id);
        mediaIdAliases.set(candidate.item.id, targetId);
      }
    }

    const replacement: LibraryItemEntry = { collection: targetCollection, item: merged };
    if (parentEntry) replacements.set(targetId, replacement);
    else syntheticEntries.push(replacement);
  }

  const repairedCollections: Record<LibraryCollection, MediaItem[]> = {
    movies: [],
    tvShows: [],
    animeShows: [],
  };
  for (const entry of entries) {
    if (removedIds.has(entry.item.id)) continue;
    const replacement = replacements.get(entry.item.id);
    repairedCollections[entry.collection].push(replacement?.item || entry.item);
  }
  for (const entry of syntheticEntries) repairedCollections[entry.collection].push(entry.item);

  const allItems = [
    ...repairedCollections.movies,
    ...repairedCollections.tvShows,
    ...repairedCollections.animeShows,
  ];
  const scanCacheResult = updateScanCacheItemCounts(data, allItems);
  const changed = removedIds.size > 0 || syntheticEntries.length > 0 || scanCacheResult.changed;
  if (!changed) return { data, mediaIdAliases, changed: false };

  return {
    data: {
      ...data,
      movies: repairedCollections.movies,
      tvShows: repairedCollections.tvShows,
      animeShows: repairedCollections.animeShows,
      scanCache: scanCacheResult.scanCache,
    },
    mediaIdAliases,
    changed: true,
  };
}
