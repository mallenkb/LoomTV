import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { inflateSync, deflateSync } from 'node:zlib';
import {
  getAuxiliaryFingerprint,
  getMediaFingerprint,
  getResolvedMediaSegments,
  getSegmentAnalysisStates,
  replaceSegmentCandidatesForSource,
  saveMediaFingerprint,
  saveAuxiliaryFingerprint,
  saveSegmentAnalysisState,
} from '../database.ts';
import type { SkipAnalysisSettings } from '../../shared/desktopProtocol.ts';
import {
  currentAnalysisInterruptionEpoch,
  isPlaybackActivityActive,
  registerAnalysisProcess,
} from '../ffmpegGovernor.ts';
import { findFFmpeg, findFFprobe, findFpcalc } from '../mediaBinaries.ts';
import type { EpisodeFile, MediaItem } from '../metadata/types';
import type { ProbeMediaFileResult } from '../mediaProbeFile';
import { bestFingerprintMatch, scoreFingerprintMatches, type FingerprintMatch, type FingerprintWindow } from './fingerprintMatcher.ts';
import {
  detectMovieCreditIntervals,
  MOVIE_CREDIT_FRAME_HEIGHT,
  MOVIE_CREDIT_FRAME_WIDTH,
} from './movieCreditsDetector.ts';
import { chapterType, segmentRevision } from './normalize.ts';
import { selectRefinedBoundary, type BoundaryPoint } from './boundaryRefinement.ts';
import {
  AnalysisInterruptedError,
  batchedFingerprintIndices,
  isAnalysisInterruptedError,
  neighborIndices,
  runIsolatedWorkerPool,
  yieldToAnalysisEvents,
} from './analysisBatch.ts';
import type {
  LocalAnalysisOutcome,
  MediaSegmentCandidate,
  MediaSegmentResponse,
  SegmentAnalysisPhaseProgress,
  SegmentAnalysisStatus,
} from './types';

export { FINGERPRINT_ALGORITHM_VERSION } from './fileIdentity.ts';
import { FINGERPRINT_ALGORITHM_VERSION } from './fileIdentity.ts';
const SAMPLE_RATE = 11025;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Bounded fingerprint parallelism: episodes are independent, but FFmpeg decode
// is itself multithreaded and media often lives on NAS/spinning disks, so keep
// this small. Raise only with benchmarks (docs/skip-analysis-performance-plan.md).
const FINGERPRINT_WORKERS = 2;

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

function collectOutput(proc: ChildProcess, maxBytes = MAX_OUTPUT_BYTES, label = 'Analysis helper'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    proc.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        proc.kill('SIGKILL');
        reject(new Error(`${label} output exceeded the safety limit.`));
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
  const parsed = JSON.parse(inflateSync(Buffer.from(value, 'base64'), { maxOutputLength: MAX_OUTPUT_BYTES }).toString('utf8')) as Partial<FingerprintWindow>;
  if (!Array.isArray(parsed.frames) || !parsed.frames.length || parsed.frames.length > 500_000
    || parsed.frames.some((frame) => !Number.isFinite(frame))
    || !Number.isFinite(parsed.durationMs) || !Number.isFinite(parsed.windowStartMs)) {
    throw new Error('Cached fingerprint data is invalid.');
  }
  return parsed as FingerprintWindow;
}

type FingerprintType = 'intro' | 'credits' | 'recap' | 'preview';

const FINGERPRINT_WINDOW_VERSION: Record<FingerprintType, string> = {
  intro: 'head-max600000-ratio025-v1',
  recap: 'head-max180000-ratio015-v1',
  credits: 'tail-max300000-v1',
  preview: 'tail-max120000-v1',
};

function fingerprintCacheVersion(type: FingerprintType): string {
  return `${FINGERPRINT_ALGORITHM_VERSION}:${FINGERPRINT_WINDOW_VERSION[type]}`;
}

function windowDetails(type: FingerprintType, durationMs: number): { startMs: number; durationMs: number } {
  if (type === 'intro') return { startMs: 0, durationMs: Math.min(10 * 60_000, Math.floor(durationMs * 0.25)) };
  if (type === 'recap') return { startMs: 0, durationMs: Math.min(3 * 60_000, Math.floor(durationMs * 0.15)) };
  const windowDuration = Math.min(type === 'preview' ? 2 * 60_000 : 5 * 60_000, durationMs);
  return { startMs: Math.max(0, durationMs - windowDuration), durationMs: windowDuration };
}

