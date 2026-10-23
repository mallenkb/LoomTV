import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  StremioAddonStateSnapshot,
  StremioFetchImplementation,
} from '@loom-media-server/plugin-protocol';
import {
  createStremioPluginService,
  StremioPluginServiceError,
  type StremioHostProfile,
} from '../src/main/stremioPluginService.ts';

const addonId = 'org.example.catalog';
const manifest = {
  id: addonId,
  version: '1.0.0',
  name: 'Example catalog',
  description: 'A bounded test provider.',
  resources: ['catalog'],
  types: ['movie'],
  idPrefixes: ['tt'],
  catalogs: [{ type: 'movie', id: 'popular', name: 'Popular' }],
};

function jsonResponse(url: string, payload: unknown) {
  const text = JSON.stringify(payload);
  return {
    status: 200,
    url,
    headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(text)) : null },
    text: async () => text,
  };
}

function fixture(providerFetch?: StremioFetchImplementation) {
  const owner: StremioHostProfile = { id: 'owner', type: 'owner', isGuest: false };
  const standard: StremioHostProfile = { id: 'standard', type: 'standard', isGuest: false };
  const kid: StremioHostProfile = { id: 'kid', type: 'kid', isGuest: false };
  const profiles = new Map([owner, standard, kid].map((profile) => [profile.id, profile]));
  const access = new Map<string, Set<string>>();
  let state: StremioAddonStateSnapshot | null = null;
  const fetchImpl: StremioFetchImplementation = async (url) => (
    jsonResponse(url, url.endsWith('/manifest.json')
      ? manifest
      : { metas: [{ id: 'tt123', type: 'movie', name: 'Movie', genres: [] }] })
  );
  const service = createStremioPluginService({
    loadState: () => state,
    saveState: (snapshot) => { state = snapshot; return snapshot; },
    getProfile: (profileId) => profiles.get(profileId) || null,
    listProfileAccess: (profileId) => [...(access.get(profileId) || [])],
    hasProfileAccess: (profileId, candidateAddonId) => access.get(profileId)?.has(candidateAddonId) === true,
    setProfileAccess: (profileId, candidateAddonId, enabled) => {
      const grants = access.get(profileId) || new Set<string>();
      if (enabled) grants.add(candidateAddonId);
      else grants.delete(candidateAddonId);
      access.set(profileId, grants);
      return enabled;
    },
    authorizeManagement: () => owner,
    fetchImpl: providerFetch ?? fetchImpl,
  });
  return { service, standard, kid, clearPersistedState: () => { state = null; } };
}

test('official review pins the expected manifest identity and rolls back a mismatch', async () => {
  const { service } = fixture();

  await assert.rejects(
    () => service.reviewManifestUrl('https://catalog.example/manifest.json', 'org.example.expected'),
    (error) => error instanceof StremioPluginServiceError
      && error.code === 'STREMIO_PLUGIN_OFFICIAL_ID_MISMATCH',
  );
  assert.deepEqual(service.listManaged(), []);
});

for (const action of ['disable', 'remove'] as const) {
  test(`${action} aborts only that add-on and rejects its late result`, async () => {
    const otherId = 'org.example.other';
    const pending = new Map<string, { signal: AbortSignal; respond: () => void }>();
    let started!: () => void;
    const bothStarted = new Promise<void>(resolve => { started = resolve; });
    const { service } = fixture(async (url, init) => {
      const id = url.includes('other.example') ? otherId : addonId;
      if (url.endsWith('/manifest.json')) return jsonResponse(url, { ...manifest, id });
      return new Promise(resolve => {
        pending.set(id, {
          signal: (init as { signal: AbortSignal }).signal,
          respond: () => resolve(jsonResponse(url, { metas: [{ id: 'tt123', type: 'movie', name: 'Movie' }] })),
        });
        if (pending.size === 2) started();
      });
    });
    for (const [id, host] of [[addonId, 'catalog.example'], [otherId, 'other.example']]) {
      const review = await service.reviewManifestUrl(`https://${host}/manifest.json`, id);
      await service.approve(id, review.reviewToken);
    }
    const cancelled = service.fetchCatalog('owner', addonId, { type: 'movie', catalogId: 'popular' });
    const rejected = assert.rejects(cancelled, (error) => error instanceof StremioPluginServiceError
      && error.code === 'STREMIO_PLUGIN_REQUEST_CANCELLED');
    const other = service.fetchCatalog('owner', otherId, { type: 'movie', catalogId: 'popular' });
    await bothStarted;
    await service[action](addonId);
    const cancelledRequest = pending.get(addonId);
    const otherRequest = pending.get(otherId);
    assert.ok(cancelledRequest);
    assert.ok(otherRequest);
    assert.equal(cancelledRequest.signal.aborted, true);
    assert.equal(otherRequest.signal.aborted, false);
    cancelledRequest.respond();
    otherRequest.respond();
    await rejected;
    assert.equal((await other).items[0].id, 'tt123');
  });
}

