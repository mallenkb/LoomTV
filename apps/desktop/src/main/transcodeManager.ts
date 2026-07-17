import { app } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendQueryToHlsPlaylist } from './hlsPlaylist';
import { killAllManagedFfmpeg, registerPlaybackProcess, touchPlaybackProcess } from './ffmpegGovernor';
import { findFFmpeg } from './mediaBinaries';
import { pipeResponse } from './httpResponses';
import { assertLocalMediaPath, probeMedia } from './mediaProbe';
import {
  HLS_SEGMENT_SECONDS,
  HLS_WINDOW_SEGMENTS,
  buildHlsArgs,
  buildVodPlaylist,
  shouldRepositionEncoder,
  transcodeSegmentCount,
  transcodeSegmentName,
  transcodeSessionKey,
  type HlsMediaInfo,
  type TranscodePreset,
} from './transcodePlan';
import type { MediaTrack, TranscodeOptions, TranscodeSession } from './mediaTypes';

interface ActiveSession {
  sessionId: string;
  sessionKey: string;
  filePath: string;
  outputDir: string;
  playlistUrl: string;
  options: TranscodeOptions;
  preset: TranscodePreset;
  mediaInfo?: HlsMediaInfo;
  durationSeconds: number;
  segmentSeconds: number;
  segmentCount: number;
  seekable: boolean;
  process: ChildProcess | null;
  readyPromise?: Promise<void>;
  windowStartIndex: number;
  lastRequestedIndex: number;
  lastActivityAt: number;
  lastPrunedAt: number;
  encoderIdleTimer: ReturnType<typeof setTimeout> | null;
  sessionIdleTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  stderr: string;
}

const sessions = new Map<string, ActiveSession>();
const SEGMENT_SECONDS = HLS_SEGMENT_SECONDS;
// One in-app viewer plus one LAN viewer; a third session evicts the least
// recently active one instead of stacking more encoders.
const MAX_ACTIVE_TRANSCODE_SESSIONS = 2;
const ENCODER_IDLE_TIMEOUT_MS = 30000;
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CACHE_PRUNE_INTERVAL_MS = 5000;
const MAX_CACHED_SEGMENTS_PER_SESSION = HLS_WINDOW_SEGMENTS * 3;
// hls.js fetches fragments roughly in order; allow this much slack before a
// non-contiguous request counts as a seek that repositions the encoder.
const SEGMENT_REQUEST_CONTIGUITY = 3;
const TRANSCODE_READY_TIMEOUT_MS = 30000;
const TRANSCODE_READY_POLL_MS = 80;
// A repositioned encoder must produce its first segment; a deep sequential
// request waits for the running encoder to catch up. Both bounded here.
const HLS_PENDING_SEGMENT_TIMEOUT_MS = 30000;
const HLS_PENDING_SEGMENT_POLL_MS = 80;
const encoderSupport = new Map<string, boolean>();

function transcodeRoot(): string {
  return path.join(app.getPath('userData'), 'transcodes');
}

function listProcessRows(): Array<{ pid: number; command: string }> {
  if (process.platform === 'win32') {
    try {
      const script = 'Get-CimInstance Win32_Process -Filter "Name = \'ffmpeg.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
      if (!output) return [];
      const parsed = JSON.parse(output) as Array<{ ProcessId?: number; CommandLine?: string }> | { ProcessId?: number; CommandLine?: string };
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((row) => ({ pid: Number(row.ProcessId), command: String(row.CommandLine || '') }))
        .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.command);
    } catch {
      return [];
    }
  }

  try {
    const output = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => ({ pid: Number(match[1]), command: match[2] || '' }))
      .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.command);
  } catch {
    return [];
  }
}

function commandIncludesPath(command: string, targetPath: string): boolean {
  const normalizedCommand = command.replace(/\\/g, '/');
  const normalizedPath = targetPath.replace(/\\/g, '/');
  return command.includes(targetPath) || normalizedCommand.includes(normalizedPath);
}

function cleanupStaleTranscodeProcesses(): void {
  const root = transcodeRoot();
  let killed = 0;
  for (const row of listProcessRows()) {
    if (row.pid === process.pid) continue;
    if (!/ffmpeg(?:\.exe)?/i.test(row.command)) continue;
    if (!commandIncludesPath(row.command, root)) continue;

    try {
      process.kill(row.pid, 'SIGKILL');
      killed += 1;
    } catch {
      // The process may have exited between listing and kill.
    }
  }
  if (killed > 0) console.log(`[transcode] stopped ${killed} stale ffmpeg process${killed === 1 ? '' : 'es'}`);
}

