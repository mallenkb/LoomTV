import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, LibraryData } from './appContracts.ts';
import {
  bestSeriesTitleFromEpisodeFiles,
  chooseMetadataSearchTitle,
  cleanMediaTitle,
  episodeTitleFromFileName,
  findEpisodeMetadataMatch,
  normalizeTitleForMatch,
  numericRating,
  parseYearFromText,
  remoteMatchesAnyLocalTitle,
  uniqueLocalTitles,
} from './metadata/helpers.ts';
import type { ContentRating, EpisodeMeta, MediaItem, StreamingProvider } from './metadata/types.ts';
import { omdbContentRatings, omdbProviderRatings, type OMDbResponse } from './metadata/omdb.ts';
import { mergeContentRatings } from './metadata/contentRatings.ts';
import { mergeProviderIds, parseMetadataProviderIds } from './mediaTags.ts';
import type { MetadataProviderIds } from './mediaTags.ts';
import type { ProbeMediaFileResult } from './mediaProbeFile.ts';
import {
  mergeLocalSeasonsWithMetadata,
  mergeOfficialSeasonMetadata,
} from './scanClassification.ts';
import { normalizeAnimeCast } from '../shared/animeCast.ts';

export type OfficialArtworkRefreshResult = {
  title?: string;
  year?: number;
  format?: string;
  thumbnail?: string;
  cover?: string;
  summary?: string;
  rating?: number;
  providerRatings?: MediaItem['providerRatings'];
  genres?: string[];
  seasons?: { number: number; title: string; episodeCount: number }[];
  episodes?: EpisodeMeta[];
  episodeSource?: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan' | 'AniList';
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logo?: string;
  logoCandidates?: string[];
  contentRatings?: Record<string, ContentRating>;
  cast?: MediaItem['cast'];
  streamingProviders?: MediaItem['streamingProviders'];
  originPlatform?: MediaItem['originPlatform'];
  providerIds?: MetadataProviderIds;
};

export type OfficialArtworkRefreshTarget = 'all' | 'poster' | 'cover';
export type OfficialMetadataApplyTarget = OfficialArtworkRefreshTarget | 'episodes';

export type OfficialMetadataCandidate = OfficialArtworkRefreshResult & {
  id: string;
  source: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan' | 'AniList';
  title: string;
  year?: number;
  genres?: string[];
  episodeCount?: number;
  episodePreview?: string[];
};

export type OfficialMetadataServiceDependencies = {
  loadLibrary: () => LibraryData;
  saveLibrary: (library: LibraryData) => void;
  cacheArtworkNow: (library: LibraryData) => Promise<void>;
  loadSettings: () => AppSettings;
  getMetadataApiKey: typeof import('./settings.ts').getMetadataApiKey;
  localTitleFromPath: (filePath?: string) => string | null;
  probeMediaFile: (filePath: string) => ProbeMediaFileResult;
  fetchAniListAnimeMetadata: typeof import('./metadata/anilist.ts').fetchAniListAnimeMetadata;
  fetchFanartMovieLogos: typeof import('./metadata/fanart.ts').fetchFanartMovieLogos;
  fetchFanartTVLogos: typeof import('./metadata/fanart.ts').fetchFanartTVLogos;
  fetchJikanMetadata: typeof import('./metadata/jikan.ts').fetchJikanMetadata;
  fetchJikanMetadataCandidates: typeof import('./metadata/jikan.ts').fetchJikanMetadataCandidates;
  fetchOMDbMetadata: typeof import('./metadata/omdb.ts').fetchOMDbMetadata;
  fetchOMDbMetadataById: typeof import('./metadata/omdb.ts').fetchOMDbMetadataById;
  fetchTMDBMovieMetadata: typeof import('./metadata/tmdb.ts').fetchTMDBMovieMetadata;
  fetchTMDBMovieMetadataById: typeof import('./metadata/tmdb.ts').fetchTMDBMovieMetadataById;
  fetchTMDBMovieMetadataCandidates: typeof import('./metadata/tmdb.ts').fetchTMDBMovieMetadataCandidates;
  fetchTMDBStreamingProvidersById: typeof import('./metadata/tmdb.ts').fetchTMDBStreamingProvidersById;
  fetchTMDBTVMetadata: typeof import('./metadata/tmdb.ts').fetchTMDBTVMetadata;
  fetchTMDBTVMetadataById: typeof import('./metadata/tmdb.ts').fetchTMDBTVMetadataById;
  fetchTMDBTVMetadataCandidates: typeof import('./metadata/tmdb.ts').fetchTMDBTVMetadataCandidates;
  fetchTVMetadata: typeof import('./metadata/tvmaze.ts').fetchTVMetadata;
  fetchTVMetadataCandidates: typeof import('./metadata/tvmaze.ts').fetchTVMetadataCandidates;
  artworkDeliveryUrl: (source?: string | null) => string;
  artworkDeliveryUrls: (sources?: string[]) => string[];
  orderedArtworkCandidates: (...urls: Array<string | null | undefined>) => string[];
};

function hasContentRatings(contentRatings?: Record<string, ContentRating>): contentRatings is Record<string, ContentRating> {
  return Object.keys(contentRatings || {}).length > 0;
}

function hasProviderRatings(
  providerRatings?: MediaItem['providerRatings'],
): providerRatings is NonNullable<MediaItem['providerRatings']> {
  return Object.keys(providerRatings || {}).length > 0;
}

function hasText(value?: string | null): boolean {
  return Boolean(value?.trim());
}

function applyOfficialSeasons(
  target: MediaItem,
  officialSeasons?: OfficialArtworkRefreshResult['seasons'],
): void {
  if (target.type === 'movie') return;
  if (!officialSeasons?.length) return;

  const localSeasons = target.seasons?.length
    ? target.seasons
    : officialSeasons.map((season) => ({
      number: season.number,
      title: '',
      episodeCount: season.episodeCount,
    }));
  if (localSeasons.length === 0) return;

  target.seasons = mergeLocalSeasonsWithMetadata(localSeasons, officialSeasons);
}

function isGenericEpisodeTitle(value: string | undefined, episodeNumber: number): boolean {
  const normalized = value?.trim().toLowerCase() || '';
  if (!normalized) return true;
  return normalized === `episode ${episodeNumber}`
    || normalized === `ep ${episodeNumber}`
    || normalized === `episode ${String(episodeNumber).padStart(2, '0')}`
    || normalized === `ep ${String(episodeNumber).padStart(2, '0')}`;
}

function isMeaningfulAnimeRole(value?: string | null): boolean {
  const role = value?.trim().toLowerCase();
  return role === 'main' || role === 'supporting' || role === 'background';
}

function animeCreditKey(credit: MediaItem['cast'][number]): string {
  return (credit.characterName || credit.character || credit.name || '').trim().toLowerCase();
}

