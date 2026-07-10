import {
  app,
  dialog,
  nativeImage,
  protocol,
  net,
  session,
} from 'electron';
import type { OpenDialogOptions } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
import { decodeDataUrl, readJsonBody, redirectToArtworkSource, safeEndResponse, writeJson } from './main/httpResponses';
import { browserPlaybackPlan, needsBrowserTranscoding } from './main/transcodeDecision';
import { createLanSecurity } from './main/lanSecurity';
import { getMetadataApiKey, loadSettings, saveSettings } from './main/settings';
import { createArtworkUrls } from './main/artworkUrls';
import {
  isImageFileName,
  isMacSidecarFile,
  isSubtitleFileName,
  isVideoFileName,
} from './main/fileClassification';
import { createArtworkFinders } from './main/artworkFinders';
import {
  defaultLibraryFolderGroups,
  detectLibraryFolderKind,
  flattenLibraryFolders,
  getLibraryFolderStatus,
  libraryFolderStatusesFor,
  normalizeLibraryFolderGroups,
  type LibraryFolderStatus,
} from './main/libraryFolders';
import {
  createSubtitleRecords,
  fetchJikanEpisodesForLocalAnimeSeasons,
  inferSeriesTitleFromEpisodeFiles,
  isAnimeMetadata,
  isLikelyAnimePath,
  isSeriesMetadata,
  isTVPattern,
  mergeLocalSeasonsWithMetadata,
  shouldTreatAsTV,
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
import type { UpdateState } from './main/autoUpdater';
import { testMetadataKeys } from './main/metadataKeys';
import {
  downloadMissingOpenSubtitlesForFolder,
  downloadMissingOpenSubtitlesForVideo,
  openSubtitlesCacheKey,
  openSubtitlesIsConfigured,
  type OpenSubtitlesScanOptions,
} from './main/openSubtitles';
import {
  durableArtworkSource,
  durableArtworkSources,
} from './main/artworkSources';
import {
  cachedItemsAreComplete,
  createMediaItemId,
  isTrustedLocalTagTitle,
  looksLikeLocalEpisodeFileTitle,
  mostCommonUsefulTitle,
} from './main/libraryItemHelpers';
import {
  mergeProviderIds,
  parseMetadataProviderIds,
} from './main/mediaTags';
import type { MetadataProviderIds } from './main/mediaTags';
import {
  getLocalNetworkAddresses,
  getLocalNetworkNameFast,
} from './main/networkInfo';
import { closeServerForUpdateInstall } from './main/updateInstall';
import {
  backupDatabase,
  cacheLibraryArtwork,
  clearDatabase,
  getAllProgress,
  getPlaybackTrackPreferences,
  getProgress,
  importCustomArtwork,
  importProgress,
  loadLibraryFromDatabase,
  saveCustomArtwork,
  saveLibraryToDatabase,
  savePlaybackTrackPreferences,
  saveProgress,
} from './main/database';
import {
  cleanMediaTitle,
  bestSeriesTitleFromEpisodeFiles,
  chooseMetadataSearchTitle,
  isGenericGroupingFolderTitle,
  mergeEpisodeMetadataSources,
  normalizeTitleForMatch,
  numericRating,
  parseYearFromText,
  remoteMatchesAnyLocalTitle,
  uniqueLocalTitles,
  usefulLocalTitle,
} from './main/metadata/helpers';
import type {
  EpisodeFile as MetadataEpisodeFile,
  EpisodeMeta as MetadataEpisodeMeta,
  MediaItem as MetadataMediaItem,
} from './main/metadata/types';
import { fetchOMDbMetadata, fetchOMDbMetadataById } from './main/metadata/omdb';
import type { OMDbResponse } from './main/metadata/omdb';
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

type EpisodeMeta = MetadataEpisodeMeta;
type EpisodeFile = MetadataEpisodeFile;
type MediaItem = MetadataMediaItem;

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
});

const {
  getLocalFolderArtworkUrl,
  getLocalMovieArtworkUrl,
  getEmbeddedArtworkUrl,
  hasPlayableVideoTrack,
} = createArtworkFinders({
  getLocalImageUrl,
  getEmbeddedThumbnailUrl,
});

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface LibraryData {
  movies: MediaItem[];
  tvShows: MediaItem[];
  animeShows: MediaItem[];
  libraryFolders: string[];
  libraryFolderGroups?: LibraryFolderGroups;
  libraryFolderStatuses?: LibraryFolderStatus[];
  scanCache?: LibraryScanCache;
}

type LibraryScanProgress = LibraryData & {
  isComplete: boolean;
  scannedFolders: number;
  totalFolders: number;
};

export type LibraryFolderKind = 'movies' | 'tvShows' | 'anime' | 'others';
type ScanFolderKind = 'movies' | 'tv' | 'anime';
type ScanCacheFolderKind = ScanFolderKind | 'auto';
type LibraryScanMode = 'quick' | 'metadata' | 'full';