export function cleanupOldTranscodes(): void {
  const root = transcodeRoot();
  try {
    cleanupStaleTranscodeProcesses();
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

async function hlsMediaInfo(filePath: string, options: TranscodeOptions): Promise<HlsMediaInfo | undefined> {
  try {
    const probe = await probeMedia(filePath);
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

function shouldFallbackTranscode(options: TranscodeOptions): boolean {
  return options.preset !== 'software'
    || typeof options.videoTrackIndex === 'number'
    || typeof options.audioTrackIndex === 'number'
    || typeof options.subtitleTrackIndex === 'number'
    || Boolean(options.subtitleFilePath);
}

function cleanSoftwareOptions(options: TranscodeOptions, includeAudio: boolean): TranscodeOptions {
  return {
    ...options,
    preset: 'software',
    audioTrackIndex: includeAudio ? options.audioTrackIndex : -1,
  };
}

function stderrTail(session: ActiveSession): string {
  return session.stderr.split('\n').filter(Boolean).slice(-4).join(' ');
}

function processAlive(session: ActiveSession): boolean {
  const proc = session.process;
  return Boolean(proc && proc.exitCode === null && !proc.killed);
}

function clearSessionTimers(session: ActiveSession): void {
  if (session.encoderIdleTimer) {
    clearTimeout(session.encoderIdleTimer);
    session.encoderIdleTimer = null;
  }
  if (session.sessionIdleTimer) {
    clearTimeout(session.sessionIdleTimer);
    session.sessionIdleTimer = null;
  }
}

function stopSession(session: ActiveSession, deleteOutput = true): boolean {
  if (session.stopped) return false;
  session.stopped = true;
  clearSessionTimers(session);
  killWindow(session);
  sessions.delete(session.sessionId);
  if (deleteOutput) fs.rmSync(session.outputDir, { recursive: true, force: true });
  return true;
}

function scheduleSessionTimers(session: ActiveSession): void {
  if (session.stopped) return;
  clearSessionTimers(session);

  if (!session.readyPromise) {
    session.encoderIdleTimer = setTimeout(() => {
      const idleFor = Date.now() - session.lastActivityAt;
      if (idleFor >= ENCODER_IDLE_TIMEOUT_MS) killWindow(session);
      scheduleSessionTimers(session);
    }, ENCODER_IDLE_TIMEOUT_MS);
    session.encoderIdleTimer.unref?.();
  }

  session.sessionIdleTimer = setTimeout(() => {
    const idleFor = Date.now() - session.lastActivityAt;
    if (idleFor >= SESSION_IDLE_TIMEOUT_MS) {
      stopSession(session);
      return;
    }
    scheduleSessionTimers(session);
  }, SESSION_IDLE_TIMEOUT_MS);
  session.sessionIdleTimer.unref?.();
}

function touchSession(session: ActiveSession): void {
  session.lastActivityAt = Date.now();
  touchPlaybackProcess(session.process);
  scheduleSessionTimers(session);
}

function killWindow(session: ActiveSession): void {
  const proc = session.process;
  if (proc && proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
  session.process = null;
}

function segmentPath(session: ActiveSession, index: number): string {
  return path.join(session.outputDir, transcodeSegmentName(index));
}

function segmentReady(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function clampIndex(index: number, segmentCount: number): number {
  if (!(index > 0)) return 0;
  return Math.min(Math.floor(index), Math.max(0, segmentCount - 1));
}

/** Spawn (or respawn) the encoder window starting at a global segment index. */
function spawnWindow(
  ffmpeg: string,
  session: ActiveSession,
  index: number,
  preset = session.preset,
  options = session.options,
  seekable = session.seekable,
): void {
  const startSeconds = seekable ? index * session.segmentSeconds : (options.startSeconds || 0);
  const windowOptions: TranscodeOptions = { ...options, startSeconds };
  const outputPath = path.join(session.outputDir, seekable ? 'encoder.m3u8' : 'index.m3u8');
  const args = buildHlsArgs({
    filePath: session.filePath,
    outputPath,
    options: windowOptions,
    preset,
    mediaInfo: session.mediaInfo,
    seekable,
    startNumber: index,
    segmentSeconds: session.segmentSeconds,
  });

  console.log(`[transcode] ${path.basename(session.filePath)} window@${index} | preset:${preset} seekable:${seekable}`);
  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  registerPlaybackProcess(proc, `hls:${session.sessionId}`, `HLS encoder for ${path.basename(session.filePath)}`);
  session.process = proc;
  session.windowStartIndex = index;
  proc.once('exit', () => {
    if (session.process === proc) session.process = null;
  });
  proc.once('error', (error) => {
    session.stderr = `${session.stderr}\n${error.message}`.slice(-2400);
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    session.stderr = `${session.stderr}\n${text}`.slice(-2400);
    if (process.env.DEBUG_TRANSCODE) console.debug('[transcode]', text);
  });
}

function waitForReady(session: ActiveSession, isReady: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (isReady()) {
        resolve();
        return;
      }
      if (!processAlive(session)) {
        const detail = stderrTail(session);
        reject(new Error(detail ? `Transcode process exited before media was ready: ${detail}` : 'Transcode process exited before media was ready.'));
        return;
      }
      if (Date.now() - startedAt > TRANSCODE_READY_TIMEOUT_MS) {
        reject(new Error('Timed out waiting for the transcode to start.'));
        return;
      }
      setTimeout(check, TRANSCODE_READY_POLL_MS);
    };
    check();
  });
}

function linearPlaylistReady(session: ActiveSession): boolean {
  const playlistPath = path.join(session.outputDir, 'index.m3u8');
  try {
    if (!fs.existsSync(playlistPath) || fs.statSync(playlistPath).size === 0) return false;
    const content = fs.readFileSync(playlistPath, 'utf8');
    if (!content.includes('#EXTINF')) return false;
    const segment = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    if (!segment) return false;
    const resolved = path.resolve(session.outputDir, segment);
    if (!resolved.startsWith(`${path.resolve(session.outputDir)}${path.sep}`)) return false;
    return segmentReady(resolved);
  } catch {
    return false;
  }
}

/**
 * Launch the first window, applying the hardware → software → software-no-audio
 * fallback once. The working preset/options are persisted on the session so
 * later repositions reuse a configuration already known to play.
 */
async function startInitialWindow(ffmpeg: string, session: ActiveSession, startIndex: number): Promise<void> {
  const attempts: Array<{ preset: TranscodePreset; options: TranscodeOptions }> = [
    { preset: session.preset, options: session.options },
  ];
  if (shouldFallbackTranscode(session.options)) {
    attempts.push({ preset: 'software', options: cleanSoftwareOptions(session.options, true) });
    attempts.push({ preset: 'software', options: cleanSoftwareOptions(session.options, false) });
  }

  let lastError: unknown;
  for (const attempt of attempts) {
    spawnWindow(ffmpeg, session, startIndex, attempt.preset, attempt.options);
    try {
      await waitForReady(
        session,
        session.seekable
          ? () => segmentReady(segmentPath(session, startIndex))
          : () => linearPlaylistReady(session),
      );
      session.preset = attempt.preset;
      session.options = { ...attempt.options };
      session.mediaInfo = await hlsMediaInfo(session.filePath, attempt.options);
      session.lastRequestedIndex = startIndex;
      return;
    } catch (error) {
      lastError = error;
      killWindow(session);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : 'Unable to start transcoding.');
}

/** Ensure an encoder is producing (or about to produce) the requested segment. */
function ensureWindowForSegment(ffmpeg: string, session: ActiveSession, index: number): void {
  const onDisk = segmentReady(segmentPath(session, index));
  if (shouldRepositionEncoder({
    requestedIndex: index,
    windowStartIndex: session.windowStartIndex,
    lastRequestedIndex: session.lastRequestedIndex,
    segmentOnDisk: onDisk,
    processAlive: processAlive(session),
    contiguityTolerance: SEGMENT_REQUEST_CONTIGUITY,
  })) {
    killWindow(session);
    spawnWindow(ffmpeg, session, index);
    session.lastRequestedIndex = index;
    return;
  }
  if (!onDisk) session.lastRequestedIndex = Math.max(session.lastRequestedIndex, index);
}

function playlistUrlFor(serverBase: string, sessionId: string): string {
  return `${serverBase}/hls/${sessionId}/index.m3u8`;
}

function transcodeSessionResult(session: ActiveSession, serverBase: string): TranscodeSession {
  session.playlistUrl = playlistUrlFor(serverBase, session.sessionId);
  return {
    sessionId: session.sessionId,
    filePath: session.filePath,
    outputDir: session.outputDir,
    playlistUrl: session.playlistUrl,
    seekable: session.seekable,
    startSeconds: session.seekable ? 0 : session.windowStartIndex * session.segmentSeconds,
  };
}

function reusableSession(sessionKey: string): ActiveSession | null {
  for (const session of sessions.values()) {
    if (!session.stopped && session.sessionKey === sessionKey) return session;
  }
  return null;
}

function enforceSessionLimit(nextSessionKey: string): void {
  const candidates = [...sessions.values()]
    .filter((session) => !session.stopped && session.sessionKey !== nextSessionKey)
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

  while (sessions.size >= MAX_ACTIVE_TRANSCODE_SESSIONS && candidates.length > 0) {
    const session = candidates.shift();
    if (session) stopSession(session);
  }
}

function pruneCachedSegments(session: ActiveSession, centerIndex: number): void {
  if (!session.seekable) return;
  const now = Date.now();
  if (now - session.lastPrunedAt < CACHE_PRUNE_INTERVAL_MS) return;
  session.lastPrunedAt = now;

  const radius = Math.floor(MAX_CACHED_SEGMENTS_PER_SESSION / 2);
  const minIndex = Math.max(0, centerIndex - radius);
  const maxIndex = centerIndex + radius;
  try {
    for (const entry of fs.readdirSync(session.outputDir)) {
      const match = entry.match(/^segment-(\d+)\.ts$/);
      if (!match) continue;
      const index = Number.parseInt(match[1], 10);
      if (Number.isFinite(index) && (index < minIndex || index > maxIndex)) {
        fs.rmSync(path.join(session.outputDir, entry), { force: true });
      }
    }
  } catch {
    // Cache pruning is best effort; playback can continue without it.
  }
}

async function ensureSessionReadyAt(ffmpeg: string, session: ActiveSession, startIndex: number): Promise<void> {
  if (session.readyPromise) await session.readyPromise;
  if (session.stopped) throw new Error('Transcode session was replaced.');

  touchSession(session);
  if (!session.seekable) {
    if (!linearPlaylistReady(session)) {
      if (!processAlive(session)) spawnWindow(ffmpeg, session, 0);
      await waitForReady(session, () => linearPlaylistReady(session));
    }
    return;
  }

  const index = clampIndex(startIndex, session.segmentCount);
  if (!segmentReady(segmentPath(session, index))) {
    ensureWindowForSegment(ffmpeg, session, index);
    await waitForReady(session, () => segmentReady(segmentPath(session, index)));
  }
  session.lastRequestedIndex = index;
  pruneCachedSegments(session, index);
  touchSession(session);
}

export async function startTranscode(filePath: string, options: TranscodeOptions, serverBase: string): Promise<TranscodeSession> {
  assertLocalMediaPath(filePath);
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) throw new Error('FFmpeg is not available.');
  const sessionKey = transcodeSessionKey(filePath, options);

  const existingSession = reusableSession(sessionKey);
  if (existingSession) {
    const startIndex = existingSession.seekable
      ? clampIndex(Math.floor((options.startSeconds || 0) / existingSession.segmentSeconds), existingSession.segmentCount)
      : 0;
    await ensureSessionReadyAt(ffmpeg, existingSession, startIndex);
    return transcodeSessionResult(existingSession, serverBase);
  }

  let durationSeconds = 0;
  try {
    durationSeconds = (await probeMedia(filePath)).durationSeconds || 0;
  } catch {
    // Treat an unprobeable duration as a non-seekable stream.
  }

  const segmentSeconds = SEGMENT_SECONDS;
  const seekable = durationSeconds > 0;
  const segmentCount = transcodeSegmentCount(durationSeconds, segmentSeconds);
  const sessionId = randomUUID();
  const outputDir = path.join(transcodeRoot(), sessionId);
  enforceSessionLimit(sessionKey);
  fs.mkdirSync(outputDir, { recursive: true });

  const startIndex = seekable
    ? clampIndex(Math.floor((options.startSeconds || 0) / segmentSeconds), segmentCount)
    : 0;

  const session: ActiveSession = {
    sessionId,
    sessionKey,
    filePath,
    outputDir,
    playlistUrl: playlistUrlFor(serverBase, sessionId),
    options,
    preset: selectedPreset(ffmpeg, options),
    mediaInfo: await hlsMediaInfo(filePath, options),
    durationSeconds,
    segmentSeconds,
    segmentCount,
    seekable,
    process: null,
    windowStartIndex: startIndex,
    lastRequestedIndex: startIndex,
    lastActivityAt: Date.now(),
    lastPrunedAt: 0,
    encoderIdleTimer: null,
    sessionIdleTimer: null,
    stopped: false,
    stderr: '',
  };
  sessions.set(sessionId, session);

  if (seekable) {
    // Serve the whole timeline up front so the player seeks natively; segments
    // are materialized on demand by ensureWindowForSegment.
    fs.writeFileSync(path.join(outputDir, 'index.m3u8'), buildVodPlaylist({ durationSeconds, segmentSeconds }));
  }

  const readyPromise = startInitialWindow(ffmpeg, session, startIndex);
  session.readyPromise = readyPromise;
  try {
    await readyPromise;
    if (session.readyPromise === readyPromise) session.readyPromise = undefined;
    if (session.stopped) throw new Error('Transcode session was replaced.');
    touchSession(session);
  } catch (error) {
    stopSession(session);
    throw error;
  } finally {
    if (session.readyPromise === readyPromise) session.readyPromise = undefined;
  }

  return transcodeSessionResult(session, serverBase);
}

export function stopTranscode(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return stopSession(session);
}

export function stopAllTranscodes(): void {
  for (const sessionId of [...sessions.keys()]) {
    stopTranscode(sessionId);
  }
  // Also stop non-session ffmpeg work (progressive streams, queued tools).
  killAllManagedFfmpeg();
}

function hlsContentType(filePath: string): string {
  if (filePath.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (filePath.endsWith('.mp4')) return 'video/mp4';
  if (filePath.endsWith('.m4s')) return 'video/iso.segment';
  if (filePath.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}

function sendHlsFile(filePath: string, res: http.ServerResponse, playlistQueryString: string): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': hlsContentType(filePath), 'Cache-Control': 'no-store' });
  if (filePath.endsWith('.m3u8') && playlistQueryString) {
    res.end(appendQueryToHlsPlaylist(fs.readFileSync(filePath, 'utf8'), playlistQueryString));
    return;
  }
  pipeResponse(fs.createReadStream(filePath), res);
}

function notFound(res: http.ServerResponse): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(404);
  res.end('HLS file not found');
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
  touchSession(session);

  const outputRoot = path.resolve(session.outputDir);
  const filePath = path.resolve(outputRoot, relativeFile);
  if (!filePath.startsWith(`${outputRoot}${path.sep}`) && filePath !== outputRoot) {
    notFound(res);
    return true;
  }

  if (fs.existsSync(filePath)) {
    sendHlsFile(filePath, res, playlistQueryString);
    return true;
  }

  const segmentMatch = relativeFile.match(/^segment-(\d+)\.ts$/);
  if (session.seekable && segmentMatch) {
    const index = Number.parseInt(segmentMatch[1], 10);
    if (!Number.isFinite(index) || index < 0 || index >= session.segmentCount) {
      notFound(res);
      return true;
    }
    pruneCachedSegments(session, index);
    const ffmpeg = findFFmpeg();
    if (!ffmpeg) {
      notFound(res);
      return true;
    }
    ensureWindowForSegment(ffmpeg, session, index);

    const startedAt = Date.now();
    const waitForSegment = () => {
      if (res.destroyed || res.writableEnded) return;
      if (segmentReady(filePath)) {
        sendHlsFile(filePath, res, playlistQueryString);
        return;
      }
      if (Date.now() - startedAt > HLS_PENDING_SEGMENT_TIMEOUT_MS) {
        notFound(res);
        return;
      }
      // Self-heal: if the encoder died, reposition it back onto this segment.
      ensureWindowForSegment(ffmpeg, session, index);
      setTimeout(waitForSegment, HLS_PENDING_SEGMENT_POLL_MS);
    };
    waitForSegment();
    return true;
  }

  // Linear fallback (unknown duration): single window, segments appear in order.
  if (relativeFile.endsWith('.ts') && processAlive(session)) {
    const startedAt = Date.now();
    const waitForSegment = () => {
      if (res.destroyed || res.writableEnded) return;
      if (segmentReady(filePath)) {
        sendHlsFile(filePath, res, playlistQueryString);
        return;
      }
      if (!processAlive(session) || Date.now() - startedAt > HLS_PENDING_SEGMENT_TIMEOUT_MS) {
        notFound(res);
        return;
      }
      setTimeout(waitForSegment, HLS_PENDING_SEGMENT_POLL_MS);
    };
    waitForSegment();
    return true;
  }

  notFound(res);
  return true;
}
