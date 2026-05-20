import { app } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendQueryToHlsPlaylist } from './hlsPlaylist';
import { findFFmpeg } from './mediaBinaries';
import { assertLocalMediaPath, probeMedia } from './mediaProbe';
import {
  TRANSCODE_READY_SEGMENTS,
  buildHlsArgs,
  type HlsMediaInfo,
  type TranscodePreset,
} from './transcodePlan';
import type { MediaTrack, TranscodeOptions, TranscodeSession } from './mediaTypes';

interface ActiveSession extends TranscodeSession {
  process: ChildProcess;
  exitedAt?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
}

const sessions = new Map<string, ActiveSession>();
const TRANSCODE_READY_TIMEOUT_MS = 30000;
const TRANSCODE_READY_POLL_MS = 150;
const HLS_PENDING_SEGMENT_TIMEOUT_MS = 8000;
const HLS_PENDING_SEGMENT_POLL_MS = 80;
const encoderSupport = new Map<string, boolean>();

function transcodeRoot(): string {
  return path.join(app.getPath('userData'), 'transcodes');
}

export function cleanupOldTranscodes(): void {
  const root = transcodeRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, entry), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  } catch (error) {
    console.error('[transcode] cleanup failed:', error);
  }
}

function hasEncoder(ffmpegPath: string, encoder: string): boolean {
  const key = `${ffmpegPath}:${encoder}`;
  const cached = encoderSupport.get(key);
  if (typeof cached === 'boolean') return cached;

  try {
    const output = execFileSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    const supported = output.includes(encoder);
    encoderSupport.set(key, supported);
    return supported;
  } catch {
    encoderSupport.set(key, false);
    return false;
  }
}

function selectedPreset(ffmpegPath: string, options: TranscodeOptions): TranscodePreset {
  const preset = options.preset || 'auto';
  if (preset !== 'auto') return preset as TranscodePreset;
  const candidates: Array<'videotoolbox' | 'nvenc' | 'qsv'> =
    process.platform === 'darwin'
      ? ['videotoolbox', 'nvenc', 'qsv']
      : process.platform === 'win32'
        ? ['nvenc', 'qsv', 'videotoolbox']
        : ['nvenc', 'qsv', 'videotoolbox'];
  const encoderForPreset: Record<'videotoolbox' | 'nvenc' | 'qsv', string> = {
    videotoolbox: 'h264_videotoolbox',
    nvenc: 'h264_nvenc',
    qsv: 'h264_qsv',
  };
  for (const candidate of candidates) {
    if (hasEncoder(ffmpegPath, encoderForPreset[candidate])) return candidate;
  }
  return 'software';
}

function selectedTrack(tracks: MediaTrack[], type: MediaTrack['type'], selectedIndex?: number): MediaTrack | undefined {
  if (typeof selectedIndex === 'number' && selectedIndex >= 0) {
    return tracks.find((track) => track.index === selectedIndex && track.type === type);
  }
  return tracks.find((track) => track.type === type);
}

function hlsMediaInfo(filePath: string, options: TranscodeOptions): HlsMediaInfo | undefined {
  try {
    const probe = probeMedia(filePath);
    const video = selectedTrack(probe.tracks, 'video', options.videoTrackIndex);
    const audio = options.audioTrackIndex === -1
      ? undefined
      : selectedTrack(probe.tracks, 'audio', options.audioTrackIndex);

    return {
      videoCodec: video?.codec,
      videoProfile: video?.profile,
      pixelFormat: video?.pixelFormat,
      audioCodec: audio?.codec,
    };
  } catch {
    return undefined;
  }
}

function firstReadySegmentFromPlaylist(playlistPath: string): boolean {
  try {
    const content = fs.readFileSync(playlistPath, 'utf8');
    if (!content.includes('#EXTINF')) return false;

    const segments = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (segments.length < TRANSCODE_READY_SEGMENTS && !content.includes('#EXT-X-ENDLIST')) return false;

    const playlistDir = path.resolve(path.dirname(playlistPath));
    return segments.slice(0, TRANSCODE_READY_SEGMENTS).every((segment) => {
      const segmentPath = path.resolve(playlistDir, segment);
      if (!segmentPath.startsWith(`${playlistDir}${path.sep}`)) return false;
      return fs.existsSync(segmentPath) && fs.statSync(segmentPath).size > 0;
    });
  } catch {
    return false;
  }
}

function waitForPlaylist(playlistPath: string, ffmpegProc: ChildProcess, stderrTail: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
      if (fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0 && firstReadySegmentFromPlaylist(playlistPath)) {
        resolve();
        return;
      }

      if (ffmpegProc.exitCode !== null) {
        const detail = stderrTail();
        reject(new Error(detail ? `Transcode process exited before the playlist was ready: ${detail}` : 'Transcode process exited before the playlist was ready.'));
        return;
      }

      if (Date.now() - startedAt > TRANSCODE_READY_TIMEOUT_MS) {
        reject(new Error('Timed out waiting for the transcode playlist.'));
        return;
      }

      setTimeout(check, TRANSCODE_READY_POLL_MS);
    };

    check();
  });
}

