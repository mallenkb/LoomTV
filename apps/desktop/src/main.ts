import {
  app,
  dialog,
  nativeImage,
  powerMonitor,
  protocol,
  net,
  session,
} from 'electron';
import type { OpenDialogOptions } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import squirrelStartup from 'electron-squirrel-startup';
import {
  LOCAL_ACCESS_HEADER,
  LOCAL_ACCESS_QUERY_PARAM,
  allowedCorsOrigin,
  createLocalAccessToken,
  localAccessQuery,
} from './main/serverSecurity';
import {
  destroyLanDiscovery,
  discoverLanPeers,
} from './main/lanDiscovery';
import { findFFmpeg } from './main/mediaBinaries';
import {
  assertLocalMediaPath,
  canDirectPlay,
  probeMedia,
} from './main/mediaProbe';
import type { ApiResult } from './main/mediaTypes';
import {
  cleanupOldTranscodes,
  startTranscode,
  stopAllTranscodes,
  stopTranscode,
} from './main/transcodeManager';
import { probeMediaFile } from './main/mediaProbeFile';
import { decodeDataUrl, readJsonBody, safeEndResponse, writeJson } from './main/httpResponses';
import { browserPlaybackPlan, needsBrowserTranscoding } from './main/transcodeDecision';
import { createLanSecurity } from './main/lanSecurity';
import { getMetadataApiKey, loadSettings, saveSettings } from './main/settings';
import { createArtworkUrls } from './main/artworkUrls';
import { registerResource } from './main/resourceRegistry';
import { isImageFileName, isMacSidecarFile, isVideoFileName } from './main/fileClassification';
import { createArtworkFinders } from './main/artworkFinders';
import {
  defaultLibraryFolderGroups,
  flattenLibraryFolders,
  getLibraryFolderStatus,
  libraryFolderStatusesFor,
  normalizeLibraryFolderGroups,
} from './main/libraryFolders';
import {
  fetchJikanEpisodesForLocalAnimeSeasons,
  isLikelyAnimePath,
} from './main/scanClassification';
import { registerIpcHandlers } from './main/ipcHandlers';
import { createWindow, getMainWindow, getWindowIconPath } from './main/windowManager';
import { createServerTray, destroyServerTray } from './main/serverTray';
import {
  getMediaServer,
  getMediaServerPort,
  getMediaServerSockets,
  setMediaServer,
  startMediaServer,
  type MediaServerDependencies,
} from './main/mediaServer';
import {
  buildUpdateMenu,
  checkForUpdates,
  clearUpdateQuitFallback,
  getUpdateState,
  initAutoUpdater,
  installDownloadedUpdate,
  isUpdateInstalling,
  startUpdateAdapter,
  stopUpdateCheckTimer,
} from './main/autoUpdater';
import { testMetadataKeys } from './main/metadataKeys';
import {
  downloadMissingOpenSubtitlesForFolder,
  openSubtitlesCacheKey,
  openSubtitlesIsConfigured,
} from './main/openSubtitles';
import {
  createLibraryDeliveryProjections,
  stripInlineArtworkFromLibrary,
} from './main/libraryProjections';
import {
  cachedItemsAreComplete,
  createMediaItemId,
} from './main/libraryItemHelpers';
import {
  mergeProviderIds,
} from './main/mediaTags';
import {
  getLocalNetworkAddresses,
  getLocalNetworkNameFast,
} from './main/networkInfo';
import { closeServerForUpdateInstall } from './main/updateInstall';
import {
  backupDatabase,
  cacheLibraryArtwork,
  clearDatabase,
  cancelSegmentAnalysisJobs,
  cleanupOrphanedAutomaticSegments,
  cleanupOrphanedAnalysisData,
  enqueueSegmentAnalysisJob,
  fingerprintCacheBytes,
  fingerprintCount,
  getSegmentAnalysisInventory,
  getSegmentAnalysisJobCounts,
  getSegmentAnalysisJobs,
  getAllProgress,
  getManagedSegmentCandidates,
  getPlaybackTrackPreferences,
  getProgress,
  importCustomArtwork,
  importProgress,
  eraseAutomaticSegmentCandidates,
  loadLibraryFromDatabase,
  saveCustomArtwork,
  saveLibraryToDatabase,
  savePlaybackTrackPreferences,
  saveProgress,
  saveSegmentAnalysisInventory,
  updateSegmentAnalysisJob,
  updateSegmentCandidate,
  recoverRunningSegmentAnalysisJobs,
  requeueWaitingSegmentAnalysisJobs,
  resetAutomaticAnalysisData,
} from './main/database';
import {
  cleanMediaTitle,
  isGenericGroupingFolderTitle,
} from './main/metadata/helpers';
import type {
  EpisodeFile as MetadataEpisodeFile,
  EpisodeMeta as MetadataEpisodeMeta,
  MediaItem as MetadataMediaItem,
} from './main/metadata/types';
import { fetchOMDbMetadata, fetchOMDbMetadataById } from './main/metadata/omdb';
import { fetchTVMetadata, fetchTVMetadataCandidates } from './main/metadata/tvmaze';
import {
  fetchTMDBMovieMetadata,
  fetchTMDBMovieMetadataById,
  fetchTMDBMovieMetadataCandidates,
  fetchTMDBTVMetadata,
  fetchTMDBTVMetadataById,
  fetchTMDBTVMetadataCandidates,
} from './main/metadata/tmdb';
import {
  fetchJikanMetadata,
  fetchJikanMetadataCandidates,
} from './main/metadata/jikan';
import { fetchFanartMovieLogos, fetchFanartTVLogos } from './main/metadata/fanart';
import { createSkipSegmentService } from './main/skipSegments/service';
import { createLocalSegmentAnalysis } from './main/skipSegments/localAnalysis';
import { createAnalysisCoordinator } from './main/skipSegments/analysisCoordinator';
import { setPlaybackActivityLease } from './main/ffmpegGovernor';
import {
  createLibraryScanFiles,
  getLibraryFolderSignature,
} from './main/libraryScanFiles';
import {
  createLibraryScanner,
  type ScanContext,
} from './main/libraryScanner';
import { createMetadataItemBuilders } from './main/metadataItemBuilders.ts';
import {
  createOfficialMetadataService,
} from './main/officialMetadataService.ts';
import type {
  AppSettings,
  LibraryData,
  LibraryFolderKind,
  LibraryFolderStatus,
  LibraryScanCache,
  LibraryScanMode,
  LibraryScanProgress,
  ScanCacheFolderKind,
} from './main/appContracts.ts';
export type {
  AppSettings,
  LanPairedDevice,
  LibraryData,
  LibraryFolderGroups,
  LibraryFolderKind,
} from './main/appContracts.ts';
export type { OfficialMetadataCandidate } from './main/officialMetadataService.ts';