export interface LibraryFolderGroups {
  movies: string[];
  tvShows: string[];
  anime: string[];
  others: string[];
}

interface ScanCacheEntry {
  version?: number;
  folderKind: ScanCacheFolderKind;
  signature: string;
  subtitleProfile?: string;
  fileCount: number;
  itemCount: number;
  scannedAt: number;
}

type LibraryScanCache = Record<string, ScanCacheEntry>;

export interface AppSettings {
  omdbApiKey?: string;
  tmdbApiKey?: string;
  metadataApiKeys?: Record<string, string>;
  openSubtitlesUsername?: string;
  openSubtitlesPassword?: string;
  openSubtitlesLanguages?: string;
  openSubtitlesAutoDownload?: boolean;
  autoSyncIntervalHours?: number;
  playbackSkipBackSeconds?: number;
  playbackSkipForwardSeconds?: number;
  sidebarNavOrder?: string[];
  appThemeMode?: 'dark' | 'light';
  appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue';
  appDarkTheme?: 'default' | 'justwatch' | 'black';
  appLoaderStyle?: 'play-mark' | 'logo-mark' | 'horizontal-logo';
  localNetworkSharingEnabled?: boolean;
  localNetworkShareToken?: string;
  localNetworkDeviceId?: string;
  localNetworkDeviceName?: string;
  localNetworkHmacSecret?: string;
  localNetworkPairedDevices?: LanPairedDevice[];
}

export type LanPairedDevice = {
  id: string;
  name: string;
  token: string;
  createdAt: number;
  lastSeenAt: number;
  lastAddress?: string;
};

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

function matchingSubtitleFilesForVideo(dir: string, videoFileName: string): string[] {
  const baseName = path.basename(videoFileName, path.extname(videoFileName)).toLowerCase();
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && isSubtitleFileName(entry.name))
      .map((entry) => entry.name)
      .filter((fileName) => path.basename(fileName, path.extname(fileName)).toLowerCase().startsWith(baseName));
  } catch {
    return [];
  }
}

function makeLocalEpisodeMeta(files: EpisodeFile[], seriesTitle?: string): EpisodeMeta[] {
  return files.map((file) => {
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
}

function libraryFolderKindForScanKind(folderKind: ScanCacheFolderKind): LibraryFolderKind {
  if (folderKind === 'tv') return 'tvShows';
  if (folderKind === 'anime') return 'anime';
  if (folderKind === 'auto') return 'others';
  return 'movies';
}

// ─── HTTP Media Server ────────────────────────────────────────────────────────


// ─── Library scanning ─────────────────────────────────────────────────────────

function getLibraryFolderSignature(folderPath: string): { signature: string; fileCount: number } | null {
  if (!fs.existsSync(folderPath)) return null;

  const hash = createHash('sha256');
  const stack = [folderPath];
  let fileCount = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (isMacSidecarFile(entry.name)) continue;
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!isVideoFileName(entry.name) && !isSubtitleFileName(entry.name) && !isImageFileName(entry.name)) continue;

      try {
        const stats = fs.statSync(fullPath);
        hash.update(path.relative(folderPath, fullPath));
        hash.update('\0');
        hash.update(String(stats.size));
        hash.update('\0');
        hash.update(String(Math.round(stats.mtimeMs)));
        hash.update('\0');
        fileCount++;
      } catch {
        // File disappeared while scanning; the next sync will pick it up cleanly.
      }
    }
  }

  return { signature: `${fileCount}:${hash.digest('hex')}`, fileCount };
}

