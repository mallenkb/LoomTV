import { spawn } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { safeFetch } from '../safeFetch.ts';
import {
  currentAnalysisInterruptionEpoch,
  isPlaybackActivityActive,
  registerAnalysisProcess,
  registerAnalysisRequest,
} from '../ffmpegGovernor.ts';

/**
 * Decides whether an IPTV stream would actually play in LoomTV. The fetches
 * mirror the stream proxy (same transport, same HTTPS-only rule, same redirect
 * budget), so a stream that fails here fails at play time too.
 *
 * A stream is "dead" when it cannot be fetched and "blank" when it answers but
 * shows nothing: no decodable audio or video, a black or frozen picture with no
 * sound, or a live playlist that has stopped advancing.
 */

const FETCH_TIMEOUT_MS = 15_000;
const PLAYLIST_MAX_BYTES = 2 * 1024 * 1024;
const KEY_MAX_BYTES = 1024;
const INIT_MAX_BYTES = 1024 * 1024;
/** Enough of a low-bitrate segment to judge a few seconds of picture. */
const SAMPLE_BYTES = 1536 * 1024;
const SAMPLE_MAX_BYTES = 3 * 1024 * 1024;
/** One retry with more of the segment when the first sample decodes too briefly. */
const LARGE_SAMPLE_BYTES = 6 * 1024 * 1024;
const LARGE_SAMPLE_MAX_BYTES = 9 * 1024 * 1024;
const ANALYSIS_TIMEOUT_MS = 20_000;
const ANALYSIS_SECONDS = 8;
/** Shorter samples cannot tell a black cut or a paused frame from a dead feed. */
const MIN_JUDGED_SECONDS = 2;
const SILENT_DB = -50;

export type StreamLiveMarker = {
  mediaUrl: string;
  lastSegment: string;
  sequence: number;
  targetSeconds: number;
  fetchedAt: number;
};

export type StreamCheckResult =
  | { outcome: 'ok'; analyzed: boolean; live: StreamLiveMarker | null }
  | { outcome: 'dead' | 'blank'; reason: string; definitive: boolean; analyzed: boolean }
  | { outcome: 'inconclusive'; reason: string; interrupted?: boolean };

export type StreamAnalysis = {
  /** Video frames ffmpeg actually decoded, not just a declared video track. */
  hasVideo: boolean;
  /** Audio samples ffmpeg actually decoded. */
  hasAudio: boolean;
  seconds: number;
  blackSeconds: number;
  frozenToEnd: boolean;
  maxVolumeDb: number | null;
};

export type FfmpegRun = {
  stderr: string;
  /** Null when the process did not exit on its own. */
  exitCode: number | null;
  timedOut: boolean;
  /** Stopped because playback started, or never started because playback was active. */
  interrupted: boolean;
  /** ffmpeg could not be started at all. */
  failedToStart: boolean;
};

export type FfmpegRunner = (input: Buffer) => Promise<FfmpegRun>;

export type SampleVerdict =
  | { kind: 'plays' }
  | { kind: 'blank'; reason: string }
  | { kind: 'unconfirmed'; reason: string; tooShort?: boolean };

class StreamFailure extends Error {
  readonly definitive: boolean;

  constructor(message: string, definitive: boolean) {
    super(message);
    this.definitive = definitive;
  }
}

function describeNetworkError(error: unknown): StreamFailure {
  const code = (error as { code?: string; cause?: { code?: string } })?.code
    || (error as { cause?: { code?: string } })?.cause?.code
    || '';
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'AbortError') return new StreamFailure('The stream did not respond.', false);
  if (code === 'ENOTFOUND') return new StreamFailure('The stream host no longer exists.', true);
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY/i.test(code)) return new StreamFailure('The stream has an invalid HTTPS certificate.', true);
  if (/Only HTTPS/i.test(message)) return new StreamFailure('The stream redirects to plain HTTP.', true);
  if (/private or invalid address|Private network/i.test(message)) return new StreamFailure('The stream points at a private address.', true);
  if (/redirected too many times/i.test(message)) return new StreamFailure('The stream redirects in a loop.', true);
  return new StreamFailure(`The stream could not be reached (${code || message}).`, false);
}

