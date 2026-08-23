import fs from 'node:fs';
import path from 'node:path';
import {
  createMediaItemId,
  isTrustedLocalTagTitle,
  looksLikeLocalEpisodeFileTitle,
  mostCommonUsefulTitle,
} from './libraryItemHelpers.ts';
import {
  cleanMediaTitle,
  episodeTitleFromFileName,
  mergeEpisodeMetadataSources,
  numericRating,
  remoteMatchesAnyLocalTitle,
  uniqueLocalTitles,
  usefulLocalTitle,
} from './metadata/helpers.ts';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './metadata/types.ts';
import { omdbContentRatings, omdbProviderRatings, type OMDbResponse } from './metadata/omdb.ts';
import { mergeContentRatings } from './metadata/contentRatings.ts';
import { mergeProviderIds, parseMetadataProviderIds } from './mediaTags.ts';
import {
  inferSeriesTitleFromEpisodeFiles,
  isAnimeMetadata,
  isLikelyAnimePath,
  isSeriesMetadata,
  mergeLocalSeasonsWithMetadata,
  mergeOfficialSeasonMetadata,
} from './scanClassification.ts';
import type { BuildMovieItemRequest, BuildTVItemRequest } from './libraryScanner.ts';
import type { ProbeMediaFileResult } from './mediaProbeFile.ts';
import { normalizeAnimeCast } from '../shared/animeCast.ts';
import {
  getBoundedLibraryProbe,
  LIBRARY_PROBE_CONCURRENCY,
  mapWithConcurrency,
} from './libraryScanConcurrency.ts';

export type MetadataItemBuilderDependencies = {
  downloadMissingOpenSubtitlesForFolder: typeof import('./openSubtitles.ts').downloadMissingOpenSubtitlesForFolder;
  openSubtitlesIsConfigured: typeof import('./openSubtitles.ts').openSubtitlesIsConfigured;
  extractSeasons: (folderPath: string, folderName: string, episodeFiles?: EpisodeFile[]) => Promise<Array<{ number: number; title: string; episodeCount: number }>>;
  scanEpisodeFiles: (folderPath: string) => Promise<EpisodeFile[]>;
  probeMediaFile: (filePath: string) => Promise<ProbeMediaFileResult>;
  fetchAniListAnimeMetadata: typeof import('./metadata/anilist.ts').fetchAniListAnimeMetadata;
  fetchJikanEpisodesForLocalAnimeSeasons: typeof import('./scanClassification.ts').fetchJikanEpisodesForLocalAnimeSeasons;
  fetchJikanMetadata: typeof import('./metadata/jikan.ts').fetchJikanMetadata;
  fetchOMDbMetadata: typeof import('./metadata/omdb.ts').fetchOMDbMetadata;
  fetchOMDbMetadataById: typeof import('./metadata/omdb.ts').fetchOMDbMetadataById;
  fetchTMDBMovieMetadata: typeof import('./metadata/tmdb.ts').fetchTMDBMovieMetadata;
  fetchTMDBMovieMetadataById: typeof import('./metadata/tmdb.ts').fetchTMDBMovieMetadataById;
  fetchTMDBTVMetadata: typeof import('./metadata/tmdb.ts').fetchTMDBTVMetadata;
  fetchTMDBTVMetadataById: typeof import('./metadata/tmdb.ts').fetchTMDBTVMetadataById;
  fetchTVDBMetadata: typeof import('./metadata/tvdb.ts').fetchTVDBMetadata;
  fetchTVDBMetadataById: typeof import('./metadata/tvdb.ts').fetchTVDBMetadataById;
  fetchTVMetadata: typeof import('./metadata/tvmaze.ts').fetchTVMetadata;
  fetchFanartMovieLogos: typeof import('./metadata/fanart.ts').fetchFanartMovieLogos;
  fetchFanartTVLogos: typeof import('./metadata/fanart.ts').fetchFanartTVLogos;
  getEmbeddedArtworkUrl: (filePath: string, probe: ProbeMediaFileResult) => string;
  getLocalFolderArtworkUrl: (folderPath: string, kind: 'poster' | 'backdrop') => string;
  getLocalMovieArtworkUrl: (filePath: string, kind: 'poster' | 'backdrop') => string;
  getLocalThumbnailUrl: (filePath: string) => string;
  orderedArtworkCandidates: (...urls: Array<string | null | undefined>) => string[];
};

