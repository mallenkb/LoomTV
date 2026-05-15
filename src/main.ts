import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  nativeImage,
  ipcMain,
  protocol,
  net,
  shell,
} from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { autoUpdater } from 'electron-updater';
import { mpvController } from './main/mpv/mpvController';
import {
  advertiseLanService,
  destroyLanDiscovery,
  discoverLanPeers,
  unadvertiseLanService,
} from './main/lanDiscovery';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import {
  getLocalState,
  pauseLocal,
  playLocal,
  resumeLocal,
  seekLocal,
  setLocalVolume,
  stopLocal,
} from './main/localPlaybackEngine';
import { assertLocalMediaPath, canDirectPlay, probeMedia } from './main/mediaProbe';
import type { ApiResult, SubtitleStyleOptions, TranscodeOptions } from './main/mediaTypes';
import {
  cleanupOldTranscodes,
  serveHls,
  startTranscode,
  stopAllTranscodes,
  stopTranscode,
} from './main/transcodeManager';
import {
  backupDatabase,
  cacheLibraryArtwork,
  clearDatabase,
  getAllProgress,
  getCachedArtwork,
  getCustomArtwork,
  getProgress,
  importCustomArtwork,
  importProgress,
  loadLibraryFromDatabase,
  loadSettingsFromDatabase,
  saveCustomArtwork,
  saveLibraryToDatabase,
  saveProgress,
  saveSettingsToDatabase,
} from './main/database';
import {
  cleanMediaTitle,
  isGenericGroupingFolderTitle,
  normalizeTitleForMatch,
  numericRating,
  parseYearFromText,
  remoteMatchesAnyLocalTitle,
  titleMatchesLocal,
  uniqueLocalTitles,
  usefulLocalTitle,
} from './main/metadata/helpers';
import type {
  EpisodeFile as MetadataEpisodeFile,
  EpisodeMeta as MetadataEpisodeMeta,
  LocalMediaDetails as MetadataLocalMediaDetails,
  MediaItem as MetadataMediaItem,
  TVMetadata as MetadataTVMetadata,
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
  type JikanAnimeResult,
  fetchJikanMetadata,
  fetchJikanMetadataCandidates,
} from './main/metadata/jikan';

type EpisodeMeta = MetadataEpisodeMeta;
type EpisodeFile = MetadataEpisodeFile;
type LocalMediaDetails = MetadataLocalMediaDetails;
type MediaItem = MetadataMediaItem;
type TVMetadata = MetadataTVMetadata;

function ignoreBrokenConsolePipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

ignoreBrokenConsolePipe(process.stdout);
ignoreBrokenConsolePipe(process.stderr);

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const squirrelStartup: boolean = require('electron-squirrel-startup');
  if (squirrelStartup) app.quit();
} catch {
  // electron-squirrel-startup is optional and missing in some envs.
}

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

app.setName('LoomTV');
const USER_DATA_DIR = path.join(app.getPath('appData'), 'LoomTV');
app.setPath('userData', USER_DATA_DIR);

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const LIBRARY_FILE = path.join(app.getPath('userData'), 'library.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const SCAN_CACHE_VERSION = 8;
let libraryMutationVersion = 0;

let mediaServerPort = 3847;
let mediaServer: http.Server | null = null;
const UPDATE_OWNER = 'mallenkb';
const UPDATE_REPO = 'LoomTV';

type UpdateStatus =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'not-available'
  | 'error';

interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  supported: boolean;
  downloadPercent?: number;
  latestVersion?: string;
  releaseUrl?: string;
  message?: string;
  checkedAt?: string;
}

let updateState: UpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  supported: isUpdaterSupportedPlatform(),
};
let updaterConfigured = false;
let updateCheckInFlight = false;
let updateCheckPromise: Promise<UpdateState> | null = null;
let updateInstallStarted = false;
let updatePromptInFlight = false;
let updateCheckTimer: NodeJS.Timeout | null = null;
let updateMenu: Menu | null = null;
const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAIN_WINDOW_DEV_SERVER_URL =
  typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;
const MAIN_WINDOW_NAME =
  typeof MAIN_WINDOW_VITE_NAME === 'string' && MAIN_WINDOW_VITE_NAME ? MAIN_WINDOW_VITE_NAME : 'main_window';

function isUpdaterSupportedPlatform(): boolean {
  return process.platform === 'darwin'
    || process.platform === 'win32'
    || (process.platform === 'linux' && Boolean(process.env.APPIMAGE));
}

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface LibraryData {
  movies: MediaItem[];
  tvShows: MediaItem[];
  animeShows: MediaItem[];
  libraryFolders: string[];
  libraryFolderGroups?: LibraryFolderGroups;
  scanCache?: LibraryScanCache;
}

type LibraryScanProgress = LibraryData & {
  isComplete: boolean;
  scannedFolders: number;
  totalFolders: number;
};

type LibraryFolderKind = 'movies' | 'tvShows' | 'anime' | 'others';
type ScanFolderKind = 'movies' | 'tv' | 'anime';
type ScanCacheFolderKind = ScanFolderKind | 'auto';
type LibraryScanMode = 'quick' | 'metadata' | 'full';

interface LibraryFolderGroups {
  movies: string[];
  tvShows: string[];
  anime: string[];
  others: string[];
}

interface MetadataProviderIds {
  tmdbId?: string;
  imdbId?: string;
  tvdbId?: string;
}

interface ScanCacheEntry {
  version?: number;
  folderKind: ScanCacheFolderKind;
  signature: string;
  fileCount: number;
  itemCount: number;
  scannedAt: number;
}

type LibraryScanCache = Record<string, ScanCacheEntry>;

interface ProbeMediaFileResult {
  localMetadata?: LocalMediaDetails;
  embeddedTitle?: string;
  embeddedShowTitle?: string;
  embeddedThumbnailStreamIndex?: number;
  summary?: string;
  year?: number;
  season?: number;
  episode?: number;
  providerIds?: MetadataProviderIds;
}

interface AppSettings {
  omdbApiKey?: string;
  tmdbApiKey?: string;
  metadataApiKeys?: Record<string, string>;
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

const METADATA_KEY_ALIASES: Record<string, keyof Pick<AppSettings, 'omdbApiKey' | 'tmdbApiKey'>> = {
  omdb: 'omdbApiKey',
  tmdb: 'tmdbApiKey',
};

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeSettings(raw: AppSettings): AppSettings {
  const metadataApiKeys: Record<string, string> = {};
  const rawKeys = raw.metadataApiKeys || {};
  const autoSyncIntervalHours = Number(raw.autoSyncIntervalHours);
  const defaultSidebarNavOrder = ['anime', 'tv', 'movies', 'others'];
  const rawSidebarNavOrder = Array.isArray(raw.sidebarNavOrder) ? raw.sidebarNavOrder : [];
  const sidebarNavOrder = [
    ...rawSidebarNavOrder.filter((item) => defaultSidebarNavOrder.includes(item)),
    ...defaultSidebarNavOrder.filter((item) => !rawSidebarNavOrder.includes(item)),
  ];

  for (const [provider, value] of Object.entries(rawKeys)) {
    const providerId = normalizeProviderId(provider);
    const apiKey = typeof value === 'string' ? value.trim() : '';
    if (providerId && apiKey) metadataApiKeys[providerId] = apiKey;
  }

  if (raw.omdbApiKey?.trim()) metadataApiKeys.omdb = raw.omdbApiKey.trim();
  if (raw.tmdbApiKey?.trim()) metadataApiKeys.tmdb = raw.tmdbApiKey.trim();

  return {
    ...raw,
    omdbApiKey: metadataApiKeys.omdb || '',
    tmdbApiKey: metadataApiKeys.tmdb || '',
    metadataApiKeys,
    autoSyncIntervalHours: Number.isFinite(autoSyncIntervalHours) && autoSyncIntervalHours > 0
      ? autoSyncIntervalHours
      : 12,
    playbackSkipBackSeconds: Number.isFinite(Number(raw.playbackSkipBackSeconds)) && Number(raw.playbackSkipBackSeconds) > 0
      ? Number(raw.playbackSkipBackSeconds)
      : 10,
    playbackSkipForwardSeconds: Number.isFinite(Number(raw.playbackSkipForwardSeconds)) && Number(raw.playbackSkipForwardSeconds) > 0
      ? Number(raw.playbackSkipForwardSeconds)
      : 15,
    sidebarNavOrder,
    appThemeMode: 'dark',
    appThemeColor: raw.appThemeColor === 'yellow' || raw.appThemeColor === 'red' || raw.appThemeColor === 'blue' || raw.appThemeColor === 'orange'
      ? raw.appThemeColor
      : 'yellow',
    appDarkTheme: raw.appDarkTheme === 'default' || raw.appDarkTheme === 'justwatch' || raw.appDarkTheme === 'black'
      ? raw.appDarkTheme
      : 'black',
    appLoaderStyle: raw.appLoaderStyle === 'logo-mark' || raw.appLoaderStyle === 'horizontal-logo' || raw.appLoaderStyle === 'play-mark'
      ? raw.appLoaderStyle
      : 'play-mark',
    localNetworkSharingEnabled: Boolean(raw.localNetworkSharingEnabled),
    localNetworkShareToken: raw.localNetworkShareToken && /^\d{6}$/.test(raw.localNetworkShareToken)
      ? raw.localNetworkShareToken
      : createLanShareCode(),
    localNetworkDeviceId: typeof raw.localNetworkDeviceId === 'string' && raw.localNetworkDeviceId.length >= 8
      ? raw.localNetworkDeviceId
      : randomUUID(),
    localNetworkDeviceName: typeof raw.localNetworkDeviceName === 'string' && raw.localNetworkDeviceName.trim()
      ? raw.localNetworkDeviceName.trim().slice(0, 80)
      : os.hostname(),
    localNetworkHmacSecret: typeof raw.localNetworkHmacSecret === 'string' && /^[0-9a-f]{32,}$/i.test(raw.localNetworkHmacSecret)
      ? raw.localNetworkHmacSecret
      : randomBytes(32).toString('hex'),
    localNetworkPairedDevices: Array.isArray(raw.localNetworkPairedDevices)
      ? raw.localNetworkPairedDevices
        .filter((entry): entry is LanPairedDevice =>
          !!entry
          && typeof entry.id === 'string'
          && typeof entry.token === 'string'
          && /^[0-9a-f]{32,}$/i.test(entry.token))
        .map((entry) => ({
          id: entry.id,
          name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 80) : 'Unnamed device',
          token: entry.token,
          createdAt: Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : Date.now(),
          lastSeenAt: Number.isFinite(entry.lastSeenAt) ? Number(entry.lastSeenAt) : Date.now(),
          lastAddress: typeof entry.lastAddress === 'string' ? entry.lastAddress : undefined,
        }))
      : [],
  };
}

function getMetadataApiKey(settings: AppSettings, providerId: string): string | undefined {
  const normalized = normalizeSettings(settings);
  const id = normalizeProviderId(providerId);
  const directKey = normalized.metadataApiKeys?.[id]?.trim();
  if (directKey) return directKey;

  const legacyField = METADATA_KEY_ALIASES[id];
  return legacyField ? normalized[legacyField]?.trim() || undefined : undefined;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
  const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/s);
  if (!match) return null;
  return {
    mimeType: match[1] || 'application/octet-stream',
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function redirectToArtworkSource(res: http.ServerResponse, sourceUrl: string): void {
  res.writeHead(302, {
    Location: sourceUrl,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end();
}

function safeEndResponse(res: http.ServerResponse): void {
  if (!res.writableEnded) res.end();
}

function createLanShareCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

async function safeResult<T>(fn: () => T | Promise<T>): Promise<ApiResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

function loadSettings(): AppSettings {
  const databaseSettings = loadSettingsFromDatabase();
  if (databaseSettings) return normalizeSettings(databaseSettings as AppSettings);

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const settings = normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as AppSettings);
      saveSettingsToDatabase(settings as unknown as Record<string, unknown>);
      return settings;
    }
  } catch (e) {}
  return normalizeSettings({});
}

function saveSettings(settings: AppSettings): void {
  try {
    saveSettingsToDatabase(normalizeSettings(settings) as unknown as Record<string, unknown>);
  } catch (e) {}
}

// ─── FFmpeg ──────────────────────────────────────────────────────────────────

function isCompatibleDarwinBinary(binaryPath: string): boolean {
  if (process.platform !== 'darwin') return true;

  try {
    const description = execFileSync('file', [binaryPath], { encoding: 'utf8' });
    if (process.arch === 'arm64') {
      return description.includes('arm64');
    }
    if (process.arch === 'x64') {
      return description.includes('x86_64');
    }
  } catch (error) {
    return true;
  }

  return true;
}

function existingCompatibleBinary(candidate?: string | null): string | null {
  if (!candidate) return null;
  try {
    if (fs.existsSync(candidate) && isCompatibleDarwinBinary(candidate)) {
      return candidate;
    }
  } catch (error) {}
  return null;
}

