import assert from 'node:assert/strict';
import test from 'node:test';
import { bestFingerprintMatch, scoreFingerprintMatches } from '../src/main/skipSegments/fingerprintMatcher.ts';
import {
  chapterType,
  deduplicateProviderSegments,
  durationIsCompatible,
  normalizeSegment,
  resolveCandidates,
} from '../src/main/skipSegments/normalize.ts';
import { fetchAniSkipSegments, fetchTheIntroDbSegments } from '../src/main/skipSegments/providers.ts';
import type { MediaSegmentCandidate } from '../src/main/skipSegments/types.ts';

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

test('TheIntroDB normalization handles open credits and duration mismatch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    tmdb_id: 1399,
    intro: [{ start_ms: 20_000, end_ms: 110_000 }],
    credits: [{ start_ms: 1_300_000, end_ms: null }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await fetchTheIntroDbSegments({ ids: { tmdbId: '1399' }, season: 1, episode: 1, durationMs: 1_400_000 });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') assert.equal(result.segments.find((segment) => segment.type === 'credits')?.endMs, null);

    globalThis.fetch = async () => new Response(JSON.stringify({ duration_ms: 900_000, intro: [{ start_ms: 0, end_ms: 90_000 }] }), { status: 200 });
    assert.equal((await fetchTheIntroDbSegments({ ids: { tmdbId: '1399' }, season: 1, episode: 1, durationMs: 1_400_000 })).kind, 'empty');
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
    const result = await fetchAniSkipSegments({ malId: '1', episode: 1, durationMs: 1_400_000 });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') assert.deepEqual(result.segments.map((segment) => segment.type), ['recap', 'intro', 'credits']);
    globalThis.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '2' } });
    assert.deepEqual(await fetchAniSkipSegments({ malId: '1', episode: 1, durationMs: 1_400_000 }), { kind: 'retry', retryAfterMs: 2000 });
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
    assert.equal((await fetchAniSkipSegments({ malId: '1', episode: 1, durationMs: 1_400_000 })).kind, 'error');
    globalThis.fetch = async () => new Response('{bad json', { status: 200 });
    assert.equal((await fetchTheIntroDbSegments({ ids: { tmdbId: '1' }, season: 1, episode: 1, durationMs: 1_400_000 })).kind, 'error');
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
  assert.ok((match?.similarity || 0) >= 0.99);
  assert.ok(scoreFingerprintMatches([match!, match!, match!, match!]) >= 0.90);
});