function scanEpisodeFiles(folderPath: string): EpisodeFile[] {
  const files: EpisodeFile[] = [];

  function seasonFromPath(dir: string): number | null {
    const relativeParts = path.relative(folderPath, dir).split(path.sep).filter(Boolean).reverse();
    for (const part of relativeParts) {
      const match = part.match(/(?:season|series|s)\s*0*(\d{1,2})/i);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  }

  function episodeFromName(fileName: string, fallbackSeason: number): { season: number; episode: number } | null {
    const withoutExt = fileName.replace(/\.[^.]+$/, '');

    // SxxExx / SxxExx – standard TV naming
    const seMatch = withoutExt.match(/[Ss]\s*0*(\d{1,2})\s*[._ -]*[Ee]\s*0*(\d{1,3})/);
    if (seMatch) {
      return { season: parseInt(seMatch[1], 10), episode: parseInt(seMatch[2], 10) };
    }

    // "Episode N" / "Ep N" / " - E N" prefix keyword
    const episodeMatch = withoutExt.match(/(?:episode|ep|e)\s*0*(\d{1,3})\b/i);
    if (episodeMatch) {
      return { season: fallbackSeason, episode: parseInt(episodeMatch[1], 10) };
    }

    // Trailing number — catches anime naming like "[Group] Show Name - 01"
    // Must be the last numeric token (after a separator) to avoid false-positives on years
    const trailingMatch = withoutExt.match(/[-–_\s]+0*(\d{1,3})\s*$/);
    if (trailingMatch) {
      const n = parseInt(trailingMatch[1], 10);
      // Ignore bare 4-digit years (1900–2099)
      if (n < 1900 || n > 2099) {
        return { season: fallbackSeason, episode: n };
      }
    }

    // Leading number (e.g. "01 - Title.mkv")
    const leadingNumber = withoutExt.match(/^\s*0*(\d{1,3})(?:\D|$)/);
    if (leadingNumber) {
      return { season: fallbackSeason, episode: parseInt(leadingNumber[1], 10) };
    }

    return null;
  }

  // Subfolders that are extras / bonus content, not real episodes
  const SKIP_DIRS = new Set([
    'nc', 'nced', 'ncop', 'bonus', 'extras', 'extra', 'special', 'specials',
    'behind the scenes', 'featurettes', 'interviews', 'scenes', 'shorts',
    'trailers', 'featurette', 'sample', 'samples', 'subs', 'subtitles',
  ]);

  function scanDir(dir: string) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
          scanDir(fullPath);
        } else if (isVideoFileName(entry.name)) {
          const probe = probeMediaFile(fullPath);
          if (!hasPlayableVideoTrack(probe)) continue;
          const parsed = episodeFromName(entry.name, probe.season || seasonFromPath(dir) || 1);
          if (parsed) {
            files.push({
              season: probe.season || parsed.season,
              episode: probe.episode || parsed.episode,
              filePath: fullPath,
              title: probe.embeddedTitle,
              subtitles: createSubtitleRecords(dir, matchingSubtitleFilesForVideo(dir, entry.name)),
              localMetadata: probe.localMetadata,
            });
          }
        }
      }
    } catch (e) {
      console.error('scanDir error:', e);
    }
  }

  scanDir(folderPath);
  return files.sort((a, b) => a.season !== b.season ? a.season - b.season : a.episode - b.episode);
}

function extractSeasons(folderPath: string, folderName: string): { number: number; title: string; episodeCount: number }[] {
  const seasons: { number: number; title: string; episodeCount: number }[] = [];
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    const videoFiles = entries.filter((e) => !e.isDirectory() && isVideoFileName(e.name));

    if (dirs.some((d) => /season/i.test(d.name))) {
      for (const dir of dirs) {
        const m = dir.name.match(/season\s*(\d+)/i);
        const num = m ? parseInt(m[1]) : 1;
        const dirPath = path.join(folderPath, dir.name);
        const count = scanEpisodeFiles(dirPath).length || fs.readdirSync(dirPath).filter(isVideoFileName).length;
        seasons.push({ number: num, title: dir.name, episodeCount: count });
      }
    } else {
      const m = folderName.match(/[Ss](\d{1,2})/);
      const num = m ? parseInt(m[1]) : 1;
      const episodeFiles = scanEpisodeFiles(folderPath);
      const grouped = new Map<number, number>();
      episodeFiles.forEach((file) => grouped.set(file.season, (grouped.get(file.season) || 0) + 1));
      if (grouped.size > 0) {
        grouped.forEach((count, season) => {
          seasons.push({ number: season, title: `Season ${String(season).padStart(2, '0')}`, episodeCount: count });
        });
      } else {
        seasons.push({ number: num, title: `Season ${num}`, episodeCount: videoFiles.length });
      }
    }
  } catch (e) {
    console.error('extractSeasons error:', e);
  }
  return seasons.sort((a, b) => a.number - b.number);
}

