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

test('legacy catalog extras normalize required fields and genres with modern precedence', () => {
  const catalog = { type: 'movie', id: 'legacy', name: 'Legacy', extraSupported: ['search', 'genre', 'search'], extraRequired: ['search', 'skip'], genres: ['Drama', 'Comedy'] };
  const normalize = (entry) => normalizeStremioManifest({ ...manifest, catalogs: [entry] }, 'https://catalog.example/manifest.json').catalogs[0].extra;
  assert.deepEqual(normalize(catalog), [
    { name: 'search', isRequired: true },
    { name: 'genre', isRequired: false, options: ['Drama', 'Comedy'] },
    { name: 'skip', isRequired: true },
  ]);
  assert.deepEqual(normalize({ type: 'movie', id: 'genres', name: 'Genres', genres: ['Drama'] }), [
    { name: 'genre', isRequired: false, options: ['Drama'] },
  ]);
  assert.deepEqual(normalize({ ...catalog, extra: [] }), []);
  assert.deepEqual(normalize({ ...catalog, extra: [{ name: 'genre', options: ['Modern'] }, { name: 'search', isRequired: false }] }), [
    { name: 'genre', isRequired: false, options: ['Modern'] },
    { name: 'search', isRequired: false },
  ]);
  assert.throws(() => normalize({ ...catalog, extraSupported: 'search' }), StremioAdapterError);
  assert.throws(() => normalize({ ...catalog, extraSupported: Array.from({ length: 32 }, (_, index) => `field${index}`) }), StremioAdapterError);
});

test('registry capacity is enforced before changing records and permits replacements', async () => {
  let nextManifest = manifest;
  const registry = registryFor(() => nextManifest);
  for (let index = 0; index < 64; index += 1) {
    nextManifest = { ...manifest, id: `org.example.addon${index}` };
    const review = await registry.reviewManifestUrl(`https://catalog.example/${index}/manifest.json`);
    registry.approve(review.addonId, { confirmed: true, reviewToken: review.reviewToken });
  }
  const before = registry.toJSON();
  const restored = createStremioAddonRegistry();
  restored.loadPersistedState(JSON.parse(JSON.stringify(before)));
  assert.deepEqual(restored.toJSON(), before);
  nextManifest = { ...manifest, id: 'org.example.overflow' };
  for (const url of ['https://catalog.example/overflow/manifest.json', 'https://catalog.example/0/manifest.json']) {
    await assert.rejects(() => registry.reviewManifestUrl(url), (error) => error instanceof StremioAdapterError
      && error.code === 'REGISTRY_CAPACITY_EXCEEDED' && error.retryable === false);
    assert.deepEqual(registry.toJSON(), before);
  }
  nextManifest = { ...manifest, id: 'org.example.addon0', version: '1.1.0' };
  const replacement = await registry.reviewManifestUrl('https://catalog.example/0/manifest.json');
  assert.equal(replacement.manifest.version, '1.1.0');
  assert.equal(replacement.state, 'pending-review');
  assert.equal(registry.list().length, 64);
  assert.notEqual(replacement.reviewToken, before.addons[0].reviewToken);
  registry.remove('org.example.addon1');
  nextManifest = { ...manifest, id: 'org.example.new' };
  await registry.reviewManifestUrl('https://catalog.example/new/manifest.json');
  restored.loadPersistedState(JSON.parse(JSON.stringify(registry.toJSON())));
  assert.equal(restored.list().length, 64);
});

test('concurrent manifest reviews cannot overfill the registry', async () => {
  const registry = registryFor((url) => ({ ...manifest, id: `org.example.addon${new URL(url).pathname.split('/')[1]}` }));
  const results = await Promise.allSettled(Array.from({ length: 65 }, (_, index) => registry.reviewManifestUrl(`https://catalog.example/${index}/manifest.json`)));
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 64);
  assert.equal(results.find(({ status }) => status === 'rejected').reason.code, 'REGISTRY_CAPACITY_EXCEEDED');
  assert.equal(registry.toJSON().addons.length, 64);
});

test('legacy extras survive registry persistence as modern declarations', async () => {
  const registry = registryFor(() => ({ ...manifest, catalogs: [{ type: 'movie', id: 'legacy', name: 'Legacy', extraSupported: ['search'], extraRequired: ['search'], genres: ['Drama'] }] }));
  const review = await registry.reviewManifestUrl('https://catalog.example/manifest.json');
  const restored = createStremioAddonRegistry();
  restored.loadPersistedState(JSON.parse(JSON.stringify(registry.toJSON())));
  assert.deepEqual(restored.get(review.addonId).manifest.catalogs, review.manifest.catalogs);
});

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