type EpisodeMeta = MetadataEpisodeMeta;
type EpisodeFile = MetadataEpisodeFile;
type MediaItem = MetadataMediaItem;

const { extractSeasons, scanEpisodeFiles } = createLibraryScanFiles(probeMediaFile);

function ignoreBrokenConsolePipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

ignoreBrokenConsolePipe(process.stdout);
ignoreBrokenConsolePipe(process.stderr);

if (squirrelStartup) app.quit();

// Enable hardware HEVC (H.265) decoding — allows MKV/HEVC files to be
// remuxed instead of re-encoded, giving near-instant local playback.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,HardwareMediaKeyHandling,MediaFoundationH264Encoding');

// Avoid Chromium's zero-copy shared-image path, which can spam mailbox errors
// during video surface churn, without disabling the video compositor itself.
app.commandLine.appendSwitch('disable-zero-copy');

// Register privileged scheme BEFORE app ready — required for video streaming
protocol.registerSchemesAsPrivileged([
  { scheme: 'plexserver', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } },
]);

app.setName('Loom Media Server');
const USER_DATA_DIR = path.join(app.getPath('appData'), 'LoomTV');
app.setPath('userData', USER_DATA_DIR);

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

let isAppShuttingDown = false;

function showOpenFolderDialog(options: OpenDialogOptions) {
  const win = getMainWindow();
  return win
    ? dialog.showOpenDialog(win, options)
    : dialog.showOpenDialog(options);
}
const LIBRARY_FILE = path.join(app.getPath('userData'), 'library.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const SCAN_CACHE_VERSION = 9;
let libraryMutationVersion = 0;

const LOCAL_ACCESS_TOKEN = createLocalAccessToken();
const MAIN_WINDOW_DEV_SERVER_URL =
  typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;
const ALLOWED_CORS_ORIGINS = new Set<string>(
  [MAIN_WINDOW_DEV_SERVER_URL ? new URL(MAIN_WINDOW_DEV_SERVER_URL).origin : ''].filter(Boolean),
);

const {
  isLoopbackRequest,
  getLanServerBase,
  isLanSharingEnabled,
  getLanShareToken,
  buildSignedLanUrl,
  isSignedLanRequestValid,
  authorizeLanRequest,
  authorizeLocalRequest,
  requireLocalOrLanAccess,
  requireStreamAccess,
  requestToken,
  handleLanPairRequest,
  handleLanRefreshRequest,
  libraryEtagFor,
  syncLanAdvertisement,
} = createLanSecurity({
  loadSettings,
  saveSettings,
  localAccessToken: LOCAL_ACCESS_TOKEN,
  libraryForLocalNetwork,
});

const {
  getLocalImageUrl,
  getLocalThumbnailUrl,
  getRemoteThumbnailUrl,
  getEmbeddedThumbnailUrl,
  isExternalArtworkUrl,
  artworkDeliveryUrl,
  remoteArtworkDeliveryUrl,
  artworkDeliveryUrls,
  customArtworkForRenderer,
  subtitleRecordsForRenderer,
  subtitleRecordsForLocalNetwork,
  orderedArtworkCandidates,
} = createArtworkUrls({
  localAccessToken: LOCAL_ACCESS_TOKEN,
  buildSignedLanUrl,
  registerRemoteResource: (kind, value) => registerResource(loadSettings().localNetworkHmacSecret || '', kind, value),
});

const {
  getLocalFolderArtworkUrl,
  getLocalMovieArtworkUrl,
  getEmbeddedArtworkUrl,
} = createArtworkFinders({
  getLocalImageUrl,
  getEmbeddedThumbnailUrl,
});

const {
  libraryForLocalNetwork: projectLibraryForLocalNetwork,
  libraryForRenderer: projectLibraryForRenderer,
} = createLibraryDeliveryProjections({
  artworkDeliveryUrl,
  artworkDeliveryUrls,
  flattenLibraryFolders,
  getRemoteThumbnailUrl,
  libraryFolderStatusesFor,
  localMetadataWithTracks,
  normalizeLibraryFolderGroups,
  remoteArtworkDeliveryUrl,
  signedStreamUrlForRemote,
  subtitleRecordsForLocalNetwork,
  subtitleRecordsForRenderer,
});

async function safeResult<T>(fn: () => T | Promise<T>): Promise<ApiResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function clearAppData(): LibraryData {
  clearDatabase();
  for (const filePath of [LIBRARY_FILE, SETTINGS_FILE]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      console.warn(`[data] Failed to remove legacy file ${filePath}:`, error);
    }
  }
  libraryMutationVersion++;
  return loadLibrary();
}

function shouldSplitContainerFolder(folderPath: string, folderName: string, subDirs: fs.Dirent[]): boolean {
  const episodeBearingDirs = subDirs.filter((dir) => {
    try {
      return scanEpisodeFiles(path.join(folderPath, dir.name)).length > 0;
    } catch {
      return false;
    }
  });

  if (episodeBearingDirs.length === 0) return false;

  const showLikeDirs = episodeBearingDirs.filter((dir) => !isGenericGroupingFolderTitle(dir.name));
  return showLikeDirs.length > 0 || (episodeBearingDirs.length > 1 && isGenericGroupingFolderTitle(folderName));
}


function libraryFolderKindForScanKind(folderKind: ScanCacheFolderKind): LibraryFolderKind {
  if (folderKind === 'tv') return 'tvShows';
  if (folderKind === 'anime') return 'anime';
  if (folderKind === 'auto') return 'others';
  return 'movies';
}

// ─── HTTP Media Server ────────────────────────────────────────────────────────


