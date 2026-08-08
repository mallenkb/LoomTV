import assert from 'node:assert/strict';
import test from 'node:test';
import { StremioAdapterError, createStremioAddonRegistry } from '../src/stremio-adapter.mjs';

const manifest = {
  id: 'org.example.configured',
  version: '1.0.0',
  name: 'Configured provider',
  description: 'Configuration lifecycle fixture.',
  resources: ['catalog'],
  types: ['movie'],
  catalogs: [{ type: 'movie', id: 'popular', name: 'Popular', extra: [] }],
  config: [{ key: 'apiKey', type: 'password', required: true }],
};

test('configuration callbacks gate approval and provider requests without exposing values', async () => {
  let configured = false;
  const registry = createStremioAddonRegistry({
    isAddonConfigured: () => configured,
    getConfiguration: () => ({ apiKey: 'host-only' }),
    fetchImpl: async (url) => ({
      status: 200,
      url,
      headers: { get: () => null },
      text: async () => url.endsWith('/manifest.json') ? JSON.stringify(manifest) : JSON.stringify({ metas: [] }),
    }),
  });
  const review = await registry.reviewManifestUrl('https://configured.example/manifest.json');
  assert.throws(
    () => registry.approve(review.addonId, { confirmed: true, reviewToken: review.reviewToken }),
    (error) => error instanceof StremioAdapterError && error.code === 'CONFIGURATION_REQUIRED',
  );
  configured = true;
  registry.approve(review.addonId, { confirmed: true, reviewToken: review.reviewToken });
  assert.equal((await registry.fetchCatalog(review.addonId, { type: 'movie', catalogId: 'popular' })).items.length, 0);
});

test('repeated retryable provider failures transition to broken and review resets health', async () => {
  let manifestRequest = true;
  let now = 0;
  const registry = createStremioAddonRegistry({
    now: () => now,
    fetchImpl: async (url) => {
      if (manifestRequest) return { status: 200, url, headers: { get: () => null }, text: async () => JSON.stringify({ ...manifest, id: 'org.example.broken', config: undefined }) };
      throw new Error('provider unavailable');
    },
  });
  const review = await registry.reviewManifestUrl('https://broken.example/manifest.json');
  registry.approve(review.addonId, { confirmed: true, reviewToken: review.reviewToken });
  manifestRequest = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() => registry.fetchCatalog(review.addonId, { type: 'movie', catalogId: 'popular' }));
    registry.recordFailure(review.addonId);
    now += 1_000 * (2 ** attempt) + 1;
  }
  assert.equal(registry.get(review.addonId)?.state, 'broken');
  const refreshed = await registry.reviewManifestUrl('https://broken.example/manifest.json');
  assert.equal(refreshed.state, 'pending-review');
});
