import {
  app,
  dialog,
  nativeImage,
  powerMonitor,
  protocol,
  net,
  session,
  shell,
} from 'electron';
import type { OpenDialogOptions } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import squirrelStartup from 'electron-squirrel-startup';
import {
  LOCAL_ACCESS_HEADER,
  LOCAL_ACCESS_QUERY_PARAM,
  allowedCorsOrigin,
  createLocalAccessToken,
  describeErrorForLog,
} from './main/serverSecurity';
import { isTrustedIpcSender } from './main/trustedIpcSender.ts';
import {
  destroyLanDiscovery,
  discoverLanPeers,
} from './main/lanDiscovery';
import { findFFmpeg, getTranscodeCapabilities } from './main/mediaBinaries';
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
  stopTranscodesForScope,
  stopTranscode,
} from './main/transcodeManager';
import { probeMediaFile, probeMediaFileAsync } from './main/mediaProbeFile';
import { decodeDataUrl, readJsonBody, safeEndResponse, writeJson } from './main/httpResponses';
import { parseRequiredJson, profileExportSchema } from './main/runtimeValidation.ts';
import { browserPlaybackPlan, needsBrowserTranscoding } from './main/transcodeDecision';
import { createLanSecurity, type LanPairingApprovalPrompt } from './main/lanSecurity';
import { isIpcOnlyHttpRoute } from './main/lanRoutePolicy';
import { isTrustedRendererHttpOrigin } from './main/rendererHttpAccess';
import { getMetadataApiKey, loadSettings, saveSettings } from './main/settings';
import { refreshNativePlaybackDisplaySleepTimeout } from './main/nativePlaybackPower';
import { createArtworkUrls } from './main/artworkUrls';
import {
  registerResource,
  setResourceRegistryCatalogGeneration,
} from './main/resourceRegistry';
import { isImageFileName, isMacSidecarFile, isSubtitleFileName, isVideoFileName } from './main/fileClassification';
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
import {
  createWindow,
  getMainWindow,
  getMainWindowIpcIdentity,
  getTrayIconPath,
  getWindowIconPath,
} from './main/windowManager';
import { stopAllMpvPlayback } from './main/mpvPlayback';
import { libVlcRuntimeSummary, stopAllLibVlcPlayback } from './main/libvlcPlayback';
import { createServerTray, destroyServerTray } from './main/serverTray';
import { createRemoteLibraryClient } from './main/remoteLibraryClient';
import {
  settingsForRenderer,
  settingsPreferencesForRenderer,
} from './main/rendererSettings';
import {
  getLanMediaServer,
  getLanMediaServerSockets,
  getMediaServer,
  getMediaServerPort,
  getMediaServerSockets,
  setLanMediaServer,
  setMediaServer,
  startMediaServer,
  type MediaServerDependencies,
} from './main/mediaServer';
import { loadOrCreateLanTlsIdentity } from './main/lanTlsIdentity';
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
import { preserveExistingItemDuringScan } from './main/libraryScanReconciliation';
import {
  getLocalNetworkAddresses,
  getLocalNetworkNameFast,
  getPrimaryLocalNetworkAddress,
} from './main/networkInfo';
import { closeServerForUpdateInstall } from './main/updateInstall';
import {
  backupDatabase,
  cacheLibraryArtwork,
  removePluginArtworkForAddon,
  clearDatabase,
  clearAllGuestProfiles,
  cancelSegmentAnalysisJobs,
  cleanupOrphanedAutomaticSegments,
  cleanupOrphanedAnalysisData,
  enqueueSegmentAnalysisJob,
  fingerprintCacheBytes,
  fingerprintCount,
  getSegmentAnalysisInventory,
  getSegmentAnalysisJobCounts,
  getSegmentAnalysisJobs,
  createProfile,
  deleteProfile,
  exportProfileData,
  getAllProgress,
  getManagedSegmentCandidates,
  getPlaybackTrackPreferences,
  getProgress,
  getProfileLists,
  getProfilePreferences,
  getProfileRestrictions,
  getStremioAddonConfigurationState,
  importCustomArtwork,
  importProfileData,
  importProgress,
  reorderProfiles,
  updateProfile,
  eraseAutomaticSegmentCandidates,
  loadLibraryFromDatabase,
  saveCustomArtwork,
  saveLibraryToDatabase,
  savePlaybackTrackPreferences,
  saveProfilePreferences,
  saveProfileRestrictions,
  saveProgress,
  selectDeviceProfile,
  setProfileListEntry,
  saveSegmentAnalysisInventory,
  updateSegmentAnalysisJob,
  updateSegmentCandidate,
  recoverRunningSegmentAnalysisJobs,
  requeueWaitingSegmentAnalysisJobs,
  resetAutomaticAnalysisData,
} from './main/database';
import {
  broadcastProfilesChanged,
  broadcastActiveProfileChanged,
  changeProfilePin,
  createAndSelectGuest,
  DESKTOP_DEVICE_ID,
  getDesktopActiveProfileId,
  getDesktopActiveProfileState,
  getActiveProfileState,
  lockProfile,
  prepareDesktopProfileStartup,
  profileSummaries,
  requireDesktopProfileId,
  requireOwner,
  revokeDeviceProfileAccess,
  resolveLanProfileId,
  resetOwnerProfile,
  setDesktopAutomaticSignIn,
  selectDesktopProfile,
} from './main/profileService';
import {
  createDesktopStremioPluginService,
} from './main/stremioPluginServiceDesktop.ts';
import { StremioPluginServiceError } from './main/stremioPluginService.ts';
import {
  OFFICIAL_STREMIO_ADDONS,
  officialStremioAddonId,
  officialStremioManifestUrl,
  parseStremioItemId,
  stremioCatalogResult,
  stremioMetaResult,
  stremioPluginReview,
  stremioPluginSummary,
} from './main/stremioPluginWire.ts';
import {
  assertProfileCanAccessPath,
  assertSubtitleCanAccessMediaPath,
  filterLibraryForProfile,
  profileRestrictionIdentity,
} from './main/contentPolicy.ts';
import {
  cleanMediaTitle,
  isGenericGroupingFolderTitle,
} from './main/metadata/helpers';
import type {
  MediaItem as MetadataMediaItem,
} from './main/metadata/types';
import { fetchOMDbMetadata, fetchOMDbMetadataById } from './main/metadata/omdb';
import { fetchTVMetadata, fetchTVMetadataCandidates } from './main/metadata/tvmaze';
import {
  fetchTMDBMovieMetadata,
  fetchTMDBMovieMetadataById,
  fetchTMDBMovieMetadataCandidates,
  fetchTMDBStreamingProvidersById,
  fetchTMDBTVMetadata,
  fetchTMDBTVMetadataById,
  fetchTMDBTVMetadataCandidates,
} from './main/metadata/tmdb';
import {
  fetchJikanMetadata,
  fetchJikanMetadataCandidates,
} from './main/metadata/jikan';
import { fetchAniListAnimeMetadata } from './main/metadata/anilist';
import { fetchFanartMovieLogos, fetchFanartTVLogos } from './main/metadata/fanart';
import { createSkipSegmentService } from './main/skipSegments/service';
import { createLocalSegmentAnalysis } from './main/skipSegments/localAnalysis';
import { createAnalysisCoordinator } from './main/skipSegments/analysisCoordinator';
import { setPlaybackActivityLease } from './main/ffmpegGovernor';
import {
  createLibraryScanFilesAsync,
  getLibraryFolderSignatureAsync,
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

type MediaItem = MetadataMediaItem;

const { extractSeasons, scanEpisodeFiles } = createLibraryScanFilesAsync(probeMediaFileAsync);

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

// Keep Chromium's zero-copy path enabled for normal playback. It avoids an
// unnecessary GPU-to-CPU round trip in the browser fallback. Affected drivers
// retain an explicit compatibility escape hatch for support runs.
const disableZeroCopy = ['1', 'true', 'yes'].includes(
  String(process.env.LOOMTV_DISABLE_ZERO_COPY || '').trim().toLowerCase(),
);
if (disableZeroCopy) app.commandLine.appendSwitch('disable-zero-copy');

// Register privileged scheme BEFORE app ready — required for video streaming
protocol.registerSchemesAsPrivileged([
  { scheme: 'plexserver', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } },
]);