// ─── Library scanning ─────────────────────────────────────────────────────────


const { buildMovieItemFromFile, buildTVItemFromFolder } = createMetadataItemBuilders({
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
});
const { scanDirectoryAsItem, scanFolder } = createLibraryScanner({
  buildMovieItemFromFile,
  buildTVItemFromFolder,
  probeMediaFile,
  scanEpisodeFiles,
  shouldSplitContainerFolder,
});

function episodeKey(episode: Pick<EpisodeMeta, 'season' | 'number'>): string {
  return `${episode.season}-${episode.number}`;
}

function episodeFileKey(episodeFile: Pick<EpisodeFile, 'season' | 'episode'>): string {
  return `${episodeFile.season}-${episodeFile.episode}`;
}

function preserveExistingItemDuringScan(fresh: MediaItem, existing?: MediaItem): MediaItem {
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
  const episodes = new Map<string, EpisodeMeta>();
  for (const episode of existing.episodes || []) {
    const key = episodeKey(episode);
    if (localEpisodeKeys.size === 0 || localEpisodeKeys.has(key)) episodes.set(key, episode);
  }
  for (const episode of fresh.episodes || []) {
    const key = episodeKey(episode);
    if (!episodes.has(key) && (localEpisodeKeys.size === 0 || localEpisodeKeys.has(key))) {
      episodes.set(key, episode);
    }
  }

  const seasonCounts = new Map<number, number>();
  for (const episodeFile of episodeFiles.values()) {
    seasonCounts.set(episodeFile.season, (seasonCounts.get(episodeFile.season) || 0) + 1);
  }
  const seasons = new Map<number, NonNullable<MediaItem['seasons']>[number]>();
  for (const season of existing.seasons || []) {
    if (seasonCounts.has(season.number)) seasons.set(season.number, season);
  }
  for (const season of fresh.seasons || []) {
    if (!seasons.has(season.number)) seasons.set(season.number, season);
  }
  for (const [number, count] of seasonCounts) {
    const season = seasons.get(number);
    seasons.set(number, {
      number,
      title: season?.title || `Season ${String(number).padStart(2, '0')}`,
      episodeCount: count,
    });
  }

  // A scan owns filesystem-derived fields, but an existing library record owns
  // its chosen metadata and artwork. In particular, keep the complete artwork
  // candidate lists so cache pruning cannot discard a user's selected image.
  return {
    ...fresh,
    title: existing.title || fresh.title,
    year: existing.year || fresh.year,
    poster: existing.poster || fresh.poster,
    backdrop: existing.backdrop || fresh.backdrop,
    logo: existing.logo || fresh.logo,
    posterCandidates: existing.posterCandidates?.length ? existing.posterCandidates : fresh.posterCandidates,
    backdropCandidates: existing.backdropCandidates?.length ? existing.backdropCandidates : fresh.backdropCandidates,
    logoCandidates: existing.logoCandidates?.length ? existing.logoCandidates : fresh.logoCandidates,
    summary: existing.summary || fresh.summary,
    rating: existing.rating || fresh.rating,
    genres: existing.genres?.length ? existing.genres : fresh.genres,
    cast: existing.cast?.length ? existing.cast : fresh.cast,
    providerIds: mergeProviderIds(existing.providerIds || {}, fresh.providerIds || {}),
    lastPlayed: existing.lastPlayed || fresh.lastPlayed,
    seasons: seasons.size > 0
      ? [...seasons.values()].sort((a, b) => a.number - b.number)
      : fresh.seasons,
    episodes: episodes.size > 0
      ? [...episodes.values()].sort((a, b) => a.season - b.season || a.number - b.number)
      : fresh.episodes,
    episodeFiles: episodeFiles.size > 0
      ? [...episodeFiles.values()].sort((a, b) => a.season - b.season || a.episode - b.episode)
      : fresh.episodeFiles,
  };
}