function binaryName(name: 'ffmpeg' | 'ffprobe'): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function platformFolder(): 'win' | 'mac' | 'linux' {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function bundledMediaBinary(name: 'ffmpeg' | 'ffprobe'): string | null {
  const relative = path.join('ffmpeg', platformFolder(), binaryName(name));
  return firstExistingBinary([
    path.join(process.resourcesPath || '', relative),
    path.join(app.getAppPath(), 'resources', relative),
    path.join(process.cwd(), 'resources', relative),
  ]);
}

function systemBinaryCandidates(name: 'ffmpeg' | 'ffprobe'): string[] {
  const executable = binaryName(name);
  const candidates = [
    `/opt/homebrew/bin/${executable}`,
    `/usr/local/bin/${executable}`,
    `/opt/local/bin/${executable}`,
    `/usr/bin/${executable}`,
    `/snap/bin/${executable}`,
  ];

  try {
    const whichResult = execFileSync('which', ['-a', executable], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    candidates.push(...whichResult);
  } catch (e) {}

  return [...new Set(candidates)];
}

function hasFFmpegEncoder(binaryPath: string, encoder: string): boolean {
  try {
    const output = execFileSync(binaryPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return output.includes(encoder);
  } catch (e) {
    return false;
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

type H264HardwareEncoder = 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv';

function preferredH264HardwareEncoder(binaryPath: string): H264HardwareEncoder | null {
  const candidates: H264HardwareEncoder[] =
    process.platform === 'darwin'
      ? ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv']
      : process.platform === 'win32'
        ? ['h264_nvenc', 'h264_qsv', 'h264_videotoolbox']
        : ['h264_nvenc', 'h264_qsv', 'h264_videotoolbox'];

  return candidates.find((encoder) => hasFFmpegEncoder(binaryPath, encoder)) || null;
}

function appendH264EncoderOptions(args: string[], encoder: H264HardwareEncoder): void {
  if (encoder === 'h264_videotoolbox') {
    args.push(
      '-allow_sw', '1',
      '-realtime', '1',
      '-b:v', '6500k',
      '-maxrate', '8500k',
      '-bufsize', '12000k',
      '-profile:v', 'main',
    );
    return;
  }

  if (encoder === 'h264_nvenc') {
    args.push('-preset', 'p4', '-cq', '23', '-b:v', '0');
    return;
  }

  args.push('-global_quality', '23', '-look_ahead', '0');
}

function firstExistingBinary(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const binary = existingCompatibleBinary(candidate);
    if (binary) return binary;
  }
  return null;
}

function findFFmpeg(): string | null {
  const bundled = bundledMediaBinary('ffmpeg');
  const appNodeModule = path.join(
    app.getAppPath(),
    'node_modules',
    'ffmpeg-static',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  );
  const candidates = [
    bundled,
    ffmpegStatic,
    appNodeModule,
    ...systemBinaryCandidates('ffmpeg'),
  ];

  for (const candidate of candidates) {
    const binary = existingCompatibleBinary(candidate);
    if (binary && preferredH264HardwareEncoder(binary)) return binary;
  }

  return firstExistingBinary(candidates);
}

function findFFprobe(): string | null {
  const bundled = bundledMediaBinary('ffprobe');
  if (bundled) return bundled;

  try {
    const staticBinary = existingCompatibleBinary(ffprobeStatic?.path);
    if (staticBinary) return staticBinary;
  } catch (e) {}
  try {
    if (ffmpegStatic) {
      const sibling = path.join(path.dirname(ffmpegStatic), binaryName('ffprobe'));
      const siblingBinary = existingCompatibleBinary(sibling);
      if (siblingBinary) return siblingBinary;
    }
  } catch (e) {}
  try {
    const candidate = path.join(
      app.getAppPath(),
      'node_modules',
      'ffprobe-static',
      'bin',
      process.platform,
      process.arch,
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
    );
    const bundledBinary = existingCompatibleBinary(candidate);
    if (bundledBinary) return bundledBinary;
  } catch (e) {}

  return firstExistingBinary(systemBinaryCandidates('ffprobe'));
}

function needsTranscoding(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.mkv', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.m2ts', '.3gp', '.ts'].includes(ext);
}

function needsBrowserTranscoding(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (needsTranscoding(filePath)) return true;
  if (!['.mp4', '.m4v', '.mov', '.webm'].includes(ext)) return true;

  const probe = probeMediaFile(filePath);
  const videoCodec = (probe.localMetadata?.videoCodec || '').toLowerCase();
  const videoProfile = (probe.localMetadata?.videoProfile || '').toLowerCase();
  const pixelFormat = (probe.localMetadata?.pixelFormat || '').toLowerCase();
  const audioCodec = (probe.localMetadata?.audioCodec || '').toLowerCase();

  if (ext === '.webm') {
    return !['vp8', 'vp9', 'av1'].includes(videoCodec) || !['opus', 'vorbis'].includes(audioCodec);
  }

  const safeH264 = videoCodec === 'h264'
    && pixelFormat === 'yuv420p'
    && !videoProfile.includes('10');

  return !safeH264 || !['aac', 'mp3'].includes(audioCodec);
}

function queryNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function streamMap(type: 'v' | 'a', selectedIndex?: number, optional = false): string {
  const suffix = optional ? '?' : '';
  return typeof selectedIndex === 'number' && selectedIndex >= 0
    ? `0:${selectedIndex}${suffix}`
    : `0:${type}:0${suffix}`;
}

function filterStream(selectedIndex?: number, fallback = '0:v:0'): string {
  return typeof selectedIndex === 'number' && selectedIndex >= 0 ? `0:${selectedIndex}` : fallback;
}

function escapeFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function isBitmapSubtitleCodec(codec?: string): boolean {
  const normalized = (codec || '').toLowerCase();
  return normalized.includes('pgs') || normalized.includes('dvd') || normalized.includes('dvb');
}

type SubtitlePlacement = 'primary' | 'secondary';

interface SubtitleSelection {
  trackIndex: number;
  streamOrdinal: number;
  codec?: string;
  placement: SubtitlePlacement;
}

function subtitleSelections(options: TranscodeOptions): SubtitleSelection[] {
  const selections: SubtitleSelection[] = [];
  if (typeof options.subtitleTrackIndex === 'number' && options.subtitleTrackIndex >= 0) {
    selections.push({
      trackIndex: options.subtitleTrackIndex,
      streamOrdinal: typeof options.subtitleStreamOrdinal === 'number' ? options.subtitleStreamOrdinal : 0,
      codec: options.subtitleCodec,
      placement: 'primary',
    });
  }

  if (
    typeof options.secondarySubtitleTrackIndex === 'number'
    && options.secondarySubtitleTrackIndex >= 0
    && options.secondarySubtitleTrackIndex !== options.subtitleTrackIndex
  ) {
    selections.push({
      trackIndex: options.secondarySubtitleTrackIndex,
      streamOrdinal: typeof options.secondarySubtitleStreamOrdinal === 'number'
        ? options.secondarySubtitleStreamOrdinal
        : 0,
      codec: options.secondarySubtitleCodec,
      placement: 'secondary',
    });
  }

  return selections;
}

function hasSubtitleSelection(options: TranscodeOptions): boolean {
  return subtitleSelections(options).length > 0;
}

function hasBitmapSubtitleSelection(options: TranscodeOptions): boolean {
  return subtitleSelections(options).some((selection) => isBitmapSubtitleCodec(selection.codec));
}

function clampStyleNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function assColor(value: unknown, fallback: string): string {
  const hex = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  const red = hex.slice(1, 3);
  const green = hex.slice(3, 5);
  const blue = hex.slice(5, 7);
  return `&H00${blue}${green}${red}`.toUpperCase();
}

function subtitleForceStyle(style?: SubtitleStyleOptions, placement: SubtitlePlacement = 'primary'): string {
  const fontSize = clampStyleNumber(style?.fontSize, 32, 24, 96) * clampStyleNumber(style?.scale, 1, 0.5, 2);
  const position = placement === 'secondary' ? 8 : clampStyleNumber(style?.position, 96, 0, 100);
  const marginV = placement === 'secondary'
    ? Math.round(position * 6)
    : Math.round((100 - position) * 6);
  const borderWidth = clampStyleNumber(style?.borderWidth, 3, 0, 10);

  return [
    `Fontsize=${Math.round(fontSize)}`,
    `PrimaryColour=${assColor(style?.fontColor, '#ffffff')}`,
    `OutlineColour=${assColor(style?.borderColor, '#000000')}`,
    `BackColour=${assColor(style?.backgroundColor, '#000000')}`,
    `Outline=${borderWidth}`,
    'Shadow=0',
    `Alignment=${placement === 'secondary' ? 8 : 2}`,
    `MarginV=${marginV}`,
  ].join(',');
}

function subtitleFilterSegment(
  filePath: string,
  subtitleOrdinal: number,
  style?: SubtitleStyleOptions,
  placement: SubtitlePlacement = 'primary',
): string {
  return `subtitles='${escapeFilterPath(filePath)}':si=${subtitleOrdinal}:force_style='${subtitleForceStyle(style, placement)}'`;
}

function textSubtitleFilter(
  filePath: string,
  subtitleOrdinal: number,
  style?: SubtitleStyleOptions,
  startSeconds = 0,
  secondarySubtitleOrdinal?: number,
): string {
  const subtitleFilters = [subtitleFilterSegment(filePath, subtitleOrdinal, style, 'primary')];
  if (typeof secondarySubtitleOrdinal === 'number' && secondarySubtitleOrdinal >= 0) {
    subtitleFilters.push(subtitleFilterSegment(filePath, secondarySubtitleOrdinal, style, 'secondary'));
  }
  const subtitleFilter = subtitleFilters.join(',');
  const seekOffset = Number.isFinite(startSeconds) && startSeconds > 0 ? Math.floor(startSeconds) : 0;
  if (seekOffset <= 0) return `${subtitleFilter},format=yuv420p`;

  // FFmpeg fast input seeking resets video PTS to zero, but the subtitles
  // filter matches cues against the original file timeline. Temporarily shift
  // frames back to the original timeline while rendering subtitles, then shift
  // them back for playback output.
  return `setpts=PTS+${seekOffset}/TB,${subtitleFilter},setpts=PTS-${seekOffset}/TB,format=yuv420p`;
}

function subtitleFilterComplex(filePath: string, options: TranscodeOptions): { filter: string; output: string } {
  const selections = subtitleSelections(options);
  let currentLabel = filterStream(options.videoTrackIndex);
  const filters: string[] = [];

  selections.forEach((selection, index) => {
    const output = `vsub${index}`;
    if (isBitmapSubtitleCodec(selection.codec)) {
      filters.push(`[${currentLabel}][0:${selection.trackIndex}]overlay,format=yuv420p[${output}]`);
    } else {
      filters.push(
        `[${currentLabel}]${subtitleFilterSegment(filePath, selection.streamOrdinal, options.subtitleStyle, selection.placement)},format=yuv420p[${output}]`,
      );
    }
    currentLabel = output;
  });

  return { filter: filters.join(';'), output: currentLabel };
}

function parseSubtitleStyle(value: string | null): SubtitleStyleOptions | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as SubtitleStyleOptions;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return {
      delaySeconds: clampStyleNumber(parsed.delaySeconds, 0, -5, 5),
      position: clampStyleNumber(parsed.position, 96, 0, 100),
      scale: clampStyleNumber(parsed.scale, 1, 0.5, 2),
      fontSize: clampStyleNumber(parsed.fontSize, 32, 24, 96),
      fontColor: typeof parsed.fontColor === 'string' ? parsed.fontColor : '#ffffff',
      borderColor: typeof parsed.borderColor === 'string' ? parsed.borderColor : '#000000',
      borderWidth: clampStyleNumber(parsed.borderWidth, 3, 0, 10),
      backgroundColor: typeof parsed.backgroundColor === 'string' ? parsed.backgroundColor : '#000000',
    };
  } catch {
    return undefined;
  }
}

function appendStreamOptionParams(params: URLSearchParams, options?: TranscodeOptions): void {
  if (!options) return;
  if (typeof options.startSeconds === 'number' && options.startSeconds > 0) params.set('t', String(Math.floor(options.startSeconds)));
  if (typeof options.videoTrackIndex === 'number') params.set('video', String(options.videoTrackIndex));
  if (typeof options.audioTrackIndex === 'number') params.set('audio', String(options.audioTrackIndex));
  if (typeof options.subtitleTrackIndex === 'number') params.set('subtitle', String(options.subtitleTrackIndex));
  if (typeof options.subtitleStreamOrdinal === 'number') params.set('subtitleOrdinal', String(options.subtitleStreamOrdinal));
  if (options.subtitleCodec) params.set('subtitleCodec', options.subtitleCodec);
  if (typeof options.secondarySubtitleTrackIndex === 'number') params.set('secondarySubtitle', String(options.secondarySubtitleTrackIndex));
  if (typeof options.secondarySubtitleStreamOrdinal === 'number') params.set('secondarySubtitleOrdinal', String(options.secondarySubtitleStreamOrdinal));
  if (options.secondarySubtitleCodec) params.set('secondarySubtitleCodec', options.secondarySubtitleCodec);
  if (options.subtitleStyle) params.set('subtitleStyle', JSON.stringify(options.subtitleStyle));
  if (options.forceTranscode) params.set('forceTranscode', '1');
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/mp4',
    '.m4v': 'video/mp4',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg',
    '.ts': 'video/mp2t',
    '.m2ts': 'video/mp2t',
  };
  return map[ext] || 'video/mp4';
}

function getSubtitleMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.vtt') return 'text/vtt; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function getImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
  };
  return map[ext] || 'application/octet-stream';
}

function getLocalImageUrl(filePath: string): string {
  const params = new URLSearchParams({ path: filePath });
  return `http://127.0.0.1:${mediaServerPort}/api/local-image?${params.toString()}`;
}

function getLocalThumbnailUrl(filePath: string, time = '00:03:00'): string {
  const params = new URLSearchParams({ path: filePath, t: time });
  return `http://127.0.0.1:${mediaServerPort}/api/thumbnail?${params.toString()}`;
}

function getEmbeddedThumbnailUrl(filePath: string, streamIndex?: number): string {
  const params = new URLSearchParams({ path: filePath, embedded: '1' });
  if (streamIndex !== undefined) params.set('stream', String(streamIndex));
  return `http://127.0.0.1:${mediaServerPort}/api/thumbnail?${params.toString()}`;
}

function isInlineArtworkSource(source?: string | null): boolean {
  return /^data:/i.test(source || '');
}

function hasDurableArtworkSource(source?: string | null): boolean {
  return Boolean(source?.trim()) && !isInlineArtworkSource(source);
}

function durableArtworkSource(source?: string | null): string {
  if (!hasDurableArtworkSource(source)) return '';
  return String(source).trim();
}

function durableArtworkSources(sources?: string[]): string[] {
  return Array.from(new Set((sources || []).map(durableArtworkSource).filter(Boolean)));
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function getLocalNetworkAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function getPrimaryLocalNetworkAddress(): string | null {
  return getLocalNetworkAddresses()[0] || null;
}

function cleanNetworkName(value?: string | null): string | null {
  const name = (value || '').trim();
  if (!name || /^<redacted>$/i.test(name) || /not associated/i.test(name)) return null;
  return name;
}

function getWifiDeviceName(): string {
  try {
    const hardwarePorts = execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 1000 });
    return hardwarePorts.match(/Hardware Port: Wi-Fi[\s\S]*?Device: (\S+)/)?.[1] || 'en0';
  } catch {
    return 'en0';
  }
}

function getMacWifiSsid(wifiDevice: string): string | null {
  try {
    const airportNetwork = execFileSync('networksetup', ['-getairportnetwork', wifiDevice], { encoding: 'utf8', timeout: 1000 });
    const match = airportNetwork.match(/Current Wi-Fi Network: (.+)$/m);
    const name = cleanNetworkName(match?.[1]);
    if (name) return name;
  } catch {
    // Try the next source.
  }

  try {
    const summary = execFileSync('ipconfig', ['getsummary', wifiDevice], { encoding: 'utf8', timeout: 1000 });
    const name = cleanNetworkName(summary.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]);
    if (name) return name;
  } catch {
    // Try the next source.
  }

  try {
    const profiler = execFileSync('system_profiler', ['SPAirPortDataType', '-detailLevel', 'mini'], { encoding: 'utf8', timeout: 2500 });
    const currentNetworkBlock = profiler.match(/Current Network Information:\s*\n\s*([^:\n]+):/);
    const name = cleanNetworkName(currentNetworkBlock?.[1] || profiler.match(/^\s*SSID:\s*(.+)$/m)?.[1]);
    if (name) return name;
  } catch {
    // Fall through to interface-based labels.
  }

  return null;
}

function getWindowsWifiSsid(): string | null {
  try {
    const output = execFileSync('netsh', ['wlan', 'show', 'interfaces'], { encoding: 'utf8', timeout: 1500 });
    const connectedBlocks = output.split(/\r?\n\r?\n/).filter((block) => /State\s*:\s*connected/i.test(block));
    const source = connectedBlocks[0] || output;
    const name = cleanNetworkName(source.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]);
    return name;
  } catch {
    return null;
  }
}

function getLinuxWifiSsid(): string | null {
  try {
    const output = execFileSync('iwgetid', ['-r'], { encoding: 'utf8', timeout: 1000 });
    const name = cleanNetworkName(output);
    if (name) return name;
  } catch {
    // Try NetworkManager below.
  }

  try {
    const output = execFileSync('nmcli', ['-t', '-f', 'active,ssid', 'dev', 'wifi'], { encoding: 'utf8', timeout: 1500 });
    const activeLine = output.split(/\r?\n/).find((line) => line.startsWith('yes:'));
    const name = cleanNetworkName(activeLine?.slice('yes:'.length).replace(/\\:/g, ':'));
    if (name) return name;
  } catch {
    // Try iw below.
  }

  try {
    const output = execFileSync('iw', ['dev'], { encoding: 'utf8', timeout: 1000 });
    const interfaces = [...output.matchAll(/Interface\s+(\S+)/g)].map((match) => match[1]);
    for (const networkInterface of interfaces) {
      try {
        const link = execFileSync('iw', ['dev', networkInterface, 'link'], { encoding: 'utf8', timeout: 1000 });
        const name = cleanNetworkName(link.match(/^\s*SSID:\s*(.+)$/m)?.[1]);
        if (name) return name;
      } catch {
        // Try the next interface.
      }
    }
  } catch {
    // Fall through to the generic local label.
  }

  return null;
}

function getLocalNetworkName(): string {
  if (process.platform === 'darwin') {
    const wifiDevice = getWifiDeviceName();
    const ssid = getMacWifiSsid(wifiDevice);
    if (ssid) return ssid;
  } else if (process.platform === 'win32') {
    const ssid = getWindowsWifiSsid();
    if (ssid) return ssid;
  } else if (process.platform === 'linux') {
    const ssid = getLinuxWifiSsid();
    if (ssid) return ssid;
  }

  return getPrimaryLocalNetworkAddress() ? 'Connected locally' : 'No local network detected';
}