test('standard profiles require an explicit grant while Kids profiles remain denied', async () => {
  const { service, standard, kid } = fixture();
  const review = await service.reviewManifestUrl('https://catalog.example/manifest.json', addonId);
  await service.approve(addonId, review.reviewToken);

  await assert.rejects(
    () => service.fetchCatalog(standard.id, addonId, { type: 'movie', catalogId: 'popular' }),
    (error) => error instanceof StremioPluginServiceError && error.code === 'STREMIO_PLUGIN_ACCESS_DENIED',
  );
  assert.equal(await service.setProfileAccess(standard.id, addonId, true), true);
  assert.equal((await service.fetchCatalog(standard.id, addonId, { type: 'movie', catalogId: 'popular' })).items[0].id, 'tt123');
  await assert.rejects(
    () => service.fetchCatalog(kid.id, addonId, { type: 'movie', catalogId: 'popular' }),
    (error) => error instanceof StremioPluginServiceError && error.code === 'STREMIO_PLUGIN_PROFILE_NOT_ALLOWED',
  );
});

test('a cleared app reloads add-on state instead of keeping the cached registry', async () => {
  const { service, clearPersistedState } = fixture();
  const review = await service.reviewManifestUrl('https://catalog.example/manifest.json', addonId);
  await service.approve(addonId, review.reviewToken);
  assert.equal(service.listManaged().length, 1);

  clearPersistedState();
  service.discardCachedState();
  assert.deepEqual(service.listManaged(), []);
});

test('browser configuration keeps the configured endpoint in the host and requires a new approval', async () => {
  let configurationRequired = true;
  const { service } = fixture(async url => jsonResponse(url, {
    ...manifest, behaviorHints: { configurable: true, configurationRequired },
  }));
  const endpoint = 'https://catalog.example/user%2Fsecret/manifest.json?token=private';
  const review = await service.reviewManifestUrl(endpoint);
  assert.equal(service.configurationUrl(addonId), 'https://catalog.example/user%2Fsecret/configure?token=private');
  assert.ok(!JSON.stringify(review).includes('token=private'));
  await assert.rejects(() => service.approve(addonId, review.reviewToken));
  configurationRequired = false;
  const configured = await service.reviewManifestUrl(endpoint, addonId);
  await assert.rejects(() => service.approve(addonId, review.reviewToken));
  const enabled = await service.approve(addonId, configured.reviewToken);
  assert.equal(enabled.state, 'enabled');
});

test('closing a source request aborts its transport without recording a provider failure', async () => {
  let fetchSignal: AbortSignal | undefined;
  let finishFetch: (() => void) | undefined;
  let notifyStarted = () => { throw new Error('Start notification is unavailable.'); };
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const { service } = fixture(async (url, init) => {
    if (url.endsWith('/manifest.json')) return jsonResponse(url, { ...manifest, resources: ['stream'], catalogs: [] });
    fetchSignal = (init as { signal: AbortSignal }).signal;
    return new Promise(resolve => {
      finishFetch = () => resolve(jsonResponse(url, { streams: [] }));
      notifyStarted();
    });
  });
  const review = await service.reviewManifestUrl('https://catalog.example/manifest.json');
  await service.approve(addonId, review.reviewToken);
  const controller = new AbortController();
  const pending = service.fetchStreams('owner', addonId, { type: 'movie', videoId: 'tt123' }, controller.signal);
  const rejected = assert.rejects(pending, error => error instanceof StremioPluginServiceError && error.code === 'STREMIO_PLUGIN_REQUEST_CANCELLED');
  await started;
  controller.abort();
  assert.equal(fetchSignal?.aborted, true);
  finishFetch?.();
  await rejected;
  assert.equal(service.listManaged()[0].failureCount || 0, 0);
});