async function buildTVItemFromFolder(
  fullPath: string,
  entryName: string,
  id: string,
  subtitles: { lang: string; label: string; url: string }[],
  year: number,
  cleanTitle: string,
  omdbApiKey?: string,
  itemType: 'tv' | 'anime' = 'tv',
  tmdbApiKey?: string,
  fanartApiKey?: string,
  openSubtitles?: OpenSubtitlesScanOptions,
): Promise<MediaItem | null> {
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
    : [];

  // ── Merge episode metadata onto local files ────────────────────────────────
  // Keep provider priority per field so anime can use TVmaze titles while Jikan
  // fills episode scores that TVmaze often leaves empty.
  const mergedEpisodes = mergeEpisodeMetadataSources(localEpisodes, [
    matchedTVMeta?.episodes,
    finalType === 'anime' && jikanEpisodesForLocalSeasons.length > 0 ? jikanEpisodesForLocalSeasons : null,
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
    providerIds: mergeProviderIds(providerIds, matchedTmdbTVMeta?.providerIds || {}, matchedTVMeta?.providerIds || {}),
  };
}

async function buildMovieItemFromFile(
  fullPath: string,
  fileName: string,
  titleFallback: string,
  subtitles: { lang: string; label: string; url: string }[],
  year: number,
  omdbApiKey?: string,
  tmdbApiKey?: string,
  fanartApiKey?: string,
  forcedType?: 'movie' | 'tv' | 'anime',
): Promise<MediaItem> {
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

interface ScanContext {
  omdbApiKey?: string;
  tmdbApiKey?: string;
  fanartApiKey?: string;
  openSubtitles?: OpenSubtitlesScanOptions;
  folderKind?: ScanFolderKind;
}

function subtitleFilesInDirectory(folderPath: string): string[] {
  try {
    return fs.readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name)
      .filter(isSubtitleFileName);
  } catch {
    return [];
  }
}

async function downloadOpenSubtitlesForVideos(folderPath: string, videoFiles: string[], ctx: ScanContext): Promise<void> {
  if (!openSubtitlesIsConfigured(ctx.openSubtitles) || videoFiles.length === 0) return;

  for (const videoFile of videoFiles) {
    const videoPath = path.join(folderPath, videoFile);
    const results = await downloadMissingOpenSubtitlesForVideo(videoPath, ctx.openSubtitles);
    results
      .filter((result) => result.status === 'error')
      .forEach((result) => console.warn('[OpenSubtitles]', result.videoPath, result.message));
  }
}

async function scanDirectoryAsItem(folderPath: string, ctx: ScanContext): Promise<MediaItem | null> {
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const folderName = path.basename(folderPath);
  const videoFiles = dirEntries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => entry.name)
    .filter(isVideoFileName);
  await downloadOpenSubtitlesForVideos(folderPath, videoFiles, ctx);
  const subtitleFiles = subtitleFilesInDirectory(folderPath);
  const subDirs = dirEntries.filter((entry) => entry.isDirectory());
  const hasSeasonDirs = subDirs.some((entry) => /season|series/i.test(entry.name));
  const nestedEpisodeFiles = videoFiles.length === 0 && !hasSeasonDirs ? scanEpisodeFiles(folderPath) : [];
  const detectedFolderKind = detectLibraryFolderKind(folderPath);

  if (ctx.folderKind && detectedFolderKind) return null;
  if (ctx.folderKind === 'movies' && videoFiles.length > 1) return null;

  if (videoFiles.length === 0 && !hasSeasonDirs && nestedEpisodeFiles.length === 0) return null;

  const parsedFolder = cleanMediaTitle(folderName);
  const subtitles = createSubtitleRecords(folderPath, subtitleFiles);
  const id = createMediaItemId(folderPath);
  const representativeProbe = videoFiles[0] ? probeMediaFile(path.join(folderPath, videoFiles[0])) : undefined;
  const isTV = nestedEpisodeFiles.length > 0
    || shouldTreatAsTV(folderName, videoFiles, hasSeasonDirs, representativeProbe);

  if (videoFiles.length === 0 && !hasSeasonDirs && nestedEpisodeFiles.length > 0 && shouldSplitContainerFolder(folderPath, folderName, subDirs)) {
    return null;
  }

  if (ctx.folderKind === 'movies') {
    if (videoFiles.length === 0) return null;
    return buildMovieItemFromFile(
      path.join(folderPath, videoFiles[0]),
      videoFiles[0], parsedFolder.title,
      subtitles, parsedFolder.year,
      ctx.omdbApiKey, ctx.tmdbApiKey,
      'movie',
    );
  }

  if ((ctx.folderKind === 'tv' || ctx.folderKind === 'anime') && !isTV && videoFiles.length > 0) {
    return buildMovieItemFromFile(
      path.join(folderPath, videoFiles[0]),
      videoFiles[0], parsedFolder.title,
      subtitles, parsedFolder.year,
      ctx.omdbApiKey, ctx.tmdbApiKey, ctx.fanartApiKey,
      ctx.folderKind === 'anime' ? 'anime' : 'tv',
    );
  }

  if (isTV || ctx.folderKind === 'tv' || ctx.folderKind === 'anime') {
    return buildTVItemFromFolder(
      folderPath, folderName, id, subtitles,
      parsedFolder.year, parsedFolder.title,
      ctx.omdbApiKey,
      ctx.folderKind === 'anime' || isLikelyAnimePath(folderPath, parsedFolder.title) ? 'anime' : 'tv',
      ctx.tmdbApiKey,
      ctx.fanartApiKey,
      ctx.openSubtitles,
    );
  }

  return buildMovieItemFromFile(
    path.join(folderPath, videoFiles[0]),
    videoFiles[0], parsedFolder.title,
    subtitles, parsedFolder.year,
    ctx.omdbApiKey, ctx.tmdbApiKey, ctx.fanartApiKey,
    ctx.folderKind === 'anime' ? 'anime' : undefined,
  );
}