app.setName('LoomTV');
const USER_DATA_DIR = path.join(app.getPath('appData'), 'LoomTV');
app.setPath('userData', USER_DATA_DIR);

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // Do not merely schedule app.quit() here. Electron keeps executing the
  // current main-process turn until the quit event loop runs, which allowed a
  // losing dev/installer launch to continue into app.whenReady() and create a
  // second server/window. A secondary instance has no resources to clean up;
  // exit immediately before registering any startup handlers.
  app.exit(0);
}

let isAppShuttingDown = false;

function showOpenFolderDialog(options: OpenDialogOptions) {
  const win = getMainWindow();
  return win
    ? dialog.showOpenDialog(win, options)
    : dialog.showOpenDialog(options);
}

async function requestLanPairingApproval(request: LanPairingApprovalPrompt): Promise<boolean> {
  let win = getMainWindow();
  if (!win || win.isDestroyed()) {
    createWindow();
    win = getMainWindow();
  }
  if (!win || win.isDestroyed()) return false;

  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const secondsRemaining = Math.max(1, Math.ceil((request.expiresAt - Date.now()) / 1000));
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'LoomTV device request',
    message: `${request.deviceName} wants to connect`,
    detail: `Network address: ${request.address}\n\nAllow this device to browse and stream your LoomTV library? This request expires in ${secondsRemaining} seconds.`,
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}
const LIBRARY_FILE = path.join(app.getPath('userData'), 'library.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const SCAN_CACHE_VERSION = 10;
let libraryMutationVersion = 0;

function advanceLibraryMutationVersion(): void {
  libraryMutationVersion++;
  setResourceRegistryCatalogGeneration(libraryMutationVersion);
}

const LOCAL_ACCESS_TOKEN = createLocalAccessToken();
const MAIN_WINDOW_DEV_SERVER_URL =
  typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;

function getLanRendererUrl(): string | null {
  const address = getPrimaryLocalNetworkAddress();
  if (!address || !MAIN_WINDOW_DEV_SERVER_URL) return null;

  const rendererUrl = new URL(MAIN_WINDOW_DEV_SERVER_URL);
  rendererUrl.hostname = address;
  return rendererUrl.toString();
}

const LAN_RENDERER_URL = getLanRendererUrl();
const ALLOWED_CORS_ORIGINS = new Set<string>(
  [
    MAIN_WINDOW_DEV_SERVER_URL ? new URL(MAIN_WINDOW_DEV_SERVER_URL).origin : '',
    LAN_RENDERER_URL ? new URL(LAN_RENDERER_URL).origin : '',
  ].filter(Boolean),
);
const remoteLibraryClient = createRemoteLibraryClient();
const RESOURCE_REGISTRY_BOOT_ID = randomUUID();

const {
  isLoopbackRequest,
  getLanServerBase,
  getLanHmacSecret,
  isLanSharingEnabled,
  getLanShareToken,
  buildSignedLanUrl,
  isSignedLanRequestValid,
  authorizeLanRequest,
  authorizeLocalRequest,
  requireLocalOrLanAccess,
  requireStreamAccess,
  flushPairedDeviceTouches,
  handleLanPairRequest,
  handleLanPairStatusRequest,
  handleLanRefreshRequest,
  libraryEtagFor,
  syncLanAdvertisement,
} = createLanSecurity({
  loadSettings,
  saveSettings,
  localAccessToken: LOCAL_ACCESS_TOKEN,
  authorizeLocalBrowserRequest: (reqUrl, req) => {
    // A browser opened at the local /app/ route is another renderer of the
    // desktop host. Keep this fallback loopback-only and exclude routes that
    // are intentionally reserved for validated Electron IPC.
    if (isIpcOnlyHttpRoute(reqUrl.pathname)) return false;
    return isTrustedRendererHttpOrigin({
      headers: req.headers,
      // Direct browser access must be the exact loopback media-server origin;
      // do not widen this local authorization through LAN/dev CORS origins.
      allowedOrigins: new Set<string>(),
      loopbackServerPort: getMediaServerPort(),
    });
  },
  requestPairingApproval: requestLanPairingApproval,
});

const {
  getLocalImageUrl,
  getLocalThumbnailUrl,
  getRemoteThumbnailUrl,
  getEmbeddedThumbnailUrl,
  isExternalArtworkUrl,
  artworkDeliveryUrl,
  pluginArtworkDeliveryUrl,
  remoteArtworkDeliveryUrl,
  artworkDeliveryUrls,
  customArtworkForRenderer,
  subtitleRecordsForRenderer,
  subtitleRecordsForLocalNetwork,
  orderedArtworkCandidates,
} = createArtworkUrls({
  localAccessToken: LOCAL_ACCESS_TOKEN,
  buildSignedLanUrl,
  registerRemoteResource: (kind, value, scopePath, ownerId) => registerResource(
    getLanHmacSecret(),
    kind,
    value,
    scopePath,
    ownerId,
  ),
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
  libraryIndexForLocalNetwork: projectLibraryIndexForLocalNetwork,
  libraryIndexForRenderer: projectLibraryIndexForRenderer,
  libraryItemForLocalNetwork: projectLibraryItemForLocalNetwork,
  libraryItemForRenderer: projectLibraryItemForRenderer,
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
  progressKeyFor: (filePath) => registerResource(getLanHmacSecret(), 'media', filePath),
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
  const owner = clearDatabase();
  selectDeviceProfile(DESKTOP_DEVICE_ID, owner.id);
  broadcastProfilesChanged();
  broadcastActiveProfileChanged(DESKTOP_DEVICE_ID);
  for (const filePath of [LIBRARY_FILE, SETTINGS_FILE]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      console.warn(`[data] Failed to remove legacy file ${filePath}:`, error);
    }
  }
  advanceLibraryMutationVersion();
  return loadLibrary();
}

async function shouldSplitContainerFolder(folderPath: string, folderName: string, subDirs: fs.Dirent[]): Promise<boolean> {
  const episodeBearingDirs: fs.Dirent[] = [];
  for (const dir of subDirs) {
    if ((await scanEpisodeFiles(path.join(folderPath, dir.name))).length > 0) {
      episodeBearingDirs.push(dir);
    }
  }

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
  fetchAniListAnimeMetadata,
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
  probeMediaFile: probeMediaFileAsync,
  scanEpisodeFiles,
});
const { scanDirectoryAsItem, scanFolder } = createLibraryScanner({
  buildMovieItemFromFile,
  buildTVItemFromFolder,
  probeMediaFile: probeMediaFileAsync,
  scanEpisodeFiles,
  shouldSplitContainerFolder,
});