function mergeAnimeCastMissingFields(
  existing: MediaItem['cast'],
  incoming: MediaItem['cast'],
): MediaItem['cast'] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;

  const existingByCharacter = new Map(existing.map((credit) => [animeCreditKey(credit), credit]));
  const mergeCredit = (current: MediaItem['cast'][number] | undefined, next: MediaItem['cast'][number]) => {
    const characterRole = (isMeaningfulAnimeRole(next.characterRole)
      ? next.characterRole
      : isMeaningfulAnimeRole(current?.characterRole)
        ? current?.characterRole
        : next.characterRole || current?.characterRole || next.character || current?.character || '') || '';
    return {
      ...(current || next),
      name: next.name || current?.name || '',
      character: characterRole,
      image: next.image || current?.image || '',
      characterName: next.characterName || current?.characterName || next.name || current?.name || '',
      characterRole,
      characterImage: next.characterImage || current?.characterImage || '',
      voiceActorName: next.voiceActorName || current?.voiceActorName || '',
      voiceActorImage: next.voiceActorImage || current?.voiceActorImage || '',
      voiceActorLanguage: next.voiceActorLanguage || current?.voiceActorLanguage || '',
    };
  };

  const merged = incoming.map((credit) => mergeCredit(existingByCharacter.get(animeCreditKey(credit)), credit));
  const incomingKeys = new Set(incoming.map(animeCreditKey));
  return [
    ...merged,
    ...existing.filter((credit) => !incomingKeys.has(animeCreditKey(credit))),
  ];
}

function itemNeedsIncompleteMetadata(item: MediaItem): boolean {
  if (!hasText(item.title) || !hasText(item.summary) || !item.genres?.length || item.rating <= 0) return true;
  if (!hasProviderRatings(item.providerRatings)) return true;
  if (!hasContentRatings(item.contentRatings) && !hasText((item as MediaItem & { contentRating?: string }).contentRating)) return true;
  if (item.providerIds?.tmdbId && !item.streamingProviders?.length && !item.originPlatform) return true;
  if (item.type !== 'movie' && !item.originPlatform && !item.streamingProviders?.length) return true;

  if (item.type === 'anime') {
    const cast = normalizeAnimeCast(item.cast);
    if (cast.length === 0 || cast.some((credit) => (
      !hasText(credit.characterImage)
      || !isMeaningfulAnimeRole(credit.characterRole)
      || !hasText(credit.voiceActorName)
    ))) return true;
  } else if (!item.cast?.length) {
    return true;
  }

  const episodeFiles = item.episodeFiles || [];
  if (item.type !== 'movie' && episodeFiles.length > 0) {
    const episodesByKey = new Map((item.episodes || []).map((episode) => [`${episode.season}-${episode.number}`, episode]));
    if (episodeFiles.some((file) => {
      const episode = episodesByKey.get(`${file.season}-${file.episode}`);
      return !episode
        || isGenericEpisodeTitle(episode.title, file.episode)
        || !hasText(episode.summary)
        || !hasText(episode.airDate)
        || !hasText(episode.still)
        || episode.rating <= 0;
    })) return true;
  }

  return false;
}

const STREAMING_PROVIDER_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const streamingProviderRefreshState = new Map<string, {
  nextAttemptAt: number;
  pending?: Promise<StreamingProvider[]>;
}>();
const INCOMPLETE_METADATA_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const DISPLAY_METADATA_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const incompleteMetadataRefreshState = new Map<string, {
  nextAttemptAt: number;
  pending?: Promise<boolean>;
}>();
const displayMetadataRefreshState = new Map<string, {
  nextAttemptAt: number;
  pending?: Promise<boolean>;
}>();

