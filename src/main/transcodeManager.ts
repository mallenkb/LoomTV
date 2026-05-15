import { app } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { findFFmpeg } from './mediaBinaries';
import { assertLocalMediaPath } from './mediaProbe';
import type { SubtitleStyleOptions, TranscodeOptions, TranscodeSession } from './mediaTypes';

interface ActiveSession extends TranscodeSession {
  process: ChildProcess;
  exitedAt?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
}

const sessions = new Map<string, ActiveSession>();
const TRANSCODE_READY_TIMEOUT_MS = 30000;
const TRANSCODE_READY_POLL_MS = 150;
const TRANSCODE_READY_SEGMENTS = 3;
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

function selectedPreset(ffmpegPath: string, options: TranscodeOptions): TranscodeOptions['preset'] {
  const preset = options.preset || 'auto';
  if (preset !== 'auto') return preset;
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

function streamMap(type: 'v' | 'a', selectedIndex?: number, optional = false): string {
  const suffix = optional ? '?' : '';
  return typeof selectedIndex === 'number' && selectedIndex >= 0
    ? `0:${selectedIndex}${suffix}`
    : `0:${type}:0${suffix}`;
}

function filterStream(selectedIndex?: number, fallback = '0:v:0'): string {
  return typeof selectedIndex === 'number' && selectedIndex >= 0 ? `0:${selectedIndex}` : fallback;
}

function escapeSubtitleFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function isBitmapSubtitle(codec?: string): boolean {
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
  return subtitleSelections(options).some((selection) => isBitmapSubtitle(selection.codec));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
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

function subtitleForceStyle(style?: SubtitleStyleOptions): string {
  const fontSize = clampNumber(style?.fontSize, 55, 24, 96) * clampNumber(style?.scale, 1, 0.5, 2);
  const position = clampNumber(style?.position, 92, 0, 100);
  const marginV = Math.round((100 - position) * 6);
  const borderWidth = clampNumber(style?.borderWidth, 3, 0, 10);

  return [
    `Fontsize=${Math.round(fontSize)}`,
    `PrimaryColour=${assColor(style?.fontColor, '#ffffff')}`,
    `OutlineColour=${assColor(style?.borderColor, '#000000')}`,
    `BackColour=${assColor(style?.backgroundColor, '#000000')}`,
    `Outline=${borderWidth}`,
    'Shadow=0',
    'Alignment=2',
    `MarginV=${marginV}`,
  ].join(',');
}

function textSubtitleFilter(
  filePath: string,
  subtitleOrdinal: number,
  style?: SubtitleStyleOptions,
  startSeconds = 0,
): string {
  const subtitleFilter = `subtitles='${escapeSubtitleFilterPath(filePath)}':si=${subtitleOrdinal}:force_style='${subtitleForceStyle(style)}'`;
  const seekOffset = Number.isFinite(startSeconds) && startSeconds > 0 ? Math.floor(startSeconds) : 0;
  if (seekOffset <= 0) return `${subtitleFilter},format=yuv420p`;

  return `setpts=PTS+${seekOffset}/TB,${subtitleFilter},setpts=PTS-${seekOffset}/TB,format=yuv420p`;
}

function hlsArgs(filePath: string, outputPath: string, options: TranscodeOptions, ffmpegPath: string): string[] {
  const args: string[] = [];
  const preset = selectedPreset(ffmpegPath, options);
  const hasAudio = options.audioTrackIndex !== -1;
  const hasSubtitle = typeof options.subtitleTrackIndex === 'number' && options.subtitleTrackIndex >= 0;
  const bitmapSubtitle = hasSubtitle && isBitmapSubtitle(options.subtitleCodec);

  if (typeof options.startSeconds === 'number' && options.startSeconds > 0) {
    args.push('-ss', String(Math.floor(options.startSeconds)));
  }

  if (preset === 'nvenc') {
    args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  } else if (preset === 'qsv') {
    args.push('-hwaccel', 'qsv');
  }

  args.push('-i', filePath);

  if (bitmapSubtitle) {
    args.push(
      '-filter_complex',
      `[${filterStream(options.videoTrackIndex)}][0:${options.subtitleTrackIndex}]overlay,format=yuv420p[v]`,
      '-map',
      '[v]',
    );
  } else {
    args.push('-map', streamMap('v', options.videoTrackIndex));
  }

  if (hasAudio) {
    args.push('-map', streamMap('a', options.audioTrackIndex, true));
  }

  args.push('-sn', '-dn');

  if (hasSubtitle && !bitmapSubtitle) {
    const subtitleOrdinal = typeof options.subtitleStreamOrdinal === 'number'
      ? options.subtitleStreamOrdinal
      : 0;
    args.push('-vf', textSubtitleFilter(filePath, subtitleOrdinal, options.subtitleStyle, options.startSeconds));
  } else if (!bitmapSubtitle) {
    args.push('-vf', 'format=yuv420p');
  }

  if (preset === 'nvenc') {
    args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-b:v', '0');
  } else if (preset === 'qsv') {
    args.push('-c:v', 'h264_qsv', '-global_quality', '23', '-look_ahead', '0');
  } else if (preset === 'videotoolbox') {
    args.push(
      '-c:v', 'h264_videotoolbox',
      '-allow_sw', '1',
      '-realtime', '1',
      '-b:v', '6500k',
      '-maxrate', '8500k',
      '-bufsize', '12000k',
      '-profile:v', 'main',
    );
  } else {
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main');
  }

  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push(
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'append_list+independent_segments',
    '-hls_segment_filename', path.join(path.dirname(outputPath), 'segment-%05d.ts'),
    '-force_key_frames', 'expr:gte(t,n_forced*1)',
    outputPath,
  );

  return args;
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
    const args = hlsArgs(filePath, playlistPath, options, ffmpeg);
    console.log(`[transcode] ${path.basename(filePath)} | ffmpeg:${ffmpeg} preset:${selectedPreset(ffmpeg, options)}`);
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
  } catch (error) {
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

export function serveHls(reqUrl: URL, res: http.ServerResponse): boolean {
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
