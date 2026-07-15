import { app, powerMonitor } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { inflateSync, deflateSync } from 'node:zlib';
import {
  getMediaFingerprint,
  getResolvedMediaSegments,
  getSegmentAnalysisStates,
  replaceSegmentCandidatesForSource,
  saveMediaFingerprint,
  saveSegmentAnalysisState,
} from '../database';
import {
  isPlaybackActivityActive,
  millisecondsSincePlaybackActivity,
  registerAnalysisProcess,
} from '../ffmpegGovernor';
import { findFFmpeg, findFpcalc } from '../mediaBinaries';
import type { EpisodeFile, MediaItem } from '../metadata/types';
import type { ProbeMediaFileResult } from '../mediaProbeFile';
import { bestFingerprintMatch, scoreFingerprintMatches, type FingerprintMatch, type FingerprintWindow } from './fingerprintMatcher';
import {
  detectMovieCreditIntervals,
  MOVIE_CREDIT_FRAME_HEIGHT,
  MOVIE_CREDIT_FRAME_WIDTH,
} from './movieCreditsDetector';
import { segmentRevision } from './normalize';
import type { MediaSegmentCandidate, MediaSegmentResponse, SegmentAnalysisStatus } from './types';

const ALGORITHM_VERSION = 'loom-chromaprint-v1-11025-mono';
const SAMPLE_RATE = 11025;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

type LibraryLike = { movies?: MediaItem[]; tvShows?: MediaItem[]; animeShows?: MediaItem[] };
type AnalysisContext = {
  item: MediaItem;
  file: EpisodeFile;
  durationMs: number;
  audioTrack: number;
  audioLanguage: string;
  fileRevision: string;
};

function hashId(...values: Array<string | number | null | undefined>): string {
  return createHash('sha256').update(values.map((value) => String(value ?? '')).join('|')).digest('hex').slice(0, 24);
}

function audioIdentity(file: EpisodeFile): { index: number; language: string } {
  const tracks = file.localMetadata?.tracks || [];
  const audio = tracks.find((track) => track.type === 'audio' && track.default)
    || tracks.find((track) => track.type === 'audio');
  return { index: audio?.index ?? 0, language: audio?.language || 'und' };
}

function automaticRevision(filePath: string, durationMs: number, audioTrack: number, audioLanguage: string): string {
  const stats = fs.statSync(filePath);
  void audioLanguage;
  return hashId(path.resolve(filePath), stats.size, Math.round(stats.mtimeMs), durationMs, audioTrack);
}

function lowerPriority(proc: ChildProcess): void {
  if (!proc.pid) return;
  try { os.setPriority(proc.pid, 10); } catch { /* Best effort on unsupported platforms. */ }
}