async function scanFolder(
  folderPath: string,
  ctx: ScanContext,
  onItems?: (items: MediaItem[]) => void | Promise<void>,
): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  if (!fs.existsSync(folderPath)) return items;

  const addItems = async (nextItems: MediaItem[]) => {
    items.push(...nextItems);
    if (nextItems.length > 0) await onItems?.(nextItems);
  };

  try {
    const rootEntries = fs.readdirSync(folderPath, { withFileTypes: true });

    const rootVideoFiles = rootEntries
      .filter((entry) => !entry.isDirectory() && isVideoFileName(entry.name))
      .map((entry) => entry.name);
    await downloadOpenSubtitlesForVideos(folderPath, rootVideoFiles, ctx);
    const rootSubtitleFiles = subtitleFilesInDirectory(folderPath);

    for (const videoFile of rootVideoFiles) {
      const fullVideoPath = path.join(folderPath, videoFile);
      const probe = probeMediaFile(fullVideoPath);
      const isTVFile = shouldTreatAsTV(videoFile, [videoFile], false, probe);
      if (ctx.folderKind !== 'movies' && isTVFile) continue; // belongs to a show folder, not a standalone movie

      const baseName = path.basename(videoFile, path.extname(videoFile));
      const matchingSubtitles = rootSubtitleFiles.filter((subtitle) =>
        path.basename(subtitle, path.extname(subtitle)).startsWith(baseName),
      );
      const forcedMovieType = ctx.folderKind === 'movies'
        ? 'movie'
        : ctx.folderKind === 'anime'
          ? 'anime'
          : ctx.folderKind === 'tv'
            ? 'tv'
            : undefined;
      await addItems([await buildMovieItemFromFile(
        fullVideoPath, videoFile,
        cleanMediaTitle(videoFile).title,
        createSubtitleRecords(folderPath, matchingSubtitles),
        cleanMediaTitle(videoFile).year,
        ctx.omdbApiKey, ctx.tmdbApiKey, ctx.fanartApiKey,
        forcedMovieType,
      )]);
    }

    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;

      const fullPath = path.join(folderPath, entry.name);

      let dirEntries: fs.Dirent[];
      try { dirEntries = fs.readdirSync(fullPath, { withFileTypes: true }); }
      catch { continue; }

      const videoFiles = dirEntries
        .filter((d) => !d.isDirectory())
        .map((d) => d.name)
        .filter(isVideoFileName);

      await downloadOpenSubtitlesForVideos(fullPath, videoFiles, ctx);
      const subtitleFiles = subtitleFilesInDirectory(fullPath);

      const subDirs = dirEntries.filter((d) => d.isDirectory());
      const hasSeasonDirs = subDirs.some((d) => /season|series/i.test(d.name));

      // Container folder (e.g. "TV Shows/", "Anime/") — recurse
      if (videoFiles.length === 0 && subDirs.length > 0 && !hasSeasonDirs) {
        const nestedEpisodeFiles = scanEpisodeFiles(fullPath);
        if (ctx.folderKind !== 'movies' && nestedEpisodeFiles.length > 0) {
          const parsedFolder = cleanMediaTitle(entry.name);
          const subtitles = createSubtitleRecords(fullPath, subtitleFiles);
          if (!shouldSplitContainerFolder(fullPath, entry.name, subDirs)) {
            const id = createMediaItemId(fullPath);
            const tvItem = await buildTVItemFromFolder(
              fullPath, entry.name, id, subtitles,
              parsedFolder.year, parsedFolder.title,
              ctx.omdbApiKey,
              ctx.folderKind === 'anime' || isLikelyAnimePath(fullPath, parsedFolder.title) ? 'anime' : 'tv',
              ctx.tmdbApiKey,
              ctx.fanartApiKey,
              ctx.openSubtitles,
            );
            if (tvItem) await addItems([tvItem]);
            continue;
          }
        }

        items.push(...await scanFolder(fullPath, ctx, onItems));
        continue;
      }

      const isTV = ctx.folderKind === 'tv'
        || ctx.folderKind === 'anime'
        || (ctx.folderKind !== 'movies' && (hasSeasonDirs || isTVPattern(entry.name, videoFiles)));
      const parsedFolder = cleanMediaTitle(entry.name);
      const subtitles = createSubtitleRecords(fullPath, subtitleFiles);
      const id = createMediaItemId(fullPath);

      if (isTV) {
        const tvItem = await buildTVItemFromFolder(
          fullPath, entry.name, id, subtitles,
          parsedFolder.year, parsedFolder.title,
          ctx.omdbApiKey,
          ctx.folderKind === 'anime' || isLikelyAnimePath(fullPath, parsedFolder.title) ? 'anime' : 'tv',
          ctx.tmdbApiKey,
          ctx.fanartApiKey,
          ctx.openSubtitles,
        );
        if (tvItem) await addItems([tvItem]);
      } else if (videoFiles.length > 0) {
        await addItems([await buildMovieItemFromFile(
          path.join(fullPath, videoFiles[0]),
          videoFiles[0], parsedFolder.title,
          subtitles, parsedFolder.year,
          ctx.omdbApiKey, ctx.tmdbApiKey, ctx.fanartApiKey,
          ctx.folderKind === 'movies' ? 'movie' : undefined,
        )]);
      }
    }
  } catch (error) {
    console.error('scanFolder error:', error);
  }

  return items;
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
  const previousScanCache = data.scanCache || {};
  const nextScanCache: LibraryScanCache = {};
  const totalFolders = flattenLibraryFolders(folderGroups).length;
  const processedFolders = new Set<string>();
  const folderStatusesByPath = new Map<string, LibraryFolderStatus>();
  let scannedFolders = 0;

  const appendItem = (item: MediaItem) => {
    if (item.type === 'anime') animeShows.push({ ...item, type: 'anime' });
    else if (item.type === 'tv') tvShows.push({ ...item, type: 'tv' });
    else movies.push({ ...item, type: 'movie' });
  };

  const appendItems = (items: MediaItem[], folderKind: ScanCacheFolderKind) => {
    for (const item of items) {
      if (folderKind === 'movies') movies.push({ ...item, type: 'movie' });
      else if (folderKind === 'anime') animeShows.push({ ...item, type: 'anime' });
      else if (folderKind === 'tv') tvShows.push({ ...item, type: 'tv' });
      else appendItem(item);
    }
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
      const folderStatus = folderStatusFor(folder, folderKind);
      if (folderStatus.state === 'unavailable') {
        const cachedItems = cachedItemsForFolder(folder, folderKind, { preserveUnavailable: true });
        appendItems(cachedItems, folderKind);
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
        const cachedItems = cachedItemsForFolder(folder, folderKind);
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
          appendItems(partialItems, folderKind);
          await publishProgress(false);
        });

      if (directItem) appendItems(items, folderKind);
      if (folderSignature) {
        nextScanCache[folder] = {
          version: SCAN_CACHE_VERSION,
          folderKind,
          signature: folderSignature.signature,
          subtitleProfile,
          fileCount: folderSignature.fileCount,
          itemCount: items.length,
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
      ? { ...next, id: createMediaItemId(next.filePath), title: localTitle || next.title }
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

function stripInlineArtworkFromItem(item: MediaItem): MediaItem {
  return {
    ...item,
    poster: durableArtworkSource(item.poster),
    backdrop: durableArtworkSource(item.backdrop),
    logo: durableArtworkSource(item.logo),
    posterCandidates: durableArtworkSources(item.posterCandidates),
    backdropCandidates: durableArtworkSources(item.backdropCandidates),
    logoCandidates: durableArtworkSources(item.logoCandidates),
    episodes: item.episodes?.map((episode) => ({
      ...episode,
      still: durableArtworkSource(episode.still),
    })),
  };
}

function stripInlineArtworkFromLibrary(data: LibraryData): LibraryData {
  return {
    ...data,
    movies: (data.movies || []).map(stripInlineArtworkFromItem),
    tvShows: (data.tvShows || []).map(stripInlineArtworkFromItem),
    animeShows: (data.animeShows || []).map(stripInlineArtworkFromItem),
  };
}

function itemWithArtworkDeliveryUrls(item: MediaItem): MediaItem {
  const poster = artworkDeliveryUrl(item.poster);
  const backdrop = artworkDeliveryUrl(item.backdrop);
  const logo = artworkDeliveryUrl(item.logo);
  const posterCandidates = artworkDeliveryUrls(item.posterCandidates);
  const backdropCandidates = artworkDeliveryUrls(item.backdropCandidates);
  const logoCandidates = artworkDeliveryUrls(item.logoCandidates);

  return {
    ...item,
    poster,
    backdrop,
    logo,
    posterCandidates,
    backdropCandidates,
    logoCandidates,
    subtitles: subtitleRecordsForRenderer(item.subtitles),
    episodes: item.episodes?.map((episode) => ({
      ...episode,
      still: artworkDeliveryUrl(episode.still),
    })),
    episodeFiles: item.episodeFiles?.map((episodeFile) => ({
      ...episodeFile,
      subtitles: subtitleRecordsForRenderer(episodeFile.subtitles),
    })),
  };
}

function libraryForRenderer(data: LibraryData = loadLibrary()): LibraryData {
  const libraryFolderGroups = normalizeLibraryFolderGroups(data);
  return {
    ...data,
    libraryFolders: flattenLibraryFolders(libraryFolderGroups),
    libraryFolderGroups,
    libraryFolderStatuses: libraryFolderStatusesFor(libraryFolderGroups),
    movies: (data.movies || []).map(itemWithArtworkDeliveryUrls),
    tvShows: (data.tvShows || []).map(itemWithArtworkDeliveryUrls),
    animeShows: (data.animeShows || []).map(itemWithArtworkDeliveryUrls),
  };
}

function appendLocalAccessTokenToUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(LOCAL_ACCESS_QUERY_PARAM, LOCAL_ACCESS_TOKEN);
  return parsed.toString();
}

function signedStreamUrlForRemote(base: string, filePath: string): string {
  return buildSignedLanUrl(base, '/stream', new URLSearchParams({ path: filePath }));
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

function itemForLocalNetwork(item: MediaItem, base: string, token: string): MediaItem {
  const episodeThumbnailFallback = item.episodeFiles?.[0] ? getRemoteThumbnailUrl(item.episodeFiles[0].filePath, base) : '';
  const posterCandidates = artworkDeliveryUrls(item.posterCandidates).map((url) => remoteArtworkDeliveryUrl(url, base, token));
  const backdropCandidates = artworkDeliveryUrls(item.backdropCandidates).map((url) => remoteArtworkDeliveryUrl(url, base, token));
  const logoCandidates = artworkDeliveryUrls(item.logoCandidates).map((url) => remoteArtworkDeliveryUrl(url, base, token));
  const poster = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.poster), base, token)
    || posterCandidates[0]
    || episodeThumbnailFallback;
  const backdrop = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.backdrop), base, token)
    || backdropCandidates[0]
    || poster;
  const logo = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.logo), base, token);

  const stillByEpisode = new Map(
    (item.episodes || []).map((episode) => [
      `${episode.season}-${episode.number}`,
      remoteArtworkDeliveryUrl(artworkDeliveryUrl(episode.still), base, token),
    ]),
  );

  return {
    ...item,
    filePath: signedStreamUrlForRemote(base, item.filePath),
    poster,
    backdrop,
    logo,
    posterCandidates,
    backdropCandidates,
    logoCandidates,
    localMetadata: localMetadataWithTracks(item.filePath, item.localMetadata),
    subtitles: subtitleRecordsForLocalNetwork(item.subtitles, base),
    episodes: item.episodes?.map((episode) => ({
      ...episode,
      still: remoteArtworkDeliveryUrl(artworkDeliveryUrl(episode.still), base, token),
    })),
    episodeFiles: item.episodeFiles?.map((episodeFile) => ({
      ...episodeFile,
      filePath: signedStreamUrlForRemote(base, episodeFile.filePath),
      still: stillByEpisode.get(`${episodeFile.season}-${episodeFile.episode}`) || '',
      thumbnail: getRemoteThumbnailUrl(episodeFile.filePath, base),
      localMetadata: localMetadataWithTracks(episodeFile.filePath, episodeFile.localMetadata),
      subtitles: subtitleRecordsForLocalNetwork(episodeFile.subtitles, base),
    })),
  };
}

