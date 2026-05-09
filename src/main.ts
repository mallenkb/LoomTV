import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync, execSync, spawn } from 'node:child_process';
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
import type { ApiResult, TranscodeOptions } from './main/mediaTypes';
import {
  cleanupOldTranscodes,
  serveHls,
  startTranscode,
  stopAllTranscodes,
  stopTranscode,
} from './main/transcodeManager';

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

// Register privileged scheme BEFORE app ready — required for video streaming
protocol.registerSchemesAsPrivileged([
  { scheme: 'plexserver', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow: BrowserWindow | null = null;
const LIBRARY_FILE = path.join(app.getPath('userData'), 'library.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

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
}

interface TVMetadata extends Partial<MediaItem> {
  language?: string;
  country?: string;
  showType?: string;
}

interface AppSettings {
  omdbApiKey?: string;
  tmdbApiKey?: string;
  metadataApiKeys?: Record<string, string>;
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
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as AppSettings);
    }
  } catch (e) {}
  return normalizeSettings({});
}

function saveSettings(settings: AppSettings): void {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(normalizeSettings(settings), null, 2));
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

function findFFmpeg(): string | null {
  try {
    const staticBinary = existingCompatibleBinary(ffmpegStatic);
    if (staticBinary) return staticBinary;
  } catch (e) {}
  try {
    const candidate = path.join(
      app.getAppPath(),
      'node_modules',
      'ffmpeg-static',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    );
    const bundledBinary = existingCompatibleBinary(candidate);
    if (bundledBinary) return bundledBinary;
  } catch (e) {}
  try {
    const result = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    const systemBinary = existingCompatibleBinary(result);
    if (systemBinary) return systemBinary;
  } catch (e) {}
  return null;
}