function getRequestRemoteAddress(req: http.IncomingMessage): string {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const address = getRequestRemoteAddress(req);
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

function getLanServerBase(): string | null {
  const address = getPrimaryLocalNetworkAddress();
  return address ? `http://${address}:${mediaServerPort}` : null;
}

function isLanSharingEnabled(): boolean {
  return Boolean(loadSettings().localNetworkSharingEnabled);
}

function getLanShareToken(): string {
  const settings = loadSettings();
  if (settings.localNetworkShareToken && /^\d{6}$/.test(settings.localNetworkShareToken)) {
    return settings.localNetworkShareToken;
  }

  const token = createLanShareCode();
  saveSettings({ ...settings, localNetworkShareToken: token });
  return token;
}

function getLanHmacSecret(): string {
  return loadSettings().localNetworkHmacSecret || '';
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function requestBearerToken(req: http.IncomingMessage): string {
  const authHeader = req.headers.authorization || '';
  const bearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length).trim();
  return '';
}

function requestToken(reqUrl: URL, req: http.IncomingMessage): string {
  return requestBearerToken(req) || reqUrl.searchParams.get('token') || '';
}

function findPairedDeviceByToken(token: string): LanPairedDevice | null {
  if (!token) return null;
  const settings = loadSettings();
  const devices = settings.localNetworkPairedDevices || [];
  for (const device of devices) {
    if (timingSafeStringEqual(device.token, token)) return device;
  }
  return null;
}

function touchPairedDevice(deviceId: string, address: string): void {
  const settings = loadSettings();
  const devices = settings.localNetworkPairedDevices || [];
  let changed = false;
  const updated = devices.map((device) => {
    if (device.id !== deviceId) return device;
    changed = true;
    return { ...device, lastSeenAt: Date.now(), lastAddress: address };
  });
  if (changed) saveSettings({ ...settings, localNetworkPairedDevices: updated });
}

function signLanPayload(payload: string): string {
  return createHmac('sha256', getLanHmacSecret()).update(payload).digest('hex');
}

function buildSignedLanUrl(base: string, pathname: string, params: URLSearchParams, ttlSeconds = 24 * 60 * 60): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const nonce = randomBytes(8).toString('hex');
  const signingInput = `${pathname}?${params.toString()}|exp=${expires}|nonce=${nonce}`;
  const sig = signLanPayload(signingInput);
  params.set('exp', String(expires));
  params.set('nonce', nonce);
  params.set('sig', sig);
  return `${base}${pathname}?${params.toString()}`;
}

function isSignedLanRequestValid(reqUrl: URL): boolean {
  const sig = reqUrl.searchParams.get('sig');
  const exp = reqUrl.searchParams.get('exp');
  const nonce = reqUrl.searchParams.get('nonce');
  if (!sig || !exp || !nonce) return false;

  const expSeconds = Number(exp);
  if (!Number.isFinite(expSeconds) || expSeconds < Math.floor(Date.now() / 1000)) return false;

  const params = new URLSearchParams(reqUrl.searchParams);
  params.delete('sig');
  params.delete('exp');
  params.delete('nonce');
  const signingInput = `${reqUrl.pathname}?${params.toString()}|exp=${expSeconds}|nonce=${nonce}`;
  return timingSafeStringEqual(sig, signLanPayload(signingInput));
}

function authorizeLanRequest(reqUrl: URL, req: http.IncomingMessage): { ok: boolean; device?: LanPairedDevice } {
  if (!isLanSharingEnabled()) return { ok: false };
  const token = requestToken(reqUrl, req);
  if (!token) return { ok: false };

  if (timingSafeStringEqual(token, getLanShareToken())) {
    return { ok: true };
  }

  const device = findPairedDeviceByToken(token);
  if (device) {
    touchPairedDevice(device.id, getRequestRemoteAddress(req));
    return { ok: true, device };
  }

  return { ok: false };
}

function requireLocalOrLanAccess(reqUrl: URL, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (isLoopbackRequest(req)) return true;
  if (authorizeLanRequest(reqUrl, req).ok) return true;

  res.writeHead(isLanSharingEnabled() ? 401 : 403, { 'Content-Type': 'text/plain' });
  res.end(isLanSharingEnabled() ? 'Local network pairing is required.' : 'Local network sharing is disabled.');
  return false;
}

function requireStreamAccess(reqUrl: URL, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (isLoopbackRequest(req)) return true;
  if (isLanSharingEnabled() && isSignedLanRequestValid(reqUrl)) return true;
  if (authorizeLanRequest(reqUrl, req).ok) return true;

  res.writeHead(isLanSharingEnabled() ? 401 : 403, { 'Content-Type': 'text/plain' });
  res.end(isLanSharingEnabled() ? 'Local network pairing is required.' : 'Local network sharing is disabled.');
  return false;
}

// ─── Pair rate limiting ──────────────────────────────────────────────────────
// Per-remote-IP sliding window. After PAIR_LOCKOUT_FAILS bad attempts inside
// PAIR_LOCKOUT_WINDOW_MS, lock for PAIR_LOCKOUT_DURATION_MS.

const PAIR_LOCKOUT_FAILS = 5;
const PAIR_LOCKOUT_WINDOW_MS = 60 * 1000;
const PAIR_LOCKOUT_DURATION_MS = 60 * 60 * 1000;

type PairAttemptState = { fails: number[]; lockedUntil?: number };
const pairAttempts = new Map<string, PairAttemptState>();

function checkPairRateLimit(address: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const state = pairAttempts.get(address) || { fails: [] };
  if (state.lockedUntil && state.lockedUntil > now) {
    return { allowed: false, retryAfterMs: state.lockedUntil - now };
  }
  state.fails = state.fails.filter((timestamp) => now - timestamp < PAIR_LOCKOUT_WINDOW_MS);
  pairAttempts.set(address, state);
  return { allowed: true };
}

function recordPairFailure(address: string): void {
  const now = Date.now();
  const state = pairAttempts.get(address) || { fails: [] };
  state.fails = state.fails.filter((timestamp) => now - timestamp < PAIR_LOCKOUT_WINDOW_MS);
  state.fails.push(now);
  if (state.fails.length >= PAIR_LOCKOUT_FAILS) {
    state.lockedUntil = now + PAIR_LOCKOUT_DURATION_MS;
    state.fails = [];
  }
  pairAttempts.set(address, state);
}

function recordPairSuccess(address: string): void {
  pairAttempts.delete(address);
}

async function handleLanPairRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isLanSharingEnabled()) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Local network sharing is disabled.');
    return;
  }

  const address = getRequestRemoteAddress(req);
  const limit = checkPairRateLimit(address);
  if (!limit.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(Math.ceil((limit.retryAfterMs || 0) / 1000)),
    });
    res.end(JSON.stringify({ error: 'Too many failed pairing attempts. Try again later.' }));
    return;
  }

  const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
  const code = String(body.code || '').replace(/\D/g, '').slice(0, 6);
  const deviceName = String(body.deviceName || '').trim().slice(0, 80) || 'Paired device';
  const requestedDeviceId = String(body.deviceId || '').trim().slice(0, 64);

  if (!timingSafeStringEqual(code, getLanShareToken())) {
    recordPairFailure(address);
    writeJson(res, 401, { error: 'The sharing code was not accepted.' });
    return;
  }

  recordPairSuccess(address);
  const settings = loadSettings();
  const existing = (settings.localNetworkPairedDevices || []).find((device) => requestedDeviceId && device.id === requestedDeviceId);
  const deviceId = existing?.id || requestedDeviceId || randomUUID();
  const deviceToken = randomBytes(32).toString('hex');
  const now = Date.now();
  const updated: LanPairedDevice = {
    id: deviceId,
    name: deviceName,
    token: deviceToken,
    createdAt: existing?.createdAt || now,
    lastSeenAt: now,
    lastAddress: address,
  };
  const others = (settings.localNetworkPairedDevices || []).filter((device) => device.id !== deviceId);
  saveSettings({ ...settings, localNetworkPairedDevices: [...others, updated] });

  const payload = libraryForLocalNetwork();
  writeJson(res, 200, {
    ok: true,
    deviceId,
    deviceToken,
    hostDeviceId: settings.localNetworkDeviceId,
    hostDeviceName: settings.localNetworkDeviceName || os.hostname(),
    library: payload,
    libraryEtag: libraryEtagFor(payload),
  });
}

// ─── Library snapshot ETag ────────────────────────────────────────────────────