async function scanLibrary(
  data: LibraryData,
  options: { force?: boolean; mode?: LibraryScanMode; onProgress?: (snapshot: LibraryScanProgress) => void | Promise<void> } = {},
): Promise<LibraryData> {
  const mode: LibraryScanMode = options.force ? 'full' : options.mode || 'quick';
  const settings = loadSettings();
  const ctx: ScanContext = {
    omdbApiKey: getMetadataApiKey(settings, 'omdb'),
    tmdbApiKey: getMetadataApiKey(settings, 'tmdb'),
    fanartApiKey: getMetadataApiKey(settings, 'fanart'),
    openSubtitles: {
      apiKey: getMetadataApiKey(settings, 'opensubtitles'),
      username: settings.openSubtitlesUsername,
      password: settings.openSubtitlesPassword,
      languages: settings.openSubtitlesLanguages,
      autoDownload: settings.openSubtitlesAutoDownload,
      userAgent: `Loom Media Server v${app.getVersion() || 'dev'}`,
    },
  };
  const subtitleProfile = openSubtitlesCacheKey(ctx.openSubtitles);
  const folderGroups = normalizeLibraryFolderGroups(data);
  const movies: MediaItem[] = [];
  const tvShows: MediaItem[] = [];
  const animeShows: MediaItem[] = [];
  const scannedItemIds = new Set<string>();
  const existingItems = [...(data.movies || []), ...(data.tvShows || []), ...(data.animeShows || [])];
  const existingItemsById = new Map(existingItems.map((item) => [item.id, item]));
  const existingItemsByPath = new Map(existingItems
    .filter((item) => item.filePath)
    .map((item) => [path.resolve(item.filePath), item]));
  const previousScanCache = data.scanCache || {};
  const nextScanCache: LibraryScanCache = {};
  const totalFolders = flattenLibraryFolders(folderGroups).length;
  const processedFolders = new Set<string>();
  const folderStatusesByPath = new Map<string, LibraryFolderStatus>();
  let scannedFolders = 0;

  const appendItem = (item: MediaItem, folderKind: ScanCacheFolderKind = 'auto') => {
    const type: MediaItem['type'] = folderKind === 'movies'
      ? 'movie'
      : folderKind === 'anime'
        ? 'anime'
        : folderKind === 'tv'
          ? 'tv'
          : item.type;
    const next = { ...item, type };
    const identity = next.id || (next.filePath ? createMediaItemId(next.filePath) : '');
    if (identity && scannedItemIds.has(identity)) return;
    if (identity) scannedItemIds.add(identity);
    if (type === 'anime') animeShows.push(next);
    else if (type === 'tv') tvShows.push(next);
    else movies.push(next);
  };

  const appendItems = (items: MediaItem[], folderKind: ScanCacheFolderKind) => {
    for (const item of items) appendItem(item, folderKind);
  };

  const folderStatusFor = (folder: string, folderKind: ScanCacheFolderKind): LibraryFolderStatus => {
    const existing = folderStatusesByPath.get(folder);
    if (existing) return existing;
    const status = getLibraryFolderStatus(folder, libraryFolderKindForScanKind(folderKind));
    folderStatusesByPath.set(folder, status);
    return status;
  };

  const folderStatusSnapshot = (): LibraryFolderStatus[] => [
    ...folderGroups.movies.map((folder) => folderStatusFor(folder, 'movies')),
    ...folderGroups.tvShows.map((folder) => folderStatusFor(folder, 'tv')),
    ...folderGroups.anime.map((folder) => folderStatusFor(folder, 'anime')),
    ...folderGroups.others.map((folder) => folderStatusFor(folder, 'auto')),
  ];

  const cachedItemsForFolder = (
    folder: string,
    folderKind: ScanCacheFolderKind,
    options: { preserveUnavailable?: boolean } = {},
  ): MediaItem[] => {
    const source = folderKind === 'auto'
      ? [...(data.movies || []), ...(data.tvShows || []), ...(data.animeShows || [])]
      : folderKind === 'movies'
        ? data.movies || []
        : folderKind === 'anime'
          ? data.animeShows || []
          : data.tvShows || [];

    if (options.preserveUnavailable) {
      return source.filter((item) => itemBelongsToFolder(item, folder));
    }

    return source
      .map(sanitizeStoredItem)
      .filter((item): item is MediaItem => Boolean(item))
      .filter((item) => itemBelongsToFolder(item, folder));
  };

  const mergeFreshWithCached = (freshItems: MediaItem[], cachedItems: MediaItem[], isComplete: boolean) => {
    if (isComplete) return freshItems;
    const freshIds = new Set(freshItems.map((item) => item.id));
    const processed = [...processedFolders];
    return [
      ...freshItems,
      ...cachedItems.filter((item) => (
        !freshIds.has(item.id)
        && !processed.some((folder) => itemBelongsToFolder(item, folder))
      )),
    ];
  };

  const currentLibrarySnapshot = (isComplete: boolean): LibraryScanProgress => ({
    movies: mergeFreshWithCached(movies, data.movies || [], isComplete),
    tvShows: mergeFreshWithCached(tvShows, data.tvShows || [], isComplete),
    animeShows: mergeFreshWithCached(animeShows, data.animeShows || [], isComplete),
    libraryFolders: flattenLibraryFolders(folderGroups),
    libraryFolderGroups: folderGroups,
    libraryFolderStatuses: folderStatusSnapshot(),
    scanCache: isComplete ? nextScanCache : {
      ...Object.fromEntries(
        Object.entries(previousScanCache).filter(([folder]) => !processedFolders.has(folder)),
      ),
      ...nextScanCache,
    },
    isComplete,
    scannedFolders,
    totalFolders,
  });

  const publishProgress = async (isComplete = false) => {
    if (!options.onProgress) return;
    await options.onProgress(currentLibrarySnapshot(isComplete));
  };

  const scanGroup = async (
    folders: string[],
    folderKind: ScanCacheFolderKind,
  ) => {
    for (const folder of folders) {
      const cachedItems = cachedItemsForFolder(folder, folderKind);
      const cachedItemsById = new Map(cachedItems.map((item) => [item.id, item]));
      const cachedItemsByPath = new Map(cachedItems
        .filter((item) => item.filePath)
        .map((item) => [path.resolve(item.filePath), item]));
      const preserveItems = (items: MediaItem[]) => mode === 'metadata'
        ? items
        : items.map((item) => preserveExistingItemDuringScan(
          item,
          existingItemsById.get(item.id)
            || (item.filePath ? existingItemsByPath.get(path.resolve(item.filePath)) : undefined)
            || cachedItemsById.get(item.id)
            || (item.filePath ? cachedItemsByPath.get(path.resolve(item.filePath)) : undefined),
        ));
      const folderStatus = folderStatusFor(folder, folderKind);
      if (folderStatus.state === 'unavailable') {
        const unavailableItems = cachedItemsForFolder(folder, folderKind, { preserveUnavailable: true });
        appendItems(unavailableItems, folderKind);
        if (previousScanCache[folder]) nextScanCache[folder] = previousScanCache[folder];
        processedFolders.add(folder);
        scannedFolders++;
        await publishProgress(false);
        continue;
      }

      const folderSignature = getLibraryFolderSignature(folder);
      const cachedEntry = previousScanCache[folder];

      if (
        mode !== 'full'
        && folderSignature
        && cachedEntry?.version === SCAN_CACHE_VERSION
        && cachedEntry?.folderKind === folderKind
        && cachedEntry.signature === folderSignature.signature
        && (cachedEntry.subtitleProfile || '') === subtitleProfile
      ) {
        const metadataIsFresh = mode !== 'metadata' || Date.now() - (cachedEntry.scannedAt || 0) < 7 * 24 * 60 * 60 * 1000;
        if (metadataIsFresh && cachedItems.length === cachedEntry.itemCount && cachedItemsAreComplete(cachedItems)) {
          appendItems(cachedItems, folderKind);
          nextScanCache[folder] = cachedEntry;
          processedFolders.add(folder);
          scannedFolders++;
          await publishProgress(false);
          continue;
        }
      }

      const folderCtx: ScanContext = folderKind === 'auto' ? { ...ctx } : { ...ctx, folderKind };
      const directItem = await scanDirectoryAsItem(folder, folderCtx);
      const items = directItem
        ? [directItem]
        : await scanFolder(folder, folderCtx, async (partialItems) => {
          appendItems(preserveItems(partialItems), folderKind);
          await publishProgress(false);
        });
      const uniqueItems = Array.from(new Map(items.map((item) => [item.id, item])).values());

      if (directItem) appendItems(preserveItems(uniqueItems), folderKind);
      if (folderSignature) {
        nextScanCache[folder] = {
          version: SCAN_CACHE_VERSION,
          folderKind,
          signature: folderSignature.signature,
          subtitleProfile,
          fileCount: folderSignature.fileCount,
          itemCount: uniqueItems.length,
          scannedAt: Date.now(),
        };
      }
      processedFolders.add(folder);
      scannedFolders++;
      await publishProgress(false);
    }
  };

  await scanGroup(folderGroups.movies, 'movies');
  await scanGroup(folderGroups.tvShows, 'tv');
  await scanGroup(folderGroups.anime, 'anime');
  await scanGroup(folderGroups.others, 'auto');

  const nextLibrary = {
    movies,
    tvShows,
    animeShows,
    libraryFolders: flattenLibraryFolders(folderGroups),
    libraryFolderGroups: folderGroups,
    libraryFolderStatuses: folderStatusSnapshot(),
    scanCache: nextScanCache,
  };
  await publishProgress(true);
  return nextLibrary;
}