async function scanLibrary(
  data: LibraryData,
  options: {
    force?: boolean;
    mode?: LibraryScanMode;
    onProgress?: (snapshot: LibraryScanProgress) => void | Promise<void>;
    onCheckpoint?: (snapshot: LibraryScanProgress) => void | Promise<void>;
  } = {},
): Promise<LibraryData> {
  const metadataRefreshIntervalMs = 7 * 24 * 60 * 60 * 1000;
  const missingMetadataRetryIntervalMs = 24 * 60 * 60 * 1000;
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
      userAgent: `LoomTV v${app.getVersion() || 'dev'}`,
      isEnabled: () => Boolean(loadSettings().openSubtitlesAutoDownload),
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
  let checkpointedFolders = 0;

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
    const snapshot = currentLibrarySnapshot(isComplete);
    if (!isComplete && scannedFolders > checkpointedFolders) {
      await options.onCheckpoint?.(snapshot);
      checkpointedFolders = scannedFolders;
    }
    await options.onProgress?.(snapshot);
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
      let refreshProviderRatings = false;
      const preserveItems = (items: MediaItem[]) => items.map((item) => preserveExistingItemDuringScan(
          item,
          existingItemsById.get(item.id)
            || (item.filePath ? existingItemsByPath.get(path.resolve(item.filePath)) : undefined)
            || cachedItemsById.get(item.id)
            || (item.filePath ? cachedItemsByPath.get(path.resolve(item.filePath)) : undefined),
          { refreshRatings: refreshProviderRatings },
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

      try {
        const folderSignature = await getLibraryFolderSignatureAsync(folder);
        const cachedEntry = previousScanCache[folder];
        const ratingsAreFresh = Boolean(
          cachedEntry
          && Date.now() - (cachedEntry.ratingsRefreshedAt || cachedEntry.scannedAt || 0) < metadataRefreshIntervalMs,
        );
        const cachedMetadataIsComplete = cachedItemsAreComplete(cachedItems);
        const missingMetadataRetryIsDue = Boolean(
          !cachedMetadataIsComplete
          && (!cachedEntry || Date.now() - (cachedEntry.scannedAt || 0) >= missingMetadataRetryIntervalMs),
        );
        // The automatic sync uses quick scans. Once the persisted metadata is
        // a week old, let that normal scan query providers again; the merge
        // below retains every populated/manual value and only refreshes ratings.
        refreshProviderRatings = !ratingsAreFresh;

        if (
          mode !== 'full'
          && folderSignature
          && cachedEntry?.version === SCAN_CACHE_VERSION
          && cachedEntry?.folderKind === folderKind
          && cachedEntry.signature === folderSignature.signature
          && (cachedEntry.subtitleProfile || '') === subtitleProfile
        ) {
          const canUseCachedMetadata = ratingsAreFresh
            && mode !== 'metadata'
            && (!missingMetadataRetryIsDue || cachedMetadataIsComplete);
          if (canUseCachedMetadata && cachedItems.length === cachedEntry.itemCount) {
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
            ratingsRefreshedAt: refreshProviderRatings
              ? Date.now()
              : cachedEntry?.ratingsRefreshedAt || cachedEntry?.scannedAt || Date.now(),
          };
        }
      } catch (error) {
        const currentStatus = getLibraryFolderStatus(folder, libraryFolderKindForScanKind(folderKind));
        const message = error instanceof Error ? error.message : String(error);
        folderStatusesByPath.set(folder, {
          ...currentStatus,
          state: currentStatus.state === 'unavailable' ? 'unavailable' : 'degraded',
          message: currentStatus.state === 'unavailable'
            ? `The folder disconnected during scanning. Saved items were preserved. ${message}`
            : `The folder remained available, but its scan could not finish. Saved items were preserved. ${message}`,
        });
        appendItems(cachedItemsForFolder(folder, folderKind, { preserveUnavailable: true }), folderKind);
        if (previousScanCache[folder]) nextScanCache[folder] = previousScanCache[folder];
        console.warn(`[library] Preserved ${folder} after an incomplete scan:`, error);
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
    return fs.statSync(candidatePath).isFile();
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
  const profileId = getDesktopActiveProfileId();
  const scoped = profileId
    ? filterLibraryForProfile(data, profileId)
    : { ...data, movies: [], tvShows: [], animeShows: [] };
  return projectLibraryForRenderer(scoped);
}

function findLibraryItem(data: LibraryData, mediaId: string): MediaItem | null {
  for (const collection of [data.movies || [], data.tvShows || [], data.animeShows || []]) {
    const item = collection.find((candidate) => candidate.id === mediaId);
    if (item) return item;
  }
  return null;
}

function compactLibraryIndexForRenderer(revision = libraryMutationVersion) {
  const profileId = getDesktopActiveProfileId();
  const data = loadLibrary();
  const scoped = profileId
    ? filterLibraryForProfile(data, profileId)
    : { ...data, movies: [], tvShows: [], animeShows: [] };
  return projectLibraryIndexForRenderer(scoped, revision);
}

function compactLibraryItemForRenderer(mediaId: string, revision = libraryMutationVersion) {
  const profileId = getDesktopActiveProfileId();
  if (!profileId) return null;
  const item = findLibraryItem(filterLibraryForProfile(loadLibrary(), profileId), mediaId);
  return item ? projectLibraryItemForRenderer(item, revision) : null;
}

function getRendererCatalogIdentity(): string {
  const state = getDesktopActiveProfileState();
  const profileIdentity = state.profileId
    ? `${profileRestrictionIdentity(state.profileId)}:${state.selectionRevision}`
    : `profile:none:${state.selectionRevision}`;
  const deliveryIdentity = libraryEtagFor({
    localAccessToken: LOCAL_ACCESS_TOKEN,
    serverPort: getMediaServerPort(),
    resourceRegistryBootId: RESOURCE_REGISTRY_BOOT_ID,
  });
  return `${profileIdentity}:${deliveryIdentity}:${RESOURCE_REGISTRY_BOOT_ID}`;
}

function signedStreamUrlForRemote(
  base: string,
  filePath: string,
  identity?: { deviceId: string; profileId: string; selectionRevision: number },
): string {
  const resourceId = registerResource(getLanHmacSecret(), 'media', filePath);
  return buildSignedLanUrl(base, '/stream', new URLSearchParams({
    resourceId,
    ...(identity ? {
      deviceId: identity.deviceId,
      profileId: identity.profileId,
      selectionRevision: String(identity.selectionRevision),
    } : {}),
  }));
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

function libraryForLocalNetwork(profileId?: string, deviceId?: string): LibraryData {
  const base = getLanServerBase() || `http://127.0.0.1:${getMediaServerPort()}`;
  const data = loadLibrary();
  const resolvedProfileId = profileId || resolveLanProfileId(deviceId || null);
  const state = deviceId ? getActiveProfileState(deviceId) : null;
  return projectLibraryForLocalNetwork(
    filterLibraryForProfile(data, resolvedProfileId),
    base,
    deviceId ? {
      deviceId,
      profileId: resolvedProfileId,
      selectionRevision: state?.selectionRevision ?? 0,
    } : undefined,
  );
}

function compactLibraryIndexForLocalNetwork(
  profileId: string,
  deviceId: string | undefined,
  revision = libraryMutationVersion,
) {
  const base = getLanServerBase() || `http://127.0.0.1:${getMediaServerPort()}`;
  const state = deviceId ? getActiveProfileState(deviceId) : null;
  return projectLibraryIndexForLocalNetwork(
    filterLibraryForProfile(loadLibrary(), profileId),
    base,
    revision,
    deviceId ? {
      deviceId,
      profileId,
      selectionRevision: state?.selectionRevision ?? 0,
    } : undefined,
  );
}

function compactLibraryItemForLocalNetwork(
  mediaId: string,
  profileId: string,
  deviceId: string | undefined,
  revision = libraryMutationVersion,
) {
  const item = findLibraryItem(filterLibraryForProfile(loadLibrary(), profileId), mediaId);
  if (!item) return null;
  const base = getLanServerBase() || `http://127.0.0.1:${getMediaServerPort()}`;
  const state = deviceId ? getActiveProfileState(deviceId) : null;
  return projectLibraryItemForLocalNetwork(
    item,
    base,
    revision,
    deviceId ? {
      deviceId,
      profileId,
      selectionRevision: state?.selectionRevision ?? 0,
    } : undefined,
  );
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
  advanceLibraryMutationVersion();
  if (saveLibrary(data)) reconcileSkipAnalysisAfterScan(previous, data);
}

function stremioTypesMatch(requestedType: unknown, itemType: string): boolean {
  if (requestedType === itemType) return true;
  return (requestedType === 'series' || requestedType === 'tv')
    && (itemType === 'series' || itemType === 'tv');
}

let warmSkipSegmentsAfterScan: (data: LibraryData) => void = () => undefined;
let reconcileSkipAnalysisAfterScan: (previous: LibraryData, next: LibraryData) => void = () => undefined;

function saveLibraryFromScan(data: LibraryData, scanVersion: number): boolean {
  if (scanVersion !== libraryMutationVersion) return false;
  const previous = loadLibrary();
  if (!saveLibrary(data)) return false;
  advanceLibraryMutationVersion();
  cleanupOrphanedAutomaticSegments();
  warmSkipSegmentsAfterScan(data);
  reconcileSkipAnalysisAfterScan(previous, data);
  return true;
}

function saveLibraryScanCheckpoint(data: LibraryData, scanVersion: number): boolean {
  if (scanVersion !== libraryMutationVersion) return false;
  return saveLibrary(data);
}

const {
  applyOfficialMetadataCandidate,
  getOfficialMetadataCandidates,
  getPlaybackLogo,
  getStreamingProviders,
  refreshIncompleteMetadata,
  refreshOfficialArtwork,
} = createOfficialMetadataService({
  artworkDeliveryUrl,
  artworkDeliveryUrls,
  cacheArtworkNow,
  fetchAniListAnimeMetadata,
  fetchFanartMovieLogos,
  fetchFanartTVLogos,
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
  saveLibrary: saveLibraryMutation,
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

  app.setName('LoomTV');

  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }
}

let rendererSecurityPolicyConfigured = false;
const YOUTUBE_EMBED_REFERER = 'https://github.com/mallenkb/LoomTV/';

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
    'https:',
  ];
  if (MAIN_WINDOW_DEV_SERVER_URL) {
    connectSrc.push('ws://localhost:*', 'ws://127.0.0.1:*', 'ws://[::1]:*');
  }

  const csp = [
    "default-src 'self' file: data: blob:",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' file: 'unsafe-inline'",
    "img-src 'self' file: data: blob: http://127.0.0.1:* http://localhost:* http://[::1]:* https: plexserver:",
    "media-src 'self' file: blob: http://127.0.0.1:* http://localhost:* http://[::1]:* https: plexserver:",
    `connect-src ${connectSrc.join(' ')}`,
    "font-src 'self' file: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');

  // Packaged renderer pages use file://, which does not provide YouTube with
  // the HTTPS client identity required by its embedded player (error 153).
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        'https://www.youtube-nocookie.com/embed/*',
        'https://www.youtube.com/embed/*',
      ],
      types: ['subFrame'],
    },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Referer: YOUTUBE_EMBED_REFERER,
        },
      });
    },
  );

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isRendererDocument = details.resourceType === 'mainFrame'
      && (details.url.startsWith('file://')
        || Boolean(MAIN_WINDOW_DEV_SERVER_URL && details.url.startsWith(MAIN_WINDOW_DEV_SERVER_URL)));
    if (!isRendererDocument) {
      callback({ responseHeaders: details.responseHeaders || {} });
      return;
    }

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
const stremioPluginService = createDesktopStremioPluginService();