function libraryForLocalNetwork(): LibraryData {
  const base = getLanServerBase() || `http://127.0.0.1:${getMediaServerPort()}`;
  const token = getLanShareToken();
  const data = loadLibrary();
  return {
    ...data,
    libraryFolders: [],
    libraryFolderGroups: { movies: [], tvShows: [], anime: [], others: [] },
    libraryFolderStatuses: [],
    movies: (data.movies || []).map((item) => itemForLocalNetwork(item, base, token)),
    tvShows: (data.tvShows || []).map((item) => itemForLocalNetwork(item, base, token)),
    animeShows: (data.animeShows || []).map((item) => itemForLocalNetwork(item, base, token)),
  };
}

let artworkCacheQueue: Promise<void> = Promise.resolve();

async function cacheArtworkNow(data: LibraryData): Promise<void> {
  const snapshot = stripInlineArtworkFromLibrary(data);
  artworkCacheQueue = artworkCacheQueue
    .catch(() => undefined)
    .then(() => cacheLibraryArtwork(snapshot));
  await artworkCacheQueue;
}

function saveLibrary(data: LibraryData): void {
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
  } catch (e) {
    console.error('saveLibrary error:', e);
  }
}

function saveLibraryMutation(data: LibraryData): void {
  libraryMutationVersion++;
  saveLibrary(data);
}