function findFFprobe(): string | null {
  try {
    const staticBinary = existingCompatibleBinary(ffprobeStatic?.path);
    if (staticBinary) return staticBinary;
  } catch (e) {}
  try {
    if (ffmpegStatic) {
      const sibling = path.join(path.dirname(ffmpegStatic), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
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
  try {
    const result = execSync('which ffprobe', { encoding: 'utf8' }).trim();
    const systemBinary = existingCompatibleBinary(result);
    if (systemBinary) return systemBinary;
  } catch (e) {}
  return null;
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

function getLocalThumbnailUrl(filePath: string, time = '00:03:00'): string {
  const params = new URLSearchParams({ path: filePath, t: time });
  return `http://127.0.0.1:${mediaServerPort}/api/thumbnail?${params.toString()}`;
}

function srtToVtt(input: string): string {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `WEBVTT\n\n${normalized
    .replace(/^\uFEFF?WEBVTT\s*\n+/i, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

function cleanMediaTitle(name: string): { title: string; year: number } {
  const withoutExt = name.replace(/\.[^.]+$/, '');
  const yearMatch = withoutExt.match(/\b(19\d{2}|20\d{2})\b/);
  const title = withoutExt
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
    year: yearMatch ? parseInt(yearMatch[1], 10) : 0,
  };
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

function probeMediaFile(filePath: string): {
  localMetadata?: LocalMediaDetails;
  embeddedTitle?: string;
  embeddedShowTitle?: string;
  summary?: string;
  year?: number;
  season?: number;
  episode?: number;
} {
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
        codec_type?: string;
        codec_name?: string;
        profile?: string;
        pix_fmt?: string;
        width?: number;
        height?: number;
        channels?: number;
        tags?: Record<string, string>;
      }>;
    };

    const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video');
    const audioStreams = parsed.streams?.filter((stream) => stream.codec_type === 'audio') || [];
    const subtitleStreams = parsed.streams?.filter((stream) => stream.codec_type === 'subtitle') || [];
    const tags = parsed.format?.tags || {};
    const videoTags = videoStream?.tags || {};
    const preferredTitle = scrubTagText(tags.title || videoTags.title);
    const preferredShowTitle = scrubTagText(
      tags.show || tags.series || tags.tvshow || tags.album || videoTags.show || videoTags.series,
    );
    const summary = scrubTagText(tags.description || tags.comment || tags.synopsis);
    const year = parseYearFromText(tags.date || tags.year || tags.creation_time);
    const season = parseIntegerTag(tags.season_number || tags.season || videoTags.season_number || videoTags.season);
    const episode = parseIntegerTag(
      tags.episode_sort || tags.episode_id || tags.track || videoTags.episode_sort || videoTags.episode_id,
    );

    return {
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
      summary: summary || undefined,
      year: year || undefined,
      season,
      episode,
    };
  } catch (error) {
    console.error('ffprobe error for', filePath, error);
    return {};
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
        scanLibrary(loadLibrary().libraryFolders)
          .then((scanned) => {
            saveLibrary(scanned);
            writeJson(res, 200, scanned);
          })
          .catch((error) => {
            console.error('scan library API error:', error);
            writeJson(res, 500, { error: 'Failed to scan library' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/library/add-folder' && req.method === 'POST') {
        dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
          .then((result) => {
            if (result.canceled || result.filePaths.length === 0) {
              writeJson(res, 200, null);
              return;
            }

            const data = loadLibrary();
            const newFolder = result.filePaths[0];
            if (!data.libraryFolders.includes(newFolder)) {
              data.libraryFolders.push(newFolder);
              saveLibrary(data);
            }
            writeJson(res, 200, data);
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
            data.libraryFolders = data.libraryFolders.filter((folder) => folder !== body.folderPath);
            saveLibrary(data);
            writeJson(res, 200, data);
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
            saveSettings(body as AppSettings);
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => {
            console.error('save settings API error:', error);
            writeJson(res, 500, { error: 'Failed to save settings' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/ffmpeg') {
        writeJson(res, 200, { available: findFFmpeg() !== null, path: findFFmpeg() });
        return;
      }

      if (reqUrl.pathname === '/api/thumbnail') {
        const time = reqUrl.searchParams.get('t') || '00:01:00';
        const ffmpegPath = findFFmpeg();
        if (!ffmpegPath || !filePath) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        const args = ['-ss', time, '-i', filePath, '-vframes', '1', '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1'];
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

      if (needsBrowserTranscoding(filePath) && ffmpegPath) {
        // ── Smart remux/transcode ────────────────────────────────────────────
        // Probe to decide what actually needs re-encoding vs what can be copied.
        // Copying streams is nearly instant (just remux); re-encoding is slow.
        const probe = probeMediaFile(filePath);
        const videoCodec = (probe.localMetadata?.videoCodec || '').toLowerCase();
        const videoProfile = (probe.localMetadata?.videoProfile || '').toLowerCase();
        const pixelFormat = (probe.localMetadata?.pixelFormat || '').toLowerCase();
        const audioCodec = (probe.localMetadata?.audioCodec || '').toLowerCase();

        // Keep browser-safe streams; everything else becomes H264/AAC.
        const copyVideo = videoCodec === 'h264'
          && pixelFormat === 'yuv420p'
          && !videoProfile.includes('10');
        const copyAudio = audioCodec === 'aac' || audioCodec === 'mp3';

        console.log(`[stream] ${path.basename(filePath)} | video:${videoCodec}/${pixelFormat || 'unknown'}(${copyVideo ? 'copy' : 'encode'}) audio:${audioCodec}(${copyAudio ? 'copy' : 'encode'})`);

        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Transfer-Encoding': 'chunked',
          'X-Video-Codec': videoCodec,
          'X-Audio-Codec': audioCodec,
        });

        const args: string[] = [
          '-ss', String(startSec),
          '-i', filePath,
          '-map', '0:v:0',     // first video track only
          '-map', '0:a:0?',    // first audio track, if available
          '-sn',
          '-dn',
          '-map_chapters', '-1',
          '-map_metadata', '-1',
          '-c:v', copyVideo ? 'copy' : 'libx264',
          ...(copyVideo ? [] : ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main']),
          '-c:a', copyAudio ? 'copy' : 'aac',
          ...(copyAudio ? [] : ['-b:a', '192k', '-ac', '2']),
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          'pipe:1',
        ];

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
      poster: posterUrl,
      backdrop: posterUrl,
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

async function fetchTMDBMovieMetadata(
  title: string,
  year?: number,
  tmdbCredential?: string,
): Promise<Partial<MediaItem> | null> {
  if (!tmdbCredential) return null;
  try {
    const searchPaths = [
      `search/movie?query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`,
      year ? `search/movie?query=${encodeURIComponent(title)}` : '',
    ].filter(Boolean);
    let hit: any = null;
    for (const searchPath of searchPaths) {
      const searchData = await fetchTMDBJson<any>(searchPath, tmdbCredential);
      hit = searchData?.results?.[0];
      if (hit) break;
    }
    if (!hit) return null;

    const d = await fetchTMDBJson<any>(`movie/${hit.id}?append_to_response=credits`, tmdbCredential);
    if (!d) return null;

    const cast = ((d.credits?.cast ?? []) as any[]).slice(0, 8).map((c: any) => ({
      name: c.name ?? '',
      character: c.character ?? '',
      image: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : '',
    }));

    return {
      title: d.title || hit.title || title,
      poster: tmdbPoster(d.poster_path),
      backdrop: tmdbBackdrop(d.backdrop_path) || tmdbPoster(d.poster_path),
      summary: d.overview || '',
      rating: d.vote_average ?? 0,
      genres: ((d.genres ?? []) as any[]).map((g: any) => g.name as string),
      year: d.release_date ? new Date(d.release_date).getFullYear() : (year ?? 0),
      cast,
    };
  } catch (err) {
    console.error('[TMDB movie]', err);
    return null;
  }
}

interface TMDBTVResult extends Partial<MediaItem> {
  episodes?: EpisodeMeta[];
  tmdbSeasons?: { number: number; title: string; episodeCount: number }[];
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
    if (!d) return null;

    const cast = ((d.credits?.cast ?? []) as any[]).slice(0, 8).map((c: any) => ({
      name: c.name ?? '',
      character: c.character ?? '',
      image: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : '',
    }));

    // Fetch episodes for each real season (skip season 0 = specials)
    const realSeasons: any[] = ((d.seasons ?? []) as any[]).filter(
      (s: any) => s.season_number > 0,
    );

    const tmdbSeasons = realSeasons.map((s: any) => ({
      number: s.season_number as number,
      title: (s.name as string) || `Season ${s.season_number}`,
      episodeCount: (s.episode_count as number) || 0,
    }));

    // Fetch all season episode lists in parallel (cap at 15 seasons)
    const seasonEpisodes = await Promise.all(
      realSeasons.slice(0, 15).map(async (s: any) => {
        try {
          const epData = await fetchTMDBJson<any>(`tv/${hit.id}/season/${s.season_number}`, tmdbCredential);
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
      title: (d.name as string) || hit.name || title,
      poster: tmdbPoster(d.poster_path),
      backdrop: tmdbBackdrop(d.backdrop_path) || tmdbPoster(d.poster_path),
      summary: (d.overview as string) || '',
      rating: (d.vote_average as number) ?? 0,
      genres: ((d.genres ?? []) as any[]).map((g: any) => g.name as string),
      year: d.first_air_date ? new Date(d.first_air_date as string).getFullYear() : (year ?? 0),
      cast,
      episodes,
      tmdbSeasons,
    };
  } catch (err) {
    console.error('[TMDB TV]', err);
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
      backdrop: poster,
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
        } else if (VIDEO_EXTS.includes(path.extname(entry.name).toLowerCase())) {
          const probe = probeMediaFile(fullPath);
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
    const videoFiles = entries.filter(
      (e) => !e.isDirectory() && VIDEO_EXTS.includes(path.extname(e.name).toLowerCase()),
    );

    if (dirs.some((d) => /season/i.test(d.name))) {
      for (const dir of dirs) {
        const m = dir.name.match(/season\s*(\d+)/i);
        const num = m ? parseInt(m[1]) : 1;
        const dirPath = path.join(folderPath, dir.name);
        const count = scanEpisodeFiles(dirPath).length || fs.readdirSync(dirPath).filter((f) =>
          VIDEO_EXTS.includes(path.extname(f).toLowerCase()),
        ).length;
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
  const representativeProbe = episodeFiles[0] ? probeMediaFile(episodeFiles[0].filePath) : {};

  const searchTitle = representativeProbe.embeddedShowTitle || cleanTitle;
  const searchYear = representativeProbe.year || year;
  const likelyAnime = itemType === 'anime' || isLikelyAnimePath(fullPath, searchTitle);

  // ── Fetch metadata sources ─────────────────────────────────────────────────
  // Anime   → Jikan (MAL) primary, TMDB + OMDb as fallbacks
  // TV show → TMDB primary, TVmaze as free fallback, OMDb for extra fields
  const [omdbData, jikanMeta, tmdbTVMeta, tvMeta] = await Promise.all([
    fetchOMDbMetadata(searchTitle, searchYear, omdbApiKey),
    likelyAnime ? fetchJikanMetadata(searchTitle) : Promise.resolve(null),
    fetchTMDBTVMetadata(searchTitle, searchYear, tmdbApiKey),
    // TVmaze: free fallback for western TV episode titles when no TMDB key
    !likelyAnime ? fetchTVMetadata(searchTitle, searchYear) : Promise.resolve(null),
  ]);

  // ── Resolve type ───────────────────────────────────────────────────────────
  const finalType: 'tv' | 'anime' =
    likelyAnime || isAnimeMetadata(fullPath, searchTitle, omdbData, tvMeta)
      ? 'anime'
      : 'tv';

  // ── Poster / backdrop ──────────────────────────────────────────────────────
  // Anime  : Jikan > TMDB > OMDb
  // TV     : TMDB (wide backdrop + poster) > TVmaze > OMDb
  const omdbPoster = omdbData?.Poster && omdbData.Poster !== 'N/A' ? omdbData.Poster : '';
  const poster =
    (finalType === 'anime' ? (jikanMeta?.poster || '') : '')
    || tmdbTVMeta?.poster
    || tvMeta?.poster
    || omdbPoster;

  const backdrop =
    tmdbTVMeta?.backdrop          // TMDB always has a wide backdrop
    || tmdbTVMeta?.poster
    || (finalType === 'anime' ? (jikanMeta?.backdrop || '') : '')
    || tvMeta?.backdrop
    || poster;

  // ── Summary / rating / genres / cast ──────────────────────────────────────
  const summary =
    (finalType === 'anime' ? (jikanMeta?.summary || '') : '')
    || tmdbTVMeta?.summary
    || tvMeta?.summary
    || omdbData?.Plot
    || representativeProbe.summary
    || '';

  const rating =
    (finalType === 'anime' ? (jikanMeta?.rating ?? 0) : 0)
    || (tmdbTVMeta?.rating ?? 0)
    || (tvMeta?.rating ?? 0)
    || (omdbData?.imdbRating ? parseFloat(omdbData.imdbRating) : 0);

  const genres: string[] =
    (finalType === 'anime' ? jikanMeta?.genres : null)
    ?? tmdbTVMeta?.genres
    ?? tvMeta?.genres
    ?? (omdbData?.Genre ? omdbData.Genre.split(', ') : []);

  const cast =
    (finalType === 'anime' ? jikanMeta?.cast : null)
    ?? tmdbTVMeta?.cast
    ?? tvMeta?.cast
    ?? [];

  const resolvedTitle =
    (finalType === 'anime' ? (jikanMeta?.title || '') : '')
    || tmdbTVMeta?.title
    || omdbData?.Title
    || tvMeta?.title
    || searchTitle;

  const resolvedYear =
    (omdbData?.Year ? parseInt(omdbData.Year, 10) : 0)
    || (finalType === 'anime' ? (jikanMeta?.year ?? 0) : 0)
    || (tmdbTVMeta?.year ?? 0)
    || (tvMeta?.year ?? 0)
    || representativeProbe.year
    || year;

  // ── Merge episode metadata onto local files ────────────────────────────────
  // Priority of episode data: Jikan (anime) > TMDB TV > TVmaze
  // Remote episode maps are keyed by "season-number" (Jikan uses season=1 for all)
  const remoteEpisodes: EpisodeMeta[] =
    (finalType === 'anime' ? jikanMeta?.episodes : null)
    ?? tmdbTVMeta?.episodes
    ?? tvMeta?.episodes
    ?? [];

  let mergedEpisodes = localEpisodes;
  if (remoteEpisodes.length > 0) {
    // Jikan numbers by episode only (season always 1), so match by episode number alone for anime
    const useEpKeyOnly = finalType === 'anime' && jikanMeta?.episodes && jikanMeta.episodes.length > 0;
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
        title: remote.title || local.title,
        summary: remote.summary || local.summary,
        still: remote.still || local.still,
        rating: remote.rating || local.rating,
        airDate: remote.airDate || local.airDate,
      };
    });
  }

  const remoteSeasons = tmdbTVMeta?.tmdbSeasons ?? tvMeta?.seasons;
  const mergedSeasons = mergeLocalSeasonsWithMetadata(localSeasons, remoteSeasons);

  return {
    id,
    type: finalType,
    title: resolvedTitle,
    year: resolvedYear,
    poster,
    backdrop,
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
): Promise<MediaItem> {
  const parsedFile = cleanMediaTitle(fileName);
  const stats = fs.statSync(fullPath);
  const probe = probeMediaFile(fullPath);

  const searchTitle = probe.embeddedTitle || titleFallback || parsedFile.title;
  const searchYear = probe.year || year || parsedFile.year;

  // Fetch from TMDB and OMDb in parallel — TMDB gives better posters + backdrops
  const [tmdbData, omdbData] = await Promise.all([
    fetchTMDBMovieMetadata(searchTitle, searchYear, tmdbApiKey),
    fetchOMDbMetadata(searchTitle, searchYear, omdbApiKey),
  ]);

  // Resolve the canonical title (prefer API-confirmed names)
  const resolvedTitle = tmdbData?.title || omdbData?.Title || searchTitle;

  const finalType: 'movie' | 'tv' | 'anime' =
    isAnimeMetadata(fullPath, resolvedTitle, omdbData, null)
      ? 'anime'
      : isSeriesMetadata(omdbData, null)
        ? 'tv'
        : 'movie';

  // Poster / backdrop: TMDB has the best quality (separate poster + wide backdrop)
  const localThumbnail = getLocalThumbnailUrl(fullPath);
  const poster =
    tmdbData?.poster
    || (omdbData?.Poster && omdbData.Poster !== 'N/A' ? omdbData.Poster : '')
    || localThumbnail;
  const backdrop =
    tmdbData?.backdrop
    || tmdbData?.poster
    || poster;

  const summary = tmdbData?.summary || omdbData?.Plot || probe.summary || '';
  const rating =
    (tmdbData?.rating ?? 0)
    || (omdbData?.imdbRating ? parseFloat(omdbData.imdbRating) : 0);
  const genres: string[] =
    tmdbData?.genres
    ?? (omdbData?.Genre ? omdbData.Genre.split(', ') : []);
  const cast = tmdbData?.cast ?? [];
  const resolvedYear =
    tmdbData?.year
    || (omdbData?.Year ? parseInt(omdbData.Year, 10) : 0)
    || searchYear;

  const baseItem: MediaItem = {
    id: Buffer.from(fullPath).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20),
    type: finalType,
    title: resolvedTitle,
    year: resolvedYear,
    poster,
    backdrop,
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
    return {
      ...baseItem,
      seasons: [{ number: 1, title: finalType === 'anime' ? 'Movie' : 'Season 1', episodeCount: 1 }],
      episodes: [{
        season: 1, number: 1,
        title: resolvedTitle,
        summary,
        still: tmdbData?.backdrop || poster,
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
    .filter((name) => VIDEO_EXTS.includes(path.extname(name).toLowerCase()));
  const subtitleFiles = dirEntries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => SUBTITLE_EXTS.includes(path.extname(name).toLowerCase()));
  const subDirs = dirEntries.filter((entry) => entry.isDirectory());
  const hasSeasonDirs = subDirs.some((entry) => /season|series/i.test(entry.name));

  if (videoFiles.length === 0 && !hasSeasonDirs) return null;

  const parsedFolder = cleanMediaTitle(folderName);
  const subtitles = createSubtitleRecords(folderPath, subtitleFiles);
  const id = Buffer.from(folderPath).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  const representativeProbe = videoFiles[0] ? probeMediaFile(path.join(folderPath, videoFiles[0])) : undefined;
  const isTV = shouldTreatAsTV(folderName, videoFiles, hasSeasonDirs, representativeProbe);

  if (isTV) {
    return buildTVItemFromFolder(
      folderPath, folderName, id, subtitles,
      parsedFolder.year, parsedFolder.title,
      ctx.omdbApiKey,
      isLikelyAnimePath(folderPath, parsedFolder.title) ? 'anime' : 'tv',
      ctx.tmdbApiKey,
    );
  }

  return buildMovieItemFromFile(
    path.join(folderPath, videoFiles[0]),
    videoFiles[0], parsedFolder.title,
    subtitles, parsedFolder.year,
    ctx.omdbApiKey, ctx.tmdbApiKey,
  );
}

async function scanFolder(folderPath: string, ctx: ScanContext): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  if (!fs.existsSync(folderPath)) return items;

  try {
    const rootEntries = fs.readdirSync(folderPath, { withFileTypes: true });

    const rootVideoFiles = rootEntries
      .filter((entry) => !entry.isDirectory() && VIDEO_EXTS.includes(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name);
    const rootSubtitleFiles = rootEntries
      .filter((entry) => !entry.isDirectory() && SUBTITLE_EXTS.includes(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name);

    for (const videoFile of rootVideoFiles) {
      const fullVideoPath = path.join(folderPath, videoFile);
      const probe = probeMediaFile(fullVideoPath);
      const isTVFile = shouldTreatAsTV(videoFile, [videoFile], false, probe);
      if (isTVFile) continue; // belongs to a show folder, not a standalone movie

      const baseName = path.basename(videoFile, path.extname(videoFile));
      const matchingSubtitles = rootSubtitleFiles.filter((subtitle) =>
        path.basename(subtitle, path.extname(subtitle)).startsWith(baseName),
      );
      items.push(await buildMovieItemFromFile(
        fullVideoPath, videoFile,
        cleanMediaTitle(videoFile).title,
        createSubtitleRecords(folderPath, matchingSubtitles),
        cleanMediaTitle(videoFile).year,
        ctx.omdbApiKey, ctx.tmdbApiKey,
      ));
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
        .filter((n) => VIDEO_EXTS.includes(path.extname(n).toLowerCase()));

      const subtitleFiles = dirEntries
        .filter((d) => !d.isDirectory())
        .map((d) => d.name)
        .filter((n) => SUBTITLE_EXTS.includes(path.extname(n).toLowerCase()));

      const subDirs = dirEntries.filter((d) => d.isDirectory());
      const hasSeasonDirs = subDirs.some((d) => /season|series/i.test(d.name));

      // Container folder (e.g. "TV Shows/", "Anime/") — recurse
      if (videoFiles.length === 0 && subDirs.length > 0 && !hasSeasonDirs) {
        items.push(...await scanFolder(fullPath, ctx));
        continue;
      }

      const isTV = hasSeasonDirs || isTVPattern(entry.name, videoFiles);
      const parsedFolder = cleanMediaTitle(entry.name);
      const subtitles = createSubtitleRecords(fullPath, subtitleFiles);
      const id = Buffer.from(fullPath).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);

      if (isTV) {
        const tvItem = await buildTVItemFromFolder(
          fullPath, entry.name, id, subtitles,
          parsedFolder.year, parsedFolder.title,
          ctx.omdbApiKey,
          isLikelyAnimePath(fullPath, parsedFolder.title) ? 'anime' : 'tv',
          ctx.tmdbApiKey,
        );
        if (tvItem) items.push(tvItem);
      } else if (videoFiles.length > 0) {
        items.push(await buildMovieItemFromFile(
          path.join(fullPath, videoFiles[0]),
          videoFiles[0], parsedFolder.title,
          subtitles, parsedFolder.year,
          ctx.omdbApiKey, ctx.tmdbApiKey,
        ));
      }
    }
  } catch (error) {
    console.error('scanFolder error:', error);
  }

  return items;
}

async function scanLibrary(folders: string[]): Promise<LibraryData> {
  const settings = loadSettings();
  const ctx: ScanContext = {
    omdbApiKey: getMetadataApiKey(settings, 'omdb'),
    tmdbApiKey: getMetadataApiKey(settings, 'tmdb'),
  };
  const movies: MediaItem[] = [];
  const tvShows: MediaItem[] = [];
  const animeShows: MediaItem[] = [];

  for (const folder of folders) {
    const directItem = await scanDirectoryAsItem(folder, ctx);
    const items = directItem ? [directItem] : await scanFolder(folder, ctx);
    for (const item of items) {
      if (item.type === 'movie') movies.push(item);
      else if (item.type === 'anime') animeShows.push(item);
      else tvShows.push(item);
    }
  }

  return { movies, tvShows, animeShows, libraryFolders: folders };
}

// ─── Library persistence ──────────────────────────────────────────────────────

function loadLibrary(): LibraryData {
  try {
    if (fs.existsSync(LIBRARY_FILE)) {
      const data = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf-8'));
      const normalized: LibraryData = { animeShows: [], ...data };
      const stillMovies: MediaItem[] = [];
      for (const movie of normalized.movies || []) {
        if (movie.type === 'anime' || isLikelyAnimePath(movie.filePath, movie.title)) {
          normalized.animeShows.push({ ...movie, type: 'anime' });
        } else if (movie.type === 'tv') {
          normalized.tvShows.push(movie);
        } else {
          stillMovies.push(movie);
        }
      }
      const stillSeries: MediaItem[] = [];
      for (const show of normalized.tvShows || []) {
        if (show.type === 'anime' || isLikelyAnimePath(show.filePath, show.title)) {
          normalized.animeShows.push({ ...show, type: 'anime' });
        } else {
          stillSeries.push(show);
        }
      }
      normalized.movies = stillMovies;
      normalized.tvShows = stillSeries;
      return normalized;
    }
  } catch (e) {
    console.error('loadLibrary error:', e);
  }
  return { movies: [], tvShows: [], animeShows: [], libraryFolders: [] };
}

function saveLibrary(data: LibraryData): void {
  try {
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('saveLibrary error:', e);
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────

function getWindowIconPath(): string | null {
  const candidates = [
    path.join(process.resourcesPath, 'icon.png'),
    path.join(process.resourcesPath, 'icon', 'icon.png'),
    path.join(app.getAppPath(), 'resources', 'icon.png'),
    path.join(__dirname, '../resources/icon.png'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
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

ipcMain.handle('library:scan', async () => {
  const data = loadLibrary();
  const scanned = await scanLibrary(data.libraryFolders);
  saveLibrary(scanned);
  return scanned;
});

ipcMain.handle('library:add-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length > 0) {
    const data = loadLibrary();
    const newFolder = result.filePaths[0];
    if (!data.libraryFolders.includes(newFolder)) {
      data.libraryFolders.push(newFolder);
      saveLibrary(data);
    }
    return data;
  }
  return null;
});

ipcMain.handle('library:remove-folder', (_event, folderPath: string) => {
  const data = loadLibrary();
  data.libraryFolders = data.libraryFolders.filter((f) => f !== folderPath);
  saveLibrary(data);
  return data;
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

ipcMain.handle('media:get-stream-url', (_event, filePath: string) => {
  assertLocalMediaPath(filePath);
  // Use the privileged plexserver:// scheme so Electron's renderer never hits
  // the URL safety check that blocks http:// media sources.
  const url = `plexserver://localhost/stream?path=${encodeURIComponent(filePath)}`;
  return { url, contentType: getMimeType(filePath), fileName: path.basename(filePath) };
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
  saveSettings(settings);
  return true;
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
  await mpvController.stop();
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

app.on('ready', async () => {
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