export function createOfficialMetadataService(deps: OfficialMetadataServiceDependencies) {
  const {
    artworkDeliveryUrl,
    artworkDeliveryUrls,
    cacheArtworkNow,
    fetchFanartMovieLogos,
    fetchFanartTVLogos,
    fetchAniListAnimeMetadata,
    fetchJikanMetadata,
    fetchJikanMetadataCandidates,
    fetchOMDbMetadata,
    fetchOMDbMetadataById,
    fetchTMDBMovieMetadata,
    fetchTMDBMovieMetadataById,
    fetchTMDBMovieMetadataCandidates,
    fetchTMDBStreamingProvidersById,
    fetchTMDBTVMetadata,
    fetchTMDBTVMetadataById,
    fetchTMDBTVMetadataCandidates,
    fetchTVMetadata,
    fetchTVMetadataCandidates,
    getMetadataApiKey,
    loadLibrary,
    loadSettings,
    localTitleFromPath,
    orderedArtworkCandidates,
    probeMediaFile,
    saveLibrary,
  } = deps;

  function movieMetadataRating(
    tmdbMeta?: Partial<MediaItem> | null,
    omdbMeta?: OMDbResponse | null,
    tvMeta?: { rating?: number } | null,
  ): number {
    return numericRating(omdbMeta?.imdbRating)
      || numericRating(tmdbMeta?.rating)
      || numericRating(tvMeta?.rating);
  }

  function showMetadataRating(
    type: 'tv' | 'anime',
    jikanMeta?: { rating?: number } | null,
    tmdbMeta?: Partial<MediaItem> | null,
    tvMeta?: { rating?: number } | null,
    omdbMeta?: OMDbResponse | null,
  ): number {
    return numericRating(omdbMeta?.imdbRating)
      || (type === 'anime' ? numericRating(jikanMeta?.rating) : 0)
      || numericRating(tmdbMeta?.rating)
      || numericRating(tvMeta?.rating);
  }

  function officialArtworkOnly(urls: Array<string | null | undefined>): string[] {
    return orderedArtworkCandidates(...urls).filter((url) => {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        return host.includes('image.tmdb.org')
          || host.includes('assets.fanart.tv')
          || host.includes('fanart.tv')
          || host.includes('media-amazon.com')
          || host.includes('m.media-amazon.com')
          || host.includes('cdn.myanimelist.net')
          || host.includes('myanimelist.net')
          || host.includes('static.tvmaze.com');
      } catch {
        return false;
      }
    });
  }

  function metadataCandidateId(candidate: Omit<OfficialMetadataCandidate, 'id'>): string {
    return createHash('sha1')
      .update(JSON.stringify({
        source: candidate.source,
        title: candidate.title,
        year: candidate.year || 0,
        thumbnail: candidate.thumbnail || '',
        cover: candidate.cover || '',
      }))
      .digest('hex')
      .slice(0, 12);
  }

  function metadataCandidate(
    source: OfficialMetadataCandidate['source'],
    metadata: Partial<MediaItem> | null | undefined,
    fallbackTitle: string,
  ): OfficialMetadataCandidate | null {
    if (!metadata) return null;
    const posterCandidates = officialArtworkOnly([metadata.poster, ...(metadata.posterCandidates || [])]);
    const backdropCandidates = officialArtworkOnly([metadata.backdrop, ...(metadata.backdropCandidates || [])]);
    const logoCandidates = officialArtworkOnly([metadata.logo, ...(metadata.logoCandidates || [])]);
    const title = String(metadata.title || fallbackTitle || '').trim();
    const episodes = (metadata.episodes || []).filter((episode) => episode.title);
    const candidateWithoutId: Omit<OfficialMetadataCandidate, 'id'> = {
      source,
      format: metadata.format,
      title,
      year: metadata.year || undefined,
      thumbnail: posterCandidates[0] || '',
      cover: backdropCandidates[0] || posterCandidates[0] || '',
      summary: metadata.summary || '',
      rating: numericRating(metadata.rating),
      providerRatings: metadata.providerRatings,
      genres: Array.isArray(metadata.genres) ? metadata.genres.filter(Boolean) : [],
      seasons: metadata.seasons,
      episodes,
      episodeCount: episodes.length || undefined,
      episodePreview: episodes.slice(0, 4).map((episode) => {
        const code = `S${String(episode.season || 1).padStart(2, '0')}E${String(episode.number).padStart(2, '0')}`;
        return `${code} ${episode.title}`;
      }),
      posterCandidates,
      backdropCandidates,
      logo: logoCandidates[0] || '',
      logoCandidates,
      contentRatings: metadata.contentRatings,
      cast: metadata.cast,
      streamingProviders: metadata.streamingProviders,
      originPlatform: metadata.originPlatform,
    };
    if (!candidateWithoutId.title && !candidateWithoutId.thumbnail && !candidateWithoutId.cover) return null;
    return { ...candidateWithoutId, id: metadataCandidateId(candidateWithoutId) };
  }

  function omdbMetadataCandidate(metadata: OMDbResponse | null | undefined, fallbackTitle: string): OfficialMetadataCandidate | null {
    if (!metadata) return null;
    const poster = metadata.Poster && metadata.Poster !== 'N/A' ? metadata.Poster : '';
    return metadataCandidate('OMDb', {
      title: metadata.Title || fallbackTitle,
      year: metadata.Year ? parseInt(String(metadata.Year), 10) : 0,
      poster,
      backdrop: poster,
      summary: metadata.Plot && metadata.Plot !== 'N/A' ? metadata.Plot : '',
      rating: numericRating(metadata.imdbRating),
      providerRatings: omdbProviderRatings(metadata),
      contentRatings: omdbContentRatings(metadata),
      genres: metadata.Genre && metadata.Genre !== 'N/A' ? String(metadata.Genre).split(',').map((genre) => genre.trim()) : [],
    }, fallbackTitle);
  }

  function uniqueMetadataCandidates(candidates: Array<OfficialMetadataCandidate | null>): OfficialMetadataCandidate[] {
    const seen = new Set<string>();
    return candidates.filter((candidate): candidate is OfficialMetadataCandidate => {
      if (!candidate) return false;
      const key = `${candidate.source}:${candidate.title.toLowerCase()}:${candidate.year || ''}:${candidate.thumbnail || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function metadataResultMatchesLocalTitle(
    metadata: (Partial<MediaItem> & { aliases?: string[] }) | null | undefined,
    localTitles: string[],
  ): boolean {
    if (!metadata) return false;
    const remoteTitles = [
      metadata.title,
      ...(Array.isArray(metadata.aliases) ? metadata.aliases : []),
    ].filter((title): title is string => typeof title === 'string' && title.trim().length > 0);
    return remoteTitles.some((remoteTitle) => remoteMatchesAnyLocalTitle(localTitles, remoteTitle));
  }

  function matchingMetadataResults<T extends Partial<MediaItem> & { aliases?: string[] }>(
    candidates: T[],
    localTitles: string[],
  ): T[] {
    return candidates.filter((candidate) => metadataResultMatchesLocalTitle(candidate, localTitles));
  }

  function metadataCandidateScore(candidate: OfficialMetadataCandidate, preferredTitle: string, localTitles: string[]): number {
    const normalizedCandidate = normalizeTitleForMatch(candidate.title);
    const normalizedPreferred = normalizeTitleForMatch(preferredTitle);
    const normalizedLocals = localTitles.map(normalizeTitleForMatch).filter(Boolean);
    let score = 0;

    if (normalizedCandidate === normalizedPreferred) score += 100;
    if (normalizedLocals.some((title) => normalizedCandidate === title)) score += 80;
    if (normalizedPreferred && normalizedCandidate.includes(normalizedPreferred)) score += 45;
    if (normalizedPreferred && normalizedPreferred.includes(normalizedCandidate)) score += 35;

    const preferredTokens = new Set(normalizedPreferred.split(' ').filter((token) => token.length > 2));
    const candidateTokens = new Set(normalizedCandidate.split(' ').filter((token) => token.length > 2));
    let sharedTokens = 0;
    preferredTokens.forEach((token) => {
      if (candidateTokens.has(token)) sharedTokens++;
    });
    if (preferredTokens.size > 0) score += (sharedTokens / preferredTokens.size) * 30;

    if (candidate.thumbnail) score += 8;
    if (candidate.cover && candidate.cover !== candidate.thumbnail) score += 6;
    if (candidate.summary) score += 4;
    if (candidate.rating) score += 2;

    const sequelArcWords = /\b(mugen|entertainment|district|swordsmith|hashira|training|infinity|castle|arc)\b/i;
    if (sequelArcWords.test(candidate.title)) {
      score -= 140;
    } else {
      score += 60;
    }
    return score;
  }

  function sortMetadataCandidates(
    candidates: OfficialMetadataCandidate[],
    preferredTitle: string,
    localTitles: string[],
  ): OfficialMetadataCandidate[] {
    const sequelArcWords = /\b(mugen|entertainment|district|swordsmith|hashira|training|infinity|castle|arc)\b/i;
    return [...candidates].sort((a, b) => {
      const aIsArc = sequelArcWords.test(a.title);
      const bIsArc = sequelArcWords.test(b.title);
      if (aIsArc !== bIsArc) return aIsArc ? 1 : -1;
      return metadataCandidateScore(b, preferredTitle, localTitles) - metadataCandidateScore(a, preferredTitle, localTitles);
    });
  }

  function mergeEpisodeMetadataForTarget(
    target: MediaItem,
    remoteEpisodes: EpisodeMeta[] | undefined,
    source: OfficialMetadataCandidate['source'] | 'refresh',
    preserveExisting = false,
  ): void {
    if (target.type === 'movie' || !remoteEpisodes?.length) return;

    const useEpKeyOnly = source === 'Jikan';
    const existingByKey = new Map<string, EpisodeMeta>(
      (target.episodes || []).map((episode) => [`${episode.season}-${episode.number}`, episode]),
    );

    if (!target.episodeFiles?.length) {
      target.episodes = remoteEpisodes;
      return;
    }

    target.episodes = target.episodeFiles.map((file) => {
      const key = `${file.season}-${file.episode}`;
      const localEpisode: EpisodeMeta = {
        season: file.season,
        number: file.episode,
        title: episodeTitleFromFileName(file.filePath) || file.title || '',
        summary: '',
        still: '',
        rating: 0,
        airDate: '',
      };
      const remote = useEpKeyOnly
        ? (file.season === 0 ? undefined : remoteEpisodes.find((episode) => episode.number === file.episode))
        : findEpisodeMetadataMatch(localEpisode, remoteEpisodes);
      const existing = existingByKey.get(key);
      const existingTitleIsPlaceholder = isGenericEpisodeTitle(existing?.title, file.episode);
      return {
        season: file.season,
        number: file.episode,
        title: preserveExisting && !existingTitleIsPlaceholder
          ? existing?.title || file.title || ''
          : remote?.title || existing?.title || file.title || '',
        summary: preserveExisting
          ? existing?.summary || remote?.summary || ''
          : remote?.summary || existing?.summary || '',
        still: preserveExisting
          ? existing?.still || remote?.still || ''
          : remote?.still || existing?.still || '',
        rating: preserveExisting
          ? existing?.rating || remote?.rating || 0
          : remote?.rating || existing?.rating || 0,
        airDate: preserveExisting
          ? existing?.airDate || remote?.airDate || ''
          : remote?.airDate || existing?.airDate || '',
        localMetadata: file.localMetadata || existing?.localMetadata,
      };
    });
  }

  function itemArtworkLookupData(item: MediaItem): {
    title: string;
    year?: number;
    localTitles: string[];
    providerIds: MetadataProviderIds;
  } {
    const representativePath = item.episodeFiles?.[0]?.filePath || item.filePath;
    const probe = representativePath && fs.existsSync(representativePath) ? probeMediaFile(representativePath) : {};
    const parsedPathTitle = representativePath ? cleanMediaTitle(path.basename(representativePath)).title : '';
    const folderTitle = item.filePath ? cleanMediaTitle(path.basename(item.filePath)).title : '';
    const embeddedTitle = item.type === 'movie' ? probe.embeddedTitle : probe.embeddedShowTitle;
    const episodeSeriesTitle = item.type === 'movie' ? null : bestSeriesTitleFromEpisodeFiles(item.episodeFiles || []);
    const pathTitle = localTitleFromPath(representativePath || item.filePath) || '';
    const searchTitle = chooseMetadataSearchTitle({
      itemTitle: item.title,
      embeddedTitle,
      folderTitle,
      parsedPathTitle: pathTitle || parsedPathTitle,
      episodeSeriesTitle,
      fallbackTitle: item.title,
    });
    const localTitles = uniqueLocalTitles([
      searchTitle,
      item.title,
      folderTitle,
      parsedPathTitle,
      pathTitle,
      episodeSeriesTitle,
      embeddedTitle,
    ]);
    const providerIds = mergeProviderIds(
      item.providerIds || {},
      probe.providerIds || {},
      parseMetadataProviderIds(`${item.filePath || ''} ${representativePath || ''} ${item.title || ''}`),
    );

    return {
      title: searchTitle,
      year: item.year || probe.year || parseYearFromText(representativePath || item.filePath),
      localTitles,
      providerIds,
    };
  }

  function findLibraryMediaItem(library: LibraryData, mediaId: string): MediaItem | null {
    return [...library.movies, ...library.tvShows, ...library.animeShows].find((item) => item.id === mediaId) || null;
  }

  async function fetchOfficialMetadataCandidatesForItem(item: MediaItem): Promise<OfficialMetadataCandidate[]> {
    const settings = loadSettings();
    const tmdbApiKey = getMetadataApiKey(settings, 'tmdb');
    const omdbApiKey = getMetadataApiKey(settings, 'omdb');
    const { title, year, localTitles, providerIds } = itemArtworkLookupData(item);

    if (item.type === 'movie') {
      const [tmdbById, tmdbBySearch, tmdbCandidates, omdbById, omdbBySearch, tvMeta, tvCandidates] = await Promise.all([
        providerIds.tmdbId ? fetchTMDBMovieMetadataById(providerIds.tmdbId, tmdbApiKey) : Promise.resolve(null),
        fetchTMDBMovieMetadata(title, year, tmdbApiKey),
        fetchTMDBMovieMetadataCandidates(title, year, tmdbApiKey),
        providerIds.imdbId ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey) : Promise.resolve(null),
        fetchOMDbMetadata(title, year, omdbApiKey),
        fetchTVMetadata(title, year),
        fetchTVMetadataCandidates(title, year),
      ]);
      return sortMetadataCandidates(uniqueMetadataCandidates([
        metadataCandidate('TMDB', tmdbById, title),
        metadataCandidate('TMDB', tmdbBySearch, title),
        ...matchingMetadataResults(tmdbCandidates, localTitles).map((candidate) => metadataCandidate('TMDB', candidate, title)),
        omdbMetadataCandidate(omdbById, title),
        omdbMetadataCandidate(omdbBySearch, title),
        metadataCandidate('TVmaze', remoteMatchesAnyLocalTitle(localTitles, tvMeta?.title) ? tvMeta : null, title),
        ...matchingMetadataResults(tvCandidates, localTitles).map((candidate) => metadataCandidate('TVmaze', candidate, title)),
      ]), title, localTitles);
    }

    const likelyAnime = item.type === 'anime';
    const [omdbById, omdbBySearch, anilistMeta, jikanCandidates, tmdbById, tmdbBySearch, tmdbCandidates, tvMeta, tvCandidates] = await Promise.all([
      providerIds.imdbId ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey) : Promise.resolve(null),
      fetchOMDbMetadata(title, year, omdbApiKey),
      likelyAnime ? fetchAniListAnimeMetadata(Number(providerIds.malId) || undefined, title) : Promise.resolve(null),
      likelyAnime ? fetchJikanMetadataCandidates(title, localTitles) : Promise.resolve([]),
      providerIds.tmdbId ? fetchTMDBTVMetadataById(providerIds.tmdbId, tmdbApiKey) : Promise.resolve(null),
      fetchTMDBTVMetadata(title, year, tmdbApiKey),
      fetchTMDBTVMetadataCandidates(title, year, tmdbApiKey),
      fetchTVMetadata(title, year),
      fetchTVMetadataCandidates(title, year),
    ]);
    return sortMetadataCandidates(uniqueMetadataCandidates([
      metadataCandidate('AniList', metadataResultMatchesLocalTitle(anilistMeta, localTitles) ? anilistMeta : null, title),
      ...matchingMetadataResults(jikanCandidates, localTitles).map((candidate) => metadataCandidate('Jikan', candidate, title)),
      metadataCandidate('TMDB', tmdbById, title),
      metadataCandidate('TMDB', remoteMatchesAnyLocalTitle(localTitles, tmdbBySearch?.title) ? tmdbBySearch : null, title),
      ...matchingMetadataResults(tmdbCandidates, localTitles).map((candidate) => metadataCandidate('TMDB', candidate, title)),
      omdbMetadataCandidate(omdbById, title),
      omdbMetadataCandidate(remoteMatchesAnyLocalTitle(localTitles, omdbBySearch?.Title) ? omdbBySearch : null, title),
      metadataCandidate('TVmaze', remoteMatchesAnyLocalTitle(localTitles, tvMeta?.title) ? tvMeta : null, title),
      ...matchingMetadataResults(tvCandidates, localTitles).map((candidate) => metadataCandidate('TVmaze', candidate, title)),
    ]), title, localTitles);
  }

  async function fetchOfficialArtworkForItem(item: MediaItem): Promise<OfficialArtworkRefreshResult> {
    const settings = loadSettings();
    const tmdbApiKey = getMetadataApiKey(settings, 'tmdb');
    const omdbApiKey = getMetadataApiKey(settings, 'omdb');
    const fanartApiKey = getMetadataApiKey(settings, 'fanart');
    const { title, year, localTitles, providerIds } = itemArtworkLookupData(item);

    if (item.type === 'movie') {
      const [tmdbById, tmdbBySearch, omdbById, omdbBySearch, tvMeta] = await Promise.all([
        providerIds.tmdbId ? fetchTMDBMovieMetadataById(providerIds.tmdbId, tmdbApiKey) : Promise.resolve(null),
        fetchTMDBMovieMetadata(title, year, tmdbApiKey),
        providerIds.imdbId ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey) : Promise.resolve(null),
        fetchOMDbMetadata(title, year, omdbApiKey),
        fetchTVMetadata(title, year),
      ]);
      const tmdbMeta = tmdbById || tmdbBySearch || null;
      const omdbMeta = omdbById || omdbBySearch || null;
      const matchedTV = remoteMatchesAnyLocalTitle(localTitles, tvMeta?.title) ? tvMeta : null;
      const omdbPoster = omdbMeta?.Poster && omdbMeta.Poster !== 'N/A' ? omdbMeta.Poster : '';
      const posterCandidates = officialArtworkOnly([tmdbMeta?.poster, omdbPoster]);
      const backdropCandidates = officialArtworkOnly([tmdbMeta?.backdrop]);
      const fanartLogoCandidates = await fetchFanartMovieLogos(
        tmdbMeta?.providerIds?.tmdbId || providerIds.tmdbId,
        fanartApiKey,
      );
      const logoCandidates = orderedArtworkCandidates(
        ...officialArtworkOnly([tmdbMeta?.logo, ...(tmdbMeta?.logoCandidates || [])]),
        ...fanartLogoCandidates,
      );
      return {
        title: tmdbMeta?.title || title,
        year: tmdbMeta?.year || year,
        providerIds: mergeProviderIds(item.providerIds || {}, tmdbMeta?.providerIds || {}),
        format: 'Movie',
        thumbnail: posterCandidates[0] || '',
        cover: backdropCandidates[0] || posterCandidates[0] || '',
        summary: tmdbMeta?.summary || omdbMeta?.Plot || '',
        rating: movieMetadataRating(tmdbMeta, omdbMeta, matchedTV),
        providerRatings: omdbProviderRatings(omdbMeta),
        genres: tmdbMeta?.genres || [],
        contentRatings: mergeContentRatings(tmdbMeta?.contentRatings, omdbContentRatings(omdbMeta)),
        streamingProviders: tmdbMeta?.streamingProviders,
        posterCandidates,
        backdropCandidates,
        logo: logoCandidates[0] || '',
        logoCandidates,
        cast: tmdbMeta?.cast || matchedTV?.cast || [],
      };
    }

    const likelyAnime = item.type === 'anime';
    const [omdbById, omdbBySearch, anilistMeta, jikanMeta, tmdbById, tmdbBySearch, tvMeta] = await Promise.all([
      providerIds.imdbId ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey) : Promise.resolve(null),
      fetchOMDbMetadata(title, year, omdbApiKey),
      likelyAnime ? fetchAniListAnimeMetadata(Number(providerIds.malId) || undefined, title) : Promise.resolve(null),
      likelyAnime ? fetchJikanMetadata(title) : Promise.resolve(null),
      providerIds.tmdbId ? fetchTMDBTVMetadataById(providerIds.tmdbId, tmdbApiKey) : Promise.resolve(null),
      fetchTMDBTVMetadata(title, year, tmdbApiKey),
      fetchTVMetadata(title, year),
    ]);
    const omdbMeta = omdbById || (remoteMatchesAnyLocalTitle(localTitles, omdbBySearch?.Title) ? omdbBySearch : null);
    const matchedAniList = metadataResultMatchesLocalTitle(anilistMeta, localTitles) ? anilistMeta : null;
    const matchedJikan = metadataResultMatchesLocalTitle(jikanMeta, localTitles) ? jikanMeta : null;
    const tmdbMeta = tmdbById || (remoteMatchesAnyLocalTitle(localTitles, tmdbBySearch?.title) ? tmdbBySearch : null);
    const matchedTV = remoteMatchesAnyLocalTitle(localTitles, tvMeta?.title) ? tvMeta : null;
    const omdbPoster = omdbMeta?.Poster && omdbMeta.Poster !== 'N/A' ? omdbMeta.Poster : '';
    const posterCandidates = officialArtworkOnly([
      likelyAnime ? matchedAniList?.poster : '',
      tmdbMeta?.poster,
      omdbPoster,
      matchedTV?.poster,
      likelyAnime ? matchedJikan?.poster : '',
    ]);
    const backdropCandidates = officialArtworkOnly([
      likelyAnime ? matchedAniList?.backdrop : '',
      tmdbMeta?.backdrop,
      likelyAnime ? matchedJikan?.backdrop : '',
      matchedTV?.backdrop,
    ]);
    const fanartLogoCandidates = await fetchFanartTVLogos(
      tmdbMeta?.providerIds?.tvdbId || matchedTV?.providerIds?.tvdbId || providerIds.tvdbId,
      fanartApiKey,
    );
    const logoCandidates = orderedArtworkCandidates(
      ...officialArtworkOnly([tmdbMeta?.logo, ...(tmdbMeta?.logoCandidates || [])]),
      ...fanartLogoCandidates,
    );
    const hasLocalSpecials = item.episodeFiles?.some((file) => file.season === 0) === true;
    const hasTMDBSpecials = tmdbMeta?.episodes?.some((episode) => episode.season === 0) === true;
    const episodes = hasLocalSpecials && hasTMDBSpecials
      ? tmdbMeta?.episodes
      : matchedTV?.episodes || (likelyAnime ? matchedJikan?.episodes : undefined) || tmdbMeta?.episodes;
    const episodeSource = hasLocalSpecials && hasTMDBSpecials
      ? 'TMDB'
      : matchedTV?.episodes?.length
      ? 'TVmaze'
      : likelyAnime && matchedJikan?.episodes?.length
        ? 'Jikan'
        : tmdbMeta?.episodes?.length
          ? 'TMDB'
          : undefined;

    return {
      title: likelyAnime ? matchedAniList?.title || title : tmdbMeta?.title || matchedTV?.title || title,
      year: likelyAnime ? matchedAniList?.year || year : tmdbMeta?.year || matchedTV?.year || year,
      providerIds: mergeProviderIds(
        item.providerIds || {},
        tmdbMeta?.providerIds || {},
        matchedAniList?.providerIds || {},
        matchedJikan?.providerIds || {},
        matchedTV?.providerIds || {},
      ),
      format: likelyAnime ? (matchedAniList?.format || matchedJikan?.format || 'TV') : 'TV',
      thumbnail: posterCandidates[0] || '',
      cover: backdropCandidates[0] || posterCandidates[0] || '',
      summary: (likelyAnime ? matchedAniList?.summary : '') || tmdbMeta?.summary || omdbMeta?.Plot || matchedTV?.summary || matchedJikan?.summary || '',
      rating: numericRating(omdbMeta?.imdbRating)
        || (likelyAnime ? numericRating(matchedAniList?.rating) : 0)
        || showMetadataRating(likelyAnime ? 'anime' : 'tv', matchedJikan, tmdbMeta, matchedTV, omdbMeta),
      providerRatings: omdbProviderRatings(omdbMeta),
      genres: (likelyAnime ? matchedAniList?.genres || matchedJikan?.genres : undefined) || tmdbMeta?.genres || matchedTV?.genres || [],
      seasons: mergeOfficialSeasonMetadata(
        tmdbMeta?.tmdbSeasons,
        matchedTV?.seasons,
      ),
      contentRatings: mergeContentRatings(
        tmdbMeta?.contentRatings,
        likelyAnime ? matchedJikan?.contentRatings : undefined,
        omdbContentRatings(omdbMeta),
      ),
      episodes,
      episodeSource,
      posterCandidates,
      backdropCandidates,
      logo: logoCandidates[0] || '',
      logoCandidates,
      cast: likelyAnime
        ? normalizeAnimeCast(matchedAniList?.cast?.length ? matchedAniList.cast : matchedJikan?.cast?.length ? matchedJikan.cast : item.cast)
        : tmdbMeta?.cast || matchedTV?.cast || [],
      streamingProviders: tmdbMeta?.streamingProviders,
      originPlatform: matchedTV?.originPlatform,
    };
  }

  async function applyOfficialMetadataCandidate(
    mediaId: string,
    candidate: OfficialMetadataCandidate,
    requestedTarget: OfficialMetadataApplyTarget = 'all',
  ): Promise<OfficialArtworkRefreshResult> {
    const library = loadLibrary();
    const target = findLibraryMediaItem(library, mediaId);

    if (!target) {
      throw new Error('Media item was not found in the library.');
    }

    const applyTarget = requestedTarget === 'poster'
      || requestedTarget === 'cover'
      || requestedTarget === 'episodes'
      ? requestedTarget
      : 'all';
    const applyAll = applyTarget === 'all';
    const applyPoster = applyAll || applyTarget === 'poster';
    const applyCover = applyAll || applyTarget === 'cover';
    const applyEpisodes = applyAll || applyTarget === 'episodes';
    const selectedPoster = candidate.thumbnail || candidate.posterCandidates?.find(Boolean) || '';
    const selectedCover = candidate.cover || candidate.backdropCandidates?.find(Boolean) || '';

    if (applyAll && candidate.title) target.title = candidate.title;
    if (applyAll && candidate.year) target.year = candidate.year;
    if (applyAll && candidate.format) target.format = candidate.format;
    if (applyPoster && selectedPoster) target.poster = selectedPoster;
    if (applyCover && selectedCover) target.backdrop = selectedCover;
    if (applyAll && candidate.logo) target.logo = candidate.logo;
    if (applyAll && candidate.summary) target.summary = candidate.summary;
    if (applyAll && candidate.rating) target.rating = candidate.rating;
    if (applyAll && hasProviderRatings(candidate.providerRatings)) target.providerRatings = candidate.providerRatings;
    if (applyAll && candidate.genres?.length) target.genres = candidate.genres;
    if (applyAll && hasContentRatings(candidate.contentRatings)) target.contentRatings = candidate.contentRatings;
    if (applyAll && candidate.streamingProviders?.length) target.streamingProviders = candidate.streamingProviders;
    if (applyAll && candidate.originPlatform) target.originPlatform = candidate.originPlatform;
    if (applyAll && target.type === 'anime') {
      const normalizedCast = normalizeAnimeCast(candidate.cast?.length ? candidate.cast : target.cast);
      if (normalizedCast.length > 0) target.cast = normalizedCast;
    } else if (applyAll && candidate.cast?.length) {
      target.cast = candidate.cast;
    }
    if (applyAll) applyOfficialSeasons(target, candidate.seasons);
    if (applyEpisodes) mergeEpisodeMetadataForTarget(target, candidate.episodes, candidate.source);
    if (applyPoster) {
      target.posterCandidates = orderedArtworkCandidates(
        ...(candidate.posterCandidates || []),
        candidate.thumbnail,
        ...officialArtworkOnly(target.posterCandidates || []),
        target.poster,
      );
    }
    if (applyCover) {
      target.backdropCandidates = orderedArtworkCandidates(
        ...(candidate.backdropCandidates || []),
        candidate.cover,
        ...officialArtworkOnly(target.backdropCandidates || []),
        target.backdrop,
      );
    }
    if (applyAll) {
      target.logoCandidates = orderedArtworkCandidates(
        ...(candidate.logoCandidates || []),
        candidate.logo,
        ...officialArtworkOnly(target.logoCandidates || []),
        target.logo,
      );
    }
    saveLibrary(library);
    if (applyPoster || applyCover || applyAll) await cacheArtworkNow(library);

    return {
      thumbnail: target.poster || '',
      cover: target.backdrop || target.poster || '',
      format: target.format,
      summary: target.summary || '',
      rating: target.rating || 0,
      providerRatings: target.providerRatings,
      contentRatings: target.contentRatings,
      seasons: target.type === 'movie' ? undefined : target.seasons,
      episodes: target.type === 'movie' ? undefined : target.episodes,
      episodeSource: candidate.source,
      posterCandidates: target.posterCandidates || [],
      backdropCandidates: target.backdropCandidates || [],
      logo: target.logo || '',
      logoCandidates: target.logoCandidates || [],
      cast: target.cast,
      streamingProviders: target.streamingProviders,
      originPlatform: target.originPlatform,
    };
  }

  async function getOfficialMetadataCandidates(mediaId: string): Promise<OfficialMetadataCandidate[]> {
    const library = loadLibrary();
    const target = findLibraryMediaItem(library, mediaId);
    if (!target) {
      throw new Error('Media item was not found in the library.');
    }
    return fetchOfficialMetadataCandidatesForItem(target);
  }

  async function refreshOfficialArtwork(
    mediaId: string,
    requestedTarget: OfficialArtworkRefreshTarget = 'all',
  ): Promise<OfficialArtworkRefreshResult> {
    const library = loadLibrary();
    const target = findLibraryMediaItem(library, mediaId);

    if (!target) {
      throw new Error('Media item was not found in the library.');
    }

    const refreshed = await fetchOfficialArtworkForItem(target);
    const refreshTarget = requestedTarget === 'poster' || requestedTarget === 'cover' ? requestedTarget : 'all';
    const refreshPoster = refreshTarget === 'all' || refreshTarget === 'poster';
    const refreshCover = refreshTarget === 'all' || refreshTarget === 'cover';
    const refreshMetadata = refreshTarget === 'all';
    const refreshedPoster = refreshed.thumbnail || refreshed.posterCandidates?.find(Boolean);
    const refreshedCover = refreshed.cover || refreshed.backdropCandidates?.find(Boolean);
    const refreshedCast = target.type === 'anime'
      ? normalizeAnimeCast(refreshed.cast?.length ? refreshed.cast : target.cast)
      : refreshed.cast;
    const refreshedHasContentRatings = hasContentRatings(refreshed.contentRatings);
    const refreshedHasProviderRatings = hasProviderRatings(refreshed.providerRatings);
    const hasRefresh = Boolean(
      (refreshPoster && refreshedPoster)
      || (refreshCover && refreshedCover)
      || (refreshMetadata && (
        refreshed.format
        || refreshed.logo
        || refreshed.summary
        || refreshed.rating
        || refreshedHasProviderRatings
        || refreshedHasContentRatings
        || refreshed.seasons?.length
        || refreshed.episodes?.length
        || refreshed.streamingProviders?.length
        || refreshed.originPlatform
      ))
      || (refreshMetadata && refreshedCast?.length),
    );

    if (hasRefresh) {
      if (refreshPoster && refreshedPoster) target.poster = refreshedPoster;
      if (refreshCover && refreshedCover) target.backdrop = refreshedCover;
      if (refreshMetadata && refreshed.format) target.format = refreshed.format;
      if (refreshMetadata && refreshed.logo) target.logo = refreshed.logo;
      if (refreshMetadata && refreshed.summary) target.summary = refreshed.summary;
      if (refreshMetadata && refreshed.rating) target.rating = refreshed.rating;
      if (refreshMetadata && refreshedHasProviderRatings) target.providerRatings = refreshed.providerRatings;
      if (refreshMetadata && refreshedHasContentRatings) target.contentRatings = refreshed.contentRatings;
      if (refreshMetadata && refreshed.streamingProviders?.length) target.streamingProviders = refreshed.streamingProviders;
      if (refreshMetadata && refreshed.originPlatform) target.originPlatform = refreshed.originPlatform;
      if (refreshMetadata && refreshedCast?.length) target.cast = refreshedCast;
      if (refreshMetadata) applyOfficialSeasons(target, refreshed.seasons);
      if (refreshMetadata) mergeEpisodeMetadataForTarget(target, refreshed.episodes, refreshed.episodeSource || 'refresh');
      if (refreshPoster) target.posterCandidates = orderedArtworkCandidates(
        ...(refreshed.posterCandidates || []),
        ...officialArtworkOnly(target.posterCandidates || []),
        target.poster,
      );
      if (refreshCover) target.backdropCandidates = orderedArtworkCandidates(
        ...(refreshed.backdropCandidates || []),
        ...officialArtworkOnly(target.backdropCandidates || []),
        target.backdrop,
      );
      if (refreshMetadata) target.logoCandidates = orderedArtworkCandidates(
        ...(refreshed.logoCandidates || []),
        ...officialArtworkOnly(target.logoCandidates || []),
        target.logo,
      );
      saveLibrary(library);
      await cacheArtworkNow(library);
    }

    if (refreshTarget === 'poster') {
      return {
        thumbnail: refreshedPoster,
        posterCandidates: target.posterCandidates || refreshed.posterCandidates,
      };
    }
    if (refreshTarget === 'cover') {
      return {
        cover: refreshedCover,
        backdropCandidates: target.backdropCandidates || refreshed.backdropCandidates,
      };
    }

    return {
      ...refreshed,
      providerRatings: target.providerRatings || refreshed.providerRatings,
      seasons: target.type === 'movie' ? undefined : target.seasons,
      episodes: target.type === 'movie' ? undefined : target.episodes,
      episodeSource: refreshed.episodeSource,
      posterCandidates: target.posterCandidates || refreshed.posterCandidates,
      backdropCandidates: target.backdropCandidates || refreshed.backdropCandidates,
      logo: target.logo || refreshed.logo || '',
      logoCandidates: target.logoCandidates || refreshed.logoCandidates,
      cast: target.type === 'anime'
        ? (target.cast?.length ? normalizeAnimeCast(target.cast) : refreshedCast)
        : target.cast || refreshed.cast,
    };
  }

  async function refreshIncompleteMetadata(mediaId: string): Promise<boolean> {
    const initialLibrary = loadLibrary();
    const initialTarget = findLibraryMediaItem(initialLibrary, mediaId);
    if (!initialTarget || !itemNeedsIncompleteMetadata(initialTarget)) return false;

    const now = Date.now();
    const previousAttempt = incompleteMetadataRefreshState.get(mediaId);
    if (previousAttempt?.pending) return previousAttempt.pending;
    if (previousAttempt && previousAttempt.nextAttemptAt > now) return false;

    const request = (async () => {
      const library = loadLibrary();
      const target = findLibraryMediaItem(library, mediaId);
      if (!target || !itemNeedsIncompleteMetadata(target)) return false;

      const before = JSON.stringify(target);
      const refreshed = await fetchOfficialArtworkForItem(target);

      if (!hasText(target.title) && hasText(refreshed.title)) target.title = refreshed.title || target.title;
      if (!hasText(target.summary) && hasText(refreshed.summary)) target.summary = refreshed.summary || target.summary;
      if (target.rating <= 0 && (refreshed.rating || 0) > 0) target.rating = refreshed.rating || target.rating;
      if (!target.year && refreshed.year) target.year = refreshed.year;
      if (!target.format && refreshed.format) target.format = refreshed.format;
      if (!target.poster && refreshed.thumbnail) target.poster = refreshed.thumbnail;
      if (!target.backdrop && refreshed.cover) target.backdrop = refreshed.cover;
      if (!target.logo && refreshed.logo) target.logo = refreshed.logo;
      if (!target.genres?.length && refreshed.genres?.length) target.genres = refreshed.genres;
      if (!hasProviderRatings(target.providerRatings) && hasProviderRatings(refreshed.providerRatings)) {
        target.providerRatings = refreshed.providerRatings;
      }
      if (!hasContentRatings(target.contentRatings) && hasContentRatings(refreshed.contentRatings)) {
        target.contentRatings = refreshed.contentRatings;
      }
      if (!target.streamingProviders?.length && refreshed.streamingProviders?.length) {
        target.streamingProviders = refreshed.streamingProviders;
      }
      if (!target.originPlatform && refreshed.originPlatform) {
        target.originPlatform = refreshed.originPlatform;
      }
      if (!target.posterCandidates?.length && refreshed.posterCandidates?.length) {
        target.posterCandidates = refreshed.posterCandidates;
      }
      if (!target.backdropCandidates?.length && refreshed.backdropCandidates?.length) {
        target.backdropCandidates = refreshed.backdropCandidates;
      }
      if (!target.logoCandidates?.length && refreshed.logoCandidates?.length) {
        target.logoCandidates = refreshed.logoCandidates;
      }

      if (target.type === 'anime') {
        const mergedCast = mergeAnimeCastMissingFields(
          normalizeAnimeCast(target.cast),
          normalizeAnimeCast(refreshed.cast),
        );
        target.cast = mergedCast;
      } else if (target.cast.length === 0 && refreshed.cast?.length) {
        target.cast = refreshed.cast;
      }

      applyOfficialSeasons(target, refreshed.seasons);

      mergeEpisodeMetadataForTarget(
        target,
        refreshed.episodes,
        refreshed.episodeSource || 'refresh',
        true,
      );

      let changed = JSON.stringify(target) !== before;
      if (changed) {
        saveLibrary(library);
        await cacheArtworkNow(library);
      }

      if (target.providerIds?.tmdbId && !target.streamingProviders?.length) {
        const providers = await getStreamingProviders(mediaId);
        changed = changed || providers.length > 0;
      }
      return changed;
    })().catch((error) => {
      console.warn(`[metadata] Incomplete refresh failed for ${mediaId}:`, error);
      return false;
    });

    incompleteMetadataRefreshState.set(mediaId, {
      nextAttemptAt: now + INCOMPLETE_METADATA_RETRY_COOLDOWN_MS,
      pending: request,
    });
    void request.finally(() => {
      const current = incompleteMetadataRefreshState.get(mediaId);
      if (current?.pending === request) {
        incompleteMetadataRefreshState.set(mediaId, { nextAttemptAt: current.nextAttemptAt });
      }
    });
    return request;
  }

  async function refreshDisplayMetadata(mediaId: string): Promise<boolean> {
    const initialTarget = findLibraryMediaItem(loadLibrary(), mediaId);
    if (!initialTarget) return false;

    const now = Date.now();
    const previousAttempt = displayMetadataRefreshState.get(mediaId);
    if (previousAttempt?.pending) return previousAttempt.pending;
    if (previousAttempt && previousAttempt.nextAttemptAt > now) return false;

    const request = (async () => {
      const library = loadLibrary();
      const target = findLibraryMediaItem(library, mediaId);
      if (!target) return false;

      const before = JSON.stringify(target);
      const refreshed = await fetchOfficialArtworkForItem(target);

      if (hasText(refreshed.summary)) target.summary = refreshed.summary || target.summary;
      if ((refreshed.rating || 0) > 0) target.rating = refreshed.rating || target.rating;
      if (refreshed.genres?.length) target.genres = refreshed.genres;
      if (refreshed.format) target.format = refreshed.format;
      if (!target.year && refreshed.year) target.year = refreshed.year;
      if (hasProviderRatings(refreshed.providerRatings)) target.providerRatings = refreshed.providerRatings;
      if (hasContentRatings(refreshed.contentRatings)) target.contentRatings = refreshed.contentRatings;
      if (refreshed.providerIds) {
        target.providerIds = mergeProviderIds(target.providerIds || {}, refreshed.providerIds);
      }
      if (refreshed.cast?.length) {
        target.cast = target.type === 'anime'
          ? normalizeAnimeCast(refreshed.cast)
          : refreshed.cast;
      }
      applyOfficialSeasons(target, refreshed.seasons);

      const changed = JSON.stringify(target) !== before;
      if (changed) saveLibrary(library);
      return changed;
    })().catch((error) => {
      console.warn(`[metadata] Display refresh failed for ${mediaId}:`, error);
      return false;
    });

    displayMetadataRefreshState.set(mediaId, {
      nextAttemptAt: now + DISPLAY_METADATA_REFRESH_INTERVAL_MS,
      pending: request,
    });
    void request.finally(() => {
      const current = displayMetadataRefreshState.get(mediaId);
      if (current?.pending === request) {
        displayMetadataRefreshState.set(mediaId, { nextAttemptAt: current.nextAttemptAt });
      }
    });
    return request;
  }

  async function getStreamingProviders(mediaId: string): Promise<StreamingProvider[]> {
    const library = loadLibrary();
    const target = findLibraryMediaItem(library, mediaId);
    if (!target) return [];
    if (target.streamingProviders?.length) return target.streamingProviders;

    const tmdbId = target.providerIds?.tmdbId;
    if (!tmdbId) return [];

    const now = Date.now();
    const previousAttempt = streamingProviderRefreshState.get(mediaId);
    if (previousAttempt?.pending) return previousAttempt.pending;
    if (previousAttempt && previousAttempt.nextAttemptAt > now) return [];

    const settings = loadSettings();
    const tmdbApiKey = getMetadataApiKey(settings, 'tmdb');
    const request = (async () => {
      const providers = await fetchTMDBStreamingProvidersById(
        target.type === 'movie' ? 'movie' : 'tv',
        tmdbId,
        tmdbApiKey,
      ) || [];

      const nextAttemptAt = Date.now() + STREAMING_PROVIDER_RETRY_COOLDOWN_MS;
      streamingProviderRefreshState.set(mediaId, { nextAttemptAt });

      // Empty or failed provider responses are deliberately not persisted as
      // final metadata. A later detail/catalog load can retry after cooldown.
      if (providers.length === 0) return providers;

      const latestLibrary = loadLibrary();
      const latestTarget = findLibraryMediaItem(latestLibrary, mediaId);
      if (latestTarget && !latestTarget.streamingProviders?.length) {
        latestTarget.streamingProviders = providers;
        saveLibrary(latestLibrary);
      }
      return providers;
    })().catch(() => {
      streamingProviderRefreshState.set(mediaId, {
        nextAttemptAt: Date.now() + STREAMING_PROVIDER_RETRY_COOLDOWN_MS,
      });
      return [];
    });

    streamingProviderRefreshState.set(mediaId, {
      nextAttemptAt: now + STREAMING_PROVIDER_RETRY_COOLDOWN_MS,
      pending: request,
    });
    void request.finally(() => {
      const current = streamingProviderRefreshState.get(mediaId);
      if (current?.pending === request) {
        streamingProviderRefreshState.set(mediaId, { nextAttemptAt: current.nextAttemptAt });
      }
    });
    return request;
  }

  async function getPlaybackLogo(mediaId: string): Promise<{ logo?: string; logoCandidates: string[] }> {
    const library = loadLibrary();
    const target = findLibraryMediaItem(library, mediaId);
    if (!target) {
      throw new Error('Media item was not found in the library.');
    }

    const existing = orderedArtworkCandidates(
      target.logo,
      ...officialArtworkOnly(target.logoCandidates || []),
    );
    if (existing.length > 0) {
      const delivered = artworkDeliveryUrls(existing);
      return { logo: delivered[0] || artworkDeliveryUrl(existing[0]), logoCandidates: delivered };
    }

    const refreshed = await fetchOfficialArtworkForItem(target);
    const logoCandidates = orderedArtworkCandidates(
      refreshed.logo,
      ...officialArtworkOnly(refreshed.logoCandidates || []),
    );
    if (logoCandidates.length > 0) {
      target.logo = logoCandidates[0];
      target.logoCandidates = orderedArtworkCandidates(
        ...logoCandidates,
        ...officialArtworkOnly(target.logoCandidates || []),
      );
      saveLibrary(library);
      void cacheArtworkNow(library).catch((error) => {
        console.error('playback logo artwork cache error:', error);
      });
    }

    const delivered = artworkDeliveryUrls(logoCandidates);
    return { logo: delivered[0] || artworkDeliveryUrl(logoCandidates[0]), logoCandidates: delivered };
  }


  return {
    applyOfficialMetadataCandidate,
    fetchOfficialArtworkForItem,
    fetchOfficialMetadataCandidatesForItem,
    getOfficialMetadataCandidates,
    refreshDisplayMetadata,
    refreshIncompleteMetadata,
    getPlaybackLogo,
    getStreamingProviders,
    refreshOfficialArtwork,
  };
}