async function generateFingerprint(
  context: AnalysisContext,
  type: FingerprintType,
  ffmpegPath: string,
  fpcalcPath: string,
): Promise<FingerprintWindow> {
  if (isPlaybackActivityActive()) throw new Error('Playback became active; analysis was queued again.');
  const primary = type === 'intro' || type === 'credits';
  const cacheVersion = fingerprintCacheVersion(type);
  const cached = primary
    ? getMediaFingerprint(context.fileRevision, context.audioTrack, type, cacheVersion)
    : getAuxiliaryFingerprint(context.fileRevision, context.audioTrack, type, cacheVersion);
  if (cached) return decodeFingerprint(cached.fingerprintJson);
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
  if (!ffmpeg.stdout || !fpcalc.stdin) throw new Error('Unable to connect media analysis processes.');
  ffmpeg.stdout.pipe(fpcalc.stdin);
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
  const save = primary ? saveMediaFingerprint : saveAuxiliaryFingerprint;
  save({
    fileRevision: context.fileRevision,
    audioTrack: context.audioTrack,
    windowType: type,
    algorithmVersion: cacheVersion,
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

async function nearbyBoundaryPoints(
  context: AnalysisContext,
  proposedMs: number,
  ffmpegPath: string,
  ffprobePath: string | null,
  inwardDirection: -1 | 1,
): Promise<BoundaryPoint[]> {
  const inspectStartMs = Math.max(0, proposedMs - (inwardDirection === 1 ? 2000 : 5000));
  const inspectDurationMs = Math.min(7000, context.durationMs - inspectStartMs);
  if (inspectDurationMs <= 0 || isPlaybackActivityActive()) return [];
  const silenceProcess = spawn(ffmpegPath, [
    '-hide_banner', '-ss', String(inspectStartMs / 1000), '-t', String(inspectDurationMs / 1000),
    '-i', context.file.filePath, '-vn', '-af', 'silencedetect=n=-45dB:d=0.25', '-f', 'null', '-',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  registerAnalysisProcess(silenceProcess);
  lowerPriority(silenceProcess);
  const silenceOutput = await new Promise<string>((resolve) => {
    let stderr = '';
    silenceProcess.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 256_000) stderr += chunk.toString(); });
    silenceProcess.once('error', () => resolve(''));
    silenceProcess.once('exit', () => resolve(stderr));
  });
  const points: BoundaryPoint[] = [...silenceOutput.matchAll(/silence_(?:start|end):\s*([0-9.]+)/g)]
    .map((match) => ({ kind: 'silence' as const, timeMs: inspectStartMs + Number(match[1]) * 1000 }));
  if (!ffprobePath || isPlaybackActivityActive()) return points;
  const keyframeProcess = spawn(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0',
    '-read_intervals', `${inspectStartMs / 1000}%+${inspectDurationMs / 1000}`,
    context.file.filePath,
  ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  registerAnalysisProcess(keyframeProcess);
  lowerPriority(keyframeProcess);
  try {
    const output = (await collectOutput(keyframeProcess)).toString('utf8');
    points.push(...output.split(/\r?\n/).flatMap((line) => {
      const seconds = Number(line.trim().split(',')[0]);
      return Number.isFinite(seconds) ? [{ kind: 'keyframe' as const, timeMs: seconds * 1000 }] : [];
    }));
  } catch {
    // Refinement is best effort; retaining the fingerprint boundary is safe.
  }
  return points;
}

async function movieCreditIntervals(context: AnalysisContext, ffmpegPath: string, maximumWindowMs = 15 * 60_000) {
  if (isPlaybackActivityActive()) throw new Error('Playback became active; analysis was queued again.');
  const windowDurationMs = Math.min(maximumWindowMs, context.durationMs);
  const windowStartMs = Math.max(0, context.durationMs - windowDurationMs);
  const proc = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(windowStartMs / 1000), '-t', String(windowDurationMs / 1000),
    '-i', context.file.filePath,
    '-an', '-threads', '1',
    '-vf', `fps=1,scale=${MOVIE_CREDIT_FRAME_WIDTH}:${MOVIE_CREDIT_FRAME_HEIGHT}:flags=fast_bilinear,format=rgb24`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  registerAnalysisProcess(proc);
  lowerPriority(proc);
  proc.stderr?.resume();
  const bytesPerFrame = MOVIE_CREDIT_FRAME_WIDTH * MOVIE_CREDIT_FRAME_HEIGHT * 3;
  const maximumFrames = Math.ceil(windowDurationMs / 1000) + 2;
  const rawFrames = await collectOutput(proc, maximumFrames * bytesPerFrame, 'FFmpeg visual analysis');
  return detectMovieCreditIntervals(rawFrames, windowStartMs, context.durationMs, 3);
}

export function createLocalSegmentAnalysis(deps: {
  loadLibrary: () => LibraryLike;
  loadSettings: () => { localSkipAnalysisEnabled?: boolean; skipAnalysis?: SkipAnalysisSettings };
  probeMediaFile: (filePath: string) => ProbeMediaFileResult;
}) {
  let running: Promise<MediaSegmentResponse> | null = null;

  function settings(): SkipAnalysisSettings {
    const configured = deps.loadSettings().skipAnalysis;
    if (configured) return configured;
    return {
      enabled: deps.loadSettings().localSkipAnalysisEnabled !== false,
      analyzeNewMedia: true,
      enabledTypes: { intro: true, recap: true, credits: true, preview: true },
      promptTypes: { intro: true, recap: true, credits: true, preview: false },
      durationLimits: {
        intro: { minSeconds: 15, maxSeconds: 180 }, recap: { minSeconds: 15, maxSeconds: 120 },
        credits: { minSeconds: 15, maxSeconds: 300 }, preview: { minSeconds: 15, maxSeconds: 120 },
        movieCredits: { minSeconds: 15, maxSeconds: 900 },
      },
      suppressFirstEpisodeIntro: false,
      analyzeSpecials: false,
      exclusions: { seriesIds: [], movieIds: [], seasons: [], paths: [] },
      seasonOverrides: {},
    };
  }

  function excluded(item: MediaItem, season: number, filePath: string): boolean {
    const value = settings();
    if (item.type !== 'movie' && season === 0 && !value.analyzeSpecials) return true;
    if ((item.type === 'movie' ? value.exclusions.movieIds : value.exclusions.seriesIds).includes(item.id)) return true;
    if (value.exclusions.seasons.includes(`${item.id}:${season}`)) return true;
    const resolved = path.resolve(filePath);
    return value.exclusions.paths.some((entry) => resolved === path.resolve(entry) || resolved.startsWith(`${path.resolve(entry)}${path.sep}`));
  }

  function contexts(mediaId: string, season: number): AnalysisContext[] {
    const item = [...(deps.loadLibrary().tvShows || []), ...(deps.loadLibrary().animeShows || [])]
      .find((candidate) => candidate.id === mediaId);
    if (!item || item.type === 'movie') return [];
    return (item.episodeFiles || [])
      .filter((file) => file.season === season && fs.existsSync(file.filePath) && !excluded(item, season, file.filePath))
      .sort((a, b) => a.episode - b.episode)
      .flatMap((file) => {
        const probe = file.localMetadata?.durationSeconds ? null : deps.probeMediaFile(file.filePath);
        const durationMs = Math.round((file.localMetadata?.durationSeconds || probe?.localMetadata?.durationSeconds || 0) * 1000);
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
    if (!item || item.type !== 'movie' || !item.filePath || !fs.existsSync(item.filePath) || excluded(item, 0, item.filePath)) return null;
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

  async function analyzeSeason(
    mediaId: string,
    season: number,
    targetRevisions?: string[],
    shouldContinue: () => boolean = () => !isPlaybackActivityActive(),
    onProgress?: (progress: SegmentAnalysisPhaseProgress) => void,
    onOutcome?: (fileRevision: string, outcome: LocalAnalysisOutcome) => void,
  ): Promise<MediaSegmentResponse> {
    if (!settings().enabled) throw new Error('Enable automatic local skip analysis in Playback settings first.');
    if (running) return running;
    const interruptionEpoch = currentAnalysisInterruptionEpoch();
    const canContinue = () => shouldContinue() && currentAnalysisInterruptionEpoch() === interruptionEpoch;
    const task = (async () => {
      const fpcalcPath = findFpcalc();
      const ffmpegPath = findFFmpeg();
      const ffprobePath = findFFprobe();
      if (!fpcalcPath || !ffmpegPath) throw new Error(!fpcalcPath ? 'fpcalc was not found. Provider and manual markers remain available.' : 'FFmpeg was not found.');
      const episodes = contexts(mediaId, season);
      if (episodes.length < 3) throw new Error('At least three usable episodes are required for local analysis.');
      const identity = hashId(...episodes.map((episode) => episode.fileRevision));
      const jobKey = `season:${mediaId}:${season}:${identity}`;
      saveSegmentAnalysisState(jobKey, mediaId, season, 'running', `Analyzing ${episodes.length} episodes`);
      try {
        const configured = settings();
        const fingerprintTypes = (['intro', 'recap', 'credits', 'preview'] as const)
          .filter((type) => configured.enabledTypes[type]);
        const targetSet = targetRevisions ? new Set(targetRevisions) : null;
        const targetIndices = targetSet
          ? episodes.flatMap((episode, index) => (targetSet.has(episode.fileRevision) ? [index] : []))
          : null;
        if (targetIndices && !targetIndices.length) throw new Error('That media revision is no longer available.');
        // Matching only ever looks ±4 episodes around a target, so fingerprint
        // exactly that union once and reuse it for every comparison.
        const fingerprintIndices = targetIndices
          ? batchedFingerprintIndices(targetIndices, episodes.length)
          : episodes.map((_, index) => index);
        const fingerprintEpisodes = fingerprintIndices.map((index) => episodes[index]);
        const report = (progress: SegmentAnalysisPhaseProgress) => {
          saveSegmentAnalysisState(jobKey, mediaId, season, 'running', progress.detail);
          onProgress?.(progress);
        };
        const fingerprints = new Map<string, Partial<Record<FingerprintType, FingerprintWindow>>>();
        let fingerprinted = 0;
        report({ phase: 'fingerprinting', completed: 0, total: fingerprintEpisodes.length, detail: `Fingerprinting 0 of ${fingerprintEpisodes.length} episodes` });
        const fingerprintFailures = await runIsolatedWorkerPool(
          fingerprintEpisodes,
          FINGERPRINT_WORKERS,
          async (episode) => {
            const values: Partial<Record<FingerprintType, FingerprintWindow>> = {};
            for (const type of fingerprintTypes) {
              if (!canContinue()) throw new AnalysisInterruptedError();
              values[type] = await generateFingerprint(episode, type, ffmpegPath, fpcalcPath);
            }
            fingerprints.set(episode.fileRevision, values);
            fingerprinted += 1;
            report({
              phase: 'fingerprinting', completed: fingerprinted, total: fingerprintEpisodes.length,
              detail: `Fingerprinting ${fingerprinted} of ${fingerprintEpisodes.length} episodes`,
            });
          },
          canContinue,
        );

        let matched = 0;
        const matchTotal = targetIndices ? targetIndices.length : episodes.length;
        const outcomes = new Map<string, LocalAnalysisOutcome>();
        for (let index = 0; index < episodes.length; index += 1) {
          const episode = episodes[index];
          if (targetSet && !targetSet.has(episode.fileRevision)) continue;
          await yieldToAnalysisEvents(canContinue);
          report({
            phase: 'matching', completed: matched, total: matchTotal,
            detail: `Matching episode ${matched + 1} of ${matchTotal}`,
          });
          const targetFailure = fingerprintFailures.get(episode);
          const healthyPeerCount = neighborIndices(index, episodes.length)
            .filter((dependencyIndex) => dependencyIndex !== index && !fingerprintFailures.has(episodes[dependencyIndex]))
            .length;
          const dependencyFailure = targetFailure
            || (fingerprintFailures.size > 0 && healthyPeerCount < 2
              ? new Error('Fewer than two healthy peer fingerprints remain in this episode window.')
              : null);
          if (dependencyFailure) {
            const outcome: LocalAnalysisOutcome = {
              kind: 'error',
              detail: `Fingerprint dependency failed: ${dependencyFailure.message}`,
            };
            outcomes.set(episode.fileRevision, outcome);
            onOutcome?.(episode.fileRevision, outcome);
            matched += 1;
            report({
              phase: 'matching', completed: matched, total: matchTotal,
              detail: `Matching episode ${matched} of ${matchTotal}`,
            });
            continue;
          }
          try {
          const candidates: MediaSegmentCandidate[] = [];
          for (const type of fingerprintTypes) {
            if (!canContinue()) throw new AnalysisInterruptedError();
            const target = fingerprints.get(episode.fileRevision)?.[type];
            if (!target) continue;
            const frameMs = target.durationMs / target.frames.length;
            const neighbors = episodes.slice(Math.max(0, index - 4), Math.min(episodes.length, index + 5))
              .filter((candidate) => candidate.fileRevision !== episode.fileRevision);
            const matches = neighbors.flatMap((neighbor) => {
              const other = fingerprints.get(neighbor.fileRevision)?.[type];
              if (!other) return [];
              const limits = configured.durationLimits[type];
              const conflicting = type === 'recap'
                ? candidates.filter((candidate) => candidate.type === 'intro')
                : type === 'preview'
                  ? candidates.filter((candidate) => candidate.type === 'credits')
                  : [];
              const match = bestFingerprintMatch(target, other, {
                minDurationMs: limits.minSeconds * 1000,
                maxDurationMs: limits.maxSeconds * 1000,
                minSimilarity: 0.85,
                excludeLeft: conflicting.map((candidate) => ({
                  startMs: candidate.startMs - target.windowStartMs,
                  endMs: (candidate.endMs ?? episode.durationMs) - target.windowStartMs,
                })),
              });
              return match ? [match] : [];
            });
            const cluster = strongestCluster(matches, frameMs);
            if (cluster.length < 2) continue;
            const confidence = scoreFingerprintMatches(cluster);
            if (confidence < 0.80) continue;
            let startMs = Math.round(target.windowStartMs + median(cluster.map((match) => match.startFrame * frameMs)));
            const matchDurationMs = Math.round(median(cluster.map((match) => match.durationMs)));
            const originalStartMs = startMs;
            if (type === 'credits' && confidence >= 0.90) startMs = await refinedCreditsStart(episode, startMs, ffmpegPath);
            const chapterPoints: BoundaryPoint[] = (episode.file.localMetadata?.chapters || []).flatMap((chapter) => [
              { kind: 'chapter' as const, timeMs: chapter.startMs },
              { kind: 'chapter' as const, timeMs: chapter.endMs },
            ]);
            const creditsRefinedByAgreement = type === 'credits' && startMs !== originalStartMs;
            const startEvidence = type === 'credits' ? [] : await nearbyBoundaryPoints(episode, startMs, ffmpegPath, ffprobePath, 1);
            const refined = selectRefinedBoundary({
              proposedMs: startMs,
              mediaDurationMs: episode.durationMs,
              points: type === 'credits' ? [] : [...chapterPoints, ...startEvidence],
              inwardDirection: 1,
            });
            startMs = refined.timeMs;
            const proposedEndMs = Math.min(episode.durationMs, startMs + matchDurationMs);
            const endEvidence = type === 'credits' ? [] : await nearbyBoundaryPoints(episode, proposedEndMs, ffmpegPath, ffprobePath, -1);
            const refinedEnd = selectRefinedBoundary({
              proposedMs: proposedEndMs,
              mediaDurationMs: episode.durationMs,
              points: type === 'credits' ? [] : [...chapterPoints, ...endEvidence],
              inwardDirection: -1,
            });
            const endMs = Math.min(episode.durationMs, Math.max(startMs + 1000, refinedEnd.timeMs));
            if (configured.suppressFirstEpisodeIntro && episode.file.episode === 1 && type === 'intro') continue;
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
              analysisMetadata: {
                detector: 'chromaprint',
                peerSupport: cluster.length,
                originalStartMs,
                originalEndMs: Math.min(episode.durationMs, originalStartMs + matchDurationMs),
                startSnap: creditsRefinedByAgreement ? 'silence' : refined.kind,
                endSnap: refinedEnd.kind,
                confidenceComponents: { combined: confidence },
              },
            });
          }
          if (configured.enabledTypes.credits && !candidates.some((candidate) => candidate.type === 'credits' && candidate.confidence >= 0.90)) {
            if (!canContinue()) throw new AnalysisInterruptedError();
            const limits = configured.durationLimits.credits;
            const visualIntervals = await movieCreditIntervals(episode, ffmpegPath, 5 * 60_000);
            for (const interval of visualIntervals) {
              const intervalEnd = interval.endMs ?? episode.durationMs;
              const intervalDuration = intervalEnd - interval.startMs;
              if (intervalDuration < limits.minSeconds * 1000 || intervalDuration > limits.maxSeconds * 1000) continue;
              candidates.push({
                id: hashId(episode.fileRevision, 'chromaprint', 'episode-visual-credits', interval.startMs, interval.endMs),
                mediaId, season, episode: episode.file.episode, filePath: episode.file.filePath,
                fileRevision: episode.fileRevision, type: 'credits', startMs: interval.startMs,
                endMs: interval.endMs, confidence: interval.confidence, source: 'chromaprint', status: 'active',
                mediaDurationMs: episode.durationMs, updatedAt: new Date().toISOString(),
                analysisMetadata: {
                  detector: 'blackframe', originalStartMs: interval.startMs, originalEndMs: interval.endMs,
                  startSnap: 'original', endSnap: 'original', confidenceComponents: { visual: interval.confidence },
                },
              });
            }
          }
          const localTypePriority: Record<FingerprintType, number> = { intro: 0, recap: 1, credits: 2, preview: 3 };
          const localOnly = candidates.filter((candidate, candidateIndex) => !candidates.some((other, otherIndex) => {
            if (candidateIndex === otherIndex || candidate.type === other.type) return false;
            const candidateEnd = candidate.endMs ?? episode.durationMs;
            const otherEnd = other.endMs ?? episode.durationMs;
            const overlap = Math.max(0, Math.min(candidateEnd, otherEnd) - Math.max(candidate.startMs, other.startMs));
            const shortest = Math.min(candidateEnd - candidate.startMs, otherEnd - other.startMs);
            return shortest > 0 && overlap / shortest >= 0.6
              && (other.confidence > candidate.confidence
                || (other.confidence === candidate.confidence && localTypePriority[other.type] < localTypePriority[candidate.type]));
          }));
          if (!canContinue()) throw new AnalysisInterruptedError();
          replaceSegmentCandidatesForSource(episode.fileRevision, 'chromaprint', localOnly);
          const segments = getResolvedMediaSegments(episode.fileRevision);
          const outcome: LocalAnalysisOutcome = {
            kind: 'complete',
            response: { segments, revision: segmentRevision(segments) },
          };
          outcomes.set(episode.fileRevision, outcome);
          onOutcome?.(episode.fileRevision, outcome);
          } catch (error) {
            if (isAnalysisInterruptedError(error) || !canContinue()) throw new AnalysisInterruptedError();
            const outcome: LocalAnalysisOutcome = {
              kind: 'error',
              detail: error instanceof Error ? error.message : 'Episode analysis failed.',
            };
            outcomes.set(episode.fileRevision, outcome);
            onOutcome?.(episode.fileRevision, outcome);
          }
          matched += 1;
          report({
            phase: 'matching', completed: matched, total: matchTotal,
            detail: `Matching episode ${matched} of ${matchTotal}`,
          });
        }
        const failed = [...outcomes.values()].filter((outcome) => outcome.kind === 'error').length;
        saveSegmentAnalysisState(
          jobKey,
          mediaId,
          season,
          'complete',
          `Analyzed ${outcomes.size - failed} episodes${failed ? `; ${failed} failed` : ''}`,
        );
        const resultRevision = targetRevisions?.[0] || episodes[0].fileRevision;
        const result = outcomes.get(resultRevision);
        if (result && result.kind !== 'error') return result.response;
        const segments = getResolvedMediaSegments(resultRevision);
        return { segments, revision: segmentRevision(segments) };
      } catch (error) {
        const interrupted = isAnalysisInterruptedError(error) || !canContinue();
        const normalized = interrupted
          ? new AnalysisInterruptedError()
          : error instanceof Error ? error : new Error('Local analysis failed.');
        saveSegmentAnalysisState(jobKey, mediaId, season, interrupted ? 'queued' : 'error', normalized.message);
        throw normalized;
      }
    })();
    running = task;
    try { return await task; } finally { running = null; }
  }

  async function analyze(mediaId: string, season: number): Promise<MediaSegmentResponse> {
    return analyzeSeason(mediaId, season);
  }

  async function analyzeRevision(
    mediaId: string,
    season: number,
    fileRevision: string,
    shouldContinue: () => boolean = () => !isPlaybackActivityActive(),
  ): Promise<LocalAnalysisOutcome> {
    const outcomes = await analyzeSeasonBatch(mediaId, season, [fileRevision], shouldContinue);
    const outcome = outcomes.get(fileRevision);
    if (!outcome) throw new Error('That media revision is no longer available.');
    return outcome;
  }

  // One season pass for every requested episode: fingerprints the union of the
  // targets ±4 neighbors once, then matches and publishes per target. Outcomes
  // are emitted as each target finishes so interruption preserves completed work.
  async function analyzeSeasonBatch(
    mediaId: string,
    season: number,
    fileRevisions: string[],
    shouldContinue: () => boolean = () => !isPlaybackActivityActive(),
    onProgress?: (progress: SegmentAnalysisPhaseProgress) => void,
    onOutcome?: (fileRevision: string, outcome: LocalAnalysisOutcome) => void,
  ): Promise<Map<string, LocalAnalysisOutcome>> {
    const outcomes = new Map<string, LocalAnalysisOutcome>();
    const interruptionEpoch = currentAnalysisInterruptionEpoch();
    const canContinue = () => shouldContinue() && currentAnalysisInterruptionEpoch() === interruptionEpoch;
    const record = (revision: string, outcome: LocalAnalysisOutcome) => {
      outcomes.set(revision, outcome);
      onOutcome?.(revision, outcome);
    };
    const requested = [...new Set(fileRevisions)];
    const isMovie = (deps.loadLibrary().movies || []).some((item) => item.id === mediaId && item.type === 'movie');
    if (isMovie) {
      const response = await analyzeMovie(mediaId, canContinue);
      for (const revision of requested) record(revision, { kind: 'complete', response });
      return outcomes;
    }
    const episodes = contexts(mediaId, season);
    const known = new Set(episodes.map((episode) => episode.fileRevision));
    const targets = requested.filter((revision) => known.has(revision));
    for (const revision of requested) {
      if (!known.has(revision)) record(revision, { kind: 'error', detail: 'That media revision is no longer available.' });
    }
    if (!targets.length) return outcomes;
    const mode = settings().seasonOverrides[`${mediaId}:${season}`] || 'full';
    if (mode !== 'full') {
      for (const revision of targets) {
        await yieldToAnalysisEvents(canContinue);
        replaceSegmentCandidatesForSource(revision, 'chromaprint', []);
        if (mode === 'chapter-only') {
          replaceSegmentCandidatesForSource(revision, 'aniskip', []);
          replaceSegmentCandidatesForSource(revision, 'theintrodb', []);
        } else {
          replaceSegmentCandidatesForSource(revision, 'chapter', []);
        }
        const segments = getResolvedMediaSegments(revision);
        record(revision, { kind: 'complete', response: { segments, revision: segmentRevision(segments) } });
      }
      return outcomes;
    }
    if (episodes.length < 3) {
      for (const revision of targets) {
        const target = episodes.find((episode) => episode.fileRevision === revision);
        if (!target) continue;
        await yieldToAnalysisEvents(canContinue);
        try {
          record(revision, await analyzeUnderpopulatedEpisode(mediaId, season, target, canContinue));
        } catch (error) {
          if (isAnalysisInterruptedError(error) || !canContinue()) throw new AnalysisInterruptedError();
          record(revision, {
            kind: 'error',
            detail: error instanceof Error ? error.message : 'Episode analysis failed.',
          });
        }
      }
      return outcomes;
    }
    await analyzeSeason(mediaId, season, targets, canContinue, onProgress, record);
    for (const revision of targets) {
      if (outcomes.has(revision)) continue;
      const segments = getResolvedMediaSegments(revision);
      record(revision, { kind: 'complete', response: { segments, revision: segmentRevision(segments) } });
    }
    return outcomes;
  }

  // Seasons with fewer than three usable episodes cannot use peer matching;
  // fall back to chapter markers plus the visual credits detector.
  async function analyzeUnderpopulatedEpisode(
    mediaId: string,
    season: number,
    target: AnalysisContext,
    shouldContinue: () => boolean,
  ): Promise<LocalAnalysisOutcome> {
    const fileRevision = target.fileRevision;
    if (!shouldContinue()) throw new AnalysisInterruptedError();
    const chapterCandidates: MediaSegmentCandidate[] = (target.file.localMetadata?.chapters || []).flatMap((chapter) => {
      const type = chapterType(chapter.title);
      if (!type || !settings().enabledTypes[type] || chapter.endMs <= chapter.startMs) return [];
      return [{
        id: hashId(target.fileRevision, 'chapter', type, chapter.startMs, chapter.endMs),
        mediaId, season, episode: target.file.episode, filePath: target.file.filePath,
        fileRevision: target.fileRevision, type, startMs: chapter.startMs, endMs: chapter.endMs,
        confidence: 0.98, source: 'chapter' as const, status: 'active' as const,
        mediaDurationMs: target.durationMs, updatedAt: new Date().toISOString(),
        analysisMetadata: { detector: 'chapter' as const, startSnap: 'chapter' as const, endSnap: 'chapter' as const },
      }];
    });
    if (!shouldContinue()) throw new AnalysisInterruptedError();
    replaceSegmentCandidatesForSource(fileRevision, 'chapter', chapterCandidates);
    const ffmpegPath = findFFmpeg();
    if (ffmpegPath && settings().enabledTypes.credits && shouldContinue()) {
      const limits = settings().durationLimits.credits;
      const visualCandidates = (await movieCreditIntervals(target, ffmpegPath, 5 * 60_000)).flatMap((interval) => {
        const endMs = interval.endMs ?? target.durationMs;
        const durationMs = endMs - interval.startMs;
        if (durationMs < limits.minSeconds * 1000 || durationMs > limits.maxSeconds * 1000) return [];
        return [{
          id: hashId(target.fileRevision, 'chromaprint', 'episode-visual-credits', interval.startMs, interval.endMs),
          mediaId, season, episode: target.file.episode, filePath: target.file.filePath,
          fileRevision: target.fileRevision, type: 'credits' as const, startMs: interval.startMs,
          endMs: interval.endMs, confidence: interval.confidence, source: 'chromaprint' as const,
          status: 'active' as const, mediaDurationMs: target.durationMs, updatedAt: new Date().toISOString(),
          analysisMetadata: { detector: 'blackframe' as const, originalStartMs: interval.startMs, originalEndMs: interval.endMs, startSnap: 'original' as const, endSnap: 'original' as const },
        }];
      });
      if (shouldContinue()) replaceSegmentCandidatesForSource(fileRevision, 'chromaprint', visualCandidates);
    }
    const segments = getResolvedMediaSegments(fileRevision);
    return {
      kind: 'waiting_for_peers',
      response: { segments, revision: segmentRevision(segments) },
      detail: 'Waiting for at least three usable episodes in this season.',
    };
  }

  async function analyzeMovie(
    mediaId: string,
    shouldContinue: () => boolean = () => !isPlaybackActivityActive(),
  ): Promise<MediaSegmentResponse> {
    if (!settings().enabled) throw new Error('Enable automatic local skip analysis in Playback settings first.');
    if (running) return running;
    const task = (async () => {
      const ffmpegPath = findFFmpeg();
      if (!ffmpegPath) throw new Error('FFmpeg was not found. Provider and chapter markers remain available.');
      const context = movieContext(mediaId);
      if (!context) throw new Error('That movie file is unavailable.');
      if (!settings().enabledTypes.credits) {
        if (!shouldContinue()) throw new AnalysisInterruptedError();
        replaceSegmentCandidatesForSource(context.fileRevision, 'chromaprint', []);
        const segments = getResolvedMediaSegments(context.fileRevision);
        return { segments, revision: segmentRevision(segments) };
      }
      const jobKey = `movie:${mediaId}:${context.fileRevision}:credits-v1`;
      saveSegmentAnalysisState(jobKey, mediaId, 0, 'running', 'Inspecting the final 15 minutes for movie credits');
      try {
        if (!shouldContinue()) throw new AnalysisInterruptedError();
        const limits = settings().durationLimits.movieCredits;
        const intervals = (await movieCreditIntervals(context, ffmpegPath)).filter((interval) => {
          const durationMs = (interval.endMs ?? context.durationMs) - interval.startMs;
          return durationMs >= limits.minSeconds * 1000 && durationMs <= limits.maxSeconds * 1000;
        });
        const candidates: MediaSegmentCandidate[] = [];
        for (const interval of intervals) {
          if (!shouldContinue()) throw new AnalysisInterruptedError();
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
            analysisMetadata: {
              detector: 'blackframe',
              originalStartMs: interval.startMs,
              originalEndMs: interval.endMs,
              startSnap: startMs === interval.startMs ? 'original' : 'silence',
              endSnap: 'original',
              confidenceComponents: { visual: interval.confidence },
            },
          });
        }
        if (!shouldContinue()) throw new AnalysisInterruptedError();
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
        const interrupted = isAnalysisInterruptedError(error) || !shouldContinue();
        const normalized = interrupted
          ? new AnalysisInterruptedError()
          : error instanceof Error ? error : new Error('Movie credits analysis failed.');
        saveSegmentAnalysisState(jobKey, mediaId, 0, interrupted ? 'queued' : 'error', normalized.message);
        throw normalized;
      }
    })();
    running = task;
    try { return await task; } finally { running = null; }
  }

  function status(): SegmentAnalysisStatus & { jobs: ReturnType<typeof getSegmentAnalysisStates> } {
    const helperPath = findFpcalc();
    const ffmpegPath = findFFmpeg();
    const enabled = deps.loadSettings().localSkipAnalysisEnabled !== false;
    const jobs = getSegmentAnalysisStates();
    const available = Boolean(helperPath && ffmpegPath);
    const missingHelpers = [!helperPath && 'fpcalc', !ffmpegPath && 'FFmpeg'].filter(Boolean).join(' and ');
    return {
      enabled,
      available,
      helperPath,
      state: running ? 'running' : !enabled ? 'disabled' : available ? 'idle' : 'unavailable',
      message: available ? undefined : `${missingHelpers} unavailable. Provider and chapter markers still work.`,
      jobs,
    };
  }

  return { analyze, analyzeMovie, analyzeRevision, analyzeSeasonBatch, status };
}