// ─── Library persistence ──────────────────────────────────────────────────────

function localTitleFromPath(filePath?: string): string | null {
  if (!filePath) return null;
  const baseTitle = cleanMediaTitle(path.basename(filePath)).title;
  if (baseTitle && !isGenericGroupingFolderTitle(baseTitle)) return baseTitle;

  const parentTitle = cleanMediaTitle(path.basename(path.dirname(filePath))).title;
  if (parentTitle && !isGenericGroupingFolderTitle(parentTitle)) return parentTitle;
  return null;
}

function pathExists(candidatePath?: string): boolean {
  if (!candidatePath) return false;
  try {
    return fs.existsSync(candidatePath);
  } catch {
    return false;
  }
}

function isExistingMediaFile(candidatePath?: string): boolean {
  if (!candidatePath) return false;
  try {
    return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

function sanitizeStoredItem(item: MediaItem): MediaItem | null {
  if (item.filePath && isMacSidecarFile(path.basename(item.filePath))) return null;
  if (item.filePath && !pathExists(item.filePath)) return null;

  const episodeFiles = item.episodeFiles?.filter((episodeFile) =>
    !isMacSidecarFile(path.basename(episodeFile.filePath))
    && isExistingMediaFile(episodeFile.filePath),
  );

  const withStableIdentity = (next: MediaItem): MediaItem => {
    const localTitle = localTitleFromPath(next.filePath);
    return next.filePath
      ? { ...next, id: createMediaItemId(next.filePath), title: next.title || localTitle || '' }
      : next;
  };

  if (item.episodeFiles && (!episodeFiles || episodeFiles.length === 0)) return null;
  if (!episodeFiles && item.filePath && !isExistingMediaFile(item.filePath)) return null;
  if (!episodeFiles) return withStableIdentity(item);

  const episodeKeys = new Set(episodeFiles.map((episodeFile) => `${episodeFile.season}-${episodeFile.episode}`));
  const episodes = item.episodes?.filter((episode) => episodeKeys.has(`${episode.season}-${episode.number}`));
  const seasonCounts = new Map<number, number>();
  episodeFiles.forEach((episodeFile) => {
    seasonCounts.set(episodeFile.season, (seasonCounts.get(episodeFile.season) || 0) + 1);
  });

  const seasons = (item.seasons || [])
    .filter((season) => seasonCounts.has(season.number))
    .map((season) => ({ ...season, episodeCount: seasonCounts.get(season.number) || season.episodeCount }));

  return withStableIdentity({ ...item, episodeFiles, episodes, seasons });
}

function loadLibrary(): LibraryData {
  const databaseLibrary = loadLibraryFromDatabase();
  if (databaseLibrary) return databaseLibrary;

  try {
    if (fs.existsSync(LIBRARY_FILE)) {
      const data = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf-8'));
      const normalized: LibraryData = { animeShows: [], ...data };
      const hasExplicitFolderGroups = Boolean(data.libraryFolderGroups);
      normalized.libraryFolderGroups = normalizeLibraryFolderGroups(normalized);
      normalized.libraryFolders = flattenLibraryFolders(normalized.libraryFolderGroups);

      if (hasExplicitFolderGroups) {
        normalized.movies = (normalized.movies || [])
          .map(sanitizeStoredItem)
          .filter((item): item is MediaItem => Boolean(item))
          .map((item) => ({ ...item, type: 'movie' }));
        normalized.tvShows = (normalized.tvShows || [])
          .map(sanitizeStoredItem)
          .filter((item): item is MediaItem => Boolean(item))
          .map((item) => ({ ...item, type: 'tv' }));
        normalized.animeShows = (normalized.animeShows || [])
          .map(sanitizeStoredItem)
          .filter((item): item is MediaItem => Boolean(item))
          .map((item) => ({ ...item, type: 'anime' }));
        saveLibraryToDatabase(normalized);
        return loadLibraryFromDatabase() || normalized;
      }

      const existingAnimeShows = normalized.animeShows || [];
      normalized.animeShows = [];
      const stillMovies: MediaItem[] = [];
      for (const rawMovie of normalized.movies || []) {
        const movie = sanitizeStoredItem(rawMovie);
        if (!movie) continue;
        if (movie.type === 'anime' || isLikelyAnimePath(movie.filePath, movie.title)) {
          normalized.animeShows.push({ ...movie, type: 'anime' });
        } else if (movie.type === 'tv') {
          normalized.tvShows.push(movie);
        } else {
          stillMovies.push(movie);
        }
      }
      const stillSeries: MediaItem[] = [];
      for (const rawShow of normalized.tvShows || []) {
        const show = sanitizeStoredItem(rawShow);
        if (!show) continue;
        if (show.type === 'anime' || isLikelyAnimePath(show.filePath, show.title)) {
          normalized.animeShows.push({ ...show, type: 'anime' });
        } else {
          stillSeries.push(show);
        }
      }
      for (const rawAnimeShow of existingAnimeShows) {
        const animeShow = sanitizeStoredItem(rawAnimeShow);
        if (animeShow) normalized.animeShows.push({ ...animeShow, type: 'anime' });
      }
      normalized.movies = stillMovies;
      normalized.tvShows = stillSeries;
      saveLibraryToDatabase(normalized);
      return loadLibraryFromDatabase() || normalized;
    }
  } catch (e) {
    console.error('loadLibrary error:', e);
  }
  const libraryFolderGroups = defaultLibraryFolderGroups();
  return { movies: [], tvShows: [], animeShows: [], libraryFolders: [], libraryFolderGroups, libraryFolderStatuses: [], scanCache: {} };
}

function libraryForRenderer(data: LibraryData = loadLibrary()): LibraryData {
  return projectLibraryForRenderer(data);
}

function appendLocalAccessTokenToUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(LOCAL_ACCESS_QUERY_PARAM, LOCAL_ACCESS_TOKEN);
  return parsed.toString();
}

function signedStreamUrlForRemote(base: string, filePath: string): string {
  const resourceId = registerResource(loadSettings().localNetworkHmacSecret || '', 'media', filePath);
  return buildSignedLanUrl(base, '/stream', new URLSearchParams({ resourceId }));
}

function localMetadataWithTracks(filePath: string, metadata: MediaItem['localMetadata']): MediaItem['localMetadata'] {
  if (metadata?.tracks?.length) return metadata;
  if (!metadata?.audioTracks && !metadata?.subtitleTracks) return metadata;
  if (!fs.existsSync(filePath) || !isVideoFileName(filePath)) return metadata;

  try {
    return probeMediaFile(filePath).localMetadata || metadata;
  } catch {
    return metadata;
  }
}

function libraryForLocalNetwork(): LibraryData {
  const base = getLanServerBase() || `http://127.0.0.1:${getMediaServerPort()}`;
  const data = loadLibrary();
  return projectLibraryForLocalNetwork(data, base);
}

let artworkCacheQueue: Promise<void> = Promise.resolve();

async function cacheArtworkNow(data: LibraryData): Promise<void> {
  const snapshot = stripInlineArtworkFromLibrary(data);
  artworkCacheQueue = artworkCacheQueue
    .catch(() => undefined)
    .then(() => cacheLibraryArtwork(snapshot));
  await artworkCacheQueue;
}

function saveLibrary(data: LibraryData): boolean {
  try {
    const durableData = stripInlineArtworkFromLibrary(data);
    const libraryFolderGroups = normalizeLibraryFolderGroups(data);
    const activeFolders = new Set(flattenLibraryFolders(libraryFolderGroups));
    const scanCache = Object.fromEntries(
      Object.entries(durableData.scanCache || {}).filter(([folder]) => activeFolders.has(folder)),
    );
    saveLibraryToDatabase({
      ...durableData,
      libraryFolderGroups,
      libraryFolders: flattenLibraryFolders(libraryFolderGroups),
      scanCache,
    });
    return true;
  } catch (e) {
    console.error('saveLibrary error:', e);
    return false;
  }
}

function saveLibraryMutation(data: LibraryData): void {
  const previous = loadLibrary();
  libraryMutationVersion++;
  if (saveLibrary(data)) reconcileSkipAnalysisAfterScan(previous, data);
}

let warmSkipSegmentsAfterScan: (data: LibraryData) => void = () => undefined;
let reconcileSkipAnalysisAfterScan: (previous: LibraryData, next: LibraryData) => void = () => undefined;

function saveLibraryFromScan(data: LibraryData, scanVersion: number): boolean {
  if (scanVersion !== libraryMutationVersion) return false;
  const previous = loadLibrary();
  if (!saveLibrary(data)) return false;
  cleanupOrphanedAutomaticSegments();
  warmSkipSegmentsAfterScan(data);
  reconcileSkipAnalysisAfterScan(previous, data);
  return true;
}

const {
  applyOfficialMetadataCandidate,
  getOfficialMetadataCandidates,
  getPlaybackLogo,
  refreshOfficialArtwork,
} = createOfficialMetadataService({
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
});
function isPathInsideFolder(folderPath: string, candidatePath?: string): boolean {
  if (!candidatePath) return false;
  const relative = path.relative(path.resolve(folderPath), path.resolve(candidatePath));
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function itemBelongsToFolder(item: MediaItem, folderPath: string): boolean {
  return isPathInsideFolder(folderPath, item.filePath)
    || Boolean(item.episodeFiles?.some((episodeFile) => isPathInsideFolder(folderPath, episodeFile.filePath)));
}

function addFolderToLibrary(data: LibraryData, folderPath: string, kind: LibraryFolderKind): LibraryData {
  const libraryFolderGroups = normalizeLibraryFolderGroups(data);
  libraryFolderGroups.movies = libraryFolderGroups.movies.filter((folder) => folder !== folderPath);
  libraryFolderGroups.tvShows = libraryFolderGroups.tvShows.filter((folder) => folder !== folderPath);
  libraryFolderGroups.anime = libraryFolderGroups.anime.filter((folder) => folder !== folderPath);
  libraryFolderGroups.others = libraryFolderGroups.others.filter((folder) => folder !== folderPath);
  libraryFolderGroups[kind].push(folderPath);
  const scanCache = { ...(data.scanCache || {}) };
  delete scanCache[folderPath];
  return { ...data, libraryFolderGroups, libraryFolders: flattenLibraryFolders(libraryFolderGroups), scanCache };
}

function removeFolderFromLibrary(data: LibraryData, folderPath: string): LibraryData {
  const libraryFolderGroups = normalizeLibraryFolderGroups(data);
  libraryFolderGroups.movies = libraryFolderGroups.movies.filter((folder) => folder !== folderPath);
  libraryFolderGroups.tvShows = libraryFolderGroups.tvShows.filter((folder) => folder !== folderPath);
  libraryFolderGroups.anime = libraryFolderGroups.anime.filter((folder) => folder !== folderPath);
  libraryFolderGroups.others = libraryFolderGroups.others.filter((folder) => folder !== folderPath);
  const scanCache = { ...(data.scanCache || {}) };
  delete scanCache[folderPath];
  return {
    ...data,
    movies: (data.movies || []).filter((item) => !itemBelongsToFolder(item, folderPath)),
    tvShows: (data.tvShows || []).filter((item) => !itemBelongsToFolder(item, folderPath)),
    animeShows: (data.animeShows || []).filter((item) => !itemBelongsToFolder(item, folderPath)),
    libraryFolderGroups,
    libraryFolders: flattenLibraryFolders(libraryFolderGroups),
    scanCache,
  };
}

// ─── Window ───────────────────────────────────────────────────────────────────

function applyAppIcon() {
  const iconPath = getWindowIconPath();
  if (!iconPath) return;

  app.setName('Loom Media Server');

  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }
}

let rendererSecurityPolicyConfigured = false;

function configureRendererSecurityPolicy(): void {
  if (rendererSecurityPolicyConfigured) return;
  rendererSecurityPolicyConfigured = true;

  const scriptSrc = ["'self'", 'file:'];
  if (MAIN_WINDOW_DEV_SERVER_URL) {
    scriptSrc.push("'unsafe-inline'", "'unsafe-eval'");
  }

  const connectSrc = [
    "'self'",
    'file:',
    'http://127.0.0.1:*',
    'http://localhost:*',
    'http://[::1]:*',
    'http://*:*',
    'https:',
    'plexserver:',
  ];
  if (MAIN_WINDOW_DEV_SERVER_URL) {
    connectSrc.push('ws://localhost:*', 'ws://127.0.0.1:*', 'ws://[::1]:*');
  }

  const csp = [
    "default-src 'self' file: data: blob:",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' file: 'unsafe-inline'",
    "img-src 'self' file: data: blob: http: https: plexserver:",
    "media-src 'self' file: blob: http://127.0.0.1:* http://localhost:* http://[::1]:* plexserver:",
    `connect-src ${connectSrc.join(' ')}`,
    "font-src 'self' file: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders || {}) };
    responseHeaders['Content-Security-Policy'] = [csp];
    callback({ responseHeaders });
  });
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

const skipSegmentService = createSkipSegmentService({ loadLibrary, loadSettings, probeMediaFile });
const localSegmentAnalysis = createLocalSegmentAnalysis({ loadLibrary, loadSettings, probeMediaFile });
const analysisCoordinator = createAnalysisCoordinator({
  loadLibrary,
  loadSettings,
  detector: localSegmentAnalysis,
  repository: {
    cancelSegmentAnalysisJobs,
    cleanupOrphanedAnalysisData,
    enqueueSegmentAnalysisJob,
    fingerprintCacheBytes,
    fingerprintCount,
    getSegmentAnalysisInventory,
    getSegmentAnalysisJobCounts,
    getSegmentAnalysisJobs,
    recoverRunningSegmentAnalysisJobs,
    requeueWaitingSegmentAnalysisJobs,
    resetAutomaticAnalysisData,
    saveSegmentAnalysisInventory,
    updateSegmentAnalysisJob,
  },
  runtime: {
    isReady: () => app.isReady(),
    isOnBatteryPower: () => powerMonitor.isOnBatteryPower(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onAc: (listener) => { powerMonitor.on('on-ac', listener); },
    onBattery: (listener) => { powerMonitor.on('on-battery', listener); },
  },
});
warmSkipSegmentsAfterScan = (library) => skipSegmentService.warmLibrary(library);
reconcileSkipAnalysisAfterScan = analysisCoordinator.onLibrarySaved;

registerIpcHandlers<LibraryData, AppSettings>({
  getMediaServerPort: () => getMediaServerPort(),
  localAccessToken: LOCAL_ACCESS_TOKEN,
  showOpenFolderDialog,
  loadLibrary,
  libraryForRenderer,
  scanLibrary,
  saveLibraryFromScan,
  getLibraryMutationVersion: () => libraryMutationVersion,
  cacheArtworkNow,
  addFolderToLibrary,
  removeFolderFromLibrary,
  saveLibraryMutation,
  assertLocalMediaPath,
  needsBrowserTranscoding,
  browserPlaybackPlan,
  loadSettings,
  saveSettings,
  onSettingsSaved: analysisCoordinator.settingsChanged,
  syncLanAdvertisement,
  testMetadataKeys,
  getLanShareToken,
  getLanServerBase,
  isLanSharingEnabled,
  getLocalNetworkNameFast,
  getLocalNetworkAddresses,
  discoverLanPeers,
  getProgress,
  getAllProgress,
  saveProgress,
  importProgress,
  getPlaybackTrackPreferences,
  savePlaybackTrackPreferences: (scope, preferences) => savePlaybackTrackPreferences(scope, preferences as Parameters<typeof savePlaybackTrackPreferences>[1]),
  getMediaSegments: skipSegmentService.getSegments,
  saveManualMediaSegment: skipSegmentService.saveManualSegment,
  deleteManualMediaSegment: skipSegmentService.deleteManualSegment,
  undoManualMediaSegment: skipSegmentService.undoManualSegment,
  getManagedMediaSegments: (request) => getManagedSegmentCandidates(request?.mediaId, request?.season, request?.episode).map((candidate) => ({
    id: candidate.id,
    mediaId: candidate.mediaId,
    season: candidate.season,
    episode: candidate.episode,
    type: candidate.type,
    startMs: candidate.startMs,
    endMs: candidate.endMs,
    confidence: candidate.confidence,
    source: candidate.source,
    status: candidate.status,
    mediaDurationMs: candidate.mediaDurationMs,
    updatedAt: candidate.updatedAt,
    analysisMetadata: candidate.analysisMetadata,
  })),
  updateManagedMediaSegment: updateSegmentCandidate,
  eraseManagedMediaSegments: (request) => ({ removed: eraseAutomaticSegmentCandidates(request.mediaId, request.season, request.episode) }),
  setPlaybackActivityLease: (key, active, label) => {
    setPlaybackActivityLease(key, active, label);
    if (!active) void analysisCoordinator.tick();
  },
  getLocalSegmentAnalysisStatus: analysisCoordinator.status,
  analyzeLocalSegmentSeason: async (mediaId, season) => {
    analysisCoordinator.enqueueScope({ mediaId, season });
    return skipSegmentService.getSegments({ mediaId, season });
  },
  runLocalSegmentAnalysis: (scope) => ({ queued: analysisCoordinator.enqueueScope(scope) }),
  cancelLocalSegmentAnalysis: (request) => ({
    cancelled: request?.kind === 'manual'
      ? analysisCoordinator.cancelManual()
      : analysisCoordinator.cancel(request?.jobKey),
  }),
  pauseLocalSegmentAnalysis: () => { analysisCoordinator.pause(); return true; },
  resumeLocalSegmentAnalysis: () => { analysisCoordinator.resume(); return true; },
  cleanupLocalSegmentAnalysis: () => ({ queued: analysisCoordinator.cleanup() }),
  rebuildLocalSegmentAnalysis: analysisCoordinator.rebuild,
  customArtworkForRenderer,
  saveCustomArtwork,
  getOfficialMetadataCandidates,
  applyOfficialMetadataCandidate,
  refreshOfficialArtwork,
  getPlaybackLogo,
  importCustomArtwork,
  backupDatabase,
  clearAppData,
  getUpdateState,
  checkForUpdates,
  installDownloadedUpdate,
  findFFmpeg,
  safeResult,
  probeMedia,
  canDirectPlay,
  startTranscode,
  appendLocalAccessTokenToUrl,
  stopTranscode,
  isTrustedSender: (event) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) return false;
    try {
      const senderFrame = event.senderFrame;
      if (!senderFrame) return false;
      const senderUrl = new URL(senderFrame.url);
      const applicationUrl = new URL(window.webContents.getURL());
      if (applicationUrl.protocol === 'file:') {
        return senderUrl.protocol === 'file:' && senderUrl.pathname === applicationUrl.pathname;
      }
      return senderUrl.origin === applicationUrl.origin;
    } catch {
      return false;
    }
  },
});

