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
  mergeEpisodeMetadataSources,
  numericRating,
  remoteMatchesAnyLocalTitle,
  uniqueLocalTitles,
  usefulLocalTitle,
} from './metadata/helpers.ts';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './metadata/types.ts';
import type { OMDbResponse } from './metadata/omdb.ts';
import { mergeProviderIds, parseMetadataProviderIds } from './mediaTags.ts';
import {
  inferSeriesTitleFromEpisodeFiles,
  isAnimeMetadata,
  isLikelyAnimePath,
  isSeriesMetadata,
  mergeLocalSeasonsWithMetadata,
} from './scanClassification.ts';
import type { BuildMovieItemRequest, BuildTVItemRequest } from './libraryScanner.ts';
import type { ProbeMediaFileResult } from './mediaProbeFile.ts';

export type MetadataItemBuilderDependencies = {
  downloadMissingOpenSubtitlesForFolder: typeof import('./openSubtitles.ts').downloadMissingOpenSubtitlesForFolder;
  openSubtitlesIsConfigured: typeof import('./openSubtitles.ts').openSubtitlesIsConfigured;
  extractSeasons: (folderPath: string, folderName: string) => Array<{ number: number; title: string; episodeCount: number }>;
  scanEpisodeFiles: (folderPath: string) => EpisodeFile[];
  probeMediaFile: (filePath: string) => ProbeMediaFileResult;
  fetchJikanEpisodesForLocalAnimeSeasons: typeof import('./scanClassification.ts').fetchJikanEpisodesForLocalAnimeSeasons;
  fetchJikanMetadata: typeof import('./metadata/jikan.ts').fetchJikanMetadata;
  fetchOMDbMetadata: typeof import('./metadata/omdb.ts').fetchOMDbMetadata;
  fetchOMDbMetadataById: typeof import('./metadata/omdb.ts').fetchOMDbMetadataById;
  fetchTMDBMovieMetadata: typeof import('./metadata/tmdb.ts').fetchTMDBMovieMetadata;
  fetchTMDBMovieMetadataById: typeof import('./metadata/tmdb.ts').fetchTMDBMovieMetadataById;
  fetchTMDBTVMetadata: typeof import('./metadata/tmdb.ts').fetchTMDBTVMetadata;
  fetchTMDBTVMetadataById: typeof import('./metadata/tmdb.ts').fetchTMDBTVMetadataById;
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
    fetchTVMetadata,
    getEmbeddedArtworkUrl,
    getLocalFolderArtworkUrl,
    getLocalMovieArtworkUrl,
    getLocalThumbnailUrl,
    openSubtitlesIsConfigured,
    orderedArtworkCandidates,
    probeMediaFile,
    scanEpisodeFiles,
  } = deps;

  const makeLocalEpisodeMeta = (files: EpisodeFile[], seriesTitle?: string): EpisodeMeta[] => files.map((file) => {
    const fallback = path.basename(file.filePath, path.extname(file.filePath))
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `Episode ${file.episode}`;
    const resolvedTitle = !looksLikeLocalEpisodeFileTitle(file.title, seriesTitle) && file.title
      ? file.title
      : fallback;
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
  ): number => (type === 'anime' ? numericRating(jikanMeta?.rating) : 0)
    || numericRating(tmdbMeta?.rating)
    || numericRating(tvMeta?.rating)
    || numericRating(omdbMeta?.imdbRating);

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
    fanartApiKey,
    openSubtitles,
  }: BuildTVItemRequest): Promise<MediaItem | null> {
    if (openSubtitlesIsConfigured(openSubtitles)) {
      const results = await downloadMissingOpenSubtitlesForFolder(fullPath, openSubtitles);
      const failures = results.filter((result) => result.status === 'error');
      failures.forEach((result) => console.warn('[OpenSubtitles]', result.videoPath, result.message));
    }

    const localSeasons = extractSeasons(fullPath, entryName);
    const episodeFiles = scanEpisodeFiles(fullPath);
    const episodeProbes = episodeFiles.map((file) => probeMediaFile(file.filePath));
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
    // Anime   → Jikan (MAL) primary, TVmaze + TMDB + OMDb as fallbacks
    // TV show → TMDB primary, TVmaze as free fallback, OMDb for extra fields
    const [omdbById, omdbBySearch, jikanMeta, tmdbTVById, tmdbTVBySearch, tvMeta] = await Promise.all([
      providerIds.imdbId
        ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey)
        : Promise.resolve(null),
      fetchOMDbMetadata(searchTitle, searchYear, omdbApiKey),
      likelyAnime ? fetchJikanMetadata(searchTitle) : Promise.resolve(null),
      providerIds.tmdbId
        ? fetchTMDBTVMetadataById(providerIds.tmdbId, tmdbApiKey)
        : Promise.resolve(null),
      fetchTMDBTVMetadata(searchTitle, searchYear, tmdbApiKey),
      // TVmaze often has cleaner named episode lists, including anime seasons.
      fetchTVMetadata(searchTitle, searchYear),
    ]);
    const matchedOmdbData = [omdbById, omdbBySearch]
      .find((data) => remoteMatchesAnyLocalTitle(localTitleCandidates, data?.Title)) || null;
    const matchedJikanMeta = remoteMatchesAnyLocalTitle(localTitleCandidates, jikanMeta?.title) ? jikanMeta : null;
    const localAndAnimeAliasTitles = uniqueLocalTitles([
      ...localTitleCandidates,
      ...(matchedJikanMeta?.aliases || []),
      matchedJikanMeta?.title,
    ]);
    const matchedTmdbTVMeta = [tmdbTVById, tmdbTVBySearch]
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
    const officialPoster =
      (finalType === 'anime' ? (matchedJikanMeta?.poster || '') : '')
      || matchedTmdbTVMeta?.poster
      || matchedTVMeta?.poster
      || omdbPoster;
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
      matchedTmdbTVMeta?.backdrop
      || (finalType === 'anime' ? (matchedJikanMeta?.backdrop || '') : '')
      || matchedTVMeta?.backdrop
      || '';
    const backdrop =
      localBackdrop
      || officialBackdrop;
    const backdropCandidates = orderedArtworkCandidates(
      localBackdrop,
      officialBackdrop,
    );
    const fanartLogoCandidates = await fetchFanartTVLogos(
      matchedTmdbTVMeta?.providerIds?.tvdbId || matchedTVMeta?.providerIds?.tvdbId || providerIds.tvdbId,
      fanartApiKey,
    );
    const logoCandidates = orderedArtworkCandidates(
      matchedTmdbTVMeta?.logo,
      ...officialArtworkOnly(matchedTmdbTVMeta?.logoCandidates || []),
      ...fanartLogoCandidates,
    );
    const logo = logoCandidates[0] || '';

    // ── Summary / rating / genres / cast ──────────────────────────────────────
    const summary =
      episodeProbes.find((probe) => probe.summary)?.summary
      || (finalType === 'anime' ? (matchedJikanMeta?.summary || '') : '')
      || matchedTmdbTVMeta?.summary
      || matchedTVMeta?.summary
      || matchedOmdbData?.Plot
      || '';

    const rating = showMetadataRating(finalType, matchedJikanMeta, matchedTmdbTVMeta, matchedTVMeta, matchedOmdbData);

    const genres: string[] =
      (finalType === 'anime' ? matchedJikanMeta?.genres : null)
      ?? matchedTmdbTVMeta?.genres
      ?? matchedTVMeta?.genres
      ?? (matchedOmdbData?.Genre ? matchedOmdbData.Genre.split(', ') : []);

    const cast =
      (finalType === 'anime' ? matchedJikanMeta?.cast : null)
      ?? matchedTmdbTVMeta?.cast
      ?? matchedTVMeta?.cast
      ?? [];

    const resolvedTitle =
      searchTitle
      || cleanTitle;

    const resolvedYear =
      searchYear
      || (matchedOmdbData?.Year ? parseInt(matchedOmdbData.Year, 10) : 0)
      || (finalType === 'anime' ? (matchedJikanMeta?.year ?? 0) : 0)
      || (matchedTmdbTVMeta?.year ?? 0)
      || (matchedTVMeta?.year ?? 0)
      || year;
    const jikanEpisodesForLocalSeasons = finalType === 'anime'
      ? await fetchJikanEpisodesForLocalAnimeSeasons(episodeFiles, searchTitle, matchedJikanMeta)
      : { episodes: [], malIdBySeason: {} };

    // ── Merge episode metadata onto local files ────────────────────────────────
    // Keep provider priority per field so anime can use TVmaze titles while Jikan
    // fills episode scores that TVmaze often leaves empty.
    const mergedEpisodes = mergeEpisodeMetadataSources(localEpisodes, [
      matchedTVMeta?.episodes,
      finalType === 'anime' && jikanEpisodesForLocalSeasons.episodes.length > 0 ? jikanEpisodesForLocalSeasons.episodes : null,
      matchedTmdbTVMeta?.episodes,
    ]);
    const mergedEpisodeTitleByKey = new Map(
      mergedEpisodes.map((episode) => [`${episode.season}-${episode.number}`, episode.title]),
    );
    const mergedEpisodeFiles = episodeFiles.map((file) => ({
      ...file,
      title: mergedEpisodeTitleByKey.get(`${file.season}-${file.episode}`) || file.title,
    }));

    const remoteSeasons = matchedTmdbTVMeta?.tmdbSeasons ?? matchedTVMeta?.seasons;
    const mergedSeasons = mergeLocalSeasonsWithMetadata(localSeasons, remoteSeasons);

    return {
      id,
      type: finalType,
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
        finalType === 'anime' ? {
          malId: matchedJikanMeta?.malId ? String(matchedJikanMeta.malId) : undefined,
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
    fanartApiKey,
    forcedType,
  }: BuildMovieItemRequest): Promise<MediaItem> {
    const parsedFile = cleanMediaTitle(fileName);
    const stats = fs.statSync(fullPath);
    const probe = probeMediaFile(fullPath);
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

    // Fetch provider metadata in parallel. Single files forced into TV/anime
    // library buckets must use show providers, not movie metadata, for artwork.
    const [tmdbById, tmdbBySearch, omdbById, omdbBySearch, jikanMeta, tmdbTVById, tmdbTVBySearch, tvMeta] = await Promise.all([
      !shouldUseShowProviders && providerIds.tmdbId
        ? fetchTMDBMovieMetadataById(providerIds.tmdbId, tmdbApiKey)
        : Promise.resolve(null),
      !shouldUseShowProviders
        ? fetchTMDBMovieMetadata(searchTitle, searchYear, tmdbApiKey)
        : Promise.resolve(null),
      providerIds.imdbId
        ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey)
        : Promise.resolve(null),
      fetchOMDbMetadata(searchTitle, searchYear, omdbApiKey),
      shouldUseShowProviders && likelyAnime ? fetchJikanMetadata(searchTitle) : Promise.resolve(null),
      shouldUseShowProviders && providerIds.tmdbId
        ? fetchTMDBTVMetadataById(providerIds.tmdbId, tmdbApiKey)
        : Promise.resolve(null),
      shouldUseShowProviders
        ? fetchTMDBTVMetadata(searchTitle, searchYear, tmdbApiKey)
        : Promise.resolve(null),
      shouldUseShowProviders ? fetchTVMetadata(searchTitle, searchYear) : Promise.resolve(null),
    ]);
    const matchedTmdbData = tmdbById || tmdbBySearch || null;
    const matchedOmdbData = omdbById || omdbBySearch || null;
    const matchedJikanMeta = remoteMatchesAnyLocalTitle(localTitleCandidates, jikanMeta?.title) ? jikanMeta : null;
    const localAndAnimeAliasTitles = uniqueLocalTitles([
      ...localTitleCandidates,
      ...(matchedJikanMeta?.aliases || []),
      matchedJikanMeta?.title,
    ]);
    const matchedTmdbTVMeta = [tmdbTVById, tmdbTVBySearch]
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

    // Posters can fall through to embedded/generated thumbnails. Backdrops stay
    // limited to true local/API cover art; the renderer falls back to poster art.
    const localThumbnail = getLocalThumbnailUrl(fullPath);
    const localPoster = getLocalMovieArtworkUrl(fullPath, 'poster');
    const embeddedPoster = getEmbeddedArtworkUrl(fullPath, probe);
    const localBackdrop = getLocalMovieArtworkUrl(fullPath, 'backdrop');
    const omdbPoster = matchedOmdbData?.Poster && matchedOmdbData.Poster !== 'N/A' ? matchedOmdbData.Poster : '';
    const officialMoviePoster = matchedTmdbData?.poster || omdbPoster;
    const officialShowPoster =
      (finalType === 'anime' ? (matchedJikanMeta?.poster || '') : '')
      || matchedTmdbTVMeta?.poster
      || matchedTVMeta?.poster
      || omdbPoster;
    const officialPoster = shouldUseShowProviders ? officialShowPoster : officialMoviePoster;
    const officialMovieBackdrop = matchedTmdbData?.backdrop || '';
    const officialShowBackdrop =
      matchedTmdbTVMeta?.backdrop
      || (finalType === 'anime' ? (matchedJikanMeta?.backdrop || '') : '')
      || matchedTVMeta?.backdrop
      || '';
    const officialBackdrop = shouldUseShowProviders ? officialShowBackdrop : officialMovieBackdrop;
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
    const fanartLogoCandidates = shouldUseShowProviders
      ? await fetchFanartTVLogos(matchedTmdbTVMeta?.providerIds?.tvdbId || matchedTVMeta?.providerIds?.tvdbId || providerIds.tvdbId, fanartApiKey)
      : await fetchFanartMovieLogos(matchedTmdbData?.providerIds?.tmdbId || providerIds.tmdbId, fanartApiKey);
    const logoCandidates = orderedArtworkCandidates(
      shouldUseShowProviders ? matchedTmdbTVMeta?.logo : matchedTmdbData?.logo,
      ...officialArtworkOnly((shouldUseShowProviders ? matchedTmdbTVMeta?.logoCandidates : matchedTmdbData?.logoCandidates) || []),
      ...fanartLogoCandidates,
    );
    const logo = logoCandidates[0] || '';

    const summary =
      probe.summary
      || (finalType === 'anime' ? (matchedJikanMeta?.summary || '') : '')
      || matchedTmdbTVMeta?.summary
      || matchedTVMeta?.summary
      || matchedTmdbData?.summary
      || matchedOmdbData?.Plot
      || '';
    const rating = finalType === 'movie'
      ? movieMetadataRating(matchedTmdbData, matchedOmdbData, matchedTVMeta)
      : showMetadataRating(finalType, matchedJikanMeta, matchedTmdbTVMeta, matchedTVMeta, matchedOmdbData);
    const genres: string[] =
      (finalType === 'anime' ? matchedJikanMeta?.genres : null)
      ?? matchedTmdbTVMeta?.genres
      ?? matchedTVMeta?.genres
      ?? matchedTmdbData?.genres
      ?? (matchedOmdbData?.Genre ? matchedOmdbData.Genre.split(', ') : []);
    const cast =
      (finalType === 'anime' ? matchedJikanMeta?.cast : null)
      ?? matchedTmdbTVMeta?.cast
      ?? matchedTVMeta?.cast
      ?? matchedTmdbData?.cast
      ?? [];
    const resolvedYear =
      searchYear
      || (finalType === 'anime' ? (matchedJikanMeta?.year ?? 0) : 0)
      || (matchedTmdbTVMeta?.year ?? 0)
      || (matchedTVMeta?.year ?? 0)
      || matchedTmdbData?.year
      || (matchedOmdbData?.Year ? parseInt(matchedOmdbData.Year, 10) : 0)
      || parsedFile.year;

    const baseItem: MediaItem = {
      id: createMediaItemId(fullPath),
      type: finalType,
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
        finalType === 'anime' && matchedJikanMeta?.malId ? {
          malId: String(matchedJikanMeta.malId),
          malIdBySeason: { '1': String(matchedJikanMeta.malId) },
        } : {},
      ),
    };

    if (finalType === 'anime' || finalType === 'tv') {
      const remoteEpisodes: EpisodeMeta[] =
        matchedTVMeta?.episodes
        ?? (finalType === 'anime' ? matchedJikanMeta?.episodes : null)
        ?? matchedTmdbTVMeta?.episodes
        ?? [];
      const remoteSeasons =
        matchedTmdbTVMeta?.tmdbSeasons
        ?? matchedTVMeta?.seasons
        ?? [{ number: 1, title: finalType === 'anime' ? 'Season 1' : 'Season 1', episodeCount: 1 }];
      const episodeStill = remoteEpisodes.find((episode) => Boolean(episode.still))?.still || officialBackdrop || embeddedPoster || localThumbnail;
      const firstRemoteEpisode = remoteEpisodes.find((episode) => episode.season === 1 && episode.number === 1) || remoteEpisodes[0];

      return {
        ...baseItem,
        seasons: remoteSeasons.length > 0 ? remoteSeasons : [{ number: 1, title: 'Season 1', episodeCount: 1 }],
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
