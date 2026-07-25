import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, LibraryData } from './appContracts.ts';
import {
  bestSeriesTitleFromEpisodeFiles,
  chooseMetadataSearchTitle,
  cleanMediaTitle,
  normalizeTitleForMatch,
  numericRating,
  parseYearFromText,
  remoteMatchesAnyLocalTitle,
  uniqueLocalTitles,
} from './metadata/helpers.ts';
import type { ContentRating, EpisodeMeta, MediaItem } from './metadata/types.ts';
import { omdbContentRatings, type OMDbResponse } from './metadata/omdb.ts';
import { mergeContentRatings } from './metadata/contentRatings.ts';
import { mergeProviderIds, parseMetadataProviderIds } from './mediaTags.ts';
import type { MetadataProviderIds } from './mediaTags.ts';
import type { ProbeMediaFileResult } from './mediaProbeFile.ts';

export type OfficialArtworkRefreshResult = {
  thumbnail?: string;
  cover?: string;
  summary?: string;
  rating?: number;
  episodes?: EpisodeMeta[];
  episodeSource?: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logo?: string;
  logoCandidates?: string[];
  contentRatings?: Record<string, ContentRating>;
};

export type OfficialArtworkRefreshTarget = 'all' | 'poster' | 'cover';
export type OfficialMetadataApplyTarget = OfficialArtworkRefreshTarget | 'episodes';

export type OfficialMetadataCandidate = OfficialArtworkRefreshResult & {
  id: string;
  source: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
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
  fetchFanartMovieLogos: typeof import('./metadata/fanart.ts').fetchFanartMovieLogos;
  fetchFanartTVLogos: typeof import('./metadata/fanart.ts').fetchFanartTVLogos;
  fetchJikanMetadata: typeof import('./metadata/jikan.ts').fetchJikanMetadata;
  fetchJikanMetadataCandidates: typeof import('./metadata/jikan.ts').fetchJikanMetadataCandidates;
  fetchOMDbMetadata: typeof import('./metadata/omdb.ts').fetchOMDbMetadata;
  fetchOMDbMetadataById: typeof import('./metadata/omdb.ts').fetchOMDbMetadataById;
  fetchTMDBMovieMetadata: typeof import('./metadata/tmdb.ts').fetchTMDBMovieMetadata;
  fetchTMDBMovieMetadataById: typeof import('./metadata/tmdb.ts').fetchTMDBMovieMetadataById;
  fetchTMDBMovieMetadataCandidates: typeof import('./metadata/tmdb.ts').fetchTMDBMovieMetadataCandidates;
  fetchTMDBTVMetadata: typeof import('./metadata/tmdb.ts').fetchTMDBTVMetadata;
  fetchTMDBTVMetadataById: typeof import('./metadata/tmdb.ts').fetchTMDBTVMetadataById;
  fetchTMDBTVMetadataCandidates: typeof import('./metadata/tmdb.ts').fetchTMDBTVMetadataCandidates;
  fetchTVMetadata: typeof import('./metadata/tvmaze.ts').fetchTVMetadata;
  fetchTVMetadataCandidates: typeof import('./metadata/tvmaze.ts').fetchTVMetadataCandidates;
  artworkDeliveryUrl: (source?: string | null) => string;
  artworkDeliveryUrls: (sources?: string[]) => string[];
  orderedArtworkCandidates: (...urls: Array<string | null | undefined>) => string[];
};