// ── VideoPlayer uses HTML5 <video> + the HTTP media server directly.
// No player:* IPC handlers needed.

// ─── App lifecycle ────────────────────────────────────────────────────────────

export const mediaServerDeps = {
  ALLOWED_CORS_ORIGINS,
  LOCAL_ACCESS_HEADER,
  LOCAL_ACCESS_TOKEN,
  allowedCorsOrigin,
  authorizeLanRequest,
  authorizeLocalRequest,
  decodeDataUrl,
  getLanServerBase,
  getMediaSegments: skipSegmentService.getSegments,
  handleLanPairRequest,
  handleLanRefreshRequest,
  isExternalArtworkUrl,
  isImageFileName,
  isLanSharingEnabled,
  isLoopbackRequest,
  isSignedLanRequestValid,
  libraryEtagFor,
  libraryForLocalNetwork,
  loadLibrary,
  loadSettings,
  localAccessQuery,
  readJsonBody,
  requireLocalOrLanAccess,
  requireStreamAccess,
  requestToken,
  safeEndResponse,
  saveSettings,
  writeJson,
} satisfies MediaServerDependencies;

app.whenReady().then(async () => {
  applyAppIcon();
  cleanupOldTranscodes();
  await startMediaServer(mediaServerDeps);
  analysisCoordinator.start();
  skipSegmentService.warmLibrary(loadLibrary());
  syncLanAdvertisement();
  const trayIconPath = getWindowIconPath();
  if (trayIconPath) {
    createServerTray({
      iconPath: trayIconPath,
      onOpen: () => {
        if (isUpdateInstalling() || isAppShuttingDown) return;
        createWindow();
      },
      onQuit: () => app.quit(),
      port: getMediaServerPort(),
    });
  }
  initAutoUpdater({
    getMainWindow,
    closeMediaServer: async () => {
      const serverToClose = getMediaServer();
      setMediaServer(null);
      await closeServerForUpdateInstall(serverToClose, getMediaServerSockets());
    },
  });
  buildUpdateMenu();

  // ── plexserver:// protocol handler ──────────────────────────────────────────
  // Translates plexserver://localhost/<path>?<query> → http://127.0.0.1:<port>/<path>?<query>
  // This bypasses Electron's URL safety check that blocks http:// sources in
  // <video> / <audio> elements while still streaming from our local HTTP server.
  protocol.handle('plexserver', async (request: Request) => {
    try {
      const parsed = new URL(request.url);
      parsed.searchParams.set(LOCAL_ACCESS_QUERY_PARAM, LOCAL_ACCESS_TOKEN);
      const targetUrl = `http://127.0.0.1:${getMediaServerPort()}${parsed.pathname}${parsed.search}`;

      // Forward Range header so video seeking works correctly
      const headers: Record<string, string> = {};
      const range = request.headers.get('Range');
      if (range) headers['Range'] = range;

      const response = await net.fetch(targetUrl, { headers });
      return response;
    } catch (err) {
      console.error('[plexserver protocol] fetch error:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  });

  configureRendererSecurityPolicy();
  createWindow();
  startUpdateAdapter();
}).catch((error) => {
  console.error('Failed to start Loom Media Server:', error);
  app.quit();
});

app.on('second-instance', () => {
  if (isUpdateInstalling()) return;
  if (!app.isReady()) return;
  if (isAppShuttingDown) return;
  createWindow();
});

app.on('window-all-closed', () => {
  // Closing the UI enters lightweight host mode. The renderer is destroyed,
  // while the media server, LAN advertisement, sync, and mobile playback stay
  // active until the user explicitly quits from the tray/application menu.
  if (isUpdateInstalling()) return;
  if (isAppShuttingDown) return;
  if (process.platform === 'darwin') app.dock?.hide();
});

app.on('activate', () => {
  if (isUpdateInstalling()) return;
  if (isAppShuttingDown) return;
  createWindow();
});

app.on('before-quit', () => {
  isAppShuttingDown = true;
  clearUpdateQuitFallback();
  destroyServerTray();
  destroyLanDiscovery();
  // Skip if quitAndInstall already drained these — re-running close() on a
  // null server can throw and abort the install path.
  if (!isUpdateInstalling()) {
    stopAllTranscodes();
  }
  stopUpdateCheckTimer();
  const serverToClose = getMediaServer();
  if (serverToClose) {
    try {
      serverToClose.close();
    } catch {
      // Ignore close errors during quit.
    }
    setMediaServer(null);
  }
});