export function createMetadataItemBuilders(deps: MetadataItemBuilderDependencies) {
  const {
    downloadMissingOpenSubtitlesForFolder,
    extractSeasons,
    fetchAniListAnimeMetadata,
    fetchFanartMovieLogos,
    fetchFanartTVLogos,
    fetchJikanEpisodesForLocalAnimeSeasons,
    fetchJikanMetadata,
    fetchOMDbMetadata,
    fetchOMDbMetadataById,
    fetchTMDBMovieMetadata,
    fetchTMDBMovieMetadataById,
    fetchTMDBTVMetadata,
    fetchTMDBTVMetadataById,
    fetchTVDBMetadata,
    fetchTVDBMetadataById,
    fetchTVMetadata,
    getEmbeddedArtworkUrl,
    getLocalFolderArtworkUrl,
    getLocalMovieArtworkUrl,
    getLocalThumbnailUrl,
    openSubtitlesIsConfigured,
    orderedArtworkCandidates,
    probeMediaFile: unboundedProbeMediaFile,
    scanEpisodeFiles,
  } = deps;
  const probeMediaFile = getBoundedLibraryProbe(unboundedProbeMediaFile);

  const makeLocalEpisodeMeta = (files: EpisodeFile[], seriesTitle?: string): EpisodeMeta[] => files.map((file) => {
    const filenameTitle = episodeTitleFromFileName(file.filePath);
    const fallback = path.basename(file.filePath, path.extname(file.filePath))
      .replace(/\b[Ss]\s*0*\d{1,2}\s*[._ -]*[Ee]\s*0*\d{1,3}\b/g, '')
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `Episode ${file.episode}`;
    const resolvedTitle = filenameTitle
      || ((!looksLikeLocalEpisodeFileTitle(file.title, seriesTitle) && file.title) ? file.title : fallback);
    return {
      season: file.season,
      number: file.episode,
      title: resolvedTitle,
      summary: '',
      still: '',
      rating: 0,
      airDate: '',
      localMetadata: file.localMetadata,
    };
  });

  const movieMetadataRating = (
    tmdbMeta?: Partial<MediaItem> | null,
    omdbMeta?: OMDbResponse | null,
    tvMeta?: { rating?: number } | null,
  ): number => numericRating(tmdbMeta?.rating)
    || numericRating(omdbMeta?.imdbRating)
    || numericRating(tvMeta?.rating);

  const showMetadataRating = (
    type: MediaItem['type'],
    jikanMeta?: Partial<MediaItem> | null,
    tmdbMeta?: Partial<MediaItem> | null,
    tvMeta?: { rating?: number } | null,
    omdbMeta?: OMDbResponse | null,
    preferOmdbFallback = true,
  ): number => numericRating(tmdbMeta?.rating)
    || (type === 'anime' ? numericRating(jikanMeta?.rating) : 0)
    || (preferOmdbFallback
      ? numericRating(omdbMeta?.imdbRating) || numericRating(tvMeta?.rating)
      : numericRating(tvMeta?.rating) || numericRating(omdbMeta?.imdbRating));

  const officialArtworkOnly = (urls: Array<string | null | undefined>): string[] => {
    const seen = new Set<string>();
    const official: string[] = [];
    for (const value of urls) {
      const url = (value || '').trim();
      if (!url || seen.has(url)) continue;
      if (!/^https?:\/\//i.test(url)) continue;
      seen.add(url);
      official.push(url);
    }
    return official;
  };

  async function buildTVItemFromFolder({
    fullPath,
    entryName,
    id,
    subtitles,
    year,
    cleanTitle,
    omdbApiKey,
    itemType = 'tv',
    tmdbApiKey,
    tvdbApiKey,
    fanartApiKey,
    openSubtitles,
  }: BuildTVItemRequest): Promise<MediaItem | null> {
    if (openSubtitlesIsConfigured(openSubtitles)) {
      const results = await downloadMissingOpenSubtitlesForFolder(fullPath, openSubtitles);
      const failures = results.filter((result) => result.status === 'error');
      failures.forEach((result) => console.warn('[OpenSubtitles]', result.videoPath, result.message));
    }

    const episodeFiles = await scanEpisodeFiles(fullPath);
    const localSeasons = await extractSeasons(fullPath, entryName, episodeFiles);
    const episodeProbes = await mapWithConcurrency(
      episodeFiles,
      LIBRARY_PROBE_CONCURRENCY,
      (file) => probeMediaFile(file.filePath),
    );
    const representativeProbe = episodeProbes.find((probe) => probe.localMetadata) || episodeProbes[0] || {};
    const providerIds = mergeProviderIds(
      ...episodeProbes.map((probe) => probe.providerIds || {}),
      parseMetadataProviderIds([
        fullPath,
        ...episodeFiles.map((file) => path.basename(file.filePath)),
      ].join(' ')),
    );
    const inferredSeriesTitle = inferSeriesTitleFromEpisodeFiles(episodeFiles, cleanTitle);

    const rawFolderTitle = cleanTitle || entryName;
    const folderTitle = usefulLocalTitle(rawFolderTitle);
    const parentTitle = usefulLocalTitle(path.basename(path.dirname(fullPath)));
    const inferredTitle = usefulLocalTitle(inferredSeriesTitle);
    const embeddedShowTitle = mostCommonUsefulTitle(episodeProbes.map((probe) => probe.embeddedShowTitle));
    const structureTitle = folderTitle || parentTitle || inferredTitle || embeddedShowTitle || rawFolderTitle;
    const trustedEmbeddedShowTitle = isTrustedLocalTagTitle(structureTitle, embeddedShowTitle, rawFolderTitle)
      ? embeddedShowTitle
      : null;
    const searchTitle = trustedEmbeddedShowTitle || structureTitle;
    const localTitleCandidates = uniqueLocalTitles([
      searchTitle,
      structureTitle,
      trustedEmbeddedShowTitle,
      folderTitle,
      parentTitle,
      inferredTitle,
    ]);
    const searchYear = year || episodeProbes.find((probe) => probe.year)?.year;
    const likelyAnime = itemType === 'anime' || isLikelyAnimePath(fullPath, searchTitle);
    const localEpisodes = makeLocalEpisodeMeta(episodeFiles, searchTitle);

    // ── Fetch metadata sources ─────────────────────────────────────────────────
    // Anime   → AniList primary, Jikan + TVmaze + TMDB + OMDb as fallbacks
    // TV show → TMDB primary, TVmaze as free fallback, OMDb for extra fields
    const [omdbById, omdbBySearch, anilistMeta, jikanMeta, tmdbTVById, tmdbTVBySearch, tvdbById, tvdbBySearch, tvMeta] = await Promise.all([
      providerIds.imdbId
        ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey)
        : Promise.resolve(null),
      fetchOMDbMetadata(searchTitle, searchYear, omdbApiKey),
      likelyAnime ? fetchAniListAnimeMetadata(undefined, searchTitle) : Promise.resolve(null),
      likelyAnime ? fetchJikanMetadata(searchTitle) : Promise.resolve(null),
      providerIds.tmdbId
        ? fetchTMDBTVMetadataById(providerIds.tmdbId, tmdbApiKey)
        : Promise.resolve(null),
      fetchTMDBTVMetadata(searchTitle, searchYear, tmdbApiKey),
      providerIds.tvdbId
        ? fetchTVDBMetadataById(providerIds.tvdbId, tvdbApiKey)
        : Promise.resolve(null),
      fetchTVDBMetadata(searchTitle, searchYear, tvdbApiKey),
      // TVmaze often has cleaner named episode lists, including anime seasons.
      fetchTVMetadata(searchTitle, searchYear),
    ]);
    const matchedOmdbData = [omdbById, omdbBySearch]
      .find((data) => remoteMatchesAnyLocalTitle(localTitleCandidates, data?.Title)) || null;
    const matchedAniListMeta = remoteMatchesAnyLocalTitle(
      localTitleCandidates,
      anilistMeta?.title,
    ) || anilistMeta?.aliases?.some((alias) => remoteMatchesAnyLocalTitle(localTitleCandidates, alias))
      ? anilistMeta
      : null;
    const matchedJikanMeta = remoteMatchesAnyLocalTitle(localTitleCandidates, jikanMeta?.title) ? jikanMeta : null;
    const localAndAnimeAliasTitles = uniqueLocalTitles([
      ...localTitleCandidates,
      ...(matchedAniListMeta?.aliases || []),
      matchedAniListMeta?.title,
      ...(matchedJikanMeta?.aliases || []),
      matchedJikanMeta?.title,
    ]);
    const matchedTmdbTVMeta = [tmdbTVById, tmdbTVBySearch]
      .find((data) => remoteMatchesAnyLocalTitle(localAndAnimeAliasTitles, data?.title)) || null;
    const matchedTVDBMeta = [tvdbById, tvdbBySearch]
      .find((data) => remoteMatchesAnyLocalTitle(localAndAnimeAliasTitles, data?.title)) || null;
    const matchedTVMeta = remoteMatchesAnyLocalTitle(localAndAnimeAliasTitles, tvMeta?.title) ? tvMeta : null;

    // ── Resolve type ───────────────────────────────────────────────────────────
    const finalType: 'tv' | 'anime' =
      likelyAnime || isAnimeMetadata(fullPath, searchTitle, matchedOmdbData, matchedTVMeta)
        ? 'anime'
        : 'tv';

    // ── Poster / backdrop ──────────────────────────────────────────────────────
    // Posters can fall through to embedded/generated thumbnails. Backdrops stay
    // limited to true local/API cover art; the renderer falls back to poster art.
    const localPoster = getLocalFolderArtworkUrl(fullPath, 'poster');
    const embeddedPoster = episodeFiles[0] ? getEmbeddedArtworkUrl(episodeFiles[0].filePath, representativeProbe) : '';
    const localBackdrop = getLocalFolderArtworkUrl(fullPath, 'backdrop');
    const generatedThumbnail = episodeFiles[0] ? getLocalThumbnailUrl(episodeFiles[0].filePath) : '';
    const omdbPoster = matchedOmdbData?.Poster && matchedOmdbData.Poster !== 'N/A' ? matchedOmdbData.Poster : '';
    const preferOmdbFallback = Boolean(tmdbApiKey?.trim());
    const defaultTVPoster = preferOmdbFallback
      ? omdbPoster || matchedTVMeta?.poster || matchedTVDBMeta?.poster
      : matchedTVMeta?.poster || omdbPoster || matchedTVDBMeta?.poster;
    const officialPoster =
      (finalType === 'anime' ? (matchedAniListMeta?.poster || matchedJikanMeta?.poster || '') : '')
      || matchedTmdbTVMeta?.poster
      || defaultTVPoster
      || matchedTVDBMeta?.poster;
    const poster =
      localPoster
      || officialPoster
      || embeddedPoster
      || generatedThumbnail;
    const posterCandidates = orderedArtworkCandidates(
      localPoster,
      officialPoster,
      embeddedPoster,
      generatedThumbnail,
    );

    const officialBackdrop =
      (finalType === 'anime' ? (matchedAniListMeta?.backdrop || '') : '')
      || matchedTmdbTVMeta?.backdrop
      || (finalType === 'anime' ? (matchedJikanMeta?.backdrop || '') : '')
      || matchedTVMeta?.backdrop
      || matchedTVDBMeta?.backdrop
      || '';
    const backdrop =
      localBackdrop
      || officialBackdrop;
    const backdropCandidates = orderedArtworkCandidates(
      localBackdrop,
      officialBackdrop,
    );
    const fanartLogoCandidates = await fetchFanartTVLogos(
      matchedTmdbTVMeta?.providerIds?.tvdbId || matchedTVDBMeta?.providerIds?.tvdbId || matchedTVMeta?.providerIds?.tvdbId || providerIds.tvdbId,
      fanartApiKey,
    );
    const logoCandidates = orderedArtworkCandidates(
      matchedTmdbTVMeta?.logo,
      ...officialArtworkOnly(matchedTmdbTVMeta?.logoCandidates || []),
      ...fanartLogoCandidates,
      matchedTVDBMeta?.logo,
      ...officialArtworkOnly(matchedTVDBMeta?.logoCandidates || []),
    );
    const logo = logoCandidates[0] || '';

    // ── Summary / rating / genres / cast ──────────────────────────────────────
    const defaultTVSummary = preferOmdbFallback
      ? matchedOmdbData?.Plot || matchedTVMeta?.summary || matchedTVDBMeta?.summary
      : matchedTVMeta?.summary || matchedOmdbData?.Plot || matchedTVDBMeta?.summary;
    const summary =
      (finalType === 'anime' ? (matchedAniListMeta?.summary || matchedJikanMeta?.summary || '') : matchedTmdbTVMeta?.summary || defaultTVSummary)
      || episodeProbes.find((probe) => probe.summary)?.summary
      || matchedTmdbTVMeta?.summary
      || matchedTVDBMeta?.summary
      || defaultTVSummary
      || '';

    const rating = numericRating(matchedTmdbTVMeta?.rating)
      || (finalType === 'anime' ? numericRating(matchedAniListMeta?.rating) : 0)
      || showMetadataRating(finalType, matchedJikanMeta, matchedTmdbTVMeta, matchedTVMeta, matchedOmdbData, preferOmdbFallback);

    const defaultTVGenres = preferOmdbFallback
      ? (matchedOmdbData?.Genre ? matchedOmdbData.Genre.split(', ') : matchedTVMeta?.genres)
      : (matchedTVMeta?.genres ?? (matchedOmdbData?.Genre ? matchedOmdbData.Genre.split(', ') : undefined));
    const genres: string[] =
      (finalType === 'anime' ? matchedAniListMeta?.genres || matchedJikanMeta?.genres : null)
      ?? matchedTmdbTVMeta?.genres
      ?? defaultTVGenres
      ?? matchedTVDBMeta?.genres
      ?? [];

    const rawCast = [
      finalType === 'anime' ? matchedAniListMeta?.cast || matchedJikanMeta?.cast : null,
      matchedTmdbTVMeta?.cast,
      matchedTVMeta?.cast,
      matchedTVDBMeta?.cast,
    ].find((entries) => Boolean(entries?.length)) || [];
    const cast = finalType === 'anime' ? normalizeAnimeCast(rawCast) : rawCast;

    const resolvedTitle =
      searchTitle
      || cleanTitle;

    const resolvedYear =
      searchYear
      || (matchedOmdbData?.Year ? parseInt(matchedOmdbData.Year, 10) : 0)
      || (finalType === 'anime' ? (matchedAniListMeta?.year || matchedJikanMeta?.year || 0) : 0)
      || (matchedTmdbTVMeta?.year ?? 0)
      || (matchedTVMeta?.year ?? 0)
      || (matchedTVDBMeta?.year ?? 0)
      || year;
    const jikanEpisodesForLocalSeasons = finalType === 'anime'
      ? await fetchJikanEpisodesForLocalAnimeSeasons(episodeFiles, searchTitle, matchedJikanMeta)
      : { episodes: [], malIdBySeason: {} };

    // ── Merge episode metadata onto local files ────────────────────────────────
    // Keep provider priority per field so anime can use TVmaze titles while Jikan
    // fills episode scores that TVmaze often leaves empty.
    const mergedEpisodes = mergeEpisodeMetadataSources(localEpisodes, [
      matchedTVMeta?.episodes,
      matchedTVDBMeta?.episodes,
      finalType === 'anime' && jikanEpisodesForLocalSeasons.episodes.length > 0 ? jikanEpisodesForLocalSeasons.episodes : null,
      matchedTmdbTVMeta?.episodes,
    ], finalType === 'anime' ? { ratingSourceOrder: [1, 0, 2] } : undefined);
    const mergedEpisodeTitleByKey = new Map(
      mergedEpisodes.map((episode) => [`${episode.season}-${episode.number}`, episode.title]),
    );
    const mergedEpisodeFiles = episodeFiles.map((file) => ({
      ...file,
      title: mergedEpisodeTitleByKey.get(`${file.season}-${file.episode}`) || file.title,
    }));

    const remoteSeasons = mergeOfficialSeasonMetadata(
      matchedTmdbTVMeta?.tmdbSeasons,
      matchedTVMeta?.seasons,
      matchedTVDBMeta?.seasons,
    );
    const mergedSeasons = mergeLocalSeasonsWithMetadata(localSeasons, remoteSeasons);

    return {
      id,
      type: finalType,
      format: finalType === 'anime' ? (matchedAniListMeta?.format || matchedJikanMeta?.format || 'TV') : 'TV',
      title: resolvedTitle,
      year: resolvedYear,
      poster,
      backdrop,
      logo,
      posterCandidates,
      backdropCandidates,
      logoCandidates,
      summary,
      rating,
      runtime: matchedTmdbTVMeta?.runtime,
      seasonCount: matchedTmdbTVMeta?.seasonCount || matchedTVDBMeta?.seasonCount,
      episodeCount: matchedTmdbTVMeta?.episodeCount || matchedTVDBMeta?.episodeCount,
      trailerUrl: matchedTmdbTVMeta?.trailerUrl,
      providerRatings: omdbProviderRatings(matchedOmdbData),
      contentRatings: mergeContentRatings(
        matchedTmdbTVMeta?.contentRatings,
        omdbContentRatings(matchedOmdbData),
        finalType === 'anime' ? matchedJikanMeta?.contentRatings : undefined,
      ),
      streamingProviders: matchedTmdbTVMeta?.streamingProviders || [],
      originPlatform: matchedTVMeta?.originPlatform,
      genres,
      cast,
      filePath: fullPath,
      seasons: mergedSeasons,
      episodes: mergedEpisodes,
      episodeFiles: mergedEpisodeFiles,
      subtitles,
      localMetadata: representativeProbe.localMetadata,
      providerIds: mergeProviderIds(
        providerIds,
        matchedTmdbTVMeta?.providerIds || {},
        matchedTVMeta?.providerIds || {},
        matchedTVDBMeta?.providerIds || {},
        finalType === 'anime' ? {
          malId: matchedAniListMeta?.malId
            ? String(matchedAniListMeta.malId)
            : matchedJikanMeta?.malId ? String(matchedJikanMeta.malId) : undefined,
          malIdBySeason: jikanEpisodesForLocalSeasons.malIdBySeason,
        } : {},
      ),
    };
  }

  async function buildMovieItemFromFile({
    fullPath,
    fileName,
    titleFallback,
    subtitles,
    year,
    omdbApiKey,
    tmdbApiKey,
    tvdbApiKey,
    fanartApiKey,
    forcedType,
  }: BuildMovieItemRequest): Promise<MediaItem> {
    const parsedFile = cleanMediaTitle(fileName);
    const stats = await fs.promises.stat(fullPath);
    const probe = await probeMediaFile(fullPath);
    const providerIds = mergeProviderIds(probe.providerIds || {}, parseMetadataProviderIds(`${fullPath} ${fileName}`));

    const rawFileTitle = titleFallback || parsedFile.title;
    const fileTitle = usefulLocalTitle(titleFallback) || usefulLocalTitle(parsedFile.title);
    const embeddedMovieTitle = usefulLocalTitle(probe.embeddedTitle);
    const trustedEmbeddedTitle = isTrustedLocalTagTitle(fileTitle, embeddedMovieTitle, rawFileTitle)
      ? embeddedMovieTitle
      : null;
    const searchTitle = trustedEmbeddedTitle || fileTitle || rawFileTitle;
    const localTitleCandidates = uniqueLocalTitles([
      searchTitle,
      trustedEmbeddedTitle,
      fileTitle,
      parsedFile.title,
    ]);
    const searchYear = year || parsedFile.year || probe.year;

    const shouldUseShowProviders = forcedType === 'tv' || forcedType === 'anime';
    const likelyAnime = forcedType === 'anime' || isLikelyAnimePath(fullPath, searchTitle);
    const canUseMovieMetadata = !shouldUseShowProviders || likelyAnime;

    // Fetch provider metadata in parallel. Single files forced into TV/anime
    // library buckets must use show providers, not movie metadata, for artwork.
    const [tmdbById, tmdbBySearch, omdbById, omdbBySearch, anilistMeta, jikanMeta, tmdbTVById, tmdbTVBySearch, tvdbById, tvdbBySearch, tvMeta] = await Promise.all([
      canUseMovieMetadata && providerIds.tmdbId
        ? fetchTMDBMovieMetadataById(providerIds.tmdbId, tmdbApiKey)
        : Promise.resolve(null),
      canUseMovieMetadata
        ? fetchTMDBMovieMetadata(searchTitle, searchYear, tmdbApiKey)
        : Promise.resolve(null),
      providerIds.imdbId
        ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey)
        : Promise.resolve(null),
      fetchOMDbMetadata(searchTitle, searchYear, omdbApiKey),
      shouldUseShowProviders && likelyAnime
        ? fetchAniListAnimeMetadata(undefined, searchTitle)
        : Promise.resolve(null),
      shouldUseShowProviders && likelyAnime ? fetchJikanMetadata(searchTitle) : Promise.resolve(null),
      shouldUseShowProviders && providerIds.tmdbId
        ? fetchTMDBTVMetadataById(providerIds.tmdbId, tmdbApiKey)
        : Promise.resolve(null),
      shouldUseShowProviders
        ? fetchTMDBTVMetadata(searchTitle, searchYear, tmdbApiKey)
        : Promise.resolve(null),
      shouldUseShowProviders && providerIds.tvdbId
        ? fetchTVDBMetadataById(providerIds.tvdbId, tvdbApiKey)
        : Promise.resolve(null),
      shouldUseShowProviders
        ? fetchTVDBMetadata(searchTitle, searchYear, tvdbApiKey)
        : Promise.resolve(null),
      shouldUseShowProviders ? fetchTVMetadata(searchTitle, searchYear) : Promise.resolve(null),
    ]);
    // Mixed “Others” roots contain home videos and ambiguous filenames. Never
    // attach an unrelated provider hit just because a loose title produced a
    // result; ID-tagged matches remain trusted, while search matches must
    // agree with one of the local title candidates.
    const matchedTmdbData = tmdbById
      || (remoteMatchesAnyLocalTitle(localTitleCandidates, tmdbBySearch?.title) ? tmdbBySearch : null);
    const matchedOmdbData = omdbById
      || (remoteMatchesAnyLocalTitle(localTitleCandidates, omdbBySearch?.Title) ? omdbBySearch : null);
    const matchedAniListMeta = remoteMatchesAnyLocalTitle(localTitleCandidates, anilistMeta?.title)
      || anilistMeta?.aliases?.some((alias) => remoteMatchesAnyLocalTitle(localTitleCandidates, alias))
      ? anilistMeta
      : null;
    const matchedJikanMeta = remoteMatchesAnyLocalTitle(localTitleCandidates, jikanMeta?.title) ? jikanMeta : null;
    const localAndAnimeAliasTitles = uniqueLocalTitles([
      ...localTitleCandidates,
      ...(matchedAniListMeta?.aliases || []),
      matchedAniListMeta?.title,
      ...(matchedJikanMeta?.aliases || []),
      matchedJikanMeta?.title,
    ]);
    const matchedTmdbTVMeta = [tmdbTVById, tmdbTVBySearch]
      .find((data) => remoteMatchesAnyLocalTitle(localAndAnimeAliasTitles, data?.title)) || null;
    const matchedTVDBMeta = [tvdbById, tvdbBySearch]
      .find((data) => remoteMatchesAnyLocalTitle(localAndAnimeAliasTitles, data?.title)) || null;
    const matchedTVMeta = remoteMatchesAnyLocalTitle(localAndAnimeAliasTitles, tvMeta?.title) ? tvMeta : null;

    // Resolve the canonical title (prefer API-confirmed names)
    const resolvedTitle = searchTitle || parsedFile.title;

    const finalType: 'movie' | 'tv' | 'anime' = forcedType
      ?? (isAnimeMetadata(fullPath, resolvedTitle, matchedOmdbData, null)
        ? 'anime'
        : isSeriesMetadata(matchedOmdbData, null)
          ? 'tv'
          : 'movie');
    const isAnimeMovie = finalType === 'anime' && (
      (matchedAniListMeta?.format || matchedJikanMeta?.format)?.trim().toUpperCase() === 'MOVIE'
      || matchedOmdbData?.Type?.trim().toLowerCase() === 'movie'
    );
    const useMovieMetadata = finalType === 'movie' || isAnimeMovie;
    const useShowMetadata = finalType === 'tv' || (finalType === 'anime' && !isAnimeMovie);

    // Posters can fall through to embedded/generated thumbnails. Backdrops stay
    // limited to true local/API cover art; the renderer falls back to poster art.
    const localThumbnail = getLocalThumbnailUrl(fullPath);
    const localPoster = getLocalMovieArtworkUrl(fullPath, 'poster');
    const embeddedPoster = getEmbeddedArtworkUrl(fullPath, probe);
    const localBackdrop = getLocalMovieArtworkUrl(fullPath, 'backdrop');
    const omdbPoster = matchedOmdbData?.Poster && matchedOmdbData.Poster !== 'N/A' ? matchedOmdbData.Poster : '';
    const preferOmdbFallback = Boolean(tmdbApiKey?.trim());
    const defaultTVPoster = preferOmdbFallback
      ? omdbPoster || matchedTVMeta?.poster || matchedTVDBMeta?.poster
      : matchedTVMeta?.poster || omdbPoster || matchedTVDBMeta?.poster;
    const officialMoviePoster = matchedTmdbData?.poster
      || (isAnimeMovie ? matchedAniListMeta?.poster || matchedJikanMeta?.poster : '')
      || omdbPoster;
    const officialShowPoster =
      (finalType === 'anime' ? (matchedAniListMeta?.poster || matchedJikanMeta?.poster || '') : '')
      || matchedTmdbTVMeta?.poster
      || defaultTVPoster
      || matchedTVDBMeta?.poster;
    const officialPoster = useMovieMetadata ? officialMoviePoster : officialShowPoster;
    const officialMovieBackdrop = matchedTmdbData?.backdrop || '';
    const officialShowBackdrop =
      (finalType === 'anime' ? (matchedAniListMeta?.backdrop || '') : '')
      || matchedTmdbTVMeta?.backdrop
      || (finalType === 'anime' ? (matchedJikanMeta?.backdrop || '') : '')
      || matchedTVMeta?.backdrop
      || matchedTVDBMeta?.backdrop
      || '';
    const officialBackdrop = useMovieMetadata ? officialMovieBackdrop : officialShowBackdrop;
    const poster =
      localPoster
      || officialPoster
      || embeddedPoster
      || localThumbnail;
    const posterCandidates = orderedArtworkCandidates(
      localPoster,
      officialPoster,
      embeddedPoster,
      localThumbnail,
    );
    const backdrop =
      localBackdrop
      || officialBackdrop;
    const backdropCandidates = orderedArtworkCandidates(
      localBackdrop,
      officialBackdrop,
    );
    const fanartLogoCandidates = useShowMetadata
      ? await fetchFanartTVLogos(matchedTmdbTVMeta?.providerIds?.tvdbId || matchedTVDBMeta?.providerIds?.tvdbId || matchedTVMeta?.providerIds?.tvdbId || providerIds.tvdbId, fanartApiKey)
      : await fetchFanartMovieLogos(matchedTmdbData?.providerIds?.tmdbId || providerIds.tmdbId, fanartApiKey);
    const logoCandidates = orderedArtworkCandidates(
      useShowMetadata ? matchedTmdbTVMeta?.logo : matchedTmdbData?.logo,
      ...officialArtworkOnly((useShowMetadata ? matchedTmdbTVMeta?.logoCandidates : matchedTmdbData?.logoCandidates) || []),
      ...fanartLogoCandidates,
      useShowMetadata ? matchedTVDBMeta?.logo : '',
      ...(useShowMetadata ? officialArtworkOnly(matchedTVDBMeta?.logoCandidates || []) : []),
    );
    const logo = logoCandidates[0] || '';

    const defaultTVSummary = preferOmdbFallback
      ? matchedOmdbData?.Plot || matchedTVMeta?.summary || matchedTVDBMeta?.summary
      : matchedTVMeta?.summary || matchedOmdbData?.Plot || matchedTVDBMeta?.summary;
    const summary =
      (finalType === 'anime'
        ? (matchedAniListMeta?.summary || matchedJikanMeta?.summary || '')
        : useMovieMetadata ? matchedTmdbData?.summary : matchedTmdbTVMeta?.summary || defaultTVSummary)
      || probe.summary
      || matchedTmdbTVMeta?.summary
      || matchedTVDBMeta?.summary
      || defaultTVSummary
      || matchedTmdbData?.summary
      || '';
    const rating = finalType === 'movie'
      ? movieMetadataRating(matchedTmdbData, matchedOmdbData, matchedTVMeta)
      : numericRating(matchedTmdbTVMeta?.rating)
        || (finalType === 'anime' ? numericRating(matchedAniListMeta?.rating) : 0)
        || showMetadataRating(finalType, matchedJikanMeta, matchedTmdbTVMeta, matchedTVMeta, matchedOmdbData, preferOmdbFallback);
    const defaultTVGenres = preferOmdbFallback
      ? (matchedOmdbData?.Genre ? matchedOmdbData.Genre.split(', ') : matchedTVMeta?.genres)
      : (matchedTVMeta?.genres ?? (matchedOmdbData?.Genre ? matchedOmdbData.Genre.split(', ') : undefined));
    const genres: string[] =
      (finalType === 'anime' ? matchedAniListMeta?.genres || matchedJikanMeta?.genres : null)
      ?? matchedTmdbTVMeta?.genres
      ?? defaultTVGenres
      ?? matchedTVDBMeta?.genres
      ?? matchedTmdbData?.genres
      ?? [];
    const rawCast = [
      finalType === 'anime' ? matchedAniListMeta?.cast || matchedJikanMeta?.cast : null,
      matchedTmdbTVMeta?.cast,
      matchedTVMeta?.cast,
      matchedTVDBMeta?.cast,
      matchedTmdbData?.cast,
    ].find((entries) => Boolean(entries?.length)) || [];
    const cast = finalType === 'anime' ? normalizeAnimeCast(rawCast) : rawCast;
    const resolvedYear =
      searchYear
      || (finalType === 'anime' ? (matchedAniListMeta?.year || matchedJikanMeta?.year || 0) : 0)
      || (matchedTmdbTVMeta?.year ?? 0)
      || (matchedTVMeta?.year ?? 0)
      || (matchedTVDBMeta?.year ?? 0)
      || matchedTmdbData?.year
      || (matchedOmdbData?.Year ? parseInt(matchedOmdbData.Year, 10) : 0)
      || parsedFile.year;

    const baseItem: MediaItem = {
      id: createMediaItemId(fullPath),
      type: finalType,
      format: finalType === 'anime'
        ? (matchedAniListMeta?.format || matchedJikanMeta?.format || (isAnimeMovie ? 'Movie' : 'TV'))
        : finalType === 'tv' ? 'TV' : 'Movie',
      title: resolvedTitle,
      year: resolvedYear,
      poster,
      backdrop,
      logo,
      posterCandidates,
      backdropCandidates,
      logoCandidates,
      summary,
      rating,
      runtime: finalType === 'movie'
        ? matchedTmdbData?.runtime
        : matchedTmdbTVMeta?.runtime,
      seasonCount: finalType === 'movie' ? undefined : matchedTmdbTVMeta?.seasonCount || matchedTVDBMeta?.seasonCount,
      episodeCount: finalType === 'movie' ? undefined : matchedTmdbTVMeta?.episodeCount || matchedTVDBMeta?.episodeCount,
      trailerUrl: finalType === 'movie' ? matchedTmdbData?.trailerUrl : matchedTmdbTVMeta?.trailerUrl,
      providerRatings: omdbProviderRatings(matchedOmdbData),
      contentRatings: mergeContentRatings(
        useMovieMetadata ? matchedTmdbData?.contentRatings : undefined,
        useShowMetadata ? matchedTmdbTVMeta?.contentRatings : undefined,
        omdbContentRatings(matchedOmdbData),
        finalType === 'anime' ? matchedJikanMeta?.contentRatings : undefined,
      ),
      streamingProviders: (useShowMetadata
        ? matchedTmdbTVMeta?.streamingProviders
        : matchedTmdbData?.streamingProviders) || [],
      originPlatform: useShowMetadata ? matchedTVMeta?.originPlatform : undefined,
      genres,
      cast,
      filePath: fullPath,
      fileSize: stats.size,
      subtitles,
      localMetadata: probe.localMetadata,
      providerIds: mergeProviderIds(
        providerIds,
        matchedTmdbData?.providerIds || {},
        matchedTmdbTVMeta?.providerIds || {},
        matchedTVMeta?.providerIds || {},
        matchedTVDBMeta?.providerIds || {},
        finalType === 'anime' && (matchedAniListMeta?.malId || matchedJikanMeta?.malId) ? {
          malId: String(matchedAniListMeta?.malId || matchedJikanMeta?.malId),
          malIdBySeason: { '1': String(matchedAniListMeta?.malId || matchedJikanMeta?.malId) },
        } : {},
      ),
    };

    if (finalType === 'anime' || finalType === 'tv') {
      const remoteEpisodes: EpisodeMeta[] =
        matchedTVMeta?.episodes
        ?? matchedTVDBMeta?.episodes
        ?? (finalType === 'anime' ? matchedJikanMeta?.episodes : null)
        ?? matchedTmdbTVMeta?.episodes
        ?? [];
      const remoteSeasons = mergeOfficialSeasonMetadata(
        matchedTmdbTVMeta?.tmdbSeasons,
        matchedTVMeta?.seasons,
        matchedTVDBMeta?.seasons,
      );
      const seasons = mergeLocalSeasonsWithMetadata(
        [{ number: 1, title: 'Season 1', episodeCount: 1 }],
        remoteSeasons,
      );
      const episodeStill = remoteEpisodes.find((episode) => Boolean(episode.still))?.still || officialBackdrop || embeddedPoster || localThumbnail;
      const firstRemoteEpisode = remoteEpisodes.find((episode) => episode.season === 1 && episode.number === 1) || remoteEpisodes[0];

      return {
        ...baseItem,
        seasons,
        episodes: [{
          season: 1, number: 1,
          title: firstRemoteEpisode?.title || resolvedTitle,
          summary: firstRemoteEpisode?.summary || summary,
          still: episodeStill,
          rating: firstRemoteEpisode?.rating || rating,
          airDate: firstRemoteEpisode?.airDate || '',
          localMetadata: probe.localMetadata,
        }],
        episodeFiles: [{
          season: 1,
          episode: 1,
          filePath: fullPath,
          title: firstRemoteEpisode?.title || resolvedTitle,
          localMetadata: probe.localMetadata,
        }],
      };
    }

    return baseItem;
  }

  return { buildMovieItemFromFile, buildTVItemFromFolder };
}