export function createOfficialMetadataService(deps: OfficialMetadataServiceDependencies) {
  const {
    artworkDeliveryUrl,
    artworkDeliveryUrls,
    cacheArtworkNow,
    fetchFanartMovieLogos,
    fetchFanartTVLogos,
    fetchJikanMetadata,
    fetchJikanMetadataCandidates,
    fetchOMDbMetadata,
    fetchOMDbMetadataById,
    fetchTMDBMovieMetadata,
    fetchTMDBMovieMetadataById,
    fetchTMDBMovieMetadataCandidates,
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
    return numericRating(tmdbMeta?.rating)
      || numericRating(omdbMeta?.imdbRating)
      || numericRating(tvMeta?.rating);
  }

  function showMetadataRating(
    type: 'tv' | 'anime',
    jikanMeta?: { rating?: number } | null,
    tmdbMeta?: Partial<MediaItem> | null,
    tvMeta?: { rating?: number } | null,
    omdbMeta?: OMDbResponse | null,
  ): number {
    return (type === 'anime' ? numericRating(jikanMeta?.rating) : 0)
      || numericRating(tmdbMeta?.rating)
      || numericRating(tvMeta?.rating)
      || numericRating(omdbMeta?.imdbRating);
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
      title,
      year: metadata.year || undefined,
      thumbnail: posterCandidates[0] || '',
      cover: backdropCandidates[0] || posterCandidates[0] || '',
      summary: metadata.summary || '',
      rating: numericRating(metadata.rating),
      genres: Array.isArray(metadata.genres) ? metadata.genres.filter(Boolean) : [],
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
  ): void {
    if (target.type === 'movie' || !remoteEpisodes?.length) return;

    const useEpKeyOnly = source === 'Jikan';
    const remoteByKey = new Map<string, EpisodeMeta>(
      remoteEpisodes.map((episode) => [
        useEpKeyOnly ? String(episode.number) : `${episode.season}-${episode.number}`,
        episode,
      ]),
    );
    const existingByKey = new Map<string, EpisodeMeta>(
      (target.episodes || []).map((episode) => [`${episode.season}-${episode.number}`, episode]),
    );

    if (!target.episodeFiles?.length) {
      target.episodes = remoteEpisodes;
      return;
    }

    target.episodes = target.episodeFiles.map((file) => {
      const key = `${file.season}-${file.episode}`;
      const remote = remoteByKey.get(useEpKeyOnly ? String(file.episode) : key);
      const existing = existingByKey.get(key);
      return {
        season: file.season,
        number: file.episode,
        title: remote?.title || existing?.title || file.title || '',
        summary: remote?.summary || existing?.summary || '',
        still: remote?.still || existing?.still || '',
        rating: remote?.rating || existing?.rating || 0,
        airDate: remote?.airDate || existing?.airDate || '',
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
    const [omdbById, omdbBySearch, jikanCandidates, tmdbById, tmdbBySearch, tmdbCandidates, tvMeta, tvCandidates] = await Promise.all([
      providerIds.imdbId ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey) : Promise.resolve(null),
      fetchOMDbMetadata(title, year, omdbApiKey),
      likelyAnime ? fetchJikanMetadataCandidates(title, localTitles) : Promise.resolve([]),
      providerIds.tmdbId ? fetchTMDBTVMetadataById(providerIds.tmdbId, tmdbApiKey) : Promise.resolve(null),
      fetchTMDBTVMetadata(title, year, tmdbApiKey),
      fetchTMDBTVMetadataCandidates(title, year, tmdbApiKey),
      fetchTVMetadata(title, year),
      fetchTVMetadataCandidates(title, year),
    ]);
    return sortMetadataCandidates(uniqueMetadataCandidates([
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
        thumbnail: posterCandidates[0] || '',
        cover: backdropCandidates[0] || posterCandidates[0] || '',
        summary: tmdbMeta?.summary || omdbMeta?.Plot || '',
        rating: movieMetadataRating(tmdbMeta, omdbMeta, matchedTV),
        contentRatings: mergeContentRatings(tmdbMeta?.contentRatings, omdbContentRatings(omdbMeta)),
        posterCandidates,
        backdropCandidates,
        logo: logoCandidates[0] || '',
        logoCandidates,
      };
    }

    const likelyAnime = item.type === 'anime';
    const [omdbById, omdbBySearch, jikanMeta, tmdbById, tmdbBySearch, tvMeta] = await Promise.all([
      providerIds.imdbId ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey) : Promise.resolve(null),
      fetchOMDbMetadata(title, year, omdbApiKey),
      likelyAnime ? fetchJikanMetadata(title) : Promise.resolve(null),
      providerIds.tmdbId ? fetchTMDBTVMetadataById(providerIds.tmdbId, tmdbApiKey) : Promise.resolve(null),
      fetchTMDBTVMetadata(title, year, tmdbApiKey),
      fetchTVMetadata(title, year),
    ]);
    const omdbMeta = omdbById || (remoteMatchesAnyLocalTitle(localTitles, omdbBySearch?.Title) ? omdbBySearch : null);
    const matchedJikan = metadataResultMatchesLocalTitle(jikanMeta, localTitles) ? jikanMeta : null;
    const tmdbMeta = tmdbById || (remoteMatchesAnyLocalTitle(localTitles, tmdbBySearch?.title) ? tmdbBySearch : null);
    const matchedTV = remoteMatchesAnyLocalTitle(localTitles, tvMeta?.title) ? tvMeta : null;
    const omdbPoster = omdbMeta?.Poster && omdbMeta.Poster !== 'N/A' ? omdbMeta.Poster : '';
    const posterCandidates = officialArtworkOnly([
      tmdbMeta?.poster,
      omdbPoster,
      matchedTV?.poster,
      likelyAnime ? matchedJikan?.poster : '',
    ]);
    const backdropCandidates = officialArtworkOnly([
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
    const episodes = matchedTV?.episodes || (likelyAnime ? matchedJikan?.episodes : undefined) || tmdbMeta?.episodes;
    const episodeSource = matchedTV?.episodes?.length
      ? 'TVmaze'
      : likelyAnime && matchedJikan?.episodes?.length
        ? 'Jikan'
        : tmdbMeta?.episodes?.length
          ? 'TMDB'
          : undefined;

    return {
      thumbnail: posterCandidates[0] || '',
      cover: backdropCandidates[0] || posterCandidates[0] || '',
      summary: tmdbMeta?.summary || omdbMeta?.Plot || matchedTV?.summary || matchedJikan?.summary || '',
      rating: showMetadataRating(likelyAnime ? 'anime' : 'tv', matchedJikan, tmdbMeta, matchedTV, omdbMeta),
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
    if (applyPoster && selectedPoster) target.poster = selectedPoster;
    if (applyCover && selectedCover) target.backdrop = selectedCover;
    if (applyAll && candidate.logo) target.logo = candidate.logo;
    if (applyAll && candidate.summary) target.summary = candidate.summary;
    if (applyAll && candidate.rating) target.rating = candidate.rating;
    if (applyAll && candidate.genres?.length) target.genres = candidate.genres;
    if (applyAll && candidate.contentRatings) target.contentRatings = candidate.contentRatings;
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
      summary: target.summary || '',
      rating: target.rating || 0,
      contentRatings: target.contentRatings,
      episodes: target.type === 'movie' ? undefined : target.episodes,
      episodeSource: candidate.source,
      posterCandidates: target.posterCandidates || [],
      backdropCandidates: target.backdropCandidates || [],
      logo: target.logo || '',
      logoCandidates: target.logoCandidates || [],
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
    const hasRefresh = Boolean(
      (refreshPoster && refreshedPoster)
      || (refreshCover && refreshedCover)
      || (refreshMetadata && (refreshed.logo || refreshed.summary || refreshed.rating || refreshed.contentRatings || refreshed.episodes?.length)),
    );

    if (hasRefresh) {
      if (refreshPoster && refreshedPoster) target.poster = refreshedPoster;
      if (refreshCover && refreshedCover) target.backdrop = refreshedCover;
      if (refreshMetadata && refreshed.logo) target.logo = refreshed.logo;
      if (refreshMetadata && refreshed.summary) target.summary = refreshed.summary;
      if (refreshMetadata && refreshed.rating) target.rating = refreshed.rating;
      if (refreshMetadata && refreshed.contentRatings) target.contentRatings = refreshed.contentRatings;
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
      episodes: target.type === 'movie' ? undefined : target.episodes,
      episodeSource: refreshed.episodeSource,
      posterCandidates: target.posterCandidates || refreshed.posterCandidates,
      backdropCandidates: target.backdropCandidates || refreshed.backdropCandidates,
      logo: target.logo || refreshed.logo || '',
      logoCandidates: target.logoCandidates || refreshed.logoCandidates,
    };
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
    getPlaybackLogo,
    refreshOfficialArtwork,
  };
}
