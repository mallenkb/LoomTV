import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchSkipDBSegments,
  skipDbLookupKey,
} from '../src/main/skipSegments/providers.ts';

const providerNetwork = {
  lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
  requestImpl: async (url: URL, init: RequestInit) => globalThis.fetch(url, init),
};

test('skipDbLookupKey is keyed on imdb id with season/episode or movie marker', () => {
  assert.equal(skipDbLookupKey({ imdbId: 'tt1234567' }, 1, 2), 'skipdb:imdb:tt1234567:s1:e2');
  assert.equal(skipDbLookupKey({ imdbId: 'tt1234567' }), 'skipdb:imdb:tt1234567:movie');
  assert.equal(skipDbLookupKey({}), null);
  assert.equal(skipDbLookupKey({ tmdbId: '1399' }, 1, 1), null);
});

test('SkipDB success maps all four types with fixed 0.90 confidence', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    match: 'exact',
    adjusted: true,
    offset_ms: 0,
    confidence: 0.95,
    duration_ms: 1_405_000,
    intro: { start_ms: 10_000, end_ms: 100_000 },
    recap: { start_ms: 0, end_ms: 45_000 },
    outro: { start_ms: 1_300_000, end_ms: 1_390_000 },
    preview: { start_ms: 1_390_000, end_ms: 1_400_000 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await fetchSkipDBSegments({
      ...providerNetwork,
      ids: { imdbId: 'tt1234567' },
      season: 1,
      episode: 2,
      durationMs: 1_400_000,
    });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') {
      assert.deepEqual(
        result.segments.map((segment) => segment.type).sort(),
        ['intro', 'outro', 'preview', 'recap'],
      );
      for (const segment of result.segments) {
        assert.equal(segment.source, 'skipdb');
        // Provider 0.9 baseline is optimistic: store as providerScore only,
        // normalize with fixed 0.90 so SkipDB never outranks verified markers.
        assert.equal(segment.confidence, 0.9);
      }
      assert.equal(result.segments.find((s) => s.type === 'intro')?.startMs, 10_000);
      assert.equal(result.segments.find((s) => s.type === 'intro')?.endMs, 100_000);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SkipDB movie path omits season and episode', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      match: 'fuzzy',
      adjusted: true,
      offset_ms: 0,
      confidence: 0.9,
      duration_ms: 8_300_000,
      intro: { start_ms: 0, end_ms: 119_000 },
      recap: null,
      outro: null,
      preview: null,
    }), { status: 200 });
  };
  try {
    const result = await fetchSkipDBSegments({
      ...providerNetwork,
      ids: { imdbId: 'tt0133093' },
      durationMs: 8_300_000,
    });
    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.get('imdb_id'), 'tt0133093');
    assert.equal(url.searchParams.has('season'), false);
    assert.equal(url.searchParams.has('episode'), false);
    assert.equal(url.searchParams.get('adjust'), 'none');
    assert.ok(url.searchParams.has('duration'));
    assert.equal(result.kind, 'success');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SkipDB duration mismatch returns empty', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    match: 'exact',
    adjusted: true,
    offset_ms: 0,
    duration_ms: 900_000,
    intro: { start_ms: 0, end_ms: 90_000 },
  }), { status: 200 });
  try {
    const result = await fetchSkipDBSegments({
      ...providerNetwork,
      ids: { imdbId: 'tt1234567' },
      season: 1,
      episode: 1,
      durationMs: 1_400_000,
    });
    assert.equal(result.kind, 'empty');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SkipDB 429 retries with Retry-After seconds', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '2' } });
  try {
    assert.deepEqual(
      await fetchSkipDBSegments({ ...providerNetwork, ids: { imdbId: 'tt1234567' }, season: 1, episode: 1, durationMs: 1_400_000 }),
      { kind: 'retry', retryAfterMs: 2000 },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SkipDB timeout and malformed JSON degrade to error', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    assert.equal(
      (await fetchSkipDBSegments({ ...providerNetwork, ids: { imdbId: 'tt1234567' }, season: 1, episode: 1, durationMs: 1_400_000 })).kind,
      'error',
    );
    globalThis.fetch = async () => new Response('{bad json', { status: 200 });
    assert.equal(
      (await fetchSkipDBSegments({ ...providerNetwork, ids: { imdbId: 'tt1234567' }, season: 1, episode: 1, durationMs: 1_400_000 })).kind,
      'error',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SkipDB unknown match enum fails closed', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    match: 'super-exact-plus',
    adjusted: true,
    offset_ms: 0,
    intro: { start_ms: 10_000, end_ms: 100_000 },
  }), { status: 200 });
  try {
    // Unknown alignment claims must never be trusted as timestamps.
    assert.equal(
      (await fetchSkipDBSegments({ ...providerNetwork, ids: { imdbId: 'tt1234567' }, season: 1, episode: 1, durationMs: 1_400_000 })).kind,
      'error',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SkipDB nonzero offset with adjusted false is preserved and never applied', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    match: 'exact',
    adjusted: false,
    offset_ms: 5000,
    confidence: 0.95,
    duration_ms: 1_400_000,
    intro: { start_ms: 10_000, end_ms: 100_000 },
    recap: null,
    outro: null,
    preview: null,
  }), { status: 200 });
  try {
    const result = await fetchSkipDBSegments({
      ...providerNetwork,
      ids: { imdbId: 'tt1234567' },
      season: 1,
      episode: 1,
      durationMs: 1_400_000,
    });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') {
      const intro = result.segments.find((segment) => segment.type === 'intro');
      // Never add offset_ms: original intervals are preserved verbatim.
      assert.equal(intro?.startMs, 10_000);
      assert.equal(intro?.endMs, 100_000);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SkipDB null per-type means unknown, never confirmed absent', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    match: 'fuzzy',
    adjusted: true,
    offset_ms: 0,
    duration_ms: 1_400_000,
    intro: { start_ms: 10_000, end_ms: 100_000 },
    recap: null,
    outro: null,
    preview: null,
  }), { status: 200 });
  try {
    const result = await fetchSkipDBSegments({
      ...providerNetwork,
      ids: { imdbId: 'tt1234567' },
      season: 1,
      episode: 1,
      durationMs: 1_400_000,
    });
    // Partial success: intro present, nulls skipped so the fallback chain can
    // query the next provider for missing enabled types.
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') {
      assert.equal(result.segments.length, 1);
      assert.equal(result.segments[0].type, 'intro');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