const stremioPluginSummaryForRenderer = (record: Parameters<typeof stremioPluginSummary>[0]) => (
  stremioPluginSummary(record, getStremioAddonConfigurationState(record.addonId))
);

const stremioPluginReviewForRenderer = (review: Parameters<typeof stremioPluginReview>[0]) => (
  stremioPluginReview(review, getStremioAddonConfigurationState(review.addonId))
);

registerIpcHandlers<LibraryData, AppSettings>({
  getMediaServerPort: () => getMediaServerPort(),
  localAccessToken: LOCAL_ACCESS_TOKEN,
  showOpenFolderDialog,
  loadLibrary,
  libraryForRenderer,
  libraryIndexForRenderer: compactLibraryIndexForRenderer,
  // Detail reads must return the persisted library snapshot. Provider refreshes
  // belong to explicit metadata-refresh actions, not opening a local title.
  libraryItemForRenderer: compactLibraryItemForRenderer,
  scanLibrary,
  saveLibraryFromScan,
  saveLibraryScanCheckpoint,
  getLibraryMutationVersion: () => libraryMutationVersion,
  cacheArtworkNow,
  addFolderToLibrary,
  removeFolderFromLibrary,
  saveLibraryMutation,
  assertLocalMediaPath,
  authorizeMediaPath: (filePath) => assertProfileCanAccessPath(loadLibrary(), requireDesktopProfileId(), filePath),
  assertSubtitleCanAccessMediaPath: (mediaFilePath, subtitleFilePath) =>
    assertSubtitleCanAccessMediaPath(loadLibrary(), requireDesktopProfileId(), mediaFilePath, subtitleFilePath),
  registerSubtitleResource: (mediaFilePath, subtitleFilePath) => {
    assertLocalMediaPath(subtitleFilePath);
    if (!isSubtitleFileName(subtitleFilePath)) throw new Error('Unsupported subtitle file.');
    assertSubtitleCanAccessMediaPath(
      loadLibrary(),
      requireDesktopProfileId(),
      mediaFilePath,
      subtitleFilePath,
    );
    return registerResource(
      getLanHmacSecret(),
      'subtitle',
      subtitleFilePath,
      mediaFilePath,
    );
  },
  needsBrowserTranscoding,
  browserPlaybackPlan,
  loadSettings,
  settingsForRenderer: () => {
    const settings = loadSettings();
    try {
      requireOwner();
      return settingsForRenderer(settings);
    } catch {
      return settingsPreferencesForRenderer(settings);
    }
  },
  authorizeSettingsWrite: () => { requireOwner(); },
  saveSettings,
  onSettingsSaved: () => {
    analysisCoordinator.settingsChanged();
    refreshNativePlaybackDisplaySleepTimeout();
    if (!loadSettings().localNetworkSharingEnabled) stopTranscodesForScope('lan:');
  },
  syncLanAdvertisement,
  testMetadataKeys,
  getLanShareToken,
  getLanServerBase,
  isLanSharingEnabled,
  getLocalNetworkNameFast,
  getLocalNetworkAddresses,
  discoverLanPeers,
  connectRemoteLibrary: remoteLibraryClient.connect,
  requestRemoteLibrary: remoteLibraryClient.request,
  getRemoteLibrarySession: remoteLibraryClient.getSession,
  disconnectRemoteLibrary: remoteLibraryClient.disconnect,
  revokeDeviceProfileAccess,
  // Viewer state resolves the active desktop profile in the main process; the
  // renderer never chooses a profile ID for progress calls.
  getProgress: (filePath) => {
    const profileId = getDesktopActiveProfileId();
    return profileId ? getProgress(profileId, filePath) : null;
  },
  getAllProgress: () => {
    const profileId = getDesktopActiveProfileId();
    return profileId ? getAllProgress(profileId) : {};
  },
  saveProgress: (filePath, position, duration, expectedProfileId) =>
    saveProgress(requireDesktopProfileId(expectedProfileId), filePath, position, duration),
  importProgress: (progress, expectedProfileId) => importProgress(requireDesktopProfileId(expectedProfileId), progress),
  listProfiles: profileSummaries,
  chooseProfileAvatar: async () => {
    requireOwner();
    const result = await dialog.showOpenDialog({
      title: 'Choose profile image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return null;
    if ((await fs.promises.stat(filePath)).size > 10 * 1024 * 1024) {
      throw new Error('Choose an image smaller than 10 MB.');
    }
    const source = nativeImage.createFromPath(filePath);
    if (source.isEmpty()) throw new Error('That image could not be opened.');
    const size = source.getSize();
    const side = Math.min(size.width, size.height);
    const square = source.crop({
      x: Math.floor((size.width - side) / 2),
      y: Math.floor((size.height - side) / 2),
      width: side,
      height: side,
    }).resize({ width: 256, height: 256, quality: 'best' });
    const avatar = `data:image/png;base64,${square.toPNG().toString('base64')}`;
    if (avatar.length > 512 * 1024) throw new Error('That image is too complex. Try a smaller image.');
    return avatar;
  },
  getActiveProfileState: getDesktopActiveProfileState,
  createProfile: (input) => {
    requireOwner();
    createProfile(input);
    broadcastProfilesChanged();
    return profileSummaries();
  },
  updateProfile: (profileId, patch) => {
    requireOwner();
    updateProfile(profileId, patch);
    broadcastProfilesChanged();
    return profileSummaries();
  },
  deleteProfile: (profileId) => {
    requireOwner();
    deleteProfile(profileId);
    broadcastProfilesChanged();
    return profileSummaries();
  },
  exportProfile: async (profileId) => {
    requireOwner();
    try {
      const bundle = exportProfileData(profileId);
      const result = await dialog.showSaveDialog({
        title: 'Export LoomTV profile',
        defaultPath: `${bundle.profile.name.replace(/[^a-z0-9_-]+/gi, '-') || 'profile'}.loomprofile.json`,
        filters: [{ name: 'LoomTV Profile', extensions: ['loomprofile.json', 'json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false };
      await fs.promises.writeFile(result.filePath, JSON.stringify(bundle), { encoding: 'utf8', flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        await fs.promises.writeFile(result.filePath as string, JSON.stringify(bundle), 'utf8');
      });
      return { ok: true, path: result.filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Profile export failed.' };
    }
  },
  importProfile: async () => {
    requireOwner();
    try {
      const result = await dialog.showOpenDialog({
        title: 'Import LoomTV profile',
        properties: ['openFile'],
        filters: [{ name: 'LoomTV Profile', extensions: ['json'] }],
      });
      const filePath = result.filePaths[0];
      if (result.canceled || !filePath) return { ok: false };
      if ((await fs.promises.stat(filePath)).size > 25 * 1024 * 1024) throw new Error('The profile file is larger than 25 MB.');
      const bundle = parseRequiredJson(
        await fs.promises.readFile(filePath, 'utf8'),
        profileExportSchema,
        'Profile import',
      );
      const imported = importProfileData(bundle);
      broadcastProfilesChanged();
      return {
        ok: true,
        profile: profileSummaries().find((profile) => profile.id === imported.profile.id),
        importedProgress: imported.importedProgress,
        skippedProgress: imported.skippedProgress,
        importedLists: imported.importedLists,
        skippedLists: imported.skippedLists,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Profile import failed.' };
    }
  },
  selectProfile: (profileId, pin) => selectDesktopProfile(profileId, pin),
  selectGuestProfile: () => createAndSelectGuest(DESKTOP_DEVICE_ID),
  lockProfile: () => lockProfile(DESKTOP_DEVICE_ID),
  reorderProfiles: (profileIds) => {
    requireOwner();
    const profiles = reorderProfiles(profileIds);
    broadcastProfilesChanged();
    return profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      avatarKey: profile.avatarKey,
      colorKey: profile.colorKey,
      type: profile.type,
      hasPin: profile.hasPin,
      isGuest: profile.isGuest,
      sortOrder: profile.sortOrder,
      ...(profile.lastUsedAt ? { lastUsedAt: profile.lastUsedAt } : {}),
    }));
  },
  changeProfilePin,
  resetOwnerProfile,
  setAutomaticSignIn: setDesktopAutomaticSignIn,
  getProfilePreferences: () => getProfilePreferences(requireDesktopProfileId()),
  saveProfilePreferences: (patch, expectedProfileId) => saveProfilePreferences(requireDesktopProfileId(expectedProfileId), patch),
  getProfileRestrictions: (profileId) => {
    requireOwner();
    return getProfileRestrictions(profileId);
  },
  saveProfileRestrictions: (profileId, input) => {
    requireOwner();
    return saveProfileRestrictions(profileId, input);
  },
  getProfileLists: (kind) => getProfileLists(requireDesktopProfileId(), kind),
  setProfileListEntry: (mediaId, kind, present, expectedProfileId) => setProfileListEntry(requireDesktopProfileId(expectedProfileId), mediaId, kind, present),
  getPlaybackTrackPreferences: (scope) => {
    const profileId = getDesktopActiveProfileId();
    return profileId ? getPlaybackTrackPreferences(profileId, scope) : {};
  },
  savePlaybackTrackPreferences: (scope, preferences, expectedProfileId) => savePlaybackTrackPreferences(requireDesktopProfileId(expectedProfileId), scope, preferences as Parameters<typeof savePlaybackTrackPreferences>[2]),
  listStremioPlugins: () => stremioPluginService.listManaged().map(stremioPluginSummaryForRenderer),
  listAvailableStremioPlugins: () => stremioPluginService
    .listForProfile(requireDesktopProfileId())
    .map(stremioPluginSummaryForRenderer),
  listOfficialStremioAddons: () => [...OFFICIAL_STREMIO_ADDONS],
  reviewOfficialStremioAddon: async (officialId) => stremioPluginReviewForRenderer(
    await stremioPluginService.reviewManifestUrl(
      officialStremioManifestUrl(officialId),
      officialStremioAddonId(officialId),
    ),
  ),
  reviewStremioManifestUrl: async (manifestUrl) => stremioPluginReviewForRenderer(
    await stremioPluginService.reviewManifestUrl(manifestUrl),
  ),
  approveStremioAddon: async (addonId, reviewToken) => stremioPluginSummaryForRenderer(
    await stremioPluginService.approve(addonId, reviewToken),
  ),
  disableStremioAddon: async (addonId) => stremioPluginSummaryForRenderer(
    await stremioPluginService.disable(addonId),
  ),
  removeStremioAddon: async (addonId) => {
    const removed = await stremioPluginService.remove(addonId);
    if (removed) removePluginArtworkForAddon(addonId);
    return removed;
  },
  listStremioProfileAccess: (profileId) => [...stremioPluginService.listManagedProfileAccess(profileId)],
  setStremioProfileAccess: (profileId, addonId, enabled) => stremioPluginService.setProfileAccess(
    profileId,
    addonId,
    enabled,
  ),
  getStremioAddonConfiguration: (addonId) => stremioPluginService.getConfigurationState(addonId),
  saveStremioAddonConfiguration: (addonId, values) => stremioPluginService.saveConfiguration(addonId, values),
  listStremioPluginAudit: (addonId, limit) => stremioPluginService.listAudit(addonId, limit),
  fetchStremioCatalog: async (addonId, request) => stremioCatalogResult(
    addonId,
    request,
    await stremioPluginService.fetchCatalogComplete(requireDesktopProfileId(), addonId, request),
    (source) => pluginArtworkDeliveryUrl(addonId, source),
  ),
  fetchStremioMeta: async (addonId, request) => {
    const itemIdentity = parseStremioItemId(request?.id);
    if (!itemIdentity || itemIdentity.addonId !== addonId || !stremioTypesMatch(request?.type, itemIdentity.type)) {
      throw new StremioPluginServiceError(
        'STREMIO_PLUGIN_INVALID_ITEM_ID',
        'The requested Discover item does not belong to this add-on and content type.',
      );
    }
    return stremioMetaResult(
      addonId,
      await stremioPluginService.fetchMeta(requireDesktopProfileId(), addonId, {
        ...request,
        type: itemIdentity.type,
        id: itemIdentity.providerId,
      }),
      (source) => pluginArtworkDeliveryUrl(addonId, source),
    );
  },
  fetchStremioMetaByItem: async (request) => {
    const itemIdentity = parseStremioItemId(request?.id);
    if (!itemIdentity || !stremioTypesMatch(request?.type, itemIdentity.type)) {
      throw new StremioPluginServiceError(
        'STREMIO_PLUGIN_INVALID_ITEM_ID',
        'The requested Discover item is not a valid host-issued item key.',
      );
    }
    return stremioMetaResult(
      itemIdentity.addonId,
      await stremioPluginService.fetchMeta(requireDesktopProfileId(), itemIdentity.addonId, {
        ...request,
        type: itemIdentity.type,
        id: itemIdentity.providerId,
      }),
      (source) => pluginArtworkDeliveryUrl(itemIdentity.addonId, source),
    );
  },
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
  getStreamingProviders,
  refreshIncompleteMetadata,
  importCustomArtwork,
  backupDatabase,
  clearAppData,
  getUpdateState,
  checkForUpdates,
  installDownloadedUpdate,
  findFFmpeg,
  getTranscodeCapabilities,
  safeResult,
  probeMedia,
  canDirectPlay,
  startTranscode,
  stopTranscode,
  isTrustedSender: (event) => {
    const window = getMainWindow();
    const activeWindow = window && !window.isDestroyed() ? window : null;
    const windowIdentity = getMainWindowIpcIdentity();
    const identityMatchesWindow = Boolean(
      activeWindow
      && windowIdentity
      && activeWindow.webContents.id === windowIdentity.webContentsId,
    );
    const readBoolean = (read: () => boolean | null | undefined): boolean => {
      try {
        return read() === true;
      } catch {
        return false;
      }
    };
    return isTrustedIpcSender({
      senderWebContentsId: event.sender.id,
      senderFrameIsMainFrame: readBoolean(() => (
        event.senderFrame?.frameTreeNodeId === event.sender.mainFrame.frameTreeNodeId
      )),
      senderFrameUrl: (() => {
        try {
          return event.senderFrame?.url ?? null;
        } catch {
          return null;
        }
      })(),
      mainWindowWebContentsId: identityMatchesWindow && windowIdentity ? windowIdentity.webContentsId : null,
      expectedAppUrl: identityMatchesWindow && windowIdentity ? windowIdentity.expectedAppUrl : null,
      mainWindowDestroyed: !identityMatchesWindow,
    });
  },
});

// VideoPlayer keeps Chromium/HLS as its compatibility backend. Local desktop
// playback can additionally use the trusted native-engine handlers registered above.

// ─── App lifecycle ────────────────────────────────────────────────────────────

export const mediaServerDeps = {
  ALLOWED_CORS_ORIGINS,
  LOCAL_ACCESS_HEADER,
  // LOCAL_ACCESS_TOKEN is intentionally not passed. The media server authorizes
  // through the closures below and never holds a credential it could serialize
  // into an HTTP response (audit A.2).
  allowedCorsOrigin,
  authorizeLanRequest,
  authorizeLocalRequest,
  assertProfileCanAccessPath: (profileId: string, filePath: string) => assertProfileCanAccessPath(loadLibrary(), profileId, filePath),
  assertSubtitleCanAccessMediaPath: (profileId: string, mediaFilePath: string, subtitleFilePath: string) =>
    assertSubtitleCanAccessMediaPath(loadLibrary(), profileId, mediaFilePath, subtitleFilePath),
  decodeDataUrl,
  getLanServerBase,
  getLanHmacSecret,
  getLibraryRevision: () => libraryMutationVersion,
  getMediaSegments: skipSegmentService.getSegments,
  getOfficialMetadataCandidates,
  applyOfficialMetadataCandidate,
  getWebRendererDevServerUrl: () => MAIN_WINDOW_DEV_SERVER_URL || null,
  getWebRendererRoot: () => path.join(__dirname, '../renderer/main_window'),
  handleLanPairRequest,
  handleLanPairStatusRequest,
  handleLanRefreshRequest,
  isExternalArtworkUrl,
  isImageFileName,
  isLanSharingEnabled,
  isLoopbackRequest,
  isSignedLanRequestValid,
  // Load only when the server actually starts. A losing second-instance
  // process exits before this getter is read, so it cannot rotate the first
  // installation identity during a simultaneous launch.
  get lanTlsIdentity() {
    return loadOrCreateLanTlsIdentity(app.getPath('userData'), getLocalNetworkAddresses());
  },
  libraryEtagFor,
  compactLibraryIndexForLocalNetwork,
  compactLibraryItemForLocalNetwork,
  canProfileAccessMediaId: (profileId: string, mediaId: string) => (
    findLibraryItem(filterLibraryForProfile(loadLibrary(), profileId), mediaId) !== null
  ),
  compactLibraryIndexForRenderer,
  compactLibraryItemForRenderer,
  getRendererCatalogIdentity,
  libraryForLocalNetwork,
  libraryForRenderer,
  loadLibrary,
  resourceRegistryEpoch: RESOURCE_REGISTRY_BOOT_ID,
  loadSettings,
  profileRestrictionIdentity,
  readJsonBody,
  requireLocalOrLanAccess,
  requireStreamAccess,
  safeEndResponse,
  saveSettings,
  writeJson,
} satisfies MediaServerDependencies;

/**
 * Everything the first paint does not depend on. Kicked off without awaiting so
 * the window is already on screen while the library warms, the stale transcode
 * cache is swept, and the LAN advertisement goes out.
 */
async function startBackgroundServices(): Promise<void> {
  // The tray comes first: closing the window enters host mode rather than
  // quitting, so until the tray exists there is no way back into the app.
  const trayGlyphPath = getTrayIconPath();
  const trayIconPath = trayGlyphPath || getWindowIconPath();
  if (trayIconPath) {
    createServerTray({
      iconPath: trayIconPath,
      iconIsTemplate: Boolean(trayGlyphPath),
      onOpen: () => {
        if (isUpdateInstalling() || isAppShuttingDown) return;
        createWindow();
      },
      onOpenWeb: () => {
        if (isUpdateInstalling() || isAppShuttingDown) return;
        const webUrl = new URL(`http://127.0.0.1:${getMediaServerPort()}/app/`);
        webUrl.searchParams.set(LOCAL_ACCESS_QUERY_PARAM, LOCAL_ACCESS_TOKEN);
        void shell.openExternal(webUrl.toString()).catch((error) => {
          console.warn('[tray] Could not open LoomTV in the default browser:', error);
        });
      },
      onQuit: () => app.quit(),
      port: getMediaServerPort(),
    });
  }
  console.log(libVlcRuntimeSummary());
  initAutoUpdater({
    getMainWindow,
    stopNativePlayback: () => {
      stopAllMpvPlayback();
      stopAllLibVlcPlayback();
    },
    closeMediaServer: async () => {
      const localServerToClose = getMediaServer();
      const lanServerToClose = getLanMediaServer();
      setMediaServer(null);
      setLanMediaServer(null);
      await Promise.all([
        closeServerForUpdateInstall(localServerToClose, getMediaServerSockets()),
        closeServerForUpdateInstall(lanServerToClose, getLanMediaServerSockets()),
      ]);
    },
  });
  buildUpdateMenu();
  startUpdateAdapter();
  syncLanAdvertisement();
  analysisCoordinator.start();
  // loadLibrary() reads and sanitises the whole library synchronously, so it is
  // called here rather than being evaluated as an argument on the launch path.
  const persistedLibrary = loadLibrary();
  skipSegmentService.warmLibrary(persistedLibrary);
  // Warm artwork from the persisted database after the window is available.
  // Detail pages never need to fetch provider artwork as part of opening a
  // local title, including after an app restart.
  await cacheArtworkNow(persistedLibrary);
  await cleanupOldTranscodes();
}

app.whenReady().then(async () => {
  applyAppIcon();
  prepareDesktopProfileStartup();

  // ── plexserver:// protocol handler ──────────────────────────────────────────
  // Translates plexserver://localhost/<path>?<query> → http://127.0.0.1:<port>/<path>?<query>
  // This bypasses Electron's URL safety check that blocks http:// sources in
  // <video> / <audio> elements while still streaming from our local HTTP server.
  protocol.handle('plexserver', async (request: Request) => {
    try {
      const parsed = new URL(request.url);
      // Forward Range header so video seeking works correctly
      const headers: Record<string, string> = {};
      const range = request.headers.get('Range');
      if (range) headers['Range'] = range;
      if (parsed.hostname === 'remote') {
        return remoteLibraryClient.fetchMedia(`${parsed.pathname}${parsed.search}`, headers);
      }
      parsed.searchParams.set(LOCAL_ACCESS_QUERY_PARAM, LOCAL_ACCESS_TOKEN);
      const targetUrl = `http://127.0.0.1:${getMediaServerPort()}${parsed.pathname}${parsed.search}`;
      return net.fetch(targetUrl, { headers, redirect: 'error' });
    } catch (err) {
      // The forwarded URL carries the local access token as a query parameter,
      // and fetch failures embed that URL in their message.
      console.error('[plexserver protocol] fetch error:', describeErrorForLog(err));
      return new Response('Internal Server Error', { status: 500 });
    }
  });

  configureRendererSecurityPolicy();
  // Only the media server has to be listening before the window opens: the
  // renderer builds its artwork and stream URLs from the bound port. It is just
  // a listen() call, so everything genuinely slow is deferred below instead.
  await startMediaServer(mediaServerDeps);
  createWindow();

  void startBackgroundServices().catch((error) => {
    console.error('LoomTV background startup failed:', error);
  });
}).catch((error) => {
  console.error('Failed to start LoomTV:', error);
  // A failed startup must not remain as a headless process holding the single
  // instance lock. This is especially important when a native dependency
  // (such as better-sqlite3) has not been rebuilt for the current Electron ABI.
  app.exit(1);
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
  flushPairedDeviceTouches();
  clearAllGuestProfiles();
  clearUpdateQuitFallback();
  destroyServerTray();
  destroyLanDiscovery();
  stopAllMpvPlayback();
  stopAllLibVlcPlayback();
  // Skip if quitAndInstall already drained these — re-running close() on a
  // null server can throw and abort the install path.
  if (!isUpdateInstalling()) {
    stopAllTranscodes();
  }
  stopUpdateCheckTimer();
  const serversToClose = [
    { server: getMediaServer(), clear: () => setMediaServer(null) },
    { server: getLanMediaServer(), clear: () => setLanMediaServer(null) },
  ];
  for (const { server, clear } of serversToClose) {
    if (!server) continue;
    try {
      server.close();
    } catch {
      // Ignore close errors during quit.
    }
    clear();
  }
});