async function fetchBytes(url: string, maxBytes: number, signal: AbortSignal, range?: number): Promise<{ url: string; type: string; body: Buffer }> {
  signal.throwIfAborted();
  let response: Response;
  let finalUrl = url;
  try {
    response = await safeFetch(url, {
      signal,
      headers: { Accept: '*/*', ...(range ? { Range: `bytes=0-${range - 1}` } : {}) },
    }, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes,
      maxRedirects: 4,
      retries: 0,
      operation: 'iptv.health',
      onFinalUrl: (resolved) => { finalUrl = resolved; },
    });
  } catch (error) {
    if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
      throw new StreamFailure('oversized', false);
    }
    throw describeNetworkError(error);
  }
  signal.throwIfAborted();
  if (!response.ok) {
    const status = response.status;
    // Some origins reject a Range request they would serve whole. The player
    // never sends one for a first load, so retry the way it asks.
    if (range && (status === 416 || status === 400)) return fetchBytes(url, maxBytes, signal);
    // 404/410 are gone, 401/403/451 refuse this viewer (usually a geoblock).
    // A 5xx or a 429 can clear up, so it has to repeat before the stream hides.
    const definitive = status === 404 || status === 410 || status === 401 || status === 403 || status === 451;
    throw new StreamFailure(`The stream answered HTTP ${status}.`, definitive);
  }
  return {
    url: finalUrl,
    type: response.headers.get('content-type') || '',
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function isPlaylist(body: Buffer): boolean {
  return body.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}

function resolveEntry(reference: string, base: string): string {
  const resolved = new URL(reference, base);
  if (resolved.protocol !== 'https:') throw new StreamFailure('The stream uses plain HTTP inside its playlist.', true);
  return resolved.toString();
}

/** Pick the lowest-bandwidth variant: the cheapest one to sample. */
function pickVariant(text: string, base: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let best: { url: string; bandwidth: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue;
    const next = lines.slice(index + 1).find((line) => line && !line.startsWith('#'));
    if (!next) continue;
    const bandwidth = Number((lines[index].match(/BANDWIDTH=(\d+)/) || [])[1] || Number.MAX_SAFE_INTEGER);
    if (!best || bandwidth < best.bandwidth) best = { url: resolveEntry(next, base), bandwidth };
  }
  return best?.url ?? null;
}

type MediaPlaylist = {
  segments: Array<{ url: string; key: { method: string; uri: string; iv: string } | null }>;
  sequence: number;
  targetSeconds: number;
  endList: boolean;
  initUrl: string | null;
  byteRanges: boolean;
};

function parseMediaPlaylist(text: string, base: string): MediaPlaylist {
  const segments: MediaPlaylist['segments'] = [];
  let key: MediaPlaylist['segments'][number]['key'] = null;
  let initUrl: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = (line.match(/METHOD=([A-Z0-9-]+)/) || [])[1] || 'NONE';
      const uri = (line.match(/URI="([^"]+)"/) || [])[1] || '';
      key = method === 'NONE' ? null : { method, uri: uri ? resolveEntry(uri, base) : '', iv: (line.match(/IV=0x([0-9a-f]+)/i) || [])[1] || '' };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const uri = (line.match(/URI="([^"]+)"/) || [])[1];
      if (uri) initUrl = resolveEntry(uri, base);
    } else if (!line.startsWith('#')) {
      segments.push({ url: resolveEntry(line, base), key });
    }
  }
  return {
    segments,
    sequence: Number((text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] ?? 0),
    targetSeconds: Number((text.match(/#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/) || [])[1] || 6),
    endList: /#EXT-X-ENDLIST/.test(text),
    initUrl,
    byteRanges: /#EXT-X-BYTERANGE/.test(text) || /#EXT-X-MAP:[^\n]*BYTERANGE/.test(text),
  };
}

function decryptAes128(body: Buffer, key: Buffer, ivHex: string, sequence: number): Buffer {
  const iv = Buffer.alloc(16);
  if (ivHex) Buffer.from(ivHex.padStart(32, '0').slice(-32), 'hex').copy(iv);
  else iv.writeBigUInt64BE(BigInt(sequence), 8);
  const whole = body.subarray(0, body.length - (body.length % 16));
  const decipher = createDecipheriv('aes-128-cbc', key.subarray(0, 16), iv).setAutoPadding(false);
  return Buffer.concat([decipher.update(whole), decipher.final()]);
}

/**
 * Parse ffmpeg's stderr from a blackdetect/freezedetect/volumedetect pass.
 * Picture and sound count only when frames or samples were decoded: a track
 * the container declares but ffmpeg cannot decode is not evidence of either.
 */
export function parseStreamAnalysis(stderr: string): StreamAnalysis {
  const frames = Number([...stderr.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1] || 0);
  // volumedetect can report more than once (a probe instance says 0); the
  // largest count is the decoded audio.
  const samples = Math.max(0, ...[...stderr.matchAll(/n_samples:\s*(\d+)/g)].map((match) => Number(match[1])));
  const hasVideo = frames > 0;
  const hasAudio = samples > 0;
  const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = times.at(-1);
  const seconds = last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : 0;
  const blackSeconds = [...stderr.matchAll(/black_duration:\s*(\d+(?:\.\d+)?)/g)]
    .reduce((total, match) => total + Number(match[1]), 0);
  const freezeStarts = (stderr.match(/freeze_start:/g) || []).length;
  const freezeEnds = (stderr.match(/freeze_end:/g) || []).length;
  const volume = stderr.match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/);
  const maxVolumeDb = volume ? (volume[1] === '-inf' ? -Infinity : Number(volume[1])) : null;
  return { hasVideo, hasAudio, seconds, blackSeconds, frozenToEnd: freezeStarts > freezeEnds, maxVolumeDb };
}

/**
 * A stream plays only with decoded picture or sound over a sample long enough
 * to judge. A radio stream behind a still logo, or a news channel cutting to
 * black for a moment, still plays; black or frozen with silence does not.
 */
export function judgeStreamAnalysis(analysis: StreamAnalysis): SampleVerdict {
  const silent = !analysis.hasAudio || (analysis.maxVolumeDb !== null && analysis.maxVolumeDb <= SILENT_DB);
  if (!analysis.hasVideo && !analysis.hasAudio) return { kind: 'blank', reason: 'No picture or sound could be decoded from the stream.' };
  if (analysis.seconds < MIN_JUDGED_SECONDS) {
    return { kind: 'unconfirmed', reason: 'too little of the stream decoded to confirm it plays', tooShort: true };
  }
  if (!analysis.hasVideo) return silent ? { kind: 'blank', reason: 'The stream has no picture and no sound.' } : { kind: 'plays' };
  if (!silent) return { kind: 'plays' };
  if (analysis.blackSeconds >= analysis.seconds * 0.95) return { kind: 'blank', reason: 'The stream shows a black screen with no sound.' };
  if (analysis.frozenToEnd) return { kind: 'blank', reason: 'The stream shows a frozen picture with no sound.' };
  return { kind: 'plays' };
}

/** What a finished ffmpeg run says about the sample it was given. */
export function verdictFromRun(run: FfmpegRun): SampleVerdict | 'retry-later' {
  // Not the stream's fault: try again on a later check, and change nothing now.
  if (run.interrupted || run.timedOut || run.failedToStart) return 'retry-later';
  if (run.exitCode !== 0) return { kind: 'unconfirmed', reason: `the decoder failed with exit code ${run.exitCode}` };
  return judgeStreamAnalysis(parseStreamAnalysis(run.stderr));
}

/**
 * Runs the analysis as an app analysis process: one decoder thread,
 * registered with the FFmpeg governor so starting playback kills it, and
 * never started while something is playing.
 */
export function createFfmpegRunner(ffmpegPath: string): FfmpegRunner {
  return (input) => new Promise((resolve) => {
    const idle: FfmpegRun = { stderr: '', exitCode: null, timedOut: false, interrupted: false, failedToStart: false };
    if (isPlaybackActivityActive()) {
      resolve({ ...idle, interrupted: true });
      return;
    }
    const epoch = currentAnalysisInterruptionEpoch();
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-nostdin', '-loglevel', 'info', '-threads', '1',
      '-t', String(ANALYSIS_SECONDS),
      '-i', 'pipe:0',
      '-vf', 'blackdetect=d=0.5:pix_th=0.10,freezedetect=n=0.003:d=1.5',
      '-af', 'volumedetect',
      '-f', 'null', '-',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    registerAnalysisProcess(child);
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (run: FfmpegRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, ANALYSIS_TIMEOUT_MS);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', () => finish({ ...idle, stderr, failedToStart: true }));
    child.on('close', (exitCode) => finish({
      stderr,
      exitCode,
      timedOut,
      interrupted: currentAnalysisInterruptionEpoch() !== epoch,
      failedToStart: false,
    }));
    // ffmpeg may stop reading once it has what it needs; that is not an error.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

/**
 * A stream passes only when every step succeeds: it loads, a real segment
 * decodes to picture or sound that is not blank, and (via
 * recheckLivePlaylist) a live playlist keeps advancing. Anything the check
 * cannot actually confirm counts against the stream rather than for it.
 */
export async function checkIptvStream(streamUrl: string, runFfmpeg: FfmpegRunner): Promise<StreamCheckResult> {
  const controller = new AbortController();
  const unregister = registerAnalysisRequest(controller);
  try {
    const result = await checkStream(streamUrl, runFfmpeg, controller.signal);
    return controller.signal.aborted
      ? { outcome: 'inconclusive', interrupted: true, reason: 'Playback interrupted the check; it will resume when idle.' }
      : result;
  } finally {
    unregister();
  }
}

async function checkStream(streamUrl: string, runFfmpeg: FfmpegRunner, signal: AbortSignal): Promise<StreamCheckResult> {
  const unverifiable = (why: string): StreamCheckResult => ({
    outcome: 'blank',
    reason: `LoomTV could not confirm this stream plays (${why}).`,
    definitive: true,
    analyzed: true,
  });
  /**
   * Decode a sample and turn the verdict into a result. A sample that
   * decodes too briefly is retried once with more of the file when more is
   * available; a run cut short by playback, a timeout, or a missing decoder
   * leaves the stream's standing unchanged for a later check.
   */
  const judge = async (
    sample: Buffer,
    live: StreamLiveMarker | null,
    fetchLarger?: () => Promise<Buffer | null>,
  ): Promise<StreamCheckResult> => {
    signal.throwIfAborted();
    let verdict = verdictFromRun(await runFfmpeg(sample));
    signal.throwIfAborted();
    if (verdict !== 'retry-later' && verdict.kind === 'unconfirmed' && verdict.tooShort && fetchLarger) {
      const larger = await fetchLarger();
      signal.throwIfAborted();
      if (larger && larger.length > sample.length) verdict = verdictFromRun(await runFfmpeg(larger));
    }
    if (verdict === 'retry-later') return { outcome: 'inconclusive', reason: 'The check was paused or could not run; it is retried later.' };
    if (verdict.kind === 'blank') return { outcome: 'blank', reason: verdict.reason, definitive: true, analyzed: true };
    if (verdict.kind === 'unconfirmed') return unverifiable(verdict.reason);
    return { outcome: 'ok', analyzed: true, live };
  };
  const bounded = async (url: string, maxBytes: number, range?: number) => {
    try {
      return await fetchBytes(url, maxBytes, signal, range);
    } catch (error) {
      if (error instanceof StreamFailure && error.message === 'oversized') return null;
      throw error;
    }
  };

  try {
    if (!streamUrl.startsWith('https:')) throw new StreamFailure('The stream uses plain HTTP.', true);
    let playlist = await bounded(streamUrl, PLAYLIST_MAX_BYTES);
    if (!playlist) {
      // A direct stream: sample its start. One that ignores the range and
      // never ends cannot be played through the stream proxy either.
      const sample = await bounded(streamUrl, SAMPLE_MAX_BYTES, SAMPLE_BYTES);
      if (!sample) return unverifiable('the stream never ends and cannot be sampled');
      return await judge(sample.body, null, async () => (await bounded(streamUrl, LARGE_SAMPLE_MAX_BYTES, LARGE_SAMPLE_BYTES))?.body ?? null);
    }

    if (!isPlaylist(playlist.body)) {
      const head = playlist.body.subarray(0, 512).toString('utf8').trimStart();
      if (/text\/html/i.test(playlist.type) || /^<(!doctype|html)/i.test(head)) {
        throw new StreamFailure('The stream address returns a web page, not video.', true);
      }
      if (playlist.body.length === 0) throw new StreamFailure('The stream returned nothing.', false);
      return await judge(playlist.body, null);
    }

    const masterText = playlist.body.toString('utf8');
    if (/#EXT-X-STREAM-INF/.test(masterText)) {
      const variant = pickVariant(masterText, playlist.url);
      if (!variant) throw new StreamFailure('The stream playlist lists no variants.', true);
      playlist = await fetchBytes(variant, PLAYLIST_MAX_BYTES, signal);
      if (!isPlaylist(playlist.body)) throw new StreamFailure('The stream variant is not a playlist.', true);
    }
    const mediaUrl = playlist.url;
    const media = parseMediaPlaylist(playlist.body.toString('utf8'), mediaUrl);
    if (media.segments.length === 0) throw new StreamFailure('The stream playlist is empty.', false);
    const fetchedAt = Date.now();

    // The newest segment can still be in flight on some origins; the one
    // before it is complete and still inside every live window.
    const index = Math.max(media.segments.length - 2, 0);
    const segment = media.segments[index];
    if (segment.key && (segment.key.method !== 'AES-128' || !segment.key.uri)) {
      return unverifiable(`its video uses ${segment.key.method} encryption`);
    }
    if (media.byteRanges) return unverifiable('its playlist addresses byte ranges');

    const sample = await bounded(segment.url, SAMPLE_MAX_BYTES, SAMPLE_BYTES);
    if (!sample) return unverifiable('its video segment is too large to sample');
    if (sample.body.length === 0) throw new StreamFailure('The stream segment is empty.', false);

    const key = segment.key ? (await fetchBytes(segment.key.uri, KEY_MAX_BYTES, signal)).body : null;
    if (key && key.length < 16) return unverifiable('its decryption key is invalid');
    const init = media.initUrl ? (await fetchBytes(media.initUrl, INIT_MAX_BYTES, signal)).body : null;
    const prepare = (body: Buffer) => {
      const decrypted = key && segment.key ? decryptAes128(body, key, segment.key.iv, media.sequence + index) : body;
      return init ? Buffer.concat([init, decrypted]) : decrypted;
    };

    const live = media.endList
      ? null
      : { mediaUrl, lastSegment: media.segments.at(-1)?.url || '', sequence: media.sequence, targetSeconds: media.targetSeconds, fetchedAt };
    // Only a sample cut off at the first read limit has more to offer.
    const truncated = sample.body.length >= SAMPLE_BYTES;
    return await judge(prepare(sample.body), live, truncated
      ? async () => {
        const larger = await bounded(segment.url, LARGE_SAMPLE_MAX_BYTES, LARGE_SAMPLE_BYTES);
        return larger ? prepare(larger.body) : null;
      }
      : undefined);
  } catch (error) {
    if (error instanceof StreamFailure) {
      if (error.message === 'oversized') return { outcome: 'inconclusive', reason: 'A response was larger than expected.' };
      return { outcome: 'dead', reason: error.message, definitive: error.definitive, analyzed: false };
    }
    return { outcome: 'inconclusive', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Second look at a live playlist fetched earlier in the same run. A live
 * stream publishes a new segment every target duration; one that has not
 * moved after several of them is a frozen feed.
 */
export async function recheckLivePlaylist(marker: StreamLiveMarker): Promise<'advanced' | 'frozen' | 'inconclusive' | 'interrupted'> {
  const controller = new AbortController();
  const unregister = registerAnalysisRequest(controller);
  try {
    const playlist = await fetchBytes(marker.mediaUrl, PLAYLIST_MAX_BYTES, controller.signal);
    controller.signal.throwIfAborted();
    if (!isPlaylist(playlist.body)) return 'inconclusive';
    const media = parseMediaPlaylist(playlist.body.toString('utf8'), marker.mediaUrl);
    const advanced = media.sequence !== marker.sequence || media.segments.at(-1)?.url !== marker.lastSegment;
    if (advanced) return 'advanced';
    const elapsedSeconds = (Date.now() - marker.fetchedAt) / 1000;
    return elapsedSeconds >= Math.max(marker.targetSeconds * 3, 30) ? 'frozen' : 'inconclusive';
  } catch {
    // Session-bound playlist URLs often expire between the two looks.
    return controller.signal.aborted ? 'interrupted' : 'inconclusive';
  } finally {
    unregister();
  }
}
