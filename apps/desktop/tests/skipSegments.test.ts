import assert from 'node:assert/strict';
import test from 'node:test';
import { bestFingerprintMatch, scoreFingerprintMatches } from '../src/main/skipSegments/fingerprintMatcher.ts';
import {
  detectMovieCreditIntervals,
  MOVIE_CREDIT_FRAME_HEIGHT,
  MOVIE_CREDIT_FRAME_WIDTH,
} from '../src/main/skipSegments/movieCreditsDetector.ts';
import {
  chapterType,
  deduplicateProviderSegments,
  durationIsCompatible,
  normalizeSegment,
  resolveCandidates,
} from '../src/main/skipSegments/normalize.ts';
import { fetchAniSkipSegments, fetchTheIntroDbSegments, theIntroDbLookupKey } from '../src/main/skipSegments/providers.ts';
import type { MediaSegmentCandidate } from '../src/main/skipSegments/types.ts';

const providerNetwork = {
  lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
  requestImpl: async (url: URL, init: RequestInit) => globalThis.fetch(url, init),
};

function candidate(source: MediaSegmentCandidate['source'], confidence: number): MediaSegmentCandidate {
  return {
    id: source,
    mediaId: 'show', season: 1, episode: 1, filePath: '/episode.mkv', fileRevision: 'revision',
    type: 'intro', startMs: source === 'manual' ? 10_000 : 20_000, endMs: 90_000,
    confidence, source, status: 'active', mediaDurationMs: 1_400_000, updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('source precedence is deterministic and ignores cross-source confidence', () => {
  assert.equal(resolveCandidates([
    candidate('chromaprint', 0.999),
    candidate('theintrodb', 0.92),
    candidate('chapter', 0.10),
    candidate('manual', 0.01),
  ])[0].source, 'manual');
  assert.equal(resolveCandidates([candidate('theintrodb', 0.99), candidate('aniskip', 0.01)])[0].source, 'aniskip');
});

test('normalization rejects invalid intervals and incompatible durations', () => {
  assert.equal(normalizeSegment({ type: 'intro', startMs: -1, endMs: 20_000, confidence: 1, source: 'manual' }, 100_000), null);
  assert.equal(normalizeSegment({ type: 'intro', startMs: 20_000, endMs: 20_500, confidence: 1, source: 'manual' }, 100_000), null);
  assert.equal(durationIsCompatible(1_400_000, 1_420_000), true);
  assert.equal(durationIsCompatible(1_300_000, 1_420_000), false);
});

test('credits ending slightly past the local duration clamp to the file end', () => {
  // AniSkip ED intervals are submitted against releases whose runtime differs
  // from the local file by a few seconds (live example: ed end 1,421,210 ms
  // vs a 1,420,100 ms local file). The marker must clamp, not vanish.
  const clamped = normalizeSegment(
    { type: 'credits', startMs: 1_330_583, endMs: 1_421_210, confidence: 0.92, source: 'aniskip' },
    1_420_100,
  );
  assert.equal(clamped?.endMs, 1_420_100);
  assert.equal(clamped?.startMs, 1_330_583);
  // Beyond the shared duration tolerance the interval is still rejected.
  assert.equal(normalizeSegment(
    { type: 'credits', startMs: 1_330_583, endMs: 1_460_000, confidence: 0.92, source: 'aniskip' },
    1_420_100,
  ), null);
});

test('chapter labels are anchored and generic names are ignored', () => {
  assert.equal(chapterType(' Opening '), 'intro');
  assert.equal(chapterType('Previously On'), 'recap');
  assert.equal(chapterType('Opening scene'), null);
  assert.equal(chapterType('Chapter 1'), null);
});

test('same-source overlaps deduplicate while conflicting intervals are rejected', () => {
  const base = { type: 'intro' as const, source: 'theintrodb' as const, confidence: 0.92 };
  assert.equal(deduplicateProviderSegments([
    { ...base, startMs: 10_000, endMs: 90_000 },
    { ...base, startMs: 12_000, endMs: 88_000 },
  ], 1_000_000).length, 1);
  assert.equal(deduplicateProviderSegments([
    { ...base, startMs: 10_000, endMs: 90_000 },
    { ...base, startMs: 300_000, endMs: 390_000 },
  ], 1_000_000).length, 0);
});

test('disjoint movie credits survive provider normalization and source resolution', () => {
  const base = { type: 'credits' as const, source: 'theintrodb' as const, confidence: 0.92 };
  const normalized = deduplicateProviderSegments([
    { ...base, startMs: 6_000_000, endMs: 6_180_000 },
    { ...base, startMs: 6_000_500, endMs: 6_180_000 },
    { ...base, startMs: 6_240_000, endMs: null },
  ], 6_600_000);
  assert.equal(normalized.length, 2);
  const candidates = normalized.map((segment, index): MediaSegmentCandidate => ({
    ...segment,
    id: `credits-${index}`,
    mediaId: 'movie', season: 0, episode: 0, filePath: '/movie.mkv', fileRevision: 'movie-revision',
    status: 'active', mediaDurationMs: 6_600_000, updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  assert.deepEqual(resolveCandidates(candidates).map((segment) => segment.startMs), [6_000_000, 6_240_000]);
});

test('TheIntroDB normalization handles open credits and duration mismatch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    tmdb_id: 1399,
    intro: [{ start_ms: 20_000, end_ms: 110_000 }],
    credits: [{ start_ms: 1_300_000, end_ms: null }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await fetchTheIntroDbSegments({ ...providerNetwork, ids: { tmdbId: '1399' }, season: 1, episode: 1, durationMs: 1_400_000 });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') assert.equal(result.segments.find((segment) => segment.type === 'credits')?.endMs, null);

    globalThis.fetch = async () => new Response(JSON.stringify({ duration_ms: 900_000, intro: [{ start_ms: 0, end_ms: 90_000 }] }), { status: 200 });
    assert.equal((await fetchTheIntroDbSegments({ ...providerNetwork, ids: { tmdbId: '1399' }, season: 1, episode: 1, durationMs: 1_400_000 })).kind, 'empty');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TheIntroDB movie lookup omits episode coordinates and preserves movie segments', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      tmdb_id: 550,
      type: 'movie',
      intro: [{ start_ms: null, end_ms: 119_000 }],
      credits: [
        { start_ms: 8_000_000, end_ms: 8_100_000 },
        { start_ms: 8_160_000, end_ms: null },
      ],
    }), { status: 200 });
  };
  try {
    assert.equal(theIntroDbLookupKey({ tmdbId: '550' }), 'tmdb:550:movie');
    const result = await fetchTheIntroDbSegments({ ...providerNetwork, ids: { tmdbId: '550' }, durationMs: 8_300_000 });
    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.has('season'), false);
    assert.equal(url.searchParams.has('episode'), false);
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') {
      assert.equal(result.segments.filter((segment) => segment.type === 'credits').length, 2);
      assert.equal(result.segments.find((segment) => segment.type === 'intro')?.startMs, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AniSkip maps OP, ED, mixed markers, recap, and Retry-After', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ found: true, results: [
    { skipType: 'mixed-op', interval: { startTime: 10, endTime: 100 }, episodeLength: 1400 },
    { skipType: 'ed', interval: { startTime: 1300, endTime: 1390 }, episodeLength: 1400 },
    { skipType: 'recap', interval: { startTime: 0, endTime: 45 }, episodeLength: 1400 },
  ] }), { status: 200 });
  try {
    const result = await fetchAniSkipSegments({ ...providerNetwork, malId: '1', episode: 1, durationMs: 1_400_000 });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') assert.deepEqual(result.segments.map((segment) => segment.type), ['recap', 'intro', 'outro']);
    globalThis.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '2' } });
    assert.deepEqual(await fetchAniSkipSegments({ ...providerNetwork, malId: '1', episode: 1, durationMs: 1_400_000 }), { kind: 'retry', retryAfterMs: 2000 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider timeout and malformed JSON degrade without a player error', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    assert.equal((await fetchAniSkipSegments({ ...providerNetwork, malId: '1', episode: 1, durationMs: 1_400_000 })).kind, 'error');
    globalThis.fetch = async () => new Response('{bad json', { status: 200 });
    assert.equal((await fetchTheIntroDbSegments({ ...providerNetwork, ids: { tmdbId: '1' }, season: 1, episode: 1, durationMs: 1_400_000 })).kind, 'error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bounded fingerprint alignment detects repeated windows and scores support', () => {
  let seed = 12345;
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  const repeated = Array.from({ length: 300 }, next);
  const target = { frames: repeated, durationMs: 30_000, windowStartMs: 0 };
  const other = { frames: [...Array.from({ length: 20 }, next), ...repeated], durationMs: 32_000, windowStartMs: 0 };
  const match = bestFingerprintMatch(target, other, { minDurationMs: 15_000, maxDurationMs: 180_000, minSimilarity: 0.85 });
  assert.ok(match);
  if (!match) throw new Error('Expected a fingerprint match.');
  assert.ok(match.similarity >= 0.99);
  assert.ok(scoreFingerprintMatches([match, match, match, match]) >= 0.90);
});

test('recap and preview matching can exclude an already-classified intro or credits interval', () => {
  const repeated = Array.from({ length: 300 }, (_, index) => (index * 2654435761) >>> 0);
  const target = { frames: repeated, durationMs: 30_000, windowStartMs: 0 };
  const other = { frames: repeated, durationMs: 30_000, windowStartMs: 0 };
  const excluded = bestFingerprintMatch(target, other, {
    minDurationMs: 15_000,
    maxDurationMs: 120_000,
    minSimilarity: 0.85,
    excludeLeft: [{ startMs: 0, endMs: 30_000 }],
  });
  assert.equal(excluded, null);
});

function movieFrame(kind: 'credits' | 'scene', variation = 0): Uint8Array {
  const width = MOVIE_CREDIT_FRAME_WIDTH;
  const height = MOVIE_CREDIT_FRAME_HEIGHT;
  const frame = new Uint8Array(width * height);
  if (kind === 'scene') {
    for (let index = 0; index < frame.length; index += 1) frame[index] = 70 + ((index * 17 + variation * 29) % 150);
    return frame;
  }
  frame.fill(10);
  for (let y = 8; y < height - 6; y += 7) {
    for (let x = 28 + (y % 3); x < width - 28; x += 5) frame[y * width + x] = 235;
  }
  return frame;
}

test('bounded movie detector preserves a post-credit scene between two credits intervals', () => {
  const frames = [
    ...Array.from({ length: 100 }, () => movieFrame('credits')),
    ...Array.from({ length: 20 }, (_, index) => movieFrame('scene', index)),
    ...Array.from({ length: 55 }, () => movieFrame('credits')),
  ];
  const detected = detectMovieCreditIntervals(Buffer.concat(frames.map((frame) => Buffer.from(frame))), 0, 175_000);
  assert.equal(detected.length, 2);
  const firstEndMs = detected[0]?.endMs;
  const secondStartMs = detected[1]?.startMs;
  assert.ok(firstEndMs !== null && firstEndMs !== undefined && secondStartMs !== undefined && firstEndMs < secondStartMs);
  assert.equal(detected[1].endMs, null);
  assert.ok(detected.every((interval) => interval.confidence >= 0.90));
});

test('movie detector refuses ordinary ending footage without sustained credit evidence', () => {
  const frames = Array.from({ length: 120 }, (_, index) => movieFrame('scene', index));
  assert.deepEqual(detectMovieCreditIntervals(Buffer.concat(frames.map((frame) => Buffer.from(frame))), 0, 120_000), []);
});
