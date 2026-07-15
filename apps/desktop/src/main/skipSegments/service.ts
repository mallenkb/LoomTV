import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  deleteManualSegmentCandidate,
  getManualSegmentCandidates,
  getResolvedMediaSegments,
  getSegmentCandidates,
  getSegmentSourceCache,
  markManualSegmentCandidateForReview,
  reassociateManualSegmentCandidate,
  replaceSegmentCandidatesForSource,
  saveManualSegmentCandidate,
  saveSegmentSourceCache,
  undoManualSegmentCandidate,
} from '../database';
import type { MetadataProviderIds } from '../mediaTags';
import type { EpisodeFile, MediaItem } from '../metadata/types';
import type { ProbeMediaFileResult } from '../mediaProbeFile';
import { chapterType, normalizeSegment, segmentRevision } from './normalize';
import {
  aniSkipLookupKey,
  fetchAniSkipSegments,
  fetchTheIntroDbSegments,
  theIntroDbLookupKey,
  type ProviderLookupResult,
} from './providers';
import type {
  ManualMediaSegmentInput,
  MediaSegment,
  MediaSegmentCandidate,
  MediaSegmentRequest,
  MediaSegmentResponse,
  MediaSegmentSource,
  NormalizedSegmentInput,
  ProviderCacheEntry,
} from './types';

type LibraryLike = {
  movies?: MediaItem[];
  tvShows?: MediaItem[];
  animeShows?: MediaItem[];
};

type SegmentContext = {
  item: MediaItem;
  episodeFile: EpisodeFile;
  mediaId: string;
  season: number;
  episode: number;
  filePath: string;
  fileRevision: string;
  durationMs: number;
  providerIds: MetadataProviderIds;
  probe: ProbeMediaFileResult;
};

const POSITIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 12 * 60 * 60 * 1000;
const STALE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const RELEASE_HASH_BYTES = 64 * 1024;

const inFlight = new Map<string, Promise<ProviderLookupResult>>();
const providerQueues: Record<ProviderCacheEntry['provider'], Promise<void>> = {
  theintrodb: Promise.resolve(),
  aniskip: Promise.resolve(),
};
const providerBlockedUntil: Record<ProviderCacheEntry['provider'], number> = {
  theintrodb: 0,
  aniskip: 0,
};

function hashId(...values: Array<string | number | null | undefined>): string {
  return createHash('sha256').update(values.map((value) => String(value ?? '')).join('|')).digest('hex').slice(0, 24);
}

function defaultAudioTrack(item: EpisodeFile): number {
  const audio = item.localMetadata?.tracks?.find((track) => track.type === 'audio' && track.default)
    || item.localMetadata?.tracks?.find((track) => track.type === 'audio');
  return audio?.index ?? 0;
}

function defaultAudioLanguage(item: EpisodeFile): string {
  const audio = item.localMetadata?.tracks?.find((track) => track.type === 'audio' && track.default)
    || item.localMetadata?.tracks?.find((track) => track.type === 'audio');
  return audio?.language || 'und';
}

function fileRevision(
  filePath: string,
  durationMs: number,
  audioTrack: number,
  known?: { fileSize?: number; modifiedAtMs?: number },
): string {
  const stats = typeof known?.fileSize === 'number' && typeof known.modifiedAtMs === 'number' ? null : fs.statSync(filePath);
  return hashId(
    path.resolve(filePath),
    known?.fileSize ?? stats?.size,
    Math.round(known?.modifiedAtMs ?? stats?.mtimeMs ?? 0),
    Math.round(durationMs),
    audioTrack,
  );
}

function releaseKey(filePath: string, durationMs: number, audioTrack: number, audioLanguage: string): string {
  const stats = fs.statSync(filePath);
  const length = Math.min(RELEASE_HASH_BYTES, stats.size);
  const first = Buffer.alloc(length);
  const last = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, first, 0, length, 0);
    fs.readSync(fd, last, 0, length, Math.max(0, stats.size - length));
  } finally {
    fs.closeSync(fd);
  }
  return createHash('sha256')
    .update(String(stats.size))
    .update(String(Math.round(durationMs)))
    .update(String(audioTrack))
    .update(audioLanguage)
    .update(first)
    .update(last)
    .digest('hex');
}