function libraryEtagFor(payload: unknown): string {
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

// ─── mDNS advertisement sync ─────────────────────────────────────────────────

function syncLanAdvertisement(): void {
  const settings = loadSettings();
  if (!settings.localNetworkSharingEnabled || !mediaServerPort) {
    unadvertiseLanService();
    return;
  }
  advertiseLanService({
    port: mediaServerPort,
    deviceId: settings.localNetworkDeviceId || randomUUID(),
    deviceName: settings.localNetworkDeviceName || os.hostname(),
    appVersion: app.getVersion(),
  });
}

function isLocalMediaServerArtworkUrl(source: string): boolean {
  try {
    const parsed = new URL(source);
    return isLoopbackHost(parsed.hostname)
      && ['/api/thumbnail', '/api/local-image', '/api/cached-artwork'].includes(parsed.pathname);
  } catch {
    return false;
  }
}

function isExternalArtworkUrl(source: string): boolean {
  try {
    const parsed = new URL(source);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function artworkDeliveryUrl(source?: string | null): string {
  if (isInlineArtworkSource(source)) return String(source).trim();

  const durableSource = durableArtworkSource(source);
  if (!durableSource) return '';

  if (isLocalMediaServerArtworkUrl(durableSource)) {
    const parsed = new URL(durableSource);
    return `http://127.0.0.1:${mediaServerPort}${parsed.pathname}${parsed.search}`;
  }

  if (isExternalArtworkUrl(durableSource)) {
    const params = new URLSearchParams({ source: durableSource });
    return `http://127.0.0.1:${mediaServerPort}/api/cached-artwork?${params.toString()}`;
  }

  return durableSource;
}

function rewriteLocalServerUrl(source: string, base: string, token?: string): string {
  try {
    const parsed = new URL(source);
    const next = new URL(`${parsed.pathname}${parsed.search}`, base);
    if (token) next.searchParams.set('token', token);
    return next.toString();
  } catch {
    return source;
  }
}

function rewriteLocalServerUrlSigned(source: string, base: string): string {
  try {
    const parsed = new URL(source);
    const params = new URLSearchParams(parsed.search);
    params.delete('token');
    return signedArtworkUrlForRemote(base, parsed.pathname, params);
  } catch {
    return source;
  }
}

function remoteArtworkDeliveryUrl(source: string, base: string, _token: string): string {
  if (!source) return '';
  if (isLocalMediaServerArtworkUrl(source)) return rewriteLocalServerUrlSigned(source, base);
  if (isExternalArtworkUrl(source)) {
    return signedArtworkUrlForRemote(base, '/api/cached-artwork', new URLSearchParams({ source }));
  }
  return source;
}

function artworkDeliveryUrls(sources?: string[]): string[] {
  return Array.from(new Set((sources || []).map(artworkDeliveryUrl).filter(Boolean)));
}

function orderedArtworkCandidates(...urls: Array<string | null | undefined>): string[] {
  return Array.from(new Set(urls.filter((url): url is string => Boolean(url?.trim()))));
}

function srtToVtt(input: string): string {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `WEBVTT\n\n${normalized
    .replace(/^\uFEFF?WEBVTT\s*\n+/i, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

function createMediaItemId(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 32);
}

function mediaItemHasUsableArtwork(item: MediaItem): boolean {
  return Boolean(
    durableArtworkSource(item.poster)
    || durableArtworkSource(item.backdrop)
    || item.posterCandidates?.some((source) => durableArtworkSource(source))
    || item.backdropCandidates?.some((source) => durableArtworkSource(source)),
  );
}

function looksLikeLocalEpisodeFileTitle(title?: string, seriesTitle?: string): boolean {
  const value = (title || '').trim();
  if (!value) return true;
  const normalized = value.toLowerCase();
  const normalizedSeries = (seriesTitle || '').trim().toLowerCase();
  return /\bS\d{1,2}E\d{1,3}\b/i.test(value)
    || /^episode\s+\d{1,3}$/i.test(value)
    || /^ep\s+\d{1,3}$/i.test(value)
    || /\.(?:720p|1080p|2160p|4k|amzn|nf|web|webrip|web-dl|hdtv|bluray|x264|x265|galaxytv)\b/i.test(value)
    || /\b(720p|1080p|2160p|4k|amzn|web[- .]?rip|web[- .]?dl|hdtv|bluray|x264|x265|galaxytv)\b/i.test(value)
    || /\b(visit|support|subscribe|telegram|downloaded|encoded|uploaded|released)\b/i.test(value)
    || /\b(anikaizoku|pahe|rarbg|eztv|yts|tgx|galaxyrg)\b/i.test(value)
    || /\bwww\.|\.com\b|\.net\b|\.org\b/i.test(value)
    || (Boolean(normalizedSeries) && normalized === normalizedSeries);
}

function seriesHasGenericEpisodeTitles(item: MediaItem): boolean {
  if (item.type === 'movie' || !item.episodeFiles?.length) return false;
  const byKey = new Map((item.episodes || []).map((episode) => [`${episode.season}-${episode.number}`, episode]));
  return item.episodeFiles.some((file) => {
    const title = byKey.get(`${file.season}-${file.episode}`)?.title || file.title || '';
    return looksLikeLocalEpisodeFileTitle(title, item.title);
  });
}

function cachedItemNeedsMetadataRefresh(item: MediaItem): boolean {
  const isSeries = item.type === 'tv' || item.type === 'anime' || Boolean(item.episodeFiles?.length);
  if (isSeries && (!item.year || item.year <= 0)) return true;
  if (isSeries && seriesHasGenericEpisodeTitles(item)) return true;
  return !mediaItemHasUsableArtwork(item);
}

function cachedItemsAreComplete(items: MediaItem[]): boolean {
  return items.length > 0 && items.every((item) => !cachedItemNeedsMetadataRefresh(item));
}

function isTrustedLocalTagTitle(structureTitle: string | null, tagTitle: string | null, rawStructureTitle: string): boolean {
  if (!tagTitle) return false;
  if (!structureTitle) return true;
  if (isGenericGroupingFolderTitle(rawStructureTitle)) return true;
  return titleMatchesLocal(structureTitle, tagTitle);
}

function mostCommonUsefulTitle(candidates: Array<string | null | undefined>): string | null {
  const counts = new Map<string, { title: string; count: number }>();

  candidates.forEach((candidate) => {
    const title = usefulLocalTitle(candidate);
    if (!title) return;
    const key = normalizeTitleForMatch(title);
    counts.set(key, { title, count: (counts.get(key)?.count || 0) + 1 });
  });

  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.title || null;
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

function parseMetadataProviderIds(value: string): MetadataProviderIds {
  const ids: MetadataProviderIds = {};
  const matches = value.matchAll(/(?:\[|\{)(tmdbid|tmdb|themoviedbid|imdbid|imdb|tvdbid|tvdb)-([a-z0-9]+)(?:\]|\})/gi);
  for (const match of matches) {
    const provider = match[1].toLowerCase();
    const id = match[2];
    if (provider === 'imdbid' || provider === 'imdb') ids.imdbId = id.startsWith('tt') ? id : `tt${id}`;
    else if (provider === 'tvdbid' || provider === 'tvdb') ids.tvdbId = id;
    else ids.tmdbId = id;
  }
  return ids;
}

function mergeProviderIds(...sources: MetadataProviderIds[]): MetadataProviderIds {
  return sources.reduce<MetadataProviderIds>((merged, source) => ({
    tmdbId: merged.tmdbId || source.tmdbId,
    imdbId: merged.imdbId || source.imdbId,
    tvdbId: merged.tvdbId || source.tvdbId,
  }), {});
}

function tagValue(tags: Record<string, string> | undefined, ...names: string[]): string {
  if (!tags) return '';
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const match = Object.entries(tags).find(([key]) => wanted.has(key.toLowerCase()));
  return typeof match?.[1] === 'string' ? match[1] : '';
}

function providerIdsFromTags(tags: Record<string, string>): MetadataProviderIds {
  const directIds = {
    tmdbId: scrubTagText(tagValue(tags, 'tmdbid', 'tmdb_id', 'tmdb')),
    imdbId: scrubTagText(tagValue(tags, 'imdbid', 'imdb_id', 'imdb')),
    tvdbId: scrubTagText(tagValue(tags, 'tvdbid', 'tvdb_id', 'tvdb')),
  };
  if (directIds.imdbId && !directIds.imdbId.startsWith('tt')) directIds.imdbId = `tt${directIds.imdbId}`;

  return mergeProviderIds(
    parseMetadataProviderIds(Object.entries(tags).map(([key, value]) => `${key}-${value}`).join(' ')),
    directIds,
  );
}

function parseIntegerTag(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/\d+/);
  return match ? parseInt(match[0], 10) : undefined;
}

function scrubTagText(value?: string): string {
  return value?.replace(/\s+/g, ' ').trim() || '';
}

const mediaProbeCache = new Map<string, ProbeMediaFileResult>();

function mediaProbeCacheKey(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    return `${path.resolve(filePath)}:${stats.size}:${Math.round(stats.mtimeMs)}`;
  } catch {
    return null;
  }
}

function cacheProbeResult(cacheKey: string | null, result: ProbeMediaFileResult): ProbeMediaFileResult {
  if (!cacheKey) return result;
  if (mediaProbeCache.size > 5000) mediaProbeCache.clear();
  mediaProbeCache.set(cacheKey, result);
  return result;
}

function probeMediaFile(filePath: string): ProbeMediaFileResult {
  const cacheKey = mediaProbeCacheKey(filePath);
  if (cacheKey) {
    const cached = mediaProbeCache.get(cacheKey);
    if (cached) return cached;
  }

  const ffprobePath = findFFprobe();
  if (!ffprobePath) return {};

  try {
    const raw = execFileSync(
      ffprobePath,
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { encoding: 'utf8' },
    );

    const parsed = JSON.parse(raw) as {
      format?: { duration?: string; bit_rate?: string; format_name?: string; tags?: Record<string, string> };
      streams?: Array<{
        index?: number;
        codec_type?: string;
        codec_name?: string;
        profile?: string;
        pix_fmt?: string;
        width?: number;
        height?: number;
        channels?: number;
        disposition?: Record<string, number>;
        tags?: Record<string, string>;
      }>;
    };

    const embeddedThumbnailStream = parsed.streams?.find((stream) =>
      stream.index !== undefined
      && (
        stream.disposition?.attached_pic === 1
        || (stream.codec_type === 'attachment' && /^(mjpeg|jpeg|png|webp|bmp)$/i.test(stream.codec_name || ''))
      ),
    );
    const videoStream = parsed.streams?.find((stream) =>
      stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
    ) || parsed.streams?.find((stream) => stream.codec_type === 'video');
    const audioStreams = parsed.streams?.filter((stream) => stream.codec_type === 'audio') || [];
    const subtitleStreams = parsed.streams?.filter((stream) => stream.codec_type === 'subtitle') || [];
    const tags = parsed.format?.tags || {};
    const videoTags = videoStream?.tags || {};
    const preferredTitle = scrubTagText(
      tagValue(tags, 'title', 'name')
      || tagValue(videoTags, 'title', 'name'),
    );
    const preferredShowTitle = scrubTagText(
      tagValue(tags, 'show', 'showtitle', 'series', 'series_title', 'tvshow', 'tv_show', 'album')
      || tagValue(videoTags, 'show', 'showtitle', 'series', 'series_title', 'tvshow', 'tv_show', 'album'),
    );
    const summary = scrubTagText(
      tagValue(tags, 'description', 'comment', 'synopsis', 'overview', 'summary')
      || tagValue(videoTags, 'description', 'comment', 'synopsis', 'overview', 'summary'),
    );
    const year = parseYearFromText(
      tagValue(tags, 'date', 'year', 'originaldate', 'original_date', 'release_date', 'releasedate')
      || tagValue(videoTags, 'date', 'year', 'originaldate', 'original_date', 'release_date', 'releasedate'),
    );
    const season = parseIntegerTag(
      tagValue(tags, 'season_number', 'season', 'season_sort', 'part_number')
      || tagValue(videoTags, 'season_number', 'season', 'season_sort', 'part_number'),
    );
    const episode = parseIntegerTag(
      tagValue(tags, 'episode_sort', 'episode_id', 'episode_number', 'episode', 'track', 'tracknumber')
      || tagValue(videoTags, 'episode_sort', 'episode_id', 'episode_number', 'episode', 'track', 'tracknumber'),
    );

    return cacheProbeResult(cacheKey, {
      localMetadata: {
        durationSeconds: parsed.format?.duration ? Math.round(parseFloat(parsed.format.duration)) : undefined,
        width: videoStream?.width,
        height: videoStream?.height,
        videoCodec: videoStream?.codec_name,
        videoProfile: videoStream?.profile,
        pixelFormat: videoStream?.pix_fmt,
        audioCodec: audioStreams[0]?.codec_name,
        audioTracks: audioStreams.length || undefined,
        subtitleTracks: subtitleStreams.length || undefined,
        bitrateKbps: parsed.format?.bit_rate ? Math.round(parseInt(parsed.format.bit_rate, 10) / 1000) : undefined,
        container: parsed.format?.format_name?.split(',')[0],
      },
      embeddedTitle: preferredTitle || undefined,
      embeddedShowTitle: preferredShowTitle || undefined,
      embeddedThumbnailStreamIndex: embeddedThumbnailStream?.index,
      summary: summary || undefined,
      year: year || undefined,
      season,
      episode,
      providerIds: mergeProviderIds(providerIdsFromTags(tags), providerIdsFromTags(videoTags)),
    });
  } catch (error) {
    console.error('ffprobe error for', filePath, error);
    return cacheProbeResult(cacheKey, {});
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

// ─── HTTP Media Server ────────────────────────────────────────────────────────

function startMediaServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${mediaServerPort}`);
      const filePath = decodeURIComponent(reqUrl.searchParams.get('path') || '');
      const startSec = parseFloat(reqUrl.searchParams.get('t') || '0');

      if (reqUrl.pathname === '/api/ping') {
        writeJson(res, 200, { ok: true, port: mediaServerPort });
        return;
      }

      if (reqUrl.pathname === '/api/lan/info') {
        const settings = loadSettings();
        writeJson(res, 200, {
          ok: true,
          app: 'LoomTV',
          deviceId: settings.localNetworkDeviceId,
          deviceName: settings.localNetworkDeviceName || os.hostname(),
          sharingEnabled: Boolean(settings.localNetworkSharingEnabled),
          networkName: getLocalNetworkName(),
          port: mediaServerPort,
          addresses: getLocalNetworkAddresses(),
        });
        return;
      }

      if (reqUrl.pathname === '/api/lan/status') {
        if (!isLoopbackRequest(req)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('LAN status is only available on this device.');
          return;
        }

        const settings = loadSettings();
        const token = getLanShareToken();
        const base = getLanServerBase();
        writeJson(res, 200, {
          sharingEnabled: isLanSharingEnabled(),
          token,
          deviceId: settings.localNetworkDeviceId,
          deviceName: settings.localNetworkDeviceName || os.hostname(),
          networkName: getLocalNetworkName(),
          port: mediaServerPort,
          addresses: getLocalNetworkAddresses(),
          baseUrl: base,
          libraryUrl: base ? `${base}/api/lan/library` : null,
          pairedDevices: settings.localNetworkPairedDevices || [],
        });
        return;
      }

      if (reqUrl.pathname === '/api/lan/pair' && req.method === 'POST') {
        handleLanPairRequest(req, res).catch((error) => {
          console.error('[lan/pair] error', error);
          writeJson(res, 500, { error: 'Pairing failed' });
        });
        return;
      }

      if (reqUrl.pathname === '/api/lan/unpair' && req.method === 'POST') {
        if (!requireLocalOrLanAccess(reqUrl, req, res)) return;
        const authResult = authorizeLanRequest(reqUrl, req);
        // Devices may self-revoke; loopback can revoke any device.
        readJsonBody(req)
          .catch((): Record<string, any> => ({}))
          .then((body) => {
            const settings = loadSettings();
            const requestedId = String(body?.deviceId || authResult.device?.id || '');
            if (!requestedId) {
              writeJson(res, 400, { error: 'deviceId required' });
              return;
            }
            if (!isLoopbackRequest(req) && authResult.device && authResult.device.id !== requestedId) {
              writeJson(res, 403, { error: 'Cannot revoke other devices' });
              return;
            }
            const remaining = (settings.localNetworkPairedDevices || []).filter((device) => device.id !== requestedId);
            saveSettings({ ...settings, localNetworkPairedDevices: remaining });
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => {
            console.error('[lan/unpair] error', error);
            writeJson(res, 500, { error: 'Unpair failed' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/lan/library') {
        if (!requireLocalOrLanAccess(reqUrl, req, res)) return;
        const payload = libraryForLocalNetwork();
        const etag = `"${libraryEtagFor(payload)}"`;
        const requestEtag = (req.headers['if-none-match'] || '') as string;
        if (requestEtag && requestEtag === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'no-cache');
        writeJson(res, 200, payload);
        return;
      }

      // /stream and artwork endpoints accept signed URLs; HLS playlists too.
      const isStreamRoute = reqUrl.pathname === '/stream' || reqUrl.pathname.startsWith('/hls/');
      const isArtworkRoute = reqUrl.pathname === '/api/cached-artwork'
        || reqUrl.pathname === '/api/local-image'
        || reqUrl.pathname === '/api/thumbnail';
      const hasValidSignature = isLanSharingEnabled() && isSignedLanRequestValid(reqUrl);
      if (!isStreamRoute && !(isArtworkRoute && (isLoopbackRequest(req) || hasValidSignature)) && !requireLocalOrLanAccess(reqUrl, req, res)) return;

      if (reqUrl.pathname === '/api/library' && req.method === 'GET') {
        writeJson(res, 200, libraryForRenderer());
        return;
      }

      if (reqUrl.pathname === '/api/library/scan' && req.method === 'POST') {
        const scanVersion = libraryMutationVersion;
        readJsonBody(req)
          .catch((): Record<string, any> => ({}))
          .then((body) => scanLibrary(loadLibrary(), {
            force: Boolean(body.force),
            mode: body.mode === 'metadata' || body.mode === 'full' ? body.mode : 'quick',
          }))
          .then((scanned) => {
            if (saveLibraryFromScan(scanned, scanVersion)) {
              cacheArtworkInBackground(scanned);
            }
            writeJson(res, 200, libraryForRenderer());
          })
          .catch((error) => {
            console.error('scan library API error:', error);
            writeJson(res, 500, { error: 'Failed to scan library' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/library/add-folder' && req.method === 'POST') {
        readJsonBody(req)
          .catch((): Record<string, any> => ({}))
          .then((body) => {
            const requestedKind = String(body.kind || '');
            const kind: LibraryFolderKind = requestedKind === 'tvShows' || requestedKind === 'anime' || requestedKind === 'movies' || requestedKind === 'others'
              ? requestedKind
              : 'movies';
            return dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] }).then((result) => ({ result, kind }));
          })
          .then(async (result) => {
            if (result.result.canceled || result.result.filePaths.length === 0) {
              writeJson(res, 200, null);
              return;
            }

            const data = loadLibrary();
            const newFolder = result.result.filePaths[0];
            const updated = addFolderToLibrary(data, newFolder, result.kind);
            saveLibraryMutation(updated);
            const scanVersion = libraryMutationVersion;
            const scanned = await scanLibrary(updated, { mode: 'quick' });
            if (saveLibraryFromScan(scanned, scanVersion)) {
              cacheArtworkInBackground(scanned);
            }
            writeJson(res, 200, libraryForRenderer());
          })
          .catch((error) => {
            console.error('add folder API error:', error);
            writeJson(res, 500, { error: 'Failed to add folder' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/library/remove-folder' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const data = loadLibrary();
            const updated = removeFolderFromLibrary(data, String(body.folderPath || ''));
            saveLibraryMutation(updated);
            writeJson(res, 200, libraryForRenderer());
          })
          .catch((error) => {
            console.error('remove folder API error:', error);
            writeJson(res, 500, { error: 'Failed to remove folder' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/settings' && req.method === 'GET') {
        writeJson(res, 200, loadSettings());
        return;
      }

      if (reqUrl.pathname === '/api/settings' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            saveSettings({ ...loadSettings(), ...(body as AppSettings) });
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => {
            console.error('save settings API error:', error);
            writeJson(res, 500, { error: 'Failed to save settings' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/progress' && req.method === 'GET') {
        const requestedPath = reqUrl.searchParams.get('filePath') || '';
        writeJson(res, 200, requestedPath ? getProgress(requestedPath) : getAllProgress());
        return;
      }

      if (reqUrl.pathname === '/api/progress' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const file = String(body.filePath || '');
            if (!file) {
              writeJson(res, 400, { error: 'filePath is required' });
              return;
            }
            writeJson(res, 200, saveProgress(file, Number(body.position) || 0, Number(body.duration) || 0));
          })
          .catch((error) => {
            console.error('save progress API error:', error);
            writeJson(res, 500, { error: 'Failed to save progress' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/progress/import' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            importProgress((body.progress || {}) as Record<string, number | { position?: number; duration?: number; updatedAt?: number }>);
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => {
            console.error('import progress API error:', error);
            writeJson(res, 500, { error: 'Failed to import progress' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork' && req.method === 'GET') {
        writeJson(res, 200, getCustomArtwork(reqUrl.searchParams.get('mediaId') || ''));
        return;
      }

      if (reqUrl.pathname === '/api/artwork' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            saveCustomArtwork(String(body.mediaId || ''), String(body.target || ''), String(body.dataUrl || ''));
            writeJson(res, 200, getCustomArtwork(String(body.mediaId || '')));
          })
          .catch((error) => {
            console.error('save artwork API error:', error);
            writeJson(res, 500, { error: 'Failed to save artwork' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork/refresh-official' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => refreshOfficialArtwork(String(body.mediaId || '')))
          .then((artwork) => writeJson(res, 200, artwork))
          .catch((error) => {
            console.error('refresh official artwork API error:', error);
            writeJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to refresh official artwork' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork/official-candidates' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => getOfficialMetadataCandidates(String(body.mediaId || '')))
          .then((candidates) => writeJson(res, 200, candidates))
          .catch((error) => {
            console.error('official metadata candidates API error:', error);
            writeJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to fetch official metadata candidates' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork/apply-official' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => applyOfficialMetadataCandidate(String(body.mediaId || ''), body.candidate as OfficialMetadataCandidate))
          .then((artwork) => writeJson(res, 200, artwork))
          .catch((error) => {
            console.error('apply official metadata API error:', error);
            writeJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to apply official metadata' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/artwork/import' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            importCustomArtwork((body.entries || {}) as Record<string, Record<string, string>>);
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => {
            console.error('import artwork API error:', error);
            writeJson(res, 500, { error: 'Failed to import artwork' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/database/backup' && req.method === 'POST') {
        backupDatabase()
          .then((result) => writeJson(res, result.ok ? 200 : 400, result))
          .catch((error) => {
            console.error('database backup API error:', error);
            writeJson(res, 500, { ok: false, error: 'Failed to back up database' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/database/clear' && req.method === 'POST') {
        try {
          writeJson(res, 200, libraryForRenderer(clearAppData()));
        } catch (error) {
          console.error('database clear API error:', error);
          writeJson(res, 500, { error: 'Failed to clear app data' });
        }
        return;
      }

      if (reqUrl.pathname === '/api/ffmpeg') {
        writeJson(res, 200, { available: findFFmpeg() !== null, path: findFFmpeg() });
        return;
      }

      if (reqUrl.pathname === '/api/cached-artwork') {
        const sourceUrl = reqUrl.searchParams.get('source') || '';
        if (!sourceUrl || !isExternalArtworkUrl(sourceUrl)) {
          res.writeHead(400);
          res.end('Invalid artwork source');
          return;
        }

        const cachedArtwork = getCachedArtwork(sourceUrl);
        if (!cachedArtwork) {
          redirectToArtworkSource(res, sourceUrl);
          return;
        }

        const decoded = decodeDataUrl(cachedArtwork.dataUrl);
        if (!decoded) {
          redirectToArtworkSource(res, sourceUrl);
          return;
        }

        res.writeHead(200, {
          'Content-Type': cachedArtwork.mimeType || decoded.mimeType,
          'Cache-Control': 'public, max-age=86400',
          'Content-Length': decoded.buffer.byteLength,
        });
        res.end(decoded.buffer);
        return;
      }

      if (reqUrl.pathname === '/api/local-image') {
        if (!filePath || !isImageFileName(path.basename(filePath)) || !fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end();
          return;
        }

        res.writeHead(200, {
          'Content-Type': getImageMimeType(filePath),
          'Cache-Control': 'public, max-age=3600',
        });
        const stream = fs.createReadStream(filePath);
        stream.once('error', () => safeEndResponse(res));
        stream.pipe(res);
        return;
      }

      if (reqUrl.pathname === '/api/thumbnail') {
        const time = reqUrl.searchParams.get('t') || '00:01:00';
        const embedded = reqUrl.searchParams.get('embedded') === '1';
        const streamIndex = parseIntegerTag(reqUrl.searchParams.get('stream') || undefined);
        const ffmpegPath = findFFmpeg();
        if (!ffmpegPath || !filePath) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        const args = embedded
          ? [
              '-i', filePath,
              ...(streamIndex !== undefined ? ['-map', `0:${streamIndex}`] : ['-map', '0:v:0']),
              '-frames:v', '1',
              '-f', 'image2',
              '-vcodec', 'mjpeg',
              '-q:v', '2',
              'pipe:1',
            ]
          : ['-ss', time, '-i', filePath, '-vframes', '1', '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1'];
        try {
          const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          proc.stdout?.on('error', () => safeEndResponse(res));
          proc.stdout?.pipe(res);
          proc.once('error', (error) => {
            console.error('thumbnail FFmpeg spawn error:', error);
            safeEndResponse(res);
          });
          proc.stderr?.on('data', () => {});
          req.on('close', () => {
            if (!proc.killed) proc.kill('SIGKILL');
          });
        } catch (error) {
          console.error('thumbnail FFmpeg spawn failed:', error);
          safeEndResponse(res);
        }
        return;
      }

      if (reqUrl.pathname === '/api/ffprobe') {
        writeJson(res, 200, { available: findFFprobe() !== null, path: findFFprobe() });
        return;
      }

      if (reqUrl.pathname === '/api/media-server-port') {
        writeJson(res, 200, { port: mediaServerPort });
        return;
      }

      if (reqUrl.pathname === '/api/media/probe' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => safeResult(() => probeMedia(String(body.filePath || ''))))
          .then((result) => writeJson(res, result.ok ? 200 : 400, result))
          .catch((error) => {
            console.error('probe media API error:', error);
            writeJson(res, 500, { ok: false, error: 'Failed to probe media' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/media/start-transcode' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => safeResult(() => startTranscode(
            String(body.filePath || ''),
            (body.options || {}) as TranscodeOptions,
            `http://127.0.0.1:${mediaServerPort}`,
          )))
          .then((result) => writeJson(res, result.ok ? 200 : 400, result))
          .catch((error) => {
            console.error('start transcode API error:', error);
            writeJson(res, 500, { ok: false, error: 'Failed to start transcoding' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/media/stop-transcode' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => safeResult(() => stopTranscode(String(body.sessionId || ''))))
          .then((result) => writeJson(res, result.ok ? 200 : 400, result))
          .catch((error) => {
            console.error('stop transcode API error:', error);
            writeJson(res, 500, { ok: false, error: 'Failed to stop transcoding' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/play-media' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            assertLocalMediaPath(String(body.filePath || ''));
            writeJson(res, 200, {
              ok: false,
              error: 'Direct external playback is disabled. Use the in-app player.',
            });
          })
          .catch((error) => {
            console.error('play media API error:', error);
            writeJson(res, 400, { ok: false, error: 'Invalid media path.' });
          });
        return;
      }

      if (reqUrl.pathname === '/subtitle') {
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        try {
          const ext = path.extname(filePath).toLowerCase();
          const body = fs.readFileSync(filePath, 'utf-8');
          res.writeHead(200, {
            'Content-Type': ext === '.srt' ? 'text/vtt; charset=utf-8' : getSubtitleMimeType(filePath),
            'Cache-Control': 'no-store',
          });
          res.end(ext === '.srt' ? srtToVtt(body) : body);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Could not read subtitle');
        }
        return;
      }

      if (serveHls(reqUrl, res)) return;

      if (reqUrl.pathname !== '/stream') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      if (!requireStreamAccess(reqUrl, req, res)) return;

      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const ffmpegPath = findFFmpeg();
      const streamOptions: TranscodeOptions = {
        startSeconds: Number.isFinite(startSec) && startSec > 0 ? startSec : undefined,
        videoTrackIndex: queryNumber(reqUrl.searchParams.get('video')),
        audioTrackIndex: queryNumber(reqUrl.searchParams.get('audio')),
        subtitleTrackIndex: queryNumber(reqUrl.searchParams.get('subtitle')),
        subtitleStreamOrdinal: queryNumber(reqUrl.searchParams.get('subtitleOrdinal')),
        subtitleCodec: reqUrl.searchParams.get('subtitleCodec') || undefined,
        secondarySubtitleTrackIndex: queryNumber(reqUrl.searchParams.get('secondarySubtitle')),
        secondarySubtitleStreamOrdinal: queryNumber(reqUrl.searchParams.get('secondarySubtitleOrdinal')),
        secondarySubtitleCodec: reqUrl.searchParams.get('secondarySubtitleCodec') || undefined,
        subtitleStyle: parseSubtitleStyle(reqUrl.searchParams.get('subtitleStyle')),
        forceTranscode: reqUrl.searchParams.get('forceTranscode') === '1',
      };
      const hasSelectedTracks = typeof streamOptions.videoTrackIndex === 'number'
        || typeof streamOptions.audioTrackIndex === 'number'
        || typeof streamOptions.subtitleTrackIndex === 'number'
        || typeof streamOptions.secondarySubtitleTrackIndex === 'number';

      if ((streamOptions.forceTranscode || hasSelectedTracks || needsBrowserTranscoding(filePath)) && ffmpegPath) {
        // ── Smart remux/transcode ────────────────────────────────────────────
        // Probe to decide what actually needs re-encoding vs what can be copied.
        // Copying streams is nearly instant (just remux); re-encoding is slow.
        const probe = probeMediaFile(filePath);
        const videoCodec = (probe.localMetadata?.videoCodec || '').toLowerCase();
        const videoProfile = (probe.localMetadata?.videoProfile || '').toLowerCase();
        const pixelFormat = (probe.localMetadata?.pixelFormat || '').toLowerCase();
        const audioCodec = (probe.localMetadata?.audioCodec || '').toLowerCase();

        // Keep browser-safe streams; everything else becomes H264/AAC.
        const hasSubtitle = hasSubtitleSelection(streamOptions);
        const bitmapSubtitle = hasBitmapSubtitleSelection(streamOptions);
        const copyVideo = !hasSubtitle
          && videoCodec === 'h264'
          && pixelFormat === 'yuv420p'
          && !videoProfile.includes('10');
        const copyAudio = audioCodec === 'aac' || audioCodec === 'mp3';
        const hardwareEncoder = copyVideo ? null : preferredH264HardwareEncoder(ffmpegPath);

        console.log(`[stream] ${path.basename(filePath)} | video:${videoCodec}/${pixelFormat || 'unknown'}(${copyVideo ? 'copy' : hardwareEncoder || 'libx264'}) audio:${audioCodec}(${copyAudio ? 'copy' : 'encode'})`);

        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Transfer-Encoding': 'chunked',
          'X-Video-Codec': videoCodec,
          'X-Audio-Codec': audioCodec,
        });

        const args: string[] = ['-nostdin'];
        if (typeof streamOptions.startSeconds === 'number' && streamOptions.startSeconds > 0) {
          args.push('-ss', String(Math.floor(streamOptions.startSeconds)));
        }
        args.push('-i', filePath);

        if (hasSubtitle && bitmapSubtitle) {
          const subtitleFilter = subtitleFilterComplex(filePath, streamOptions);
          args.push('-filter_complex', subtitleFilter.filter, '-map', `[${subtitleFilter.output}]`);
        } else {
          args.push('-map', streamMap('v', streamOptions.videoTrackIndex));
        }

        if (streamOptions.audioTrackIndex !== -1) {
          args.push('-map', streamMap('a', streamOptions.audioTrackIndex, true));
        }

        args.push('-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1');

        if (hasSubtitle && !bitmapSubtitle) {
          const textSelections = subtitleSelections(streamOptions);
          const primarySubtitle = textSelections.find((selection) => selection.placement === 'primary') || textSelections[0];
          const secondarySubtitle = textSelections.find((selection) => selection !== primarySubtitle);
          args.push('-vf', textSubtitleFilter(
            filePath,
            primarySubtitle.streamOrdinal,
            streamOptions.subtitleStyle,
            streamOptions.startSeconds,
            secondarySubtitle?.streamOrdinal,
          ));
        } else if (!copyVideo && !bitmapSubtitle) {
          args.push('-vf', 'format=yuv420p');
        }

        args.push('-c:v', copyVideo ? 'copy' : hardwareEncoder || 'libx264');
        if (hardwareEncoder) {
          appendH264EncoderOptions(args, hardwareEncoder);
        } else if (!copyVideo) {
          args.push('-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main');
        }

        if (streamOptions.audioTrackIndex === -1) {
          args.push('-an');
        } else {
          args.push('-c:a', copyAudio ? 'copy' : 'aac');
          if (!copyAudio) args.push('-b:a', '192k', '-ac', '2');
        }

        args.push(
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          'pipe:1',
        );

        try {
          const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          proc.stdout?.on('error', () => safeEndResponse(res));
          proc.stdout?.pipe(res);
          req.on('close', () => {
            if (!proc.killed) proc.kill('SIGKILL');
          });
          proc.stderr?.on('data', (d: Buffer) => console.log('[ffmpeg]', d.toString().trim().split('\n').pop()));
          proc.once('error', (err) => {
            console.error('FFmpeg spawn error:', err);
            safeEndResponse(res);
          });
          proc.once('exit', (code) => {
            if (code !== 0 && code !== null) console.warn(`[ffmpeg] exited with code ${code}`);
            safeEndResponse(res);
          });
        } catch (error) {
          console.error('FFmpeg spawn failed:', error);
          safeEndResponse(res);
        }
      } else {
        // Direct streaming with range request support (essential for seeking)
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch (e) {
          res.writeHead(500);
          res.end();
          return;
        }

        const fileSize = stat.size;
        const mimeType = getMimeType(filePath);
        const range = req.headers.range;

        if (range) {
          const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
          const start = parseInt(startStr, 10);
          const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
          const chunkSize = end - start + 1;

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mimeType,
          });

          const stream = fs.createReadStream(filePath, { start, end });
          stream.pipe(res);
          req.on('close', () => stream.destroy());
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Accept-Ranges': 'bytes',
            'Content-Type': mimeType,
          });

          const stream = fs.createReadStream(filePath);
          stream.pipe(res);
          req.on('close', () => stream.destroy());
        }
      }
    };

    mediaServer = http.createServer(requestHandler);

    const tryListen = (port: number) => {
      mediaServer!.listen(port, '0.0.0.0', () => {
        mediaServerPort = port;
        console.log(`Media server on port ${port}`);
        resolve(port);
      });
    };

    mediaServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        tryListen(mediaServerPort + 1);
      } else {
        reject(err);
      }
    });

    tryListen(mediaServerPort);
  });
}

function inferAnimeSeasonSearchTitles(episodeFiles: EpisodeFile[], fallbackTitle: string): Map<number, string> {
  const titlesBySeason = new Map<number, Map<string, { title: string; count: number }>>();

  for (const file of episodeFiles) {
    const title = seriesTitleFromEpisodeFileName(path.basename(file.filePath));
    if (!title) continue;
    const seasonTitles = titlesBySeason.get(file.season) || new Map<string, { title: string; count: number }>();
    const key = title.toLowerCase();
    const current = seasonTitles.get(key);
    seasonTitles.set(key, { title, count: (current?.count || 0) + 1 });
    titlesBySeason.set(file.season, seasonTitles);
  }

  const result = new Map<number, string>();
  for (const [season, titles] of titlesBySeason) {
    const best = [...titles.values()].sort((a, b) => b.count - a.count)[0];
    result.set(season, best?.title || fallbackTitle);
  }

  if (!result.has(1)) result.set(1, fallbackTitle);
  return result;
}

async function fetchJikanEpisodesForLocalAnimeSeasons(
  episodeFiles: EpisodeFile[],
  fallbackTitle: string,
  firstSeasonMetadata?: JikanAnimeResult | null,
): Promise<EpisodeMeta[]> {
  const seasonTitles = inferAnimeSeasonSearchTitles(episodeFiles, fallbackTitle);
  const results: EpisodeMeta[] = [];
  const usedMalIds = new Set<number>();

  for (const [season, title] of [...seasonTitles.entries()].sort(([a], [b]) => a - b)) {
    let metadata = season === 1 ? firstSeasonMetadata : null;
    if (!metadata || (metadata.malId && usedMalIds.has(metadata.malId))) {
      metadata = await fetchJikanMetadata(title);
    }
    if (!metadata?.episodes?.length) continue;
    if (metadata.malId) usedMalIds.add(metadata.malId);

    results.push(...metadata.episodes.map((episode) => ({ ...episode, season })));
  }

  return results;
}

function mergeLocalSeasonsWithMetadata(
  localSeasons: { number: number; title: string; episodeCount: number }[],
  remoteSeasons?: { number: number; title: string; episodeCount: number }[],
): { number: number; title: string; episodeCount: number }[] {
  if (!remoteSeasons || remoteSeasons.length === 0) return localSeasons;

  const remoteByNumber = new Map(remoteSeasons.map((season) => [season.number, season]));
  return localSeasons.map((season) => {
    const remote = remoteByNumber.get(season.number);
    if (!remote) return season;
    return {
      number: season.number,
      title: remote.title || season.title,
      episodeCount: season.episodeCount,
    };
  });
}

function listFromApiValue(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isAnimeMetadata(
  filePath: string,
  title: string,
  omdbData?: Record<string, any> | null,
  tvMeta?: TVMetadata | null,
): boolean {
  if (isLikelyAnimePath(filePath, title)) return true;

  const omdbGenres = listFromApiValue(omdbData?.Genre);
  const omdbCountries = listFromApiValue(omdbData?.Country);
  const omdbLanguages = listFromApiValue(omdbData?.Language);
  const tvGenres = (tvMeta?.genres || []).map((genre) => genre.toLowerCase());
  const tvLanguage = (tvMeta?.language || '').toLowerCase();
  const tvCountry = (tvMeta?.country || '').toLowerCase();
  const tvType = (tvMeta?.showType || '').toLowerCase();

  if ([...omdbGenres, ...tvGenres].some((genre) => genre.includes('anime'))) return true;
  if (tvType.includes('animation') && (tvLanguage.includes('japanese') || tvCountry.includes('japan'))) return true;
  if (tvGenres.includes('animation') && (tvLanguage.includes('japanese') || tvCountry.includes('japan'))) return true;
  if (omdbGenres.includes('animation') && (omdbCountries.includes('japan') || omdbLanguages.includes('japanese'))) return true;

  return false;
}

function isSeriesMetadata(omdbData?: Record<string, any> | null, tvMeta?: TVMetadata | null): boolean {
  const type = String(omdbData?.Type || '').toLowerCase();
  return type === 'series' || type === 'episode' || Boolean(tvMeta?.episodes?.length || tvMeta?.seasons?.length);
}

// ─── Library scanning ─────────────────────────────────────────────────────────

const VIDEO_EXTS = ['.mkv', '.mp4', '.avi', '.mov', '.webm', '.m4v', '.wmv', '.flv', '.mpg', '.mpeg', '.m2ts', '.3gp', '.ts'];
const SUBTITLE_EXTS = ['.vtt', '.srt', '.ass', '.ssa'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

function isMacSidecarFile(fileName: string): boolean {
  return fileName.startsWith('._') || fileName === '.DS_Store';
}

function isVideoFileName(fileName: string): boolean {
  return !isMacSidecarFile(fileName) && VIDEO_EXTS.includes(path.extname(fileName).toLowerCase());
}

function isSubtitleFileName(fileName: string): boolean {
  return !isMacSidecarFile(fileName) && SUBTITLE_EXTS.includes(path.extname(fileName).toLowerCase());
}

function isImageFileName(fileName: string): boolean {
  return !isMacSidecarFile(fileName) && IMAGE_EXTS.includes(path.extname(fileName).toLowerCase());
}

function normalizedArtworkBaseName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findLocalArtworkFile(folderPath: string, preferredBaseNames: string[]): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return '';
  }

  const preferred = preferredBaseNames.map((name) => normalizedArtworkBaseName(name)).filter(Boolean);
  const candidates = entries
    .filter((entry) => !entry.isDirectory() && isImageFileName(entry.name))
    .map((entry) => {
      const baseName = normalizedArtworkBaseName(entry.name);
      const exactIndex = preferred.findIndex((name) => baseName === name);
      const prefixIndex = preferred.findIndex((name) => baseName.startsWith(`${name} `));
      const containsIndex = preferred.findIndex((name) => baseName.includes(name));
      const score = exactIndex >= 0
        ? exactIndex
        : prefixIndex >= 0
          ? 50 + prefixIndex
          : containsIndex >= 0
            ? 100 + containsIndex
            : 1000;
      return { name: entry.name, score };
    })
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

  return candidates[0] ? path.join(folderPath, candidates[0].name) : '';
}

function getLocalFolderArtworkUrl(folderPath: string, kind: 'poster' | 'backdrop'): string {
  const preferred = kind === 'poster'
    ? ['poster', 'folder', 'cover', 'thumbnail', 'thumb', 'default', 'movie']
    : ['backdrop', 'fanart', 'background', 'landscape', 'banner'];
  const imagePath = findLocalArtworkFile(folderPath, preferred);
  return imagePath ? getLocalImageUrl(imagePath) : '';
}

function getLocalMovieArtworkUrl(videoPath: string, kind: 'poster' | 'backdrop'): string {
  const folderPath = path.dirname(videoPath);
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const preferred = kind === 'poster'
    ? [baseName, `${baseName} poster`, 'poster', 'folder', 'cover', 'thumbnail', 'thumb', 'default', 'movie']
    : [`${baseName} backdrop`, `${baseName} fanart`, 'backdrop', 'fanart', 'background', 'landscape', 'banner'];
  const imagePath = findLocalArtworkFile(folderPath, preferred);
  return imagePath ? getLocalImageUrl(imagePath) : '';
}

function getEmbeddedArtworkUrl(filePath: string, probe: ProbeMediaFileResult): string {
  return probe.embeddedThumbnailStreamIndex !== undefined
    ? getEmbeddedThumbnailUrl(filePath, probe.embeddedThumbnailStreamIndex)
    : '';
}

function hasPlayableVideoTrack(probe: ReturnType<typeof probeMediaFile>): boolean {
  return Boolean(probe.localMetadata?.videoCodec);
}

function getLibraryFolderSignature(folderPath: string): { signature: string; fileCount: number } | null {
  if (!fs.existsSync(folderPath)) return null;

  const hash = createHash('sha256');
  const stack = [folderPath];
  let fileCount = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
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

function isTVPattern(folderName: string, files: string[]): boolean {
  const lower = folderName.toLowerCase();
  if (/season/i.test(lower)) return true;
  if (/[Ss]\d{1,2}[Ee]\d{1,3}/.test(folderName)) return true;
  const hasEpisodeFiles = files.some((f) => /[Ss]\d{1,2}[Ee]\d{1,3}/.test(f) || /[Ee]pisode/i.test(f));
  return files.length > 2 && hasEpisodeFiles;
}

function createSubtitleRecords(basePath: string, subtitleFiles: string[]) {
  return subtitleFiles.map((f) => {
    const lm = f.match(/\[(\w{2,3})\]|\.(\w{2,3})\./i);
    const lang = lm ? (lm[1] || lm[2] || 'en') : 'en';
    return {
      lang: lang.toLowerCase(),
      label: lang.toUpperCase(),
      url: `/subtitle?path=${encodeURIComponent(path.join(basePath, f))}`,
    };
  });
}

function isLikelyTVFromFileName(name: string): boolean {
  return /[Ss]\d{1,2}[Ee]\d{1,3}/.test(name) || /(?:episode|ep|e)\s*\d{1,3}\b/i.test(name);
}

function seriesTitleFromEpisodeFileName(fileName: string): string | null {
  const withoutExt = fileName.replace(/\.[^.]+$/, '');
  const match = withoutExt.match(/^(.+?)[._ -]+[Ss]\s*\d{1,2}\s*[._ -]*[Ee]\s*\d{1,3}\b/);
  if (!match) return null;
  const title = cleanMediaTitle(match[1]).title;
  return title && !/^(season|series|episode|ep)$/i.test(title) ? title : null;
}

function inferSeriesTitleFromEpisodeFiles(files: EpisodeFile[], fallbackTitle: string): string {
  const counts = new Map<string, { title: string; count: number }>();
  for (const file of files) {
    const title = seriesTitleFromEpisodeFileName(path.basename(file.filePath));
    if (!title) continue;
    const key = title.toLowerCase();
    counts.set(key, { title, count: (counts.get(key)?.count || 0) + 1 });
  }

  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  if (!best) return fallbackTitle;
  if (best.count === files.length || best.count >= Math.max(2, Math.ceil(files.length * 0.6))) return best.title;
  return fallbackTitle;
}

function shouldTreatAsTV(
  titleCandidate: string,
  videoFiles: string[],
  hasSeasonDirs: boolean,
  representativeProbe?: { embeddedShowTitle?: string; season?: number; episode?: number },
): boolean {
  if (hasSeasonDirs) return true;
  if (representativeProbe?.embeddedShowTitle) return true;
  if (representativeProbe?.season || representativeProbe?.episode) return true;
  return isTVPattern(titleCandidate, videoFiles) || videoFiles.some((file) => isLikelyTVFromFileName(file));
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
): Promise<MediaItem | null> {
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
  const jikanEpisodesForLocalSeasons = finalType === 'anime' && !matchedTVMeta?.episodes?.length
    ? await fetchJikanEpisodesForLocalAnimeSeasons(episodeFiles, searchTitle, matchedJikanMeta)
    : [];

  // ── Merge episode metadata onto local files ────────────────────────────────
  // Priority of episode data: TVmaze names > Jikan names for anime > TMDB TV.
  // Remote episode maps are keyed by "season-number" (Jikan uses season=1 for all)
  const remoteEpisodes: EpisodeMeta[] =
    matchedTVMeta?.episodes
    ?? (finalType === 'anime' && jikanEpisodesForLocalSeasons.length > 0 ? jikanEpisodesForLocalSeasons : null)
    ?? matchedTmdbTVMeta?.episodes
    ?? [];

  let mergedEpisodes = localEpisodes;
  if (remoteEpisodes.length > 0) {
    const remoteEpMap = new Map<string, EpisodeMeta>(
      remoteEpisodes.map((ep) => [
        `${ep.season}-${ep.number}`,
        ep,
      ]),
    );

    mergedEpisodes = localEpisodes.map((local) => {
      const key = `${local.season}-${local.number}`;
      const remote = remoteEpMap.get(key);
      if (!remote) return local;
      return {
        ...local,
        title: remote.title || local.title,
        summary: local.summary || remote.summary,
        still: remote.still || local.still,
        rating: remote.rating || local.rating,
        airDate: local.airDate || remote.airDate,
      };
    });
  }
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
    posterCandidates,
    backdropCandidates,
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
  };
}

function isLikelyAnimePath(filePath: string, title = ''): boolean {
  const value = `${filePath} ${title}`.toLowerCase();
  return /(^|[\\/._ -])(anime|animes|donghua|ova|ona)([\\/._ -]|$)/i.test(value)
    || /\b(horriblesubs|subsplease|erai-raws|judas|ember|commie|hakat[a]? ramen)\b/i.test(value);
}

async function buildMovieItemFromFile(
  fullPath: string,
  fileName: string,
  titleFallback: string,
  subtitles: { lang: string; label: string; url: string }[],
  year: number,
  omdbApiKey?: string,
  tmdbApiKey?: string,
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
    posterCandidates,
    backdropCandidates,
    summary,
    rating,
    genres,
    cast,
    filePath: fullPath,
    fileSize: stats.size,
    subtitles,
    localMetadata: probe.localMetadata,
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
  folderKind?: ScanFolderKind;
}

function defaultLibraryFolderGroups(): LibraryFolderGroups {
  return { movies: [], tvShows: [], anime: [], others: [] };
}

function flattenLibraryFolders(groups: LibraryFolderGroups): string[] {
  return Array.from(new Set([...groups.movies, ...groups.tvShows, ...groups.anime, ...groups.others]));
}

function normalizeLibraryFolderGroups(data?: Partial<LibraryData>): LibraryFolderGroups {
  const normalized = defaultLibraryFolderGroups();
  const groups = data?.libraryFolderGroups;
  if (groups) {
    normalized.movies = [...(groups.movies || [])];
    normalized.tvShows = [...(groups.tvShows || [])];
    normalized.anime = [...(groups.anime || [])];
    normalized.others = [...(groups.others || [])];
  }

  for (const folder of data?.libraryFolders || []) {
    if (flattenLibraryFolders(normalized).includes(folder)) continue;
    const detected = detectLibraryFolderKind(folder);
    if (detected === 'movies') normalized.movies.push(folder);
    else if (detected === 'tv') normalized.tvShows.push(folder);
    else if (detected === 'anime') normalized.anime.push(folder);
    else normalized.others.push(folder);
  }

  return {
    movies: Array.from(new Set(normalized.movies)),
    tvShows: Array.from(new Set(normalized.tvShows)),
    anime: Array.from(new Set(normalized.anime)),
    others: Array.from(new Set(normalized.others)),
  };
}

function normalizeFolderKindName(folderPath: string): string {
  return path.basename(folderPath).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function detectLibraryFolderKind(folderPath: string): ScanContext['folderKind'] {
  const name = normalizeFolderKindName(folderPath);
  if (/^(movies?|films?|cinema)$/.test(name)) return 'movies';
  if (/^(tv|tv shows?|television|shows?|series)$/.test(name)) return 'tv';
  if (/^(anime|animes|donghua)$/.test(name)) return 'anime';
  return undefined;
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
  const subtitleFiles = dirEntries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => entry.name)
    .filter(isSubtitleFileName);
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
      ctx.omdbApiKey, ctx.tmdbApiKey,
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
    );
  }

  return buildMovieItemFromFile(
    path.join(folderPath, videoFiles[0]),
    videoFiles[0], parsedFolder.title,
    subtitles, parsedFolder.year,
    ctx.omdbApiKey, ctx.tmdbApiKey,
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
    const rootSubtitleFiles = rootEntries
      .filter((entry) => !entry.isDirectory() && isSubtitleFileName(entry.name))
      .map((entry) => entry.name);

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
        ctx.omdbApiKey, ctx.tmdbApiKey,
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

      const subtitleFiles = dirEntries
        .filter((d) => !d.isDirectory())
        .map((d) => d.name)
        .filter(isSubtitleFileName);

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
        );
        if (tvItem) await addItems([tvItem]);
      } else if (videoFiles.length > 0) {
        await addItems([await buildMovieItemFromFile(
          path.join(fullPath, videoFiles[0]),
          videoFiles[0], parsedFolder.title,
          subtitles, parsedFolder.year,
          ctx.omdbApiKey, ctx.tmdbApiKey,
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
  };
  const folderGroups = normalizeLibraryFolderGroups(data);
  const movies: MediaItem[] = [];
  const tvShows: MediaItem[] = [];
  const animeShows: MediaItem[] = [];
  const previousScanCache = data.scanCache || {};
  const nextScanCache: LibraryScanCache = {};
  const totalFolders = flattenLibraryFolders(folderGroups).length;
  const processedFolders = new Set<string>();
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

  const cachedItemsForFolder = (folder: string, folderKind: ScanCacheFolderKind): MediaItem[] => {
    const source = folderKind === 'auto'
      ? [...(data.movies || []), ...(data.tvShows || []), ...(data.animeShows || [])]
      : folderKind === 'movies'
        ? data.movies || []
        : folderKind === 'anime'
          ? data.animeShows || []
          : data.tvShows || [];

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
      const folderSignature = getLibraryFolderSignature(folder);
      const cachedEntry = previousScanCache[folder];

      if (
        mode !== 'full'
        && folderSignature
        && cachedEntry?.version === SCAN_CACHE_VERSION
        && cachedEntry?.folderKind === folderKind
        && cachedEntry.signature === folderSignature.signature
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
    scanCache: nextScanCache,
  };
  await publishProgress(true);
  return nextLibrary;
}

async function scanLegacyLibrary(folders: string[]): Promise<LibraryData> {
  const folderGroups = normalizeLibraryFolderGroups({ libraryFolders: folders });
  return scanLibrary({
    movies: [],
    tvShows: [],
    animeShows: [],
    libraryFolders: flattenLibraryFolders(folderGroups),
    libraryFolderGroups: folderGroups,
  });
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

function seriesTitleFromEpisodeName(value?: string): string | null {
  if (!value) return null;
  const withoutExt = value.replace(/\.(mkv|mp4|avi|mov|webm|m4v|wmv|flv|mpg|mpeg|m2ts|3gp|ts)$/i, '');
  const withoutReleaseGroups = withoutExt.replace(/\[[^\]]*]/g, ' ');
  const beforeEpisodeMarker = withoutReleaseGroups
    .replace(/\s+-\s+S\d{1,2}E\d{1,3}\s+-\s+.*$/i, ' ')
    .replace(/\s+[Ss]\d{1,2}[Ee]\d{1,3}\s+.*$/i, ' ')
    .replace(/\s+-\s+\d{1,3}\s*$/i, ' ')
    .replace(/\s+\d{1,3}\s*$/i, ' ');
  const title = cleanMediaTitle(beforeEpisodeMarker).title;
  if (!title || isGenericGroupingFolderTitle(title)) return null;
  return title;
}

function bestSeriesTitleFromEpisodes(item: MediaItem): string | null {
  const candidates = (item.episodeFiles || []).flatMap((episodeFile) => [
    seriesTitleFromEpisodeName(path.basename(episodeFile.filePath)),
    seriesTitleFromEpisodeName(episodeFile.title || ''),
  ]);
  const titles = uniqueLocalTitles(candidates);
  if (titles.length === 0) return null;
  return titles.sort((a, b) => normalizeTitleForMatch(b).length - normalizeTitleForMatch(a).length)[0];
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
  return { movies: [], tvShows: [], animeShows: [], libraryFolders: [], libraryFolderGroups, scanCache: {} };
}

function stripInlineArtworkFromItem(item: MediaItem): MediaItem {
  return {
    ...item,
    poster: durableArtworkSource(item.poster),
    backdrop: durableArtworkSource(item.backdrop),
    posterCandidates: durableArtworkSources(item.posterCandidates),
    backdropCandidates: durableArtworkSources(item.backdropCandidates),
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
  const posterCandidates = artworkDeliveryUrls(item.posterCandidates);
  const backdropCandidates = artworkDeliveryUrls(item.backdropCandidates);

  return {
    ...item,
    poster,
    backdrop,
    posterCandidates,
    backdropCandidates,
    episodes: item.episodes?.map((episode) => ({
      ...episode,
      still: artworkDeliveryUrl(episode.still),
    })),
  };
}

function libraryForRenderer(data: LibraryData = loadLibrary()): LibraryData {
  return {
    ...data,
    movies: (data.movies || []).map(itemWithArtworkDeliveryUrls),
    tvShows: (data.tvShows || []).map(itemWithArtworkDeliveryUrls),
    animeShows: (data.animeShows || []).map(itemWithArtworkDeliveryUrls),
  };
}

function signedStreamUrlForRemote(base: string, filePath: string): string {
  return buildSignedLanUrl(base, '/stream', new URLSearchParams({ path: filePath }));
}

function signedArtworkUrlForRemote(base: string, pathname: string, params: URLSearchParams): string {
  return buildSignedLanUrl(base, pathname, params);
}

function itemForLocalNetwork(item: MediaItem, base: string, token: string): MediaItem {
  const poster = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.poster), base, token);
  const backdrop = remoteArtworkDeliveryUrl(artworkDeliveryUrl(item.backdrop), base, token);
  const posterCandidates = artworkDeliveryUrls(item.posterCandidates).map((url) => remoteArtworkDeliveryUrl(url, base, token));
  const backdropCandidates = artworkDeliveryUrls(item.backdropCandidates).map((url) => remoteArtworkDeliveryUrl(url, base, token));

  return {
    ...item,
    filePath: signedStreamUrlForRemote(base, item.filePath),
    poster,
    backdrop,
    posterCandidates,
    backdropCandidates,
    episodes: item.episodes?.map((episode) => ({
      ...episode,
      still: remoteArtworkDeliveryUrl(artworkDeliveryUrl(episode.still), base, token),
    })),
    episodeFiles: item.episodeFiles?.map((episodeFile) => ({
      ...episodeFile,
      filePath: signedStreamUrlForRemote(base, episodeFile.filePath),
    })),
  };
}

function libraryForLocalNetwork(): LibraryData {
  const base = getLanServerBase() || `http://127.0.0.1:${mediaServerPort}`;
  const token = getLanShareToken();
  const data = loadLibrary();
  return {
    ...data,
    libraryFolders: [],
    libraryFolderGroups: { movies: [], tvShows: [], anime: [], others: [] },
    movies: (data.movies || []).map((item) => itemForLocalNetwork(item, base, token)),
    tvShows: (data.tvShows || []).map((item) => itemForLocalNetwork(item, base, token)),
    animeShows: (data.animeShows || []).map((item) => itemForLocalNetwork(item, base, token)),
  };
}

let artworkCacheQueue: Promise<void> = Promise.resolve();

function cacheArtworkInBackground(data: LibraryData): void {
  const snapshot = stripInlineArtworkFromLibrary(data);
  artworkCacheQueue = artworkCacheQueue
    .catch(() => undefined)
    .then(() => cacheLibraryArtwork(snapshot))
    .catch((error) => {
      console.warn('[artwork-cache] Failed to cache library artwork:', error);
    });
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
};

type OfficialMetadataCandidate = OfficialArtworkRefreshResult & {
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
  omdbMeta?: Record<string, any> | null,
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
  omdbMeta?: Record<string, any> | null,
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
  };
  if (!candidateWithoutId.title && !candidateWithoutId.thumbnail && !candidateWithoutId.cover) return null;
  return { ...candidateWithoutId, id: metadataCandidateId(candidateWithoutId) };
}

function omdbMetadataCandidate(metadata: Record<string, any> | null | undefined, fallbackTitle: string): OfficialMetadataCandidate | null {
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
  const episodeSeriesTitle = item.type === 'movie' ? null : bestSeriesTitleFromEpisodes(item);
  const searchTitle =
    usefulLocalTitle(episodeSeriesTitle || '')
    || usefulLocalTitle(embeddedTitle)
    || usefulLocalTitle(folderTitle)
    || usefulLocalTitle(parsedPathTitle)
    || usefulLocalTitle(item.title)
    || item.title;
  const localTitles = uniqueLocalTitles([
    searchTitle,
    episodeSeriesTitle,
    item.title,
    embeddedTitle,
    folderTitle,
    parsedPathTitle,
    localTitleFromPath(representativePath || item.filePath) || '',
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
      ...tmdbCandidates.map((candidate) => metadataCandidate('TMDB', candidate, title)),
      omdbMetadataCandidate(omdbById, title),
      omdbMetadataCandidate(omdbBySearch, title),
      metadataCandidate('TVmaze', remoteMatchesAnyLocalTitle(localTitles, tvMeta?.title) ? tvMeta : null, title),
      ...tvCandidates.map((candidate) => metadataCandidate('TVmaze', candidate, title)),
    ]), title, localTitles);
  }

  const likelyAnime = item.type === 'anime';
  const [omdbById, omdbBySearch, jikanCandidates, tmdbById, tmdbBySearch, tmdbCandidates, tvMeta, tvCandidates] = await Promise.all([
    providerIds.imdbId ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey) : Promise.resolve(null),
    fetchOMDbMetadata(title, year, omdbApiKey),
    likelyAnime ? fetchJikanMetadataCandidates(title) : Promise.resolve([]),
    providerIds.tmdbId ? fetchTMDBTVMetadataById(providerIds.tmdbId, tmdbApiKey) : Promise.resolve(null),
    fetchTMDBTVMetadata(title, year, tmdbApiKey),
    fetchTMDBTVMetadataCandidates(title, year, tmdbApiKey),
    fetchTVMetadata(title, year),
    fetchTVMetadataCandidates(title, year),
  ]);
  return sortMetadataCandidates(uniqueMetadataCandidates([
    ...jikanCandidates.map((candidate) => metadataCandidate('Jikan', candidate, title)),
    metadataCandidate('TMDB', tmdbById, title),
    metadataCandidate('TMDB', remoteMatchesAnyLocalTitle(localTitles, tmdbBySearch?.title) ? tmdbBySearch : null, title),
    ...tmdbCandidates.map((candidate) => metadataCandidate('TMDB', candidate, title)),
    omdbMetadataCandidate(omdbById, title),
    omdbMetadataCandidate(remoteMatchesAnyLocalTitle(localTitles, omdbBySearch?.Title) ? omdbBySearch : null, title),
    metadataCandidate('TVmaze', remoteMatchesAnyLocalTitle(localTitles, tvMeta?.title) ? tvMeta : null, title),
    ...tvCandidates.map((candidate) => metadataCandidate('TVmaze', candidate, title)),
  ]), title, localTitles);
}

async function fetchOfficialArtworkForItem(item: MediaItem): Promise<OfficialArtworkRefreshResult> {
  const settings = loadSettings();
  const tmdbApiKey = getMetadataApiKey(settings, 'tmdb');
  const omdbApiKey = getMetadataApiKey(settings, 'omdb');
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
    return {
      thumbnail: posterCandidates[0] || '',
      cover: backdropCandidates[0] || posterCandidates[0] || '',
      summary: tmdbMeta?.summary || omdbMeta?.Plot || '',
      rating: movieMetadataRating(tmdbMeta, omdbMeta, matchedTV),
      posterCandidates,
      backdropCandidates,
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
  const matchedJikan = remoteMatchesAnyLocalTitle(localTitles, jikanMeta?.title) ? jikanMeta : null;
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
  };
}

function applyOfficialMetadataCandidate(mediaId: string, candidate: OfficialMetadataCandidate): OfficialArtworkRefreshResult {
  const library = loadLibrary();
  const target = findLibraryMediaItem(library, mediaId);

  if (!target) {
    throw new Error('Media item was not found in the library.');
  }

  if (candidate.title) target.title = candidate.title;
  if (candidate.year) target.year = candidate.year;
  if (candidate.thumbnail) target.poster = candidate.thumbnail;
  if (candidate.cover) target.backdrop = candidate.cover;
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
  saveLibrary(library);

  return {
    thumbnail: candidate.thumbnail || target.poster || '',
    cover: candidate.cover || target.backdrop || candidate.thumbnail || target.poster || '',
    summary: candidate.summary || target.summary || '',
    rating: candidate.rating || target.rating || 0,
    episodes: target.type === 'movie' ? undefined : target.episodes,
    episodeSource: candidate.source,
    posterCandidates: target.posterCandidates || [],
    backdropCandidates: target.backdropCandidates || [],
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
  if (refreshed.thumbnail || refreshed.cover || refreshed.summary || refreshed.rating || refreshed.episodes?.length) {
    if (refreshed.thumbnail) target.poster = refreshed.thumbnail;
    if (refreshed.cover) target.backdrop = refreshed.cover;
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
    saveLibrary(library);
  }

  return {
    ...refreshed,
    episodes: target.type === 'movie' ? undefined : target.episodes,
    episodeSource: refreshed.episodeSource,
    posterCandidates: target.posterCandidates || refreshed.posterCandidates,
    backdropCandidates: target.backdropCandidates || refreshed.backdropCandidates,
  };
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

function getWindowIconPath(): string | null {
  const iconFileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const candidates = [
    path.join(process.resourcesPath, iconFileName),
    path.join(process.resourcesPath, 'icon', iconFileName),
    path.join(app.getAppPath(), 'resources', iconFileName),
    path.join(__dirname, '../resources', iconFileName),
    path.join(process.resourcesPath, 'icon.png'),
    path.join(app.getAppPath(), 'resources', 'icon.png'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

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

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const windowOptions: ConstructorParameters<typeof BrowserWindow>[0] = {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 540,
    title: 'LoomTV',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // TODO(security): webSecurity:false is here so the renderer (loaded
      // from file:// in production) can fetch from http://127.0.0.1:*. The
      // tighter replacement is either (a) register a `loomtv-media://`
      // privileged scheme and route stream/artwork through it, or (b) keep
      // webSecurity:true and add a CSP via session.webRequest that allows
      // connect-src/media-src http://127.0.0.1:* + http://localhost:*.
      // Either change needs manual verification of direct play, HLS, the
      // transcode fallback, and LAN-shared playback on macOS/Windows/Linux.
      webSecurity: false,
    },
  };
  const iconPath = getWindowIconPath();
  if (iconPath) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });

  if (MAIN_WINDOW_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_NAME}/index.html`));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── App updates ─────────────────────────────────────────────────────────────

function emitUpdateState() {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('updates:state', updateState);
  });
  void refreshUpdateMenu();
}

function setUpdateState(nextState: Partial<UpdateState>) {
  updateState = {
    ...updateState,
    ...nextState,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    supported: isUpdaterSupportedPlatform(),
  };
  emitUpdateState();
  return updateState;
}

function showUpdateDialog(message: string, detail: string, type: 'info' | 'warning' | 'error' = 'info'): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void dialog.showMessageBox(mainWindow, {
    type,
    title: 'LoomTV Updates',
    message,
    detail,
    buttons: ['OK'],
  });
}

function normalizeReleaseVersion(value?: string): string {
  return String(value || '').trim().replace(/^v/i, '');
}

function compareReleaseVersions(left?: string, right?: string): number {
  const leftParts = normalizeReleaseVersion(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeReleaseVersion(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index++) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }

  return 0;
}

async function checkLatestGitHubRelease(): Promise<UpdateState> {
  setUpdateState({ status: 'checking', downloadPercent: undefined, message: 'Checking GitHub releases...' });

  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `LoomTV/${app.getVersion()}`,
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}`);
    }

    const release = await response.json() as { tag_name?: string; html_url?: string };
    const latestVersion = normalizeReleaseVersion(release.tag_name);
    const currentVersion = app.getVersion();
    const hasUpdate = compareReleaseVersions(latestVersion, currentVersion) > 0;

    return setUpdateState({
      status: hasUpdate ? 'available' : 'not-available',
      latestVersion,
      releaseUrl: release.html_url,
      checkedAt: new Date().toISOString(),
      message: hasUpdate
        ? `LoomTV ${latestVersion} is available. Download it from GitHub Releases.`
        : `LoomTV is up to date at ${currentVersion}.`,
    });
  } catch (error) {
    return setUpdateState({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    });
  }
}

function showUpdateDownloadedPrompt() {
  if (updatePromptInFlight || !mainWindow || mainWindow.isDestroyed()) return;
  updatePromptInFlight = true;

  const stateMessage = updateState.message || 'An update is available.';
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: 'LoomTV update downloaded',
    detail: `${stateMessage} Restart now to apply the update.`,
    buttons: ['Restart and Update', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
    .then((response) => {
      if (response.response === 0) {
        installDownloadedUpdate();
      }
    })
    .finally(() => {
      updatePromptInFlight = false;
    });
}

function refreshUpdateMenu() {
  if (!updateMenu) return;

  const installMenuItem = updateMenu.getMenuItemById('loomtv-install-update');
  if (installMenuItem) {
    installMenuItem.enabled = updateState.status === 'downloaded';
    installMenuItem.visible = updateState.status === 'downloaded';
  }

  const checkMenuItem = updateMenu.getMenuItemById('loomtv-check-updates');
  if (checkMenuItem) {
    checkMenuItem.enabled = !updateCheckInFlight;
    checkMenuItem.label = updateCheckInFlight ? 'Checking for Updates...' : 'Check for Updates...';
  }
}

function buildUpdateMenu() {
  const updateItems: MenuItemConstructorOptions[] = [
    {
      id: 'loomtv-check-updates',
      label: 'Check for Updates...',
      click: () => {
        void handleManualUpdateCheck();
      },
    },
    {
      id: 'loomtv-install-update',
      label: 'Install Downloaded Update...',
      visible: updateState.status === 'downloaded',
      enabled: updateState.status === 'downloaded',
      click: () => {
        if (updateState.status === 'downloaded') installDownloadedUpdate();
      },
    },
  ];

  const template: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            ...updateItems,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' },
          ],
        },
      ]
    : [
        {
          label: 'File',
          submenu: [
            ...updateItems,
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
      ];

  updateMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(updateMenu);
}

async function handleManualUpdateCheck() {
  const checkedState = await checkForUpdates();

  if (checkedState.status === 'checking') {
    showUpdateDialog(
      'Checking for updates',
      'LoomTV is already checking for an update. You’ll get notified when it completes.',
    );
    return;
  }

  if (checkedState.status === 'downloading' || checkedState.status === 'available') {
    showUpdateDialog(
      'Update check in progress',
      'An update is being checked and downloaded in the background.',
    );
    return;
  }

  if (checkedState.status === 'downloaded') {
    showUpdateDownloadedPrompt();
    return;
  }

  if (checkedState.status === 'not-available') {
    showUpdateDialog('No update found', `You’re already on LoomTV ${checkedState.currentVersion}.`);
    return;
  }

  if (checkedState.status === 'disabled') {
    showUpdateDialog('Updates are not available', checkedState.message || 'Updates are not available in this environment.');
    return;
  }

  if (checkedState.status === 'error') {
    showUpdateDialog('Update check failed', checkedState.message || 'Could not check for updates.', 'warning');
  }
}

function installDownloadedUpdate() {
  if (updateInstallStarted) return updateState;
  if (updateState.status !== 'downloaded') return updateState;
  updateInstallStarted = true;

  setUpdateState({ status: 'installing', message: 'Installing update and restarting LoomTV...' });

  // Drain pending playback/server work before quitAndInstall — otherwise
  // active streams or open file handles can stall the squirrel/NSIS installer
  // and the relaunch never happens.
  try {
    stopAllTranscodes();
    void stopLocal(mainWindow);
    void mpvController.stop({ suppressEvent: true });
    destroyLanDiscovery();
    if (mediaServer) {
      mediaServer.close();
      mediaServer = null;
    }
    if (updateCheckTimer) {
      clearInterval(updateCheckTimer);
      updateCheckTimer = null;
    }
    BrowserWindow.getAllWindows().forEach((window) => {
      try {
        window.removeAllListeners('close');
        window.destroy();
      } catch {
        // Ignore destroy errors — quitAndInstall will force-close any survivors.
      }
    });
  } catch (error) {
    console.warn('[updates] pre-install cleanup failed:', error);
  }

  // Force-restart after install. Without isForceRunAfter:true the squirrel/NSIS
  // installer can exit silently without relaunching the app.
  // - isSilent:true skips the NSIS UI on Windows (DMG on macOS ignores this).
  // - autoInstallOnAppQuit was set to false at configure time so this call is
  //   the single source of truth for installing.
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      updateInstallStarted = false;
      setUpdateState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      });
    }
  });

  return updateState;
}

function configureAutoUpdater() {
  if (updaterConfigured) return;
  updaterConfigured = true;

  if (!updateState.supported) {
    setUpdateState({
      status: 'disabled',
      message: 'Automatic updates are available in packaged macOS, Windows, and Linux AppImage builds.',
    });
    return;
  }

  if (!app.isPackaged) {
    setUpdateState({
      status: 'disabled',
      message: 'Automatic updates are enabled after LoomTV is packaged and published.',
    });
    return;
  }

  autoUpdater.autoDownload = true;
  // We control the install moment via quitAndInstall(true, true). Letting
  // electron-updater also install on natural app quit would double-install
  // and race the relaunch.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: UPDATE_OWNER,
    repo: UPDATE_REPO,
  });

  autoUpdater.on('checking-for-update', () => {
    setUpdateState({ status: 'checking', message: 'Checking for updates...' });
  });

  autoUpdater.on('update-available', () => {
    setUpdateState({ status: 'available', message: 'Update available, downloading...' });
  });

  autoUpdater.on('download-progress', (progress) => {
    if (!progress?.percent) return;
    setUpdateState({
      status: 'downloading',
      downloadPercent: Math.round(progress.percent),
      message: `Downloading update ${Math.round(progress.percent)}%`,
    });
  });

  autoUpdater.on('update-not-available', () => {
    setUpdateState({
      status: 'not-available',
      message: 'LoomTV is up to date.',
      checkedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on('update-downloaded', () => {
    setUpdateState({
      status: 'downloaded',
      message: 'Update downloaded. Restart LoomTV to install it.',
      checkedAt: new Date().toISOString(),
    });
    showUpdateDownloadedPrompt();
  });

  autoUpdater.on('error', (error) => {
    setUpdateState({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    });
  });

  updateCheckTimer = setInterval(() => {
    if (!updateCheckInFlight && updateState.supported && app.isPackaged) {
      void checkForUpdates();
    }
  }, AUTO_UPDATE_CHECK_INTERVAL_MS);
}

async function checkForUpdates(): Promise<UpdateState> {
  configureAutoUpdater();
  if (!updateState.supported || !app.isPackaged) {
    return checkLatestGitHubRelease();
  }
  if (updateCheckInFlight || updateState.status === 'downloading' || updateState.status === 'downloaded') {
    return updateCheckPromise || updateState;
  }

  updateCheckInFlight = true;
  setUpdateState({ status: 'checking', downloadPercent: undefined, message: 'Checking for updates...' });
  updateCheckPromise = autoUpdater.checkForUpdates()
    .then(() => updateState)
    .catch((error) => {
      setUpdateState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      });
      return updateState;
    })
    .finally(() => {
      updateCheckInFlight = false;
      updateCheckPromise = null;
      refreshUpdateMenu();
    });
  return updateCheckPromise;
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('library:get', () => libraryForRenderer());

ipcMain.handle('library:scan', async (event, options?: { force?: boolean; mode?: LibraryScanMode }) => {
  const data = loadLibrary();
  const scanVersion = libraryMutationVersion;
  const mode: LibraryScanMode = options?.force
    ? 'full'
    : options?.mode === 'metadata' || options?.mode === 'full'
      ? options.mode
      : 'quick';
  const scanned = await scanLibrary(data, {
    mode,
    onProgress: (snapshot) => {
      event.sender.send('library:scan-progress', libraryForRenderer(snapshot), {
        isComplete: snapshot.isComplete,
        scannedFolders: snapshot.scannedFolders,
        totalFolders: snapshot.totalFolders,
      });
    },
  });
  if (saveLibraryFromScan(scanned, scanVersion)) {
    cacheArtworkInBackground(scanned);
  }
  return libraryForRenderer();
});

ipcMain.handle('library:add-folder', async (_event, kind: LibraryFolderKind = 'movies') => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    buttonLabel: 'Add Folder',
    message: 'Select a folder to add to your LoomTV library.',
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const data = loadLibrary();
    const newFolder = result.filePaths[0];
    const safeKind: LibraryFolderKind = kind === 'tvShows' || kind === 'anime' || kind === 'movies' || kind === 'others' ? kind : 'movies';
    const updated = addFolderToLibrary(data, newFolder, safeKind);
    saveLibraryMutation(updated);
    const scanVersion = libraryMutationVersion;
    const scanned = await scanLibrary(updated, {
      mode: 'quick',
      onProgress: (snapshot) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          window.webContents.send('library:scan-progress', libraryForRenderer(snapshot), {
            isComplete: snapshot.isComplete,
            scannedFolders: snapshot.scannedFolders,
            totalFolders: snapshot.totalFolders,
          });
        });
      },
    });
    if (saveLibraryFromScan(scanned, scanVersion)) {
      cacheArtworkInBackground(scanned);
    }
    return libraryForRenderer();
  }
  return null;
});

ipcMain.handle('library:remove-folder', (_event, folderPath: string) => {
  const data = loadLibrary();
  const updated = removeFolderFromLibrary(data, folderPath);
  saveLibraryMutation(updated);
  return libraryForRenderer();
});

ipcMain.handle('media:play', async (_event, filePath: string) => {
  try {
    assertLocalMediaPath(filePath);
    // In-app playback is handled by the renderer's <video> player.
    return false;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('media:get-server-port', () => mediaServerPort);

ipcMain.handle('media:get-stream-url', (_event, filePath: string, options?: TranscodeOptions) => {
  assertLocalMediaPath(filePath);
  // Stream directly from the local media server. Routing through the custom
  // plexserver:// protocol can exhaust Electron's net.fetch resources during
  // repeated video range requests.
  const params = new URLSearchParams({ path: filePath });
  appendStreamOptionParams(params, options);
  const isTranscoded = Boolean(options?.forceTranscode)
    || typeof options?.videoTrackIndex === 'number'
    || typeof options?.audioTrackIndex === 'number'
    || typeof options?.subtitleTrackIndex === 'number'
    || typeof options?.secondarySubtitleTrackIndex === 'number'
    || needsBrowserTranscoding(filePath);
  const url = `http://127.0.0.1:${mediaServerPort}/stream?${params.toString()}`;
  return {
    url,
    contentType: isTranscoded ? 'video/mp4' : getMimeType(filePath),
    fileName: path.basename(filePath),
    isTranscoded,
  };
});

ipcMain.handle('media:get-thumbnail', (_event, filePath: string, time?: string) => {
  const base = `http://127.0.0.1:${mediaServerPort}/api/thumbnail?path=${encodeURIComponent(filePath)}`;
  return { url: time ? `${base}&t=${encodeURIComponent(time)}` : base };
});

ipcMain.handle('media:get-file-info', (_event, filePath: string) => {
  try {
    assertLocalMediaPath(filePath);
    const exists = fs.existsSync(filePath);
    const size = exists ? fs.statSync(filePath).size : 0;
    return { size, path: filePath, exists };
  } catch (e) {
    return { size: 0, path: filePath, exists: false };
  }
});

ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('settings:save', (_event, settings: AppSettings) => {
  saveSettings({ ...loadSettings(), ...settings });
  syncLanAdvertisement();
  return true;
});

ipcMain.handle('network:status', () => {
  const settings = loadSettings();
  const token = getLanShareToken();
  const base = getLanServerBase();
  return {
    sharingEnabled: isLanSharingEnabled(),
    token,
    deviceId: settings.localNetworkDeviceId,
    deviceName: settings.localNetworkDeviceName || os.hostname(),
    networkName: getLocalNetworkName(),
    port: mediaServerPort,
    addresses: getLocalNetworkAddresses(),
    baseUrl: base,
    libraryUrl: base ? `${base}/api/lan/library` : null,
    pairedDevices: settings.localNetworkPairedDevices || [],
  };
});

ipcMain.handle('network:discover-peers', async (_event, timeoutMs?: number) => {
  const settings = loadSettings();
  try {
    return await discoverLanPeers(Number(timeoutMs) || 2500, settings.localNetworkDeviceId);
  } catch (error) {
    console.warn('[mdns] discover failed:', error);
    return [];
  }
});

ipcMain.handle('network:revoke-paired-device', (_event, deviceId: string) => {
  const settings = loadSettings();
  const remaining = (settings.localNetworkPairedDevices || []).filter((device) => device.id !== deviceId);
  saveSettings({ ...settings, localNetworkPairedDevices: remaining });
  return remaining;
});

ipcMain.handle('network:set-device-name', (_event, name: string) => {
  const settings = loadSettings();
  const nextName = String(name || '').trim().slice(0, 80) || os.hostname();
  saveSettings({ ...settings, localNetworkDeviceName: nextName });
  syncLanAdvertisement();
  return nextName;
});

ipcMain.handle('progress:get', (_event, filePath?: string) => filePath ? getProgress(filePath) : getAllProgress());
ipcMain.handle('progress:save', (_event, filePath: string, position: number, duration: number) =>
  saveProgress(filePath, Number(position) || 0, Number(duration) || 0));
ipcMain.handle('progress:import', (_event, progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>) => {
  importProgress(progress || {});
  return true;
});
ipcMain.handle('artwork:get', (_event, mediaId: string) => getCustomArtwork(mediaId));
ipcMain.handle('artwork:save', (_event, mediaId: string, target: string, dataUrl: string) => {
  saveCustomArtwork(mediaId, target, dataUrl);
  return getCustomArtwork(mediaId);
});
ipcMain.handle('artwork:official-candidates', (_event, mediaId: string) => getOfficialMetadataCandidates(mediaId));
ipcMain.handle('artwork:apply-official', (_event, mediaId: string, candidate: OfficialMetadataCandidate) =>
  applyOfficialMetadataCandidate(mediaId, candidate));
ipcMain.handle('artwork:refresh-official', (_event, mediaId: string) => refreshOfficialArtwork(mediaId));
ipcMain.handle('artwork:import', (_event, entries: Record<string, Record<string, string>>) => {
  importCustomArtwork(entries || {});
  return true;
});
ipcMain.handle('database:backup', () => backupDatabase());
ipcMain.handle('database:clear', () => libraryForRenderer(clearAppData()));
ipcMain.handle('shell:open-external', (_event, url: string) => shell.openExternal(url));
ipcMain.handle('updates:get-state', () => updateState);
ipcMain.handle('updates:check', () => checkForUpdates());
ipcMain.handle('updates:install', () => {
  if (updateState.status !== 'downloaded') return updateState;
  return installDownloadedUpdate();
});

ipcMain.handle('media:ffmpeg-available', () => {
  return { available: findFFmpeg() !== null, path: findFFmpeg() };
});

ipcMain.handle('media:probe', (_event, filePath: string) => safeResult(() => probeMedia(filePath)));

ipcMain.handle('media:can-direct-play', (_event, filePath: string, backend: 'mpv' | 'html5' | 'hls' = 'mpv') =>
  safeResult(() => {
    const result = probeMedia(filePath);
    return canDirectPlay(filePath, result, backend);
  }),
);

ipcMain.handle('media:play-local', (_event, filePath: string) => safeResult(() => playLocal(filePath, mainWindow)));
ipcMain.handle('media:pause-local', () => safeResult(() => pauseLocal()));
ipcMain.handle('media:resume-local', () => safeResult(() => resumeLocal()));
ipcMain.handle('media:stop-local', () => safeResult(() => stopLocal(mainWindow)));
ipcMain.handle('media:seek-local', (_event, seconds: number) => safeResult(() => seekLocal(Number(seconds) || 0)));
ipcMain.handle('media:set-volume-local', (_event, volume: number) => safeResult(() => setLocalVolume(Number(volume) || 0)));
ipcMain.handle('media:get-playback-state', () => safeResult(() => getLocalState()));

ipcMain.handle('media:start-transcode', (_event, filePath: string, options?: TranscodeOptions) =>
  safeResult(() => startTranscode(filePath, options || {}, `http://127.0.0.1:${mediaServerPort}`)),
);
ipcMain.handle('media:stop-transcode', (_event, sessionId: string) => safeResult(() => stopTranscode(sessionId)));

// ─── MPV integration ──────────────────────────────────────────────────────────
// Uses MpvController (src/main/mpv/mpvController.ts) which wraps the mpv process
// and a proper JSON IPC client with request_id matching.

// Wire the natural-exit event so the renderer panel can close itself.
mpvController.onExit(() => {
  mainWindow?.webContents.send('mpv:event', 'closed');
});

// ── Existing preload-compatible handlers ──────────────────────────────────────

ipcMain.handle('media:play-mpv', async (_event, filePath: string, startSecs?: number) => {
  try {
    await mpvController.launch(filePath, { startSeconds: startSecs });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[mpv] launch failed:', msg);
    return { error: msg };
  }
});

ipcMain.handle('media:query-mpv', async () => {
  const state = await mpvController.getPlaybackState();
  if (!state) return null;
  return state;
});

ipcMain.handle('media:close-mpv', async () => {
  await mpvController.stop({ suppressEvent: true });
});

ipcMain.handle('media:mpv-toggle-pause', async () => {
  await mpvController.togglePause();
});

ipcMain.handle('media:mpv-seek', async (_event, seconds: number, mode: 'relative' | 'absolute' = 'relative') => {
  await mpvController.seek(Number(seconds) || 0, mode);
});

ipcMain.handle('media:mpv-set-volume', async (_event, value: number) => {
  await mpvController.setVolume(Number(value) || 0);
});

ipcMain.handle('media:mpv-toggle-mute', async () => {
  await mpvController.toggleMute();
});

ipcMain.handle('media:mpv-set-speed', async (_event, value: number) => {
  await mpvController.setSpeed(Number(value) || 1);
});

ipcMain.handle('media:mpv-set-fullscreen', async (_event, fullscreen: boolean) => {
  await mpvController.setFullscreen(Boolean(fullscreen));
});

ipcMain.handle('media:mpv-set-aspect-mode', async (_event, mode: 'default' | 'contain' | 'fill' | '4 / 3' | '16 / 9' | '21 / 9') => {
  await mpvController.setAspectMode(mode);
});

ipcMain.handle('media:mpv-select-track', async (_event, type: 'video' | 'audio' | 'sub', ffIndex: number) => {
  await mpvController.selectTrack(type, Number(ffIndex));
});

ipcMain.handle('media:mpv-select-secondary-subtitle-track', async (_event, ffIndex: number) => {
  await mpvController.selectSecondarySubtitleTrack(Number(ffIndex));
});

ipcMain.handle('media:mpv-set-subtitle-style', async (_event, style: SubtitleStyleOptions) => {
  await mpvController.setSubtitleStyle(style || {});
});

ipcMain.handle('media:mpv-cycle-audio', async () => {
  await mpvController.cycleAudio();
});

ipcMain.handle('media:mpv-cycle-subtitle', async () => {
  await mpvController.cycleSubtitle();
});

ipcMain.handle('media:mpv-disable-subtitles', async () => {
  await mpvController.disableSubtitles();
});

// ── VideoPlayer uses HTML5 <video> + the HTTP media server directly.
// No player:* IPC handlers needed.

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  applyAppIcon();
  cleanupOldTranscodes();
  await startMediaServer();
  syncLanAdvertisement();
  buildUpdateMenu();

  // ── plexserver:// protocol handler ──────────────────────────────────────────
  // Translates plexserver://localhost/<path>?<query> → http://127.0.0.1:<port>/<path>?<query>
  // This bypasses Electron's URL safety check that blocks http:// sources in
  // <video> / <audio> elements while still streaming from our local HTTP server.
  protocol.handle('plexserver', async (request: Request) => {
    try {
      const parsed = new URL(request.url);
      const targetUrl = `http://127.0.0.1:${mediaServerPort}${parsed.pathname}${parsed.search}`;

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

  createWindow();
  configureAutoUpdater();
  setTimeout(() => {
    checkForUpdates();
  }, 5000);
}).catch((error) => {
  console.error('Failed to start LoomTV:', error);
  app.quit();
});

app.on('second-instance', () => {
  if (!app.isReady()) return;
  createWindow();
});

app.on('window-all-closed', () => {
  // Don't tear down twice when quitAndInstall is closing windows — it issues
  // its own quit and the install path needs a clean exit.
  if (updateInstallStarted) return;
  stopAllTranscodes();
  void stopLocal(mainWindow);
  void mpvController.stop({ suppressEvent: true });
  destroyLanDiscovery();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  createWindow();
});

app.on('before-quit', () => {
  // Skip if quitAndInstall already drained these — re-running close() on a
  // null server or stopping mpv twice can throw and abort the install path.
  if (!updateInstallStarted) {
    stopAllTranscodes();
    void stopLocal(mainWindow);
    void mpvController.stop({ suppressEvent: true });
  }
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  if (mediaServer) {
    try {
      mediaServer.close();
    } catch {
      // Ignore close errors during quit.
    }
    mediaServer = null;
  }
});
