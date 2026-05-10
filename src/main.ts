import { app, BrowserWindow, ipcMain, dialog, nativeImage, protocol, net, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mpvController } from './main/mpv/mpvController';
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

function ignoreBrokenConsolePipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

ignoreBrokenConsolePipe(process.stdout);
ignoreBrokenConsolePipe(process.stderr);

let started = false;
try {
  started = require('electron-squirrel-startup');
  if (started) app.quit();
} catch (e) {}

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

let mainWindow: BrowserWindow | null = null;
const LIBRARY_FILE = path.join(app.getPath('userData'), 'library.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const SCAN_CACHE_VERSION = 7;
let libraryMutationVersion = 0;

let mediaServerPort = 3847;
let mediaServer: http.Server | null = null;

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface EpisodeMeta {
  season: number;
  number: number;
  title: string;
  summary: string;
  still: string;
  rating: number;
  airDate: string;
  localMetadata?: LocalMediaDetails;
}

interface EpisodeFile {
  season: number;
  episode: number;
  filePath: string;
  title?: string;
  localMetadata?: LocalMediaDetails;
}

interface LocalMediaDetails {
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  videoProfile?: string;
  pixelFormat?: string;
  audioCodec?: string;
  audioTracks?: number;
  subtitleTracks?: number;
  bitrateKbps?: number;
  container?: string;
}

interface MediaItem {
  id: string;
  type: 'movie' | 'tv' | 'anime';
  title: string;
  year: number;
  poster: string;
  backdrop: string;
  posterCandidates?: string[];
  backdropCandidates?: string[];
  summary: string;
  rating: number;
  genres: string[];
  cast: { name: string; character: string; image: string }[];
  filePath: string;
  fileSize?: number;
  lastPlayed?: number;
  seasons?: { number: number; title: string; episodeCount: number }[];
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
  subtitles?: { lang: string; label: string; url: string }[];
  localMetadata?: LocalMediaDetails;
}

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

interface TVMetadata extends Partial<MediaItem> {
  language?: string;
  country?: string;
  showType?: string;
}

type LibraryFolderKind = 'movies' | 'tvShows' | 'anime';
type ScanFolderKind = 'movies' | 'tv' | 'anime';
type LibraryScanMode = 'quick' | 'metadata' | 'full';

interface LibraryFolderGroups {
  movies: string[];
  tvShows: string[];
  anime: string[];
}

interface MetadataProviderIds {
  tmdbId?: string;
  imdbId?: string;
  tvdbId?: string;
}

interface ScanCacheEntry {
  version?: number;
  folderKind: ScanFolderKind;
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
  sidebarNavOrder?: string[];
  appThemeMode?: 'dark' | 'light';
  appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue';
  appLoaderStyle?: 'play-mark' | 'logo-mark' | 'horizontal-logo';
}

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
  const defaultSidebarNavOrder = ['anime', 'tv', 'movies'];
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
    sidebarNavOrder,
    appThemeMode: 'dark',
    appThemeColor: raw.appThemeColor === 'yellow' || raw.appThemeColor === 'red' || raw.appThemeColor === 'blue' || raw.appThemeColor === 'orange'
      ? raw.appThemeColor
      : 'yellow',
    appLoaderStyle: raw.appLoaderStyle === 'logo-mark' || raw.appLoaderStyle === 'horizontal-logo' || raw.appLoaderStyle === 'play-mark'
      ? raw.appLoaderStyle
      : 'play-mark',
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

function safeEndResponse(res: http.ServerResponse): void {
  if (!res.writableEnded) res.end();
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
  const fontSize = clampStyleNumber(style?.fontSize, 55, 24, 96) * clampStyleNumber(style?.scale, 1, 0.5, 2);
  const position = placement === 'secondary' ? 8 : clampStyleNumber(style?.position, 92, 0, 100);
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
      position: clampStyleNumber(parsed.position, 92, 0, 100),
      scale: clampStyleNumber(parsed.scale, 1, 0.5, 2),
      fontSize: clampStyleNumber(parsed.fontSize, 55, 24, 96),
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

function cleanMediaTitle(name: string): { title: string; year: number } {
  const withoutExt = name.replace(/\.(mkv|mp4|avi|mov|webm|m4v|wmv|flv|mpg|mpeg|m2ts|3gp|ts|vtt|srt|ass|ssa)$/i, '');
  const yearMatches = [...withoutExt.matchAll(/\b(19\d{2}|20\d{2})\b/g)];
  const maxReleaseYear = new Date().getFullYear() + 1;
  const releaseYearMatch =
    yearMatches.find((match) => match.index !== undefined && match.index > 0 && parseInt(match[1], 10) <= maxReleaseYear)
    || yearMatches.find((match) => parseInt(match[1], 10) <= maxReleaseYear);
  const titleSource = releaseYearMatch?.index && releaseYearMatch.index > 0
    ? withoutExt.slice(0, releaseYearMatch.index).replace(/[\s([._-]+$/, ' ')
    : withoutExt;
  const title = titleSource
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\b(480p|720p|1080p|2160p|4k|uhd|hdr10|hdr|dv|dolby|vision|bluray|blu-ray|brrip|webrip|web-rip|web-dl|webdl|hdtv|remux|proper|repack|extended|directors?|cut|imax|x264|x265|h264|h265|hevc|av1|aac|ac3|eac3|dts|truehd|atmos)\b/gi, ' ')
    .replace(/\b(yts|rarbg|ettv|eztv|tgx|galaxyrg|psa|pahe|ntb|successfulcrab)\b/gi, ' ')
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(/\s+[Ss]\d{1,2}[Ee]\d{1,3}.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title: title || withoutExt.trim() || name,
    year: releaseYearMatch ? parseInt(releaseYearMatch[1], 10) : 0,
  };
}

function normalizeTitleForMatch(value?: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatchesLocal(localTitle: string, remoteTitle?: string): boolean {
  const local = normalizeTitleForMatch(localTitle);
  const remote = normalizeTitleForMatch(remoteTitle);
  if (!local || !remote) return false;
  if (local === remote) return true;

  const localTokens = new Set(local.split(' ').filter((token) => token.length > 2));
  const remoteTokens = new Set(remote.split(' ').filter((token) => token.length > 2));
  if (localTokens.size === 0 || remoteTokens.size === 0) return false;
  if (localTokens.size > 1 && [...localTokens].every((token) => remoteTokens.has(token))) return true;
  if (remoteTokens.size > 1 && [...remoteTokens].every((token) => localTokens.has(token))) return true;

  let shared = 0;
  localTokens.forEach((token) => {
    if (remoteTokens.has(token)) shared++;
  });
  return shared / Math.max(localTokens.size, remoteTokens.size) >= 0.75;
}

function isGenericMediaFolderTitle(value: string): boolean {
  return /^(movie|movies|film|films|tv|tv shows|shows|series|season|season \d+|anime|animations?)$/i
    .test(normalizeTitleForMatch(value));
}

function isGenericGroupingFolderTitle(value: string): boolean {
  const normalized = normalizeTitleForMatch(value);
  return isGenericMediaFolderTitle(value)
    || /^(complete|completed|batch|batches|pack|packs|collection|collections|part|part \d+|pt|pt \d+|cour|cour \d+|volume|volume \d+|vol|vol \d+|episodes|episode|1080p|720p|2160p|4k)$/.test(normalized);
}

function usefulLocalTitle(value?: string): string | null {
  const title = cleanMediaTitle(value || '').title;
  if (!title || isGenericGroupingFolderTitle(title)) return null;
  return title;
}

function uniqueLocalTitles(candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];

  candidates.forEach((candidate) => {
    const title = usefulLocalTitle(candidate);
    if (!title) return;
    const key = normalizeTitleForMatch(title);
    if (seen.has(key)) return;
    seen.add(key);
    titles.push(title);
  });

  return titles;
}

function remoteMatchesAnyLocalTitle(localTitles: string[], remoteTitle?: string): boolean {
  return localTitles.some((localTitle) => titleMatchesLocal(localTitle, remoteTitle));
}

function mediaItemHasUsableArtwork(item: MediaItem): boolean {
  return Boolean(
    item.poster?.trim()
    || item.backdrop?.trim()
    || item.posterCandidates?.some((source) => source.trim())
    || item.backdropCandidates?.some((source) => source.trim()),
  );
}

function cachedItemNeedsMetadataRefresh(item: MediaItem): boolean {
  const isSeries = item.type === 'tv' || item.type === 'anime' || Boolean(item.episodeFiles?.length);
  if (isSeries && (!item.year || item.year <= 0)) return true;
  return !mediaItemHasUsableArtwork(item);
}

function cachedItemsAreComplete(items: MediaItem[]): boolean {
  return items.length > 0 && items.every((item) => !cachedItemNeedsMetadataRefresh(item));
}

function yearFromDateString(value?: string): number {
  if (!value) return 0;
  const year = new Date(value).getFullYear();
  return Number.isFinite(year) ? year : parseYearFromText(value);
}

function yearsMatch(localYear?: number, remoteYear?: number): boolean {
  if (!localYear || !remoteYear) return true;
  return Math.abs(localYear - remoteYear) <= 1;
}

function movieHitMatchesLocal(
  hit: { title?: string; original_title?: string; release_date?: string },
  localTitles: string[],
  localYear?: number,
): boolean {
  if (!remoteMatchesAnyLocalTitle(localTitles, hit.title) && !remoteMatchesAnyLocalTitle(localTitles, hit.original_title)) {
    return false;
  }
  return yearsMatch(localYear, yearFromDateString(hit.release_date));
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

function parseYearFromText(value?: string): number {
  if (!value) return 0;
  const match = value.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1], 10) : 0;
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

function makeLocalEpisodeMeta(files: EpisodeFile[]): EpisodeMeta[] {
  return files.map((file) => ({
    season: file.season,
    number: file.episode,
    title: file.title || path.basename(file.filePath, path.extname(file.filePath))
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `Episode ${file.episode}`,
    summary: '',
    still: '',
    rating: 0,
    airDate: '',
    localMetadata: file.localMetadata,
  }));
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

      if (reqUrl.pathname === '/api/library' && req.method === 'GET') {
        writeJson(res, 200, loadLibrary());
        return;
      }

      if (reqUrl.pathname === '/api/library/scan' && req.method === 'POST') {
        const scanVersion = libraryMutationVersion;
        readJsonBody(req)
          .catch(() => ({}))
          .then((body) => scanLibrary(loadLibrary(), {
            force: Boolean(body.force),
            mode: body.mode === 'metadata' || body.mode === 'full' ? body.mode : 'quick',
          }))
          .then((scanned) => {
            saveLibraryFromScan(scanned, scanVersion);
            writeJson(res, 200, loadLibrary());
          })
          .catch((error) => {
            console.error('scan library API error:', error);
            writeJson(res, 500, { error: 'Failed to scan library' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/library/add-folder' && req.method === 'POST') {
        readJsonBody(req)
          .catch(() => ({}))
          .then((body) => {
            const requestedKind = String(body.kind || '');
            const kind: LibraryFolderKind = requestedKind === 'tvShows' || requestedKind === 'anime' || requestedKind === 'movies'
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
            saveLibraryFromScan(scanned, scanVersion);
            writeJson(res, 200, loadLibrary());
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
            writeJson(res, 200, loadLibrary());
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
          writeJson(res, 200, clearAppData());
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
      mediaServer!.listen(port, '127.0.0.1', () => {
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

// ─── Metadata — OMDb API (movies & TV, with API key) ──────────────────
async function fetchOMDbMetadata(title: string, year?: number, omdbApiKey?: string): Promise<Record<string, any> | null> {
  if (!omdbApiKey) return null;
  try {
    const attempts = year ? [year, undefined] : [undefined];
    for (const attemptYear of attempts) {
      const yearParam = attemptYear ? `&y=${attemptYear}` : '';
      const url = `http://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(omdbApiKey)}${yearParam}`;
      const res = await fetch(url);
      const data = await res.json() as Record<string, any>;
      if (data.Response !== 'False') return data;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchOMDbMetadataById(imdbId: string | undefined, omdbApiKey?: string): Promise<Record<string, any> | null> {
  if (!imdbId || !omdbApiKey) return null;
  try {
    const url = `http://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(omdbApiKey)}`;
    const res = await fetch(url);
    const data = await res.json() as Record<string, any>;
    return data.Response !== 'False' ? data : null;
  } catch {
    return null;
  }
}

// ─── Metadata — TVmaze (TV shows, free, no API key) ─────────────────────────

async function fetchTVMetadata(title: string, localYear?: number): Promise<TVMetadata | null> {
  try {
    const searchRes = await fetch(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`,
    );
    const searchData: any[] = await searchRes.json();
    if (!searchData || searchData.length === 0) return null;

    // Prefer a result whose premiered year matches what we extracted locally
    let show = searchData[0].show;
    if (localYear) {
      const yearMatch = searchData.find((r: any) => {
        const premiered = r.show?.premiered;
        return premiered && new Date(premiered).getFullYear() === localYear;
      });
      if (yearMatch) show = yearMatch.show;
    }

    const detailRes = await fetch(
      `https://api.tvmaze.com/shows/${show.id}?embed[]=seasons&embed[]=episodes&embed[]=cast`,
    );
    const details: any = await detailRes.json();

    const seasons = (details._embedded?.seasons || [])
      .filter((s: any) => s.number > 0)
      .map((s: any) => ({
        number: s.number,
        title: s.name || `Season ${s.number}`,
        episodeCount: s.episodeOrder || 0,
      }));

    const episodes: EpisodeMeta[] = (details._embedded?.episodes || []).map((e: any) => ({
      season: e.season,
      number: e.number,
      title: e.name || '',
      summary: e.summary ? e.summary.replace(/<[^>]*>/g, '') : '',
      still: e.image?.medium || '',
      rating: e.rating?.average || 0,
      airDate: e.airdate || '',
    }));

    const cast = (details._embedded?.cast || []).slice(0, 6).map((c: any) => ({
      name: c.person?.name || '',
      character: c.character?.name || '',
      image: c.person?.image?.medium || '',
    }));

    const posterUrl = details.image?.original || details.image?.medium || '';

    return {
      title: details.name || show.name || title,
      poster: posterUrl,
      backdrop: '',
      summary: details.summary ? details.summary.replace(/<[^>]*>/g, '') : '',
      rating: details.rating?.average || 0,
      genres: details.genres || [],
      cast,
      year: details.premiered ? new Date(details.premiered).getFullYear() : (localYear || 0),
      language: details.language || '',
      country: details.network?.country?.name || details.webChannel?.country?.name || '',
      showType: details.type || '',
      seasons: seasons.length > 0 ? seasons : undefined,
      episodes,
    };
  } catch (error) {
    console.error('TVmaze fetch error:', error);
    return null;
  }
}

async function fetchMovieMetadata(title: string, year?: number, omdbApiKey?: string): Promise<Partial<MediaItem> | null> {
  if (!omdbApiKey) return null;
  try {
    const yearParam = year ? `&y=${year}` : '';
    const url = `http://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(omdbApiKey)}${yearParam}`;
    const res = await fetch(url);
    const data: any = await res.json();
    if (data.Response === 'False') return null;

    return {
      poster: data.Poster && data.Poster !== 'N/A' ? data.Poster : '',
      backdrop: data.Poster && data.Poster !== 'N/A' ? data.Poster : '',
      summary: data.Plot || '',
      rating: data.imdbRating ? parseFloat(data.imdbRating) : 0,
      genres: data.Genre ? data.Genre.split(', ') : [],
      cast: [],
      year: data.Year ? parseInt(data.Year, 10) : year || 0,
    };
  } catch (error) {
    console.error('OMDb fetch error:', error);
    return null;
  }
}

// ─── Metadata — TMDB (movies + TV, free key from themoviedb.org) ─────────────

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

function normalizeTMDBCredential(value: string): string {
  return value.trim().replace(/^Bearer\s+/i, '');
}

function isTMDBReadAccessToken(value: string): boolean {
  const candidate = value.trim();
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate);
}

async function fetchTMDBJson<T>(path: string, tmdbCredential?: string): Promise<T | null> {
  const credential = normalizeTMDBCredential(tmdbCredential || '');
  if (!credential) return null;

  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  url.searchParams.set('language', 'en-US');

  const requestInit: RequestInit = {};
  if (isTMDBReadAccessToken(credential)) {
    requestInit.headers = {
      Authorization: `Bearer ${credential}`,
    };
  } else {
    url.searchParams.set('api_key', credential);
  }

  const response = await fetch(url.toString(), requestInit);
  if (!response.ok) {
    throw new Error(`TMDB request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

function tmdbPoster(path: string | null | undefined): string {
  return path ? `${TMDB_IMAGE_BASE}/w500${path}` : '';
}
function tmdbBackdrop(path: string | null | undefined): string {
  return path ? `${TMDB_IMAGE_BASE}/w1280${path}` : '';
}

function tmdbMovieResult(d: any, fallbackTitle: string): Partial<MediaItem> | null {
  if (!d) return null;
  const cast = ((d.credits?.cast ?? []) as any[]).slice(0, 8).map((c: any) => ({
    name: c.name ?? '',
    character: c.character ?? '',
    image: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : '',
  }));

  return {
    title: d.title || fallbackTitle,
    poster: tmdbPoster(d.poster_path),
    backdrop: tmdbBackdrop(d.backdrop_path),
    summary: d.overview || '',
    rating: d.vote_average ?? 0,
    genres: ((d.genres ?? []) as any[]).map((g: any) => g.name as string),
    year: d.release_date ? new Date(d.release_date).getFullYear() : 0,
    cast,
  };
}

async function fetchTMDBMovieMetadata(
  title: string,
  year?: number,
  tmdbCredential?: string,
): Promise<Partial<MediaItem> | null> {
  if (!tmdbCredential) return null;
  try {
    const localTitles = uniqueLocalTitles([title]);
    const searchPaths = [
      `search/movie?query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`,
      year ? `search/movie?query=${encodeURIComponent(title)}` : '',
    ].filter(Boolean);
    let hit: any = null;
    for (const searchPath of searchPaths) {
      const searchData = await fetchTMDBJson<any>(searchPath, tmdbCredential);
      const results = Array.isArray(searchData?.results) ? searchData.results : [];
      hit = results.find((candidate: any) => movieHitMatchesLocal(candidate, localTitles, year)) || null;
      if (hit) break;
    }
    if (!hit) return null;

    const d = await fetchTMDBJson<any>(`movie/${hit.id}?append_to_response=credits`, tmdbCredential);
    const result = tmdbMovieResult(d, hit.title || title);
    return result ? { ...result, year: result.year || year || 0 } : null;
  } catch (err) {
    console.error('[TMDB movie]', err);
    return null;
  }
}

async function fetchTMDBMovieMetadataById(
  tmdbId: string | undefined,
  tmdbCredential?: string,
): Promise<Partial<MediaItem> | null> {
  if (!tmdbId || !tmdbCredential) return null;
  try {
    const d = await fetchTMDBJson<any>(`movie/${encodeURIComponent(tmdbId)}?append_to_response=credits`, tmdbCredential);
    return tmdbMovieResult(d, '');
  } catch (err) {
    console.error('[TMDB movie id]', err);
    return null;
  }
}

interface TMDBTVResult extends Partial<MediaItem> {
  episodes?: EpisodeMeta[];
  tmdbSeasons?: { number: number; title: string; episodeCount: number }[];
}

async function tmdbTVResultFromDetails(d: any, fallbackTitle: string, tmdbCredential?: string): Promise<TMDBTVResult | null> {
  if (!d) return null;

  const cast = ((d.credits?.cast ?? []) as any[]).slice(0, 8).map((c: any) => ({
    name: c.name ?? '',
    character: c.character ?? '',
    image: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : '',
  }));

  const realSeasons: any[] = ((d.seasons ?? []) as any[]).filter(
    (s: any) => s.season_number > 0,
  );

  const tmdbSeasons = realSeasons.map((s: any) => ({
    number: s.season_number as number,
    title: (s.name as string) || `Season ${s.season_number}`,
    episodeCount: (s.episode_count as number) || 0,
  }));

  const seasonEpisodes = await Promise.all(
    realSeasons.slice(0, 15).map(async (s: any) => {
      try {
        const epData = await fetchTMDBJson<any>(`tv/${d.id}/season/${s.season_number}`, tmdbCredential);
        return ((epData?.episodes ?? []) as any[]);
      } catch {
        return [] as any[];
      }
    }),
  );

  const episodes: EpisodeMeta[] = seasonEpisodes.flat().map((e: any) => ({
    season: e.season_number as number,
    number: e.episode_number as number,
    title: (e.name as string) || '',
    summary: (e.overview as string) || '',
    still: e.still_path ? `${TMDB_IMAGE_BASE}/w300${e.still_path}` : '',
    rating: (e.vote_average as number) || 0,
    airDate: (e.air_date as string) || '',
  }));

  return {
    title: (d.name as string) || fallbackTitle,
    poster: tmdbPoster(d.poster_path),
    backdrop: tmdbBackdrop(d.backdrop_path),
    summary: (d.overview as string) || '',
    rating: (d.vote_average as number) ?? 0,
    genres: ((d.genres ?? []) as any[]).map((g: any) => g.name as string),
    year: d.first_air_date ? new Date(d.first_air_date as string).getFullYear() : 0,
    cast,
    episodes,
    tmdbSeasons,
  };
}

async function fetchTMDBTVMetadata(
  title: string,
  year?: number,
  tmdbCredential?: string,
): Promise<TMDBTVResult | null> {
  if (!tmdbCredential) return null;
  try {
    const searchPath = `search/tv?query=${encodeURIComponent(title)}${year ? `&first_air_date_year=${year}` : ''}`;
    const searchData = await fetchTMDBJson<any>(searchPath, tmdbCredential);
    const hit = searchData?.results?.[0];
    if (!hit) return null;

    const d = await fetchTMDBJson<any>(`tv/${hit.id}?append_to_response=credits`, tmdbCredential);
    const result = await tmdbTVResultFromDetails(d, hit.name || title, tmdbCredential);
    return result ? { ...result, year: result.year || year || 0 } : null;
  } catch (err) {
    console.error('[TMDB TV]', err);
    return null;
  }
}

async function fetchTMDBTVMetadataById(
  tmdbId: string | undefined,
  tmdbCredential?: string,
): Promise<TMDBTVResult | null> {
  if (!tmdbId || !tmdbCredential) return null;
  try {
    const d = await fetchTMDBJson<any>(`tv/${encodeURIComponent(tmdbId)}?append_to_response=credits`, tmdbCredential);
    return tmdbTVResultFromDetails(d, '', tmdbCredential);
  } catch (err) {
    console.error('[TMDB TV id]', err);
    return null;
  }
}

// ─── Metadata — Jikan v4 (MyAnimeList, free, no key) ─────────────────────────
// https://docs.api.jikan.moe/

/** Respect Jikan's public rate limit (3 req/sec). */
const _jikan = { lastCallAt: 0 };
async function jikanDelay(): Promise<void> {
  const MIN_GAP = 350;
  const wait = MIN_GAP - (Date.now() - _jikan.lastCallAt);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  _jikan.lastCallAt = Date.now();
}

async function jikanFetch(path: string): Promise<any> {
  await jikanDelay();
  const res = await fetch(`https://api.jikan.moe/v4${path}`);
  if (!res.ok) throw new Error(`Jikan ${path} → ${res.status}`);
  return res.json();
}

interface JikanAnimeResult extends Partial<MediaItem> {
  episodes?: EpisodeMeta[];
  malId?: number;
}

async function fetchJikanMetadata(title: string): Promise<JikanAnimeResult | null> {
  try {
    // ── 1. Search ────────────────────────────────────────────────────────────
    const searchData: any = await jikanFetch(
      `/anime?q=${encodeURIComponent(title)}&limit=5&sfw`,
    );
    const hit: any = searchData.data?.[0];
    if (!hit) return null;

    const malId: number = hit.mal_id;
    const poster: string =
      hit.images?.jpg?.large_image_url || hit.images?.jpg?.image_url || '';

    // ── 2. Characters (cast) ─────────────────────────────────────────────────
    let cast: MediaItem['cast'] = [];
    try {
      const charData: any = await jikanFetch(`/anime/${malId}/characters`);
      cast = ((charData.data ?? []) as any[])
        .filter((c: any) => c.role === 'Main')
        .slice(0, 8)
        .map((c: any) => ({
          name: c.character?.name ?? '',
          character: c.character?.name ?? '',
          image: c.character?.images?.jpg?.image_url ?? '',
        }));
    } catch { /* cast is optional */ }

    // ── 3. Episodes (paginated, cap at 3 pages = 75 episodes for performance) ─
    let episodes: EpisodeMeta[] = [];
    try {
      let page = 1;
      let hasNextPage = true;
      while (hasNextPage && page <= 3) {
        const epData: any = await jikanFetch(`/anime/${malId}/episodes?page=${page}`);
        const epList: any[] = epData.data ?? [];
        episodes.push(
          ...epList.map((e: any) => ({
            season: 1, // MAL doesn't separate seasons; treat as single season
            number: e.mal_id as number,
            title: (e.title_romanji as string) || (e.title as string) || `Episode ${e.mal_id}`,
            summary: '',
            still: '',
            rating: (e.score as number) || 0,
            airDate: e.aired ? String(e.aired).split('T')[0] : '',
          })),
        );
        hasNextPage = epData.pagination?.has_next_page === true;
        page++;
      }
    } catch { /* episodes are optional */ }

    return {
      malId,
      title: (hit.title_english as string) || (hit.title as string) || title,
      poster,
      backdrop: '',
      summary: (hit.synopsis as string) || '',
      rating: (hit.score as number) ?? 0,
      genres: ((hit.genres ?? []) as any[]).map((g: any) => g.name as string),
      year: (hit.year as number) ?? (hit.aired?.from ? new Date(hit.aired.from).getFullYear() : 0),
      cast,
      episodes,
    };
  } catch (err) {
    console.error('[Jikan]', err);
    return null;
  }
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
  const localEpisodes = makeLocalEpisodeMeta(episodeFiles);
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

  // ── Fetch metadata sources ─────────────────────────────────────────────────
  // Anime   → Jikan (MAL) primary, TMDB + OMDb as fallbacks
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
    // TVmaze: free fallback for western TV episode titles.
    !likelyAnime ? fetchTVMetadata(searchTitle, searchYear) : Promise.resolve(null),
  ]);
  const matchedOmdbData = [omdbById, omdbBySearch]
    .find((data) => remoteMatchesAnyLocalTitle(localTitleCandidates, data?.Title)) || null;
  const matchedJikanMeta = remoteMatchesAnyLocalTitle(localTitleCandidates, jikanMeta?.title) ? jikanMeta : null;
  const matchedTmdbTVMeta = [tmdbTVById, tmdbTVBySearch]
    .find((data) => remoteMatchesAnyLocalTitle(localTitleCandidates, data?.title)) || null;
  const matchedTVMeta = remoteMatchesAnyLocalTitle(localTitleCandidates, tvMeta?.title) ? tvMeta : null;

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

  const rating =
    (finalType === 'anime' ? (matchedJikanMeta?.rating ?? 0) : 0)
    || (matchedTmdbTVMeta?.rating ?? 0)
    || (matchedTVMeta?.rating ?? 0)
    || (matchedOmdbData?.imdbRating ? parseFloat(matchedOmdbData.imdbRating) : 0);

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

  // ── Merge episode metadata onto local files ────────────────────────────────
  // Priority of episode data: Jikan (anime) > TMDB TV > TVmaze
  // Remote episode maps are keyed by "season-number" (Jikan uses season=1 for all)
  const remoteEpisodes: EpisodeMeta[] =
    (finalType === 'anime' ? matchedJikanMeta?.episodes : null)
    ?? matchedTmdbTVMeta?.episodes
    ?? matchedTVMeta?.episodes
    ?? [];

  let mergedEpisodes = localEpisodes;
  if (remoteEpisodes.length > 0) {
    // Jikan numbers by episode only (season always 1), so match by episode number alone for anime
    const useEpKeyOnly = finalType === 'anime' && matchedJikanMeta?.episodes && matchedJikanMeta.episodes.length > 0;
    const remoteEpMap = new Map<string, EpisodeMeta>(
      remoteEpisodes.map((ep) => [
        useEpKeyOnly ? String(ep.number) : `${ep.season}-${ep.number}`,
        ep,
      ]),
    );

    mergedEpisodes = localEpisodes.map((local) => {
      const key = useEpKeyOnly ? String(local.episode) : `${local.season}-${local.episode}`;
      const remote = remoteEpMap.get(key);
      if (!remote) return local;
      return {
        ...local,
        title: local.title || remote.title,
        summary: local.summary || remote.summary,
        still: remote.still || local.still,
        rating: remote.rating || local.rating,
        airDate: local.airDate || remote.airDate,
      };
    });
  }

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
    episodeFiles,
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
    shouldUseShowProviders && !likelyAnime ? fetchTVMetadata(searchTitle, searchYear) : Promise.resolve(null),
  ]);
  const matchedTmdbData = [tmdbById, tmdbBySearch]
    .find((data) => remoteMatchesAnyLocalTitle(localTitleCandidates, data?.title)) || null;
  const matchedOmdbData = [omdbById, omdbBySearch]
    .find((data) => remoteMatchesAnyLocalTitle(localTitleCandidates, data?.Title)) || null;
  const matchedJikanMeta = remoteMatchesAnyLocalTitle(localTitleCandidates, jikanMeta?.title) ? jikanMeta : null;
  const matchedTmdbTVMeta = [tmdbTVById, tmdbTVBySearch]
    .find((data) => remoteMatchesAnyLocalTitle(localTitleCandidates, data?.title)) || null;
  const matchedTVMeta = remoteMatchesAnyLocalTitle(localTitleCandidates, tvMeta?.title) ? tvMeta : null;

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
  const rating =
    (finalType === 'anime' ? (matchedJikanMeta?.rating ?? 0) : 0)
    || (matchedTmdbTVMeta?.rating ?? 0)
    || (matchedTVMeta?.rating ?? 0)
    || (matchedTmdbData?.rating ?? 0)
    || (matchedOmdbData?.imdbRating ? parseFloat(matchedOmdbData.imdbRating) : 0);
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
      (finalType === 'anime' ? matchedJikanMeta?.episodes : null)
      ?? matchedTmdbTVMeta?.episodes
      ?? matchedTVMeta?.episodes
      ?? [];
    const remoteSeasons =
      matchedTmdbTVMeta?.tmdbSeasons
      ?? matchedTVMeta?.seasons
      ?? [{ number: 1, title: finalType === 'anime' ? 'Season 1' : 'Season 1', episodeCount: 1 }];
    const episodeStill = remoteEpisodes.find((episode) => Boolean(episode.still))?.still || officialBackdrop || embeddedPoster || localThumbnail;

    return {
      ...baseItem,
      seasons: remoteSeasons.length > 0 ? remoteSeasons : [{ number: 1, title: 'Season 1', episodeCount: 1 }],
      episodes: [{
        season: 1, number: 1,
        title: resolvedTitle,
        summary,
        still: episodeStill,
        rating,
        airDate: '',
        localMetadata: probe.localMetadata,
      }],
      episodeFiles: [{ season: 1, episode: 1, filePath: fullPath, title: resolvedTitle, localMetadata: probe.localMetadata }],
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
  return { movies: [], tvShows: [], anime: [] };
}

function flattenLibraryFolders(groups: LibraryFolderGroups): string[] {
  return Array.from(new Set([...groups.movies, ...groups.tvShows, ...groups.anime]));
}

function normalizeLibraryFolderGroups(data?: Partial<LibraryData>): LibraryFolderGroups {
  const normalized = defaultLibraryFolderGroups();
  const groups = data?.libraryFolderGroups;
  if (groups) {
    normalized.movies = [...(groups.movies || [])];
    normalized.tvShows = [...(groups.tvShows || [])];
    normalized.anime = [...(groups.anime || [])];
  }

  for (const folder of data?.libraryFolders || []) {
    if (flattenLibraryFolders(normalized).includes(folder)) continue;
    const detected = detectLibraryFolderKind(folder);
    if (detected === 'movies') normalized.movies.push(folder);
    else if (detected === 'tv') normalized.tvShows.push(folder);
    else if (detected === 'anime') normalized.anime.push(folder);
  }

  return {
    movies: Array.from(new Set(normalized.movies)),
    tvShows: Array.from(new Set(normalized.tvShows)),
    anime: Array.from(new Set(normalized.anime)),
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

  const appendItems = (items: MediaItem[], folderKind: ScanFolderKind) => {
    for (const item of items) {
      if (folderKind === 'movies') movies.push({ ...item, type: 'movie' });
      else if (folderKind === 'anime') animeShows.push({ ...item, type: 'anime' });
      else tvShows.push({ ...item, type: 'tv' });
    }
  };

  const cachedItemsForFolder = (folder: string, folderKind: ScanFolderKind): MediaItem[] => {
    const source = folderKind === 'movies'
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
    folderKind: NonNullable<ScanContext['folderKind']>,
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

      const folderCtx: ScanContext = { ...ctx, folderKind };
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

  const nextLibrary = {
    movies,
    tvShows,
    animeShows,
    libraryFolders: flattenLibraryFolders(folderGroups),
    libraryFolderGroups: folderGroups,
    scanCache: nextScanCache,
  };
  await cacheLibraryArtwork(nextLibrary);
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

function saveLibrary(data: LibraryData): void {
  try {
    const libraryFolderGroups = normalizeLibraryFolderGroups(data);
    const activeFolders = new Set(flattenLibraryFolders(libraryFolderGroups));
    const scanCache = Object.fromEntries(
      Object.entries(data.scanCache || {}).filter(([folder]) => activeFolders.has(folder)),
    );
    saveLibraryToDatabase({
      ...data,
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
  posterCandidates: string[];
  backdropCandidates: string[];
};

function officialArtworkOnly(urls: Array<string | null | undefined>): string[] {
  return orderedArtworkCandidates(...urls).filter((url) => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return host.includes('image.tmdb.org')
        || host.includes('media-amazon.com')
        || host.includes('m.media-amazon.com')
        || host.includes('cdn.myanimelist.net')
        || host.includes('static.tvmaze.com');
    } catch {
      return false;
    }
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
  const searchTitle =
    usefulLocalTitle(item.title)
    || usefulLocalTitle(embeddedTitle)
    || usefulLocalTitle(folderTitle)
    || usefulLocalTitle(parsedPathTitle)
    || item.title;
  const localTitles = uniqueLocalTitles([
    searchTitle,
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

async function fetchOfficialArtworkForItem(item: MediaItem): Promise<OfficialArtworkRefreshResult> {
  const settings = loadSettings();
  const tmdbApiKey = getMetadataApiKey(settings, 'tmdb');
  const omdbApiKey = getMetadataApiKey(settings, 'omdb');
  const { title, year, localTitles, providerIds } = itemArtworkLookupData(item);

  if (item.type === 'movie') {
    const [tmdbById, tmdbBySearch, omdbById, omdbBySearch] = await Promise.all([
      providerIds.tmdbId ? fetchTMDBMovieMetadataById(providerIds.tmdbId, tmdbApiKey) : Promise.resolve(null),
      fetchTMDBMovieMetadata(title, year, tmdbApiKey),
      providerIds.imdbId ? fetchOMDbMetadataById(providerIds.imdbId, omdbApiKey) : Promise.resolve(null),
      fetchOMDbMetadata(title, year, omdbApiKey),
    ]);
    const tmdbMeta = tmdbById || (remoteMatchesAnyLocalTitle(localTitles, tmdbBySearch?.title) ? tmdbBySearch : null);
    const omdbMeta = omdbById || (remoteMatchesAnyLocalTitle(localTitles, omdbBySearch?.Title) ? omdbBySearch : null);
    const omdbPoster = omdbMeta?.Poster && omdbMeta.Poster !== 'N/A' ? omdbMeta.Poster : '';
    const posterCandidates = officialArtworkOnly([tmdbMeta?.poster, omdbPoster]);
    const backdropCandidates = officialArtworkOnly([tmdbMeta?.backdrop]);
    return {
      thumbnail: posterCandidates[0] || '',
      cover: backdropCandidates[0] || posterCandidates[0] || '',
      summary: tmdbMeta?.summary || omdbMeta?.Plot || '',
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
    !likelyAnime ? fetchTVMetadata(title, year) : Promise.resolve(null),
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

  return {
    thumbnail: posterCandidates[0] || '',
    cover: backdropCandidates[0] || posterCandidates[0] || '',
    summary: tmdbMeta?.summary || omdbMeta?.Plot || matchedTV?.summary || matchedJikan?.summary || '',
    posterCandidates,
    backdropCandidates,
  };
}

async function refreshOfficialArtwork(mediaId: string): Promise<OfficialArtworkRefreshResult> {
  const library = loadLibrary();
  const collections: Array<{ items: MediaItem[] }> = [
    { items: library.movies },
    { items: library.tvShows },
    { items: library.animeShows },
  ];
  const target = collections
    .flatMap((collection) => collection.items)
    .find((item) => item.id === mediaId);

  if (!target) {
    throw new Error('Media item was not found in the library.');
  }

  const refreshed = await fetchOfficialArtworkForItem(target);
  if (refreshed.thumbnail || refreshed.cover || refreshed.summary) {
    if (refreshed.thumbnail) target.poster = refreshed.thumbnail;
    if (refreshed.cover) target.backdrop = refreshed.cover;
    if (refreshed.summary) target.summary = refreshed.summary;
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
      // Allow renderer to load media from the local HTTP media server (127.0.0.1)
      webSecurity: false,
    },
  };
  const iconPath = getWindowIconPath();
  if (iconPath) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('library:get', () => loadLibrary());

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
      saveLibraryFromScan(snapshot, scanVersion);
      event.sender.send('library:scan-progress', loadLibrary(), {
        isComplete: snapshot.isComplete,
        scannedFolders: snapshot.scannedFolders,
        totalFolders: snapshot.totalFolders,
      });
    },
  });
  saveLibraryFromScan(scanned, scanVersion);
  return loadLibrary();
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
    const safeKind: LibraryFolderKind = kind === 'tvShows' || kind === 'anime' || kind === 'movies' ? kind : 'movies';
    const updated = addFolderToLibrary(data, newFolder, safeKind);
    saveLibraryMutation(updated);
    const scanVersion = libraryMutationVersion;
    const scanned = await scanLibrary(updated, {
      mode: 'quick',
      onProgress: (snapshot) => {
        saveLibraryFromScan(snapshot, scanVersion);
        BrowserWindow.getAllWindows().forEach((window) => {
          window.webContents.send('library:scan-progress', loadLibrary(), {
            isComplete: snapshot.isComplete,
            scannedFolders: snapshot.scannedFolders,
            totalFolders: snapshot.totalFolders,
          });
        });
      },
    });
    saveLibraryFromScan(scanned, scanVersion);
    return loadLibrary();
  }
  return null;
});

ipcMain.handle('library:remove-folder', (_event, folderPath: string) => {
  const data = loadLibrary();
  const updated = removeFolderFromLibrary(data, folderPath);
  saveLibraryMutation(updated);
  return loadLibrary();
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
  return true;
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
ipcMain.handle('artwork:refresh-official', (_event, mediaId: string) => refreshOfficialArtwork(mediaId));
ipcMain.handle('artwork:import', (_event, entries: Record<string, Record<string, string>>) => {
  importCustomArtwork(entries || {});
  return true;
});
ipcMain.handle('database:backup', () => backupDatabase());
ipcMain.handle('database:clear', () => clearAppData());
ipcMain.handle('shell:open-external', (_event, url: string) => shell.openExternal(url));

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
}).catch((error) => {
  console.error('Failed to start LoomTV:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  stopAllTranscodes();
  void stopLocal(mainWindow);
  void mpvController.stop({ suppressEvent: true });
  if (process.platform !== 'darwin') app.quit();
  if (mediaServer) mediaServer.close();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  stopAllTranscodes();
  void stopLocal(mainWindow);
  void mpvController.stop({ suppressEvent: true });
});