function durationBucket(durationMs: number): number {
  return Math.max(1, Math.round(durationMs / 5000));
}

function providerIdsForSeason(ids: MetadataProviderIds | undefined, season: number): MetadataProviderIds {
  const malId = ids?.malIdBySeason?.[String(season)] || ids?.malId;
  return { ...(ids || {}), ...(malId ? { malId } : {}) };
}

function findItem(library: LibraryLike, mediaId: string): MediaItem | null {
  return [...(library.tvShows || []), ...(library.animeShows || []), ...(library.movies || [])]
    .find((item) => item.id === mediaId) || null;
}

function makeCandidate(
  context: SegmentContext,
  segment: NormalizedSegmentInput,
  options: { releaseKey?: string; expiresAt?: number; status?: MediaSegmentCandidate['status'] } = {},
): MediaSegmentCandidate {
  const now = new Date().toISOString();
  return {
    id: hashId(context.fileRevision, segment.source, segment.type, segment.startMs, segment.endMs),
    mediaId: context.mediaId,
    season: context.season,
    episode: context.episode,
    filePath: context.filePath,
    fileRevision: context.fileRevision,
    releaseKey: options.releaseKey,
    type: segment.type,
    startMs: segment.startMs,
    endMs: segment.endMs,
    confidence: segment.confidence,
    source: segment.source,
    status: options.status || 'active',
    mediaDurationMs: context.durationMs,
    updatedAt: now,
    expiresAt: options.expiresAt,
  };
}

async function queuedLookup(
  provider: ProviderCacheEntry['provider'],
  key: string,
  run: () => Promise<ProviderLookupResult>,
): Promise<ProviderLookupResult> {
  const flightKey = `${provider}:${key}`;
  const existing = inFlight.get(flightKey);
  if (existing) return existing;

  let releaseQueue: () => void = () => undefined;
  const previous = providerQueues[provider];
  providerQueues[provider] = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const promise = (async () => {
    await previous.catch(() => undefined);
    const wait = providerBlockedUntil[provider] - Date.now();
    if (wait > 0) return { kind: 'retry', retryAfterMs: wait } as ProviderLookupResult;
    const result = await run();
    if (result.kind === 'retry' && result.retryAfterMs) {
      providerBlockedUntil[provider] = Date.now() + result.retryAfterMs;
    }
    return result;
  })().finally(() => {
    releaseQueue();
    inFlight.delete(flightKey);
  });
  inFlight.set(flightKey, promise);
  return promise;
}