async function launchTranscode(
  ffmpeg: string,
  filePath: string,
  options: TranscodeOptions,
  serverBase: string,
): Promise<TranscodeSession> {
  const sessionId = randomUUID();
  const outputDir = path.join(transcodeRoot(), sessionId);
  fs.mkdirSync(outputDir, { recursive: true });
  const playlistPath = path.join(outputDir, 'index.m3u8');
  let stderr = '';
  let ffmpegProc: ChildProcess;
  try {
    const preset = selectedPreset(ffmpeg, options);
    const mediaInfo = hlsMediaInfo(filePath, options);
    const args = buildHlsArgs({
      filePath,
      outputPath: playlistPath,
      options,
      preset,
      mediaInfo,
    });
    console.log(`[transcode] ${path.basename(filePath)} | ffmpeg:${ffmpeg} preset:${preset} video:${mediaInfo?.videoCodec || 'unknown'} audio:${mediaInfo?.audioCodec || 'unknown'}`);
    ffmpegProc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw new Error(`Unable to start FFmpeg: ${error instanceof Error ? error.message : String(error)}`);
  }

  ffmpegProc.once('error', (error) => {
    stderr = `${stderr}\n${error.message}`.slice(-2400);
  });
  ffmpegProc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    stderr = `${stderr}\n${text}`.slice(-2400);
    if (process.env.DEBUG_TRANSCODE) console.debug('[transcode]', text);
  });
  const session: ActiveSession = {
    sessionId,
    filePath,
    outputDir,
    playlistUrl: `${serverBase}/hls/${sessionId}/index.m3u8`,
    process: ffmpegProc,
  };
  sessions.set(sessionId, session);
  ffmpegProc.once('exit', (code, signal) => {
    const activeSession = sessions.get(sessionId);
    if (!activeSession) return;
    activeSession.exitedAt = Date.now();
    activeSession.exitCode = code;
    activeSession.exitSignal = signal;
  });
  try {
    await waitForPlaylist(playlistPath, ffmpegProc, () => stderr.split('\n').filter(Boolean).slice(-4).join(' '));
  } catch (error) {
    if (!ffmpegProc.killed) ffmpegProc.kill('SIGKILL');
    sessions.delete(sessionId);
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }

  return {
    sessionId,
    filePath,
    outputDir,
    playlistUrl: session.playlistUrl,
  };
}

function shouldFallbackTranscode(options: TranscodeOptions): boolean {
  return options.preset !== 'software'
    || typeof options.videoTrackIndex === 'number'
    || typeof options.audioTrackIndex === 'number'
    || typeof options.subtitleTrackIndex === 'number';
}

function cleanSoftwareOptions(options: TranscodeOptions, includeAudio: boolean): TranscodeOptions {
  return {
    preset: 'software',
    startSeconds: options.startSeconds,
    audioTrackIndex: includeAudio ? undefined : -1,
  };
}

export async function startTranscode(filePath: string, options: TranscodeOptions, serverBase: string): Promise<TranscodeSession> {
  assertLocalMediaPath(filePath);
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) throw new Error('FFmpeg is not available.');

  let firstError: unknown;
  try {
    return await launchTranscode(ffmpeg, filePath, options, serverBase);
  } catch (error) {
    firstError = error;
    if (!shouldFallbackTranscode(options)) throw error;
  }

  try {
    return await launchTranscode(ffmpeg, filePath, cleanSoftwareOptions(options, true), serverBase);
  } catch {
    try {
      return await launchTranscode(ffmpeg, filePath, cleanSoftwareOptions(options, false), serverBase);
    } catch (finalError) {
      const initialMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const finalMessage = finalError instanceof Error ? finalError.message : String(finalError);
      throw new Error(`Unable to start transcoding. Initial error: ${initialMessage}. Final fallback error: ${finalMessage}`);
    }
  }
}

export function stopTranscode(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.process.exitCode === null && !session.process.killed) session.process.kill('SIGKILL');
  sessions.delete(sessionId);
  fs.rmSync(session.outputDir, { recursive: true, force: true });
  return true;
}

export function stopAllTranscodes(): void {
  for (const sessionId of [...sessions.keys()]) {
    stopTranscode(sessionId);
  }
}

export function serveHls(reqUrl: URL, res: http.ServerResponse, playlistQueryString = ''): boolean {
  const match = reqUrl.pathname.match(/^\/hls\/([^/]+)\/(.+)$/);
  if (!match) return false;

  const [, sessionId, relativeFile] = match;
  const session = sessions.get(sessionId);
  if (!session) {
    res.writeHead(404);
    res.end('HLS session not found');
    return true;
  }

  const outputRoot = path.resolve(session.outputDir);
  const filePath = path.resolve(outputRoot, relativeFile);
  if ((!filePath.startsWith(`${outputRoot}${path.sep}`) && filePath !== outputRoot)) {
    res.writeHead(404);
    res.end('HLS file not found');
    return true;
  }

  const contentType = filePath.endsWith('.m3u8')
    ? 'application/vnd.apple.mpegurl'
    : filePath.endsWith('.mp4')
      ? 'video/mp4'
      : filePath.endsWith('.m4s')
        ? 'video/iso.segment'
        : filePath.endsWith('.ts')
          ? 'video/mp2t'
          : 'application/octet-stream';
  const serveFile = () => {
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    if (filePath.endsWith('.m3u8') && playlistQueryString) {
      res.end(appendQueryToHlsPlaylist(fs.readFileSync(filePath, 'utf8'), playlistQueryString));
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  };

  if (fs.existsSync(filePath)) {
    serveFile();
    return true;
  }

  if (!filePath.endsWith('.ts') || session.process.exitCode !== null) {
    res.writeHead(404);
    res.end('HLS file not found');
    return true;
  }

  const startedAt = Date.now();
  const waitForSegment = () => {
    if (res.destroyed || res.writableEnded) return;
    if (fs.existsSync(filePath)) {
      serveFile();
      return;
    }
    if (session.process.exitCode !== null || Date.now() - startedAt > HLS_PENDING_SEGMENT_TIMEOUT_MS) {
      res.writeHead(404);
      res.end('HLS file not found');
      return;
    }
    setTimeout(waitForSegment, HLS_PENDING_SEGMENT_POLL_MS);
  };
  waitForSegment();
  return true;
}