function collectOutput(proc: ChildProcess): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    proc.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        proc.kill('SIGKILL');
        reject(new Error('fpcalc output exceeded the safety limit.'));
        return;
      }
      chunks.push(chunk);
    });
    proc.once('error', reject);
    proc.once('exit', (code, signal) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Fingerprint helper stopped (${signal || code || 'unknown'}).`));
    });
  });
}

function encodeFingerprint(value: FingerprintWindow): string {
  return deflateSync(Buffer.from(JSON.stringify(value))).toString('base64');
}

function decodeFingerprint(value: string): FingerprintWindow {
  return JSON.parse(inflateSync(Buffer.from(value, 'base64')).toString('utf8')) as FingerprintWindow;
}

function windowDetails(type: 'intro' | 'credits', durationMs: number): { startMs: number; durationMs: number } {
  if (type === 'intro') return { startMs: 0, durationMs: Math.min(10 * 60_000, Math.floor(durationMs * 0.25)) };
  const windowDuration = Math.min(5 * 60_000, durationMs);
  return { startMs: Math.max(0, durationMs - windowDuration), durationMs: windowDuration };
}

async function generateFingerprint(
  context: AnalysisContext,
  type: 'intro' | 'credits',
  ffmpegPath: string,
  fpcalcPath: string,
): Promise<FingerprintWindow> {
  const cached = getMediaFingerprint(context.fileRevision, context.audioTrack, type, ALGORITHM_VERSION);
  if (cached) return decodeFingerprint(cached.fingerprintJson);
  if (isPlaybackActivityActive()) throw new Error('Playback became active; analysis was queued again.');
  const window = windowDetails(type, context.durationMs);
  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(window.startMs / 1000), '-t', String(window.durationMs / 1000),
    '-i', context.file.filePath,
    '-map', `0:${context.audioTrack}`, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-f', 's16le', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const fpcalc = spawn(fpcalcPath, [
    '-format', 's16le', '-rate', String(SAMPLE_RATE), '-channels', '1',
    '-length', '0', '-raw', '-json', '-',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  registerAnalysisProcess(ffmpeg);
  registerAnalysisProcess(fpcalc);
  lowerPriority(ffmpeg);
  lowerPriority(fpcalc);
  ffmpeg.stdout?.pipe(fpcalc.stdin!);
  ffmpeg.stderr?.resume();
  fpcalc.stderr?.resume();
  const output = await collectOutput(fpcalc);
  const parsed = JSON.parse(output.toString('utf8')) as { fingerprint?: number[]; duration?: number };
  if (!Array.isArray(parsed.fingerprint) || parsed.fingerprint.length === 0) throw new Error('fpcalc returned no raw fingerprint frames.');
  const value: FingerprintWindow = {
    frames: parsed.fingerprint.map((frame) => Number(frame) >>> 0),
    durationMs: Math.max(1, Math.round((Number(parsed.duration) || window.durationMs / 1000) * 1000)),
    windowStartMs: window.startMs,
  };
  saveMediaFingerprint({
    fileRevision: context.fileRevision,
    audioTrack: context.audioTrack,
    windowType: type,
    algorithmVersion: ALGORITHM_VERSION,
    fingerprintJson: encodeFingerprint(value),
    durationMs: value.durationMs,
    updatedAt: Date.now(),
  });
  return value;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function strongestCluster(matches: FingerprintMatch[], frameMs: number): FingerprintMatch[] {
  const groups = matches.map((anchor) => matches.filter((candidate) =>
    Math.abs(candidate.startFrame - anchor.startFrame) * frameMs <= 10_000
    && Math.abs(candidate.durationMs - anchor.durationMs) <= 10_000));
  return groups.sort((a, b) => b.length - a.length || scoreFingerprintMatches(b) - scoreFingerprintMatches(a))[0] || [];
}

async function refinedCreditsStart(
  context: AnalysisContext,
  proposedStartMs: number,
  ffmpegPath: string,
): Promise<number> {
  const inspectStartMs = Math.max(0, proposedStartMs - 15_000);
  const inspectDurationMs = Math.min(30_000, context.durationMs - inspectStartMs);
  if (inspectDurationMs <= 0 || isPlaybackActivityActive()) return proposedStartMs;
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, [
      '-hide_banner', '-ss', String(inspectStartMs / 1000), '-t', String(inspectDurationMs / 1000),
      '-i', context.file.filePath,
      '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-af', 'silencedetect=n=-45dB:d=0.5',
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    registerAnalysisProcess(proc);
    lowerPriority(proc);
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 256_000) stderr += chunk.toString(); });
    proc.once('exit', () => {
      const silences = [...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => inspectStartMs + Number(match[1]) * 1000);
      const blackFrames = [...stderr.matchAll(/black_start:([0-9.]+)/g)].map((match) => inspectStartMs + Number(match[1]) * 1000);
      const pair = silences.flatMap((silence) => blackFrames.map((black) => ({ silence, black })))
        .filter(({ silence, black }) => Math.abs(silence - black) <= 5000)
        .sort((a, b) => Math.abs((a.silence + a.black) / 2 - proposedStartMs) - Math.abs((b.silence + b.black) / 2 - proposedStartMs))[0];
      resolve(pair ? Math.round((pair.silence + pair.black) / 2) : proposedStartMs);
    });
    proc.once('error', () => resolve(proposedStartMs));
  });
}

async function movieCreditIntervals(context: AnalysisContext, ffmpegPath: string) {
  if (isPlaybackActivityActive()) throw new Error('Playback became active; analysis was queued again.');
  const windowDurationMs = Math.min(15 * 60_000, context.durationMs);
  const windowStartMs = Math.max(0, context.durationMs - windowDurationMs);
  const proc = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(windowStartMs / 1000), '-t', String(windowDurationMs / 1000),
    '-i', context.file.filePath,
    '-an', '-threads', '1',
    '-vf', `fps=1,scale=${MOVIE_CREDIT_FRAME_WIDTH}:${MOVIE_CREDIT_FRAME_HEIGHT}:flags=fast_bilinear,format=gray`,
    '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  registerAnalysisProcess(proc);
  lowerPriority(proc);
  proc.stderr?.resume();
  const rawFrames = await collectOutput(proc);
  return detectMovieCreditIntervals(rawFrames, windowStartMs, context.durationMs);
}

export function createLocalSegmentAnalysis(deps: {
  loadLibrary: () => LibraryLike;
  loadSettings: () => { localSkipAnalysisEnabled?: boolean };
  probeMediaFile: (filePath: string) => ProbeMediaFileResult;
}) {
  let running: Promise<MediaSegmentResponse> | null = null;
  let scheduler: ReturnType<typeof setInterval> | null = null;
  let onAcPower = true;

  function contexts(mediaId: string, season: number): AnalysisContext[] {
    const item = [...(deps.loadLibrary().tvShows || []), ...(deps.loadLibrary().animeShows || [])]
      .find((candidate) => candidate.id === mediaId);
    if (!item || item.type === 'movie') return [];
    return (item.episodeFiles || [])
      .filter((file) => file.season === season && fs.existsSync(file.filePath))
      .sort((a, b) => a.episode - b.episode)
      .flatMap((file) => {
        const probe = deps.probeMediaFile(file.filePath);
        const durationMs = Math.round((file.localMetadata?.durationSeconds || probe.localMetadata?.durationSeconds || 0) * 1000);
        if (!durationMs) return [];
        const audio = audioIdentity(file);
        return [{
          item,
          file,
          durationMs,
          audioTrack: audio.index,
          audioLanguage: audio.language,
          fileRevision: automaticRevision(file.filePath, durationMs, audio.index, audio.language),
        }];
      });
  }

  function movieContext(mediaId: string): AnalysisContext | null {
    const item = (deps.loadLibrary().movies || []).find((candidate) => candidate.id === mediaId);
    if (!item || item.type !== 'movie' || !item.filePath || !fs.existsSync(item.filePath)) return null;
    const probe = item.localMetadata ? { localMetadata: item.localMetadata } : deps.probeMediaFile(item.filePath);
    const durationMs = Math.round((item.localMetadata?.durationSeconds || probe.localMetadata?.durationSeconds || 0) * 1000);
    if (!durationMs) return null;
    const file: EpisodeFile = {
      season: 0,
      episode: 0,
      filePath: item.filePath,
      subtitles: item.subtitles,
      localMetadata: item.localMetadata || probe.localMetadata,
    };
    const audio = audioIdentity(file);
    return {
      item,
      file,
      durationMs,
      audioTrack: audio.index,
      audioLanguage: audio.language,
      fileRevision: automaticRevision(file.filePath, durationMs, audio.index, audio.language),
    };
  }

  async function analyze(mediaId: string, season: number): Promise<MediaSegmentResponse> {
    if (deps.loadSettings().localSkipAnalysisEnabled === false) throw new Error('Enable automatic local skip analysis in Playback settings first.');
    if (running) return running;
    const task = (async () => {
      const fpcalcPath = findFpcalc();
      const ffmpegPath = findFFmpeg();
      if (!fpcalcPath || !ffmpegPath) throw new Error(!fpcalcPath ? 'fpcalc was not found. Provider and manual markers remain available.' : 'FFmpeg was not found.');
      const episodes = contexts(mediaId, season);
      if (episodes.length < 3) throw new Error('At least three usable episodes are required for local analysis.');
      const identity = hashId(...episodes.map((episode) => episode.fileRevision));
      const jobKey = `season:${mediaId}:${season}:${identity}`;
      saveSegmentAnalysisState(jobKey, mediaId, season, 'running', `Analyzing ${episodes.length} episodes`);
      try {
        const fingerprints = new Map<string, Record<'intro' | 'credits', FingerprintWindow>>();
        for (const episode of episodes) {
          if (isPlaybackActivityActive()) throw new Error('Playback became active; analysis was queued again.');
          fingerprints.set(episode.fileRevision, {
            intro: await generateFingerprint(episode, 'intro', ffmpegPath, fpcalcPath),
            credits: await generateFingerprint(episode, 'credits', ffmpegPath, fpcalcPath),
          });
        }

        for (let index = 0; index < episodes.length; index += 1) {
          const episode = episodes[index];
          const candidates: MediaSegmentCandidate[] = [];
          for (const type of ['intro', 'credits'] as const) {
            const target = fingerprints.get(episode.fileRevision)?.[type];
            if (!target) continue;
            const frameMs = target.durationMs / target.frames.length;
            const neighbors = episodes.slice(Math.max(0, index - 4), Math.min(episodes.length, index + 5))
              .filter((candidate) => candidate.fileRevision !== episode.fileRevision);
            const matches = neighbors.flatMap((neighbor) => {
              const other = fingerprints.get(neighbor.fileRevision)?.[type];
              if (!other) return [];
              const match = bestFingerprintMatch(target, other, {
                minDurationMs: 15_000,
                maxDurationMs: type === 'intro' ? 180_000 : 300_000,
                minSimilarity: 0.85,
              });
              return match ? [match] : [];
            });
            const cluster = strongestCluster(matches, frameMs);
            if (cluster.length < 2) continue;
            const confidence = scoreFingerprintMatches(cluster);
            if (confidence < 0.80) continue;
            let startMs = Math.round(target.windowStartMs + median(cluster.map((match) => match.startFrame * frameMs)));
            const matchDurationMs = Math.round(median(cluster.map((match) => match.durationMs)));
            if (type === 'credits' && confidence >= 0.90) startMs = await refinedCreditsStart(episode, startMs, ffmpegPath);
            const endMs = Math.min(episode.durationMs, startMs + matchDurationMs);
            candidates.push({
              id: hashId(episode.fileRevision, 'chromaprint', type, startMs, endMs),
              mediaId,
              season,
              episode: episode.file.episode,
              filePath: episode.file.filePath,
              fileRevision: episode.fileRevision,
              type,
              startMs,
              endMs,
              confidence,
              source: 'chromaprint',
              status: confidence >= 0.90 ? 'active' : 'review',
              mediaDurationMs: episode.durationMs,
              updatedAt: new Date().toISOString(),
            });
          }
          replaceSegmentCandidatesForSource(episode.fileRevision, 'chromaprint', candidates);
        }
        saveSegmentAnalysisState(jobKey, mediaId, season, 'complete', `Analyzed ${episodes.length} episodes`);
        const segments = getResolvedMediaSegments(episodes[0].fileRevision);
        return { segments, revision: segmentRevision(segments) };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Local analysis failed.';
        saveSegmentAnalysisState(jobKey, mediaId, season, message.includes('Playback became active') ? 'queued' : 'error', message);
        throw error;
      }
    })();
    running = task;
    try { return await task; } finally { running = null; }
  }

  async function analyzeMovie(mediaId: string): Promise<MediaSegmentResponse> {
    if (deps.loadSettings().localSkipAnalysisEnabled === false) throw new Error('Enable automatic local skip analysis in Playback settings first.');
    if (running) return running;
    const task = (async () => {
      const ffmpegPath = findFFmpeg();
      if (!ffmpegPath) throw new Error('FFmpeg was not found. Provider and chapter markers remain available.');
      const context = movieContext(mediaId);
      if (!context) throw new Error('That movie file is unavailable.');
      const jobKey = `movie:${mediaId}:${context.fileRevision}:credits-v1`;
      saveSegmentAnalysisState(jobKey, mediaId, 0, 'running', 'Inspecting the final 15 minutes for movie credits');
      try {
        const intervals = await movieCreditIntervals(context, ffmpegPath);
        const candidates: MediaSegmentCandidate[] = [];
        for (const interval of intervals) {
          const startMs = await refinedCreditsStart(context, interval.startMs, ffmpegPath);
          candidates.push({
            id: hashId(context.fileRevision, 'chromaprint', 'movie-credits', startMs, interval.endMs),
            mediaId,
            season: 0,
            episode: 0,
            filePath: context.file.filePath,
            fileRevision: context.fileRevision,
            type: 'credits',
            startMs,
            endMs: interval.endMs,
            confidence: interval.confidence,
            source: 'chromaprint',
            status: 'active',
            mediaDurationMs: context.durationMs,
            updatedAt: new Date().toISOString(),
          });
        }
        replaceSegmentCandidatesForSource(context.fileRevision, 'chromaprint', candidates);
        saveSegmentAnalysisState(
          jobKey,
          mediaId,
          0,
          'complete',
          candidates.length ? `Detected ${candidates.length} movie credits interval${candidates.length === 1 ? '' : 's'}` : 'No high-confidence movie credits found',
        );
        const segments = getResolvedMediaSegments(context.fileRevision);
        return { segments, revision: segmentRevision(segments) };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Movie credits analysis failed.';
        saveSegmentAnalysisState(jobKey, mediaId, 0, message.includes('Playback became active') ? 'queued' : 'error', message);
        throw error;
      }
    })();
    running = task;
    try { return await task; } finally { running = null; }
  }

  function status(): SegmentAnalysisStatus & { jobs: ReturnType<typeof getSegmentAnalysisStates> } {
    const helperPath = findFpcalc();
    const enabled = deps.loadSettings().localSkipAnalysisEnabled !== false;
    const jobs = getSegmentAnalysisStates();
    return {
      enabled,
      available: Boolean(helperPath && findFFmpeg()),
      helperPath,
      state: running ? 'running' : !enabled ? 'disabled' : helperPath ? 'idle' : 'unavailable',
      message: helperPath ? undefined : 'Install fpcalc or set LOOMTV_FPCALC_PATH. Provider and chapter markers still work.',
      jobs,
    };
  }

  function startScheduler(): void {
    if (scheduler || !app.isReady()) return;
    powerMonitor.on('on-ac', () => { onAcPower = true; });
    powerMonitor.on('on-battery', () => { onAcPower = false; });
    scheduler = setInterval(() => {
      if (running || !onAcPower || deps.loadSettings().localSkipAnalysisEnabled === false) return;
      if (powerMonitor.getSystemIdleTime() < 300 || isPlaybackActivityActive() || millisecondsSincePlaybackActivity() < 60_000) return;
      const library = deps.loadLibrary();
      const seasonTargets = [...(library.tvShows || []), ...(library.animeShows || [])].flatMap((item) =>
        [...new Set((item.episodeFiles || []).map((file) => file.season))].map((season) => ({ mediaId: item.id, season })));
      const seasonTarget = seasonTargets.find(({ mediaId, season }) => {
        const revisions = contexts(mediaId, season).map((context) => context.fileRevision);
        const jobKey = `season:${mediaId}:${season}:${hashId(...revisions)}`;
        const needsLocalFallback = revisions.some((revision) => {
          const reliableTypes = new Set(getResolvedMediaSegments(revision)
            .filter((segment) => segment.source !== 'chromaprint')
            .map((segment) => segment.type));
          return !reliableTypes.has('intro') || !reliableTypes.has('credits');
        });
        return revisions.length >= 3
          && needsLocalFallback
          && !getSegmentAnalysisStates(mediaId).some((job) => job.jobKey === jobKey && job.state === 'complete');
      });
      if (seasonTarget) {
        void analyze(seasonTarget.mediaId, seasonTarget.season).catch(() => undefined);
        return;
      }
      const movieTarget = (library.movies || []).map((item) => movieContext(item.id)).find((context) => {
        if (!context) return false;
        const hasReliableCredits = getResolvedMediaSegments(context.fileRevision)
          .some((segment) => segment.type === 'credits' && segment.source !== 'chromaprint');
        const jobKey = `movie:${context.item.id}:${context.fileRevision}:credits-v1`;
        const completed = getSegmentAnalysisStates(context.item.id)
          .some((job) => job.jobKey === jobKey && job.state === 'complete');
        return !hasReliableCredits && !completed;
      });
      if (movieTarget) void analyzeMovie(movieTarget.item.id).catch(() => undefined);
    }, 60_000);
    scheduler.unref?.();
  }

  return { analyze, analyzeMovie, status, startScheduler };
}

export type LocalSegmentAnalysis = ReturnType<typeof createLocalSegmentAnalysis>;