function saveLibraryFromScan(data: LibraryData, scanVersion: number): boolean {
  if (scanVersion !== libraryMutationVersion) return false;
  saveLibrary(data);
  return true;
}

type OfficialArtworkRefreshResult = {
  thumbnail?: string;
  cover?: string;
  summary?: string;
  rating?: number;
  episodes?: EpisodeMeta[];
  episodeSource?: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
  posterCandidates: string[];
  backdropCandidates: string[];
  logo?: string;
  logoCandidates: string[];
};

export type OfficialMetadataCandidate = OfficialArtworkRefreshResult & {
  id: string;
  source: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
  title: string;
  year?: number;
  genres?: string[];
  episodeCount?: number;
  episodePreview?: string[];
};

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
    episodes,
    episodeSource,
    posterCandidates,
    backdropCandidates,
    logo: logoCandidates[0] || '',
    logoCandidates,
  };
}

async function applyOfficialMetadataCandidate(mediaId: string, candidate: OfficialMetadataCandidate): Promise<OfficialArtworkRefreshResult> {
  const library = loadLibrary();
  const target = findLibraryMediaItem(library, mediaId);

  if (!target) {
    throw new Error('Media item was not found in the library.');
  }

  if (candidate.title) target.title = candidate.title;
  if (candidate.year) target.year = candidate.year;
  if (candidate.thumbnail) target.poster = candidate.thumbnail;
  if (candidate.cover) target.backdrop = candidate.cover;
  if (candidate.logo) target.logo = candidate.logo;
  if (candidate.summary) target.summary = candidate.summary;
  if (candidate.rating) target.rating = candidate.rating;
  if (candidate.genres?.length) target.genres = candidate.genres;
  mergeEpisodeMetadataForTarget(target, candidate.episodes, candidate.source);
  target.posterCandidates = orderedArtworkCandidates(
    ...(candidate.posterCandidates || []),
    candidate.thumbnail,
    ...officialArtworkOnly(target.posterCandidates || []),
    target.poster,
  );
  target.backdropCandidates = orderedArtworkCandidates(
    ...(candidate.backdropCandidates || []),
    candidate.cover,
    ...officialArtworkOnly(target.backdropCandidates || []),
    target.backdrop,
  );
  target.logoCandidates = orderedArtworkCandidates(
    ...(candidate.logoCandidates || []),
    candidate.logo,
    ...officialArtworkOnly(target.logoCandidates || []),
    target.logo,
  );
  saveLibrary(library);
  await cacheArtworkNow(library);

  return {
    thumbnail: candidate.thumbnail || target.poster || '',
    cover: candidate.cover || target.backdrop || candidate.thumbnail || target.poster || '',
    summary: candidate.summary || target.summary || '',
    rating: candidate.rating || target.rating || 0,
    episodes: target.type === 'movie' ? undefined : target.episodes,
    episodeSource: candidate.source,
    posterCandidates: target.posterCandidates || [],
    backdropCandidates: target.backdropCandidates || [],
    logo: candidate.logo || target.logo || '',
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

async function refreshOfficialArtwork(mediaId: string): Promise<OfficialArtworkRefreshResult> {
  const library = loadLibrary();
  const target = findLibraryMediaItem(library, mediaId);

  if (!target) {
    throw new Error('Media item was not found in the library.');
  }

  const refreshed = await fetchOfficialArtworkForItem(target);
  if (refreshed.thumbnail || refreshed.cover || refreshed.logo || refreshed.summary || refreshed.rating || refreshed.episodes?.length) {
    if (refreshed.thumbnail) target.poster = refreshed.thumbnail;
    if (refreshed.cover) target.backdrop = refreshed.cover;
    if (refreshed.logo) target.logo = refreshed.logo;
    if (refreshed.summary) target.summary = refreshed.summary;
    if (refreshed.rating) target.rating = refreshed.rating;
    mergeEpisodeMetadataForTarget(target, refreshed.episodes, refreshed.episodeSource || 'refresh');
    target.posterCandidates = orderedArtworkCandidates(
      ...refreshed.posterCandidates,
      ...officialArtworkOnly(target.posterCandidates || []),
      target.poster,
    );
    target.backdropCandidates = orderedArtworkCandidates(
      ...refreshed.backdropCandidates,
      ...officialArtworkOnly(target.backdropCandidates || []),
      target.backdrop,
    );
    target.logoCandidates = orderedArtworkCandidates(
      ...refreshed.logoCandidates,
      ...officialArtworkOnly(target.logoCandidates || []),
      target.logo,
    );
    saveLibrary(library);
    await cacheArtworkNow(library);
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

registerIpcHandlers<LibraryData, AppSettings, OfficialMetadataCandidate, UpdateState>({
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
});

// ── VideoPlayer uses HTML5 <video> + the HTTP media server directly.
// No player:* IPC handlers needed.

// ─── App lifecycle ────────────────────────────────────────────────────────────

export const mediaServerDeps = {
  ALLOWED_CORS_ORIGINS,
  LOCAL_ACCESS_HEADER,
  LOCAL_ACCESS_TOKEN,
  addFolderToLibrary,
  allowedCorsOrigin,
  appendLocalAccessTokenToUrl,
  applyOfficialMetadataCandidate,
  authorizeLanRequest,
  authorizeLocalRequest,
  cacheArtworkNow,
  clearAppData,
  customArtworkForRenderer,
  decodeDataUrl,
  getLanServerBase,
  getLanShareToken,
  getLibraryMutationVersion: () => libraryMutationVersion,
  getOfficialMetadataCandidates,
  getPlaybackTrackPreferences,
  getPlaybackLogo,
  handleLanPairRequest,
  isExternalArtworkUrl,
  isImageFileName,
  isLanSharingEnabled,
  isLoopbackRequest,
  isSignedLanRequestValid,
  libraryEtagFor,
  libraryForLocalNetwork,
  libraryForRenderer,
  loadLibrary,
  loadSettings,
  localAccessQuery,
  needsBrowserTranscoding,
  browserPlaybackPlan,
  readJsonBody,
  redirectToArtworkSource,
  refreshOfficialArtwork,
  removeFolderFromLibrary,
  requireLocalOrLanAccess,
  requireStreamAccess,
  requestToken,
  safeEndResponse,
  safeResult,
  saveLibraryFromScan,
  saveLibraryMutation,
  savePlaybackTrackPreferences,
  saveSettings,
  scanLibrary,
  showOpenFolderDialog,
  writeJson,
};

app.whenReady().then(async () => {
  applyAppIcon();
  cleanupOldTranscodes();
  await startMediaServer(mediaServerDeps);
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
