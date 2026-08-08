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

function fixture() {
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
    fetchImpl,
  });
  return { service, standard, kid };
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
