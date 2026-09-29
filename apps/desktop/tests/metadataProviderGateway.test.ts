import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { SecureSettingsCorruptError } from '../src/main/secureSettings.ts';
import type { MetadataProviderRequest } from '../src/shared/desktopProtocol.ts';

const gatewayUrl = new URL('../src/main/metadataProviderGateway.ts', import.meta.url).href;
const stubUrl = `data:text/javascript,${encodeURIComponent(`
  export async function safeFetch(url) {
    return new Response(JSON.stringify({ requestedUrl: String(url) }), { status: 200 });
  }
`)}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === gatewayUrl && specifier === './safeFetch.ts') {
      return { url: stubUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { createMetadataProviderGateway } = await import('../src/main/metadataProviderGateway.ts');
hooks.deregister();

const requests: MetadataProviderRequest[] = [
  { provider: 'cinemeta', path: 'catalog/movie/top.json' },
  { provider: 'anilist', query: '{ GenreCollection }' },
  { provider: 'jikan', path: 'top/anime' },
  { provider: 'tvmaze', path: 'schedule' },
];

test('public discovery works despite conflicting secrets and never reads credentials', async () => {
  let secretReads = 0;
  const request = createMetadataProviderGateway({
    loadMetadataOfflineMode: () => false,
    loadSettings: () => { secretReads += 1; throw new SecureSettingsCorruptError(); },
    getMetadataApiKey: () => { throw new Error('Unexpected credential access'); },
  });
  for (const input of requests) {
    const result = await request(input) as { requestedUrl: string };
    assert.ok(result.requestedUrl.startsWith('https://'));
  }
  assert.equal(secretReads, 0);
});

test('offline preference still blocks all public discovery providers', async () => {
  const request = createMetadataProviderGateway({
    loadMetadataOfflineMode: () => true,
    loadSettings: () => { throw new Error('Unexpected credential access'); },
    getMetadataApiKey: () => undefined,
  });
  for (const input of requests) await assert.rejects(request(input), /offline mode/);
});

test('authenticated providers still reject conflicting credentials', async () => {
  const request = createMetadataProviderGateway({
    loadMetadataOfflineMode: () => false,
    loadSettings: () => { throw new SecureSettingsCorruptError(); },
    getMetadataApiKey: () => undefined,
  });
  await assert.rejects(request({ provider: 'tmdb', path: 'movie/popular' }), SecureSettingsCorruptError);
  await assert.rejects(request({ provider: 'omdb', query: { i: 'tt1234567' } }), SecureSettingsCorruptError);
});
