import assert from 'node:assert/strict';
import test from 'node:test';

import {
  StremioAdapterError,
  createStremioAddonRegistry,
  normalizeStremioManifest,
} from '../src/stremio-adapter.mjs';

const manifest = {
  id: 'org.example.catalog',
  version: '1.0.0',
  name: 'Example catalog',
  description: 'A bounded test provider.',
  resources: ['catalog', { name: 'stream', types: ['movie'], idPrefixes: ['tt'] }],
  types: ['movie'],
  idPrefixes: ['tt'],
  catalogs: [{ type: 'movie', id: 'popular', name: 'Popular', extra: [{ name: 'search' }] }],
};

function jsonResponse(url, payload) {
  const text = JSON.stringify(payload);
  return {
    status: 200,
    url,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(text)) : null },
    text: async () => text,
  };
}

function registryFor(route) {
  return createStremioAddonRegistry({
    fetchImpl: async (url) => jsonResponse(url, route(url)),
    now: () => 1234,
  });
}

test('known Stremio Addons signature metadata is accepted and ignored', () => {
  const normalized = normalizeStremioManifest({
    ...manifest,
    stremioAddonsConfig: {
      issuer: 'https://stremio-addons.net',
      signature: 'opaque-signature',
    },
  }, 'https://catalog.example/manifest.json');

  assert.equal(normalized.id, manifest.id);
  assert.equal(normalized.compatibilityWarnings.some(({ code }) => code === 'stremio_addons_config_ignored'), true);
  assert.equal('stremioAddonsConfig' in normalized, false);
});

test('review is non-enabling and the current review token is required for approval', async () => {
  const registry = registryFor(() => manifest);
  const review = await registry.reviewManifestUrl('https://catalog.example/manifest.json');

  assert.equal(review.state, 'pending-review');
  assert.equal(review.trusted, false);
  assert.throws(
    () => registry.approve(review.addonId, { confirmed: true, reviewToken: 'stale-token' }),
    (error) => error instanceof StremioAdapterError && error.code === 'APPROVAL_REQUIRED',
  );
  const approved = registry.approve(review.addonId, { confirmed: true, reviewToken: review.reviewToken });
  assert.equal(approved.state, 'enabled');
  assert.equal(approved.trusted, true);
});

test('enabled catalogs use the declared Stremio route and normalized response shape', async () => {
  const requested = [];
  const registry = createStremioAddonRegistry({
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.endsWith('/manifest.json')) return jsonResponse(url, manifest);
      return jsonResponse(url, { metas: [{ id: 'tt123', type: 'movie', name: 'Movie', genres: ['Drama'] }] });
    },
  });
  const review = await registry.reviewManifestUrl('https://catalog.example/manifest.json');
  registry.approve(review.addonId, { confirmed: true, reviewToken: review.reviewToken });

  const result = await registry.fetchCatalog(review.addonId, {
    type: 'movie',
    catalogId: 'popular',
    extra: { search: 'Movie' },
  });

  assert.match(requested.at(-1), /\/catalog\/movie\/popular\/search=Movie\.json$/);
  assert.deepEqual(result.items.map(({ id, title }) => [id, title]), [['tt123', 'Movie']]);
});

test('torrent and peer-to-peer stream candidates are always returned as rejected', async () => {
  const registry = registryFor((url) => url.endsWith('/manifest.json')
    ? manifest
    : { streams: [{ name: 'Torrent source', infoHash: 'abc123', fileIdx: 0 }] });
  const review = await registry.reviewManifestUrl('https://catalog.example/manifest.json');
  registry.approve(review.addonId, { confirmed: true, reviewToken: review.reviewToken });

  const result = await registry.fetchStreams(review.addonId, { type: 'movie', videoId: 'tt123' });

  assert.equal(result.playableCount, 0);
  assert.equal(result.unsupportedPeerToPeerCount, 1);
  assert.equal(result.sources[0].reasonCode, 'P2P_UNSUPPORTED');
});

test('private, local, credentialed, and non-HTTPS manifests are rejected before fetch', async () => {
  const registry = registryFor(() => manifest);
  for (const url of [
    'http://catalog.example/manifest.json',
    'https://127.0.0.1/manifest.json',
    'https://localhost/manifest.json',
    'https://user:password@catalog.example/manifest.json',
  ]) {
    await assert.rejects(
      () => registry.reviewManifestUrl(url),
      (error) => error instanceof StremioAdapterError && error.code === 'UNSAFE_URL',
      url,
    );
  }
});

test('persisted enabled state reloads only with its explicit trust and approval record intact', async () => {
  const registry = registryFor(() => manifest);
  const review = await registry.reviewManifestUrl('https://catalog.example/manifest.json');
  registry.approve(review.addonId, { confirmed: true, reviewToken: review.reviewToken });

  const restored = createStremioAddonRegistry({ fetchImpl: async (url) => jsonResponse(url, manifest) });
  restored.loadPersistedState(registry.toJSON());

  assert.equal(restored.requireEnabledRecord(review.addonId).trusted, true);
  const invalid = structuredClone(registry.toJSON());
  invalid.addons[0].trusted = false;
  assert.throws(
    () => restored.loadPersistedState(invalid),
    (error) => error instanceof StremioAdapterError && error.code === 'INVALID_PERSISTED_STATE',
  );
});