export function createSkipSegmentService(deps: {
  loadLibrary: () => LibraryLike;
  probeMediaFile: (filePath: string) => ProbeMediaFileResult;
}) {
  let warmGeneration = 0;

  function contextFor(request: MediaSegmentRequest): SegmentContext | null {
    const item = findItem(deps.loadLibrary(), String(request.mediaId || ''));
    if (!item) return null;
    if (item.type === 'movie') {
      if (!item.filePath || !fs.existsSync(item.filePath)) return null;
      const episodeFile: EpisodeFile = {
        season: 0,
        episode: 0,
        filePath: item.filePath,
        subtitles: item.subtitles,
        localMetadata: item.localMetadata,
      };
      const probe = item.localMetadata
        ? { localMetadata: item.localMetadata }
        : deps.probeMediaFile(item.filePath);
      const durationSeconds = item.localMetadata?.durationSeconds || probe.localMetadata?.durationSeconds || 0;
      if (!durationSeconds) return null;
      const durationMs = Math.round(durationSeconds * 1000);
      const audioTrack = defaultAudioTrack(episodeFile);
      return {
        item,
        episodeFile,
        mediaId: item.id,
        season: 0,
        episode: 0,
        filePath: item.filePath,
        fileRevision: fileRevision(item.filePath, durationMs, audioTrack, item.localMetadata),
        durationMs,
        providerIds: item.providerIds || {},
        probe,
      };
    }
    const sorted = (item.episodeFiles || []).slice().sort((a, b) => a.season - b.season || a.episode - b.episode);
    const episodeFile = sorted.find((file) =>
      (request.season === undefined || file.season === Number(request.season))
      && (request.episode === undefined || file.episode === Number(request.episode)),
    );
    if (!episodeFile || !fs.existsSync(episodeFile.filePath)) return null;
    const probe = episodeFile.localMetadata
      ? { localMetadata: episodeFile.localMetadata }
      : deps.probeMediaFile(episodeFile.filePath);
    const durationSeconds = episodeFile.localMetadata?.durationSeconds || probe.localMetadata?.durationSeconds || 0;
    if (!durationSeconds) return null;
    const durationMs = Math.round(durationSeconds * 1000);
    const audioTrack = defaultAudioTrack(episodeFile);
    return {
      item,
      episodeFile,
      mediaId: item.id,
      season: episodeFile.season,
      episode: episodeFile.episode,
      filePath: episodeFile.filePath,
      fileRevision: fileRevision(episodeFile.filePath, durationMs, audioTrack, episodeFile.localMetadata),
      durationMs,
      providerIds: providerIdsForSeason(item.providerIds, episodeFile.season),
      probe,
    };
  }

  function syncChapters(context: SegmentContext): void {
    const candidates = (context.probe.localMetadata?.chapters || []).flatMap((chapter) => {
      const type = chapterType(chapter.title);
      if (!type) return [];
      const normalized = normalizeSegment({
        type,
        startMs: chapter.startMs,
        endMs: chapter.endMs,
        source: 'chapter',
        confidence: 0.98,
      }, context.durationMs);
      return normalized ? [makeCandidate(context, normalized)] : [];
    });
    replaceSegmentCandidatesForSource(context.fileRevision, 'chapter', candidates);
  }

  function reassociateManualIfNeeded(context: SegmentContext): void {
    if (getSegmentCandidates(context.fileRevision).some((candidate) => candidate.source === 'manual')) return;
    const manual = getManualSegmentCandidates(context.mediaId, context.season, context.episode);
    if (!manual.length) return;
    const currentReleaseKey = releaseKey(
      context.filePath,
      context.durationMs,
      defaultAudioTrack(context.episodeFile),
      defaultAudioLanguage(context.episodeFile),
    );
    for (const candidate of manual) {
      if (candidate.releaseKey && candidate.releaseKey === currentReleaseKey) {
        reassociateManualSegmentCandidate(candidate.id, context.fileRevision, context.filePath);
      } else {
        markManualSegmentCandidateForReview(candidate.id);
      }
    }
  }

  function applyProviderSegments(
    context: SegmentContext,
    source: Extract<MediaSegmentSource, 'theintrodb' | 'aniskip'>,
    segments: NormalizedSegmentInput[],
  ): MediaSegment[] {
    const fresh = segments.map((segment) => makeCandidate(context, segment));
    const refreshedTypes = new Set(fresh.map((segment) => segment.type));
    const lastKnown = getSegmentCandidates(context.fileRevision)
      .filter((candidate) => candidate.source === source && !refreshedTypes.has(candidate.type))
      .map((candidate) => ({ ...candidate, expiresAt: undefined }));

    // Provider responses can occasionally be partial. Replace the types they
    // returned, but retain a previously verified timestamp for omitted types.
    // The file revision remains the invalidation boundary for these markers.
    return replaceSegmentCandidatesForSource(
      context.fileRevision,
      source,
      [...lastKnown, ...fresh],
    );
  }

  async function providerSegments(
    context: SegmentContext,
    provider: ProviderCacheEntry['provider'],
    waitForRefresh = false,
  ): Promise<{ segments: MediaSegment[]; kind: ProviderLookupResult['kind'] }> {
    const lookupKey = provider === 'aniskip'
      ? aniSkipLookupKey(context.providerIds.malId, context.episode)
      : context.item.type === 'movie'
        ? theIntroDbLookupKey(context.providerIds)
        : theIntroDbLookupKey(context.providerIds, context.season, context.episode);
    if (!lookupKey) return { segments: getResolvedMediaSegments(context.fileRevision), kind: 'empty' };
    const bucket = durationBucket(context.durationMs);
    const cached = getSegmentSourceCache(provider, lookupKey, bucket);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return {
        segments: cached.status === 'success'
          ? applyProviderSegments(context, provider, cached.segments)
          : getResolvedMediaSegments(context.fileRevision),
        kind: cached.status === 'success' ? 'success' : 'empty',
      };
    }
    if (cached?.status === 'success' && cached.staleUntil > now) {
      const staleSegments = applyProviderSegments(context, provider, cached.segments);
      void refreshProvider(context, provider, lookupKey, bucket);
      return { segments: staleSegments, kind: 'success' };
    }
    if (waitForRefresh) {
      const result = await refreshProvider(context, provider, lookupKey, bucket);
      return { segments: getResolvedMediaSegments(context.fileRevision), kind: result.kind };
    }
    void refreshProvider(context, provider, lookupKey, bucket).catch((error) => {
      console.warn(`[skip-segments] ${provider} refresh failed:`, error);
    });
    return { segments: getResolvedMediaSegments(context.fileRevision), kind: cached?.status || 'retry' };
  }

  async function refreshProvider(
    context: SegmentContext,
    provider: ProviderCacheEntry['provider'],
    lookupKey: string,
    bucket: number,
  ): Promise<ProviderLookupResult> {
    const result = await queuedLookup(provider, `${lookupKey}:${bucket}`, () => provider === 'aniskip'
      ? fetchAniSkipSegments({
        malId: context.providerIds.malId,
        episode: context.episode,
        durationMs: context.durationMs,
      })
      : fetchTheIntroDbSegments({
        ids: context.providerIds,
        ...(context.item.type === 'movie' ? {} : { season: context.season, episode: context.episode }),
        durationMs: context.durationMs,
      }));
    if (result.kind !== 'success' && result.kind !== 'empty') return result;
    const now = Date.now();
    const expiresAt = now + (result.kind === 'success' ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS);
    const staleUntil = result.kind === 'success' ? now + STALE_TTL_MS : expiresAt;
    saveSegmentSourceCache({
      provider,
      lookupKey,
      durationBucket: bucket,
      status: result.kind,
      segments: result.segments,
      fetchedAt: now,
      expiresAt,
      staleUntil,
    });
    // An empty refresh is not strong enough evidence to erase a timestamp that
    // already worked for this exact file. A later successful response can still
    // replace it, and a changed file naturally receives a new file revision.
    if (result.kind === 'success') applyProviderSegments(context, provider, result.segments);
    return result;
  }

  async function resolveSegments(
    request: MediaSegmentRequest,
    prefetchAdjacent: boolean,
    waitForProvider = false,
  ): Promise<MediaSegmentResponse> {
    const context = contextFor(request);
    if (!context) return { segments: [], revision: segmentRevision([]) };
    syncChapters(context);
    reassociateManualIfNeeded(context);
    let segments = getResolvedMediaSegments(context.fileRevision);
    if (context.item.type === 'anime') {
      const aniSkip = await providerSegments(context, 'aniskip', waitForProvider);
      segments = aniSkip.segments;
      const aniSkipTypes = new Set(segments.map((segment) => segment.type));
      // AniSkip frequently has an opening without an ending (or vice versa).
      // Let TheIntroDB fill whichever primary marker is missing; source
      // precedence still keeps AniSkip for any type it did return.
      if (aniSkip.kind !== 'success' || !aniSkipTypes.has('intro') || !aniSkipTypes.has('credits')) {
        segments = (await providerSegments(context, 'theintrodb', waitForProvider)).segments;
      }
    } else {
      segments = (await providerSegments(context, 'theintrodb', waitForProvider)).segments;
    }
    if (prefetchAdjacent) {
      const ordered = (context.item.episodeFiles || []).slice().sort((a, b) => a.season - b.season || a.episode - b.episode);
      const currentIndex = ordered.findIndex((file) => file.filePath === context.filePath);
      const upcoming = currentIndex >= 0 ? ordered.slice(currentIndex + 1, currentIndex + 3) : [];
      upcoming.forEach((file, index) => {
        const timer = setTimeout(() => {
          void resolveSegments({ mediaId: context.mediaId, season: file.season, episode: file.episode }, false)
            .catch(() => undefined);
        }, 100 + index * 150);
        timer.unref?.();
      });
    }
    return { segments, revision: segmentRevision(segments) };
  }

  // Active playback waits for the bounded provider lookup so the response that
  // reaches the player already contains timestamps committed to SQLite.
  const getSegments = (request: MediaSegmentRequest) => resolveSegments(request, true, true);

  function warmLibrary(library: LibraryLike = deps.loadLibrary()): void {
    const generation = ++warmGeneration;
    const requests: MediaSegmentRequest[] = [
      ...(library.movies || []).map((item) => ({ mediaId: item.id })),
      ...[...(library.tvShows || []), ...(library.animeShows || [])].flatMap((item) =>
        (item.episodeFiles || []).map((file) => ({ mediaId: item.id, season: file.season, episode: file.episode }))),
    ];
    const timer = setTimeout(() => {
      void (async () => {
        for (const request of requests) {
          if (generation !== warmGeneration) return;
          await resolveSegments(request, false, true).catch(() => undefined);
          await new Promise<void>((resolve) => {
            const pause = setTimeout(resolve, 100);
            pause.unref?.();
          });
        }
      })();
    }, 250);
    timer.unref?.();
  }

  function saveManualSegment(input: ManualMediaSegmentInput): MediaSegmentResponse {
    const context = contextFor(input);
    if (!context) throw new Error('That media file is unavailable.');
    const normalized = normalizeSegment({
      type: input.type,
      startMs: input.startMs,
      endMs: input.endMs,
      source: 'manual',
      confidence: 1,
    }, context.durationMs);
    if (!normalized) throw new Error('The manual marker timestamps are invalid.');
    const candidate = makeCandidate(context, normalized, {
      releaseKey: releaseKey(
        context.filePath,
        context.durationMs,
        defaultAudioTrack(context.episodeFile),
        defaultAudioLanguage(context.episodeFile),
      ),
    });
    const segments = saveManualSegmentCandidate(candidate);
    return { segments, revision: segmentRevision(segments) };
  }

  function deleteManualSegment(input: MediaSegmentRequest & { type: ManualMediaSegmentInput['type'] }): MediaSegmentResponse {
    const context = contextFor(input);
    if (!context) throw new Error('That episode file is unavailable.');
    deleteManualSegmentCandidate(context.fileRevision, input.type);
    const segments = getResolvedMediaSegments(context.fileRevision);
    return { segments, revision: segmentRevision(segments) };
  }

  function undoManualSegment(input: MediaSegmentRequest & { type: ManualMediaSegmentInput['type'] }): MediaSegmentResponse {
    const context = contextFor(input);
    if (!context) throw new Error('That episode file is unavailable.');
    const segments = undoManualSegmentCandidate(context.fileRevision, input.type);
    return { segments, revision: segmentRevision(segments) };
  }

  return { getSegments, warmLibrary, saveManualSegment, deleteManualSegment, undoManualSegment };
}

export type SkipSegmentService = ReturnType<typeof createSkipSegmentService>;
