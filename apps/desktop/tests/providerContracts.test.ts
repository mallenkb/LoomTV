import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchAniSkipSegments,
  fetchTheIntroDbSegments,
} from '../src/main/skipSegments/providers.ts';

const providerNetwork = {
  lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
  requestImpl: async (url: URL, init: RequestInit) => globalThis.fetch(url, init),
};

test('contract: TheIntroDB open credits preserve endMs null', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    tmdb_id: 1399,
    intro: [{ start_ms: 20_000, end_ms: 110_000 }],
    credits: [{ start_ms: 1_300_000, end_ms: null }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await fetchTheIntroDbSegments({
      ...providerNetwork,
      ids: { tmdbId: '1399' },
      season: 1,
      episode: 1,
      durationMs: 1_400_000,
    });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') {
      assert.equal(result.segments.find((segment) => segment.type === 'credits')?.endMs, null);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('contract: AniSkip ED maps to outro, never credits', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    found: true,
    results: [
      { skipType: 'ed', interval: { startTime: 1300, endTime: 1390 }, episodeLength: 1400 },
    ],
  }), { status: 200 });
  try {
    const result = await fetchAniSkipSegments({ ...providerNetwork, malId: '1', episode: 1, durationMs: 1_400_000 });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') {
      assert.deepEqual(result.segments.map((segment) => segment.type), ['outro']);
      assert.ok(result.segments.every((segment) => segment.type !== 'credits'));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('contract: AniSkip mixed-op maps to intro', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    found: true,
    results: [
      { skipType: 'mixed-op', interval: { startTime: 10, endTime: 100 }, episodeLength: 1400 },
      { skipType: 'mixed-ed', interval: { startTime: 1300, endTime: 1390 }, episodeLength: 1400 },
      { skipType: 'recap', interval: { startTime: 0, endTime: 45 }, episodeLength: 1400 },
    ],
  }), { status: 200 });
  try {
    const result = await fetchAniSkipSegments({ ...providerNetwork, malId: '1', episode: 1, durationMs: 1_400_000 });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') {
      assert.deepEqual(result.segments.map((segment) => segment.type), ['recap', 'intro', 'outro']);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('contract: provider timeout degrades without a player error', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    assert.equal(
      (await fetchAniSkipSegments({ ...providerNetwork, malId: '1', episode: 1, durationMs: 1_400_000 })).kind,
      'error',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
