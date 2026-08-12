import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchMobileCatalog, synchronizeMobileCatalog } from '../mobileCatalog.ts';

const connection = {
  baseUrl: 'https://desktop.local:3848',
  deviceId: 'mobile-device',
  deviceToken: 'access-token',
  accessTokenExpiresAt: 200_000,
  refreshToken: 'refresh-token',
  refreshTokenExpiresAt: 500_000,
  certFingerprint: 'a'.repeat(64),
  hostDeviceId: 'desktop-device',
  hostDeviceName: 'Desktop',
  clientDeviceName: 'Phone',
  library: {},
  libraryEtag: 'etag-1',
};

function clientReturning(response) {
  return {
    getLibraryIndex: async () => response,
    getLibrary: async () => response,
  };
}

test('catalog decoder rejects a malformed compact payload instead of trusting it', async () => {
  const response = new Response(JSON.stringify({ catalogVersion: 1, revision: -1 }), { status: 200 });
  await assert.rejects(
    fetchMobileCatalog(clientReturning(response), connection),
    /Library index returned an invalid payload/,
  );
});

test('catalog decoder reports profile-required as a discriminated result', async () => {
  const response = new Response(JSON.stringify({ error: 'profile_required' }), { status: 409 });
  assert.deepEqual(
    await fetchMobileCatalog(clientReturning(response), connection),
    { status: 'profile-required' },
  );
});

test('catalog synchronization refreshes an expiring credential before loading', async () => {
  const events = [];
  const result = await synchronizeMobileCatalog({
    connection: { ...connection, accessTokenExpiresAt: 1 },
    savedConnection: { ...connection, accessTokenExpiresAt: 1 },
    isServerOffline: false,
    now: 100_000,
    refreshCredentials: async (saved) => {
      events.push('refresh');
      return { ...saved, deviceToken: 'fresh-token', accessTokenExpiresAt: 300_000 };
    },
    initializeProfiles: async () => false,
    refreshProfiles: async (activeConnection) => {
      events.push(`profiles:${activeConnection.deviceToken}`);
    },
    fetchCatalog: async (activeConnection) => {
      events.push(`catalog:${activeConnection.deviceToken}`);
      return { status: 'not-modified' };
    },
  });

  assert.equal(result.status, 'not-modified');
  assert.deepEqual(events, ['refresh', 'catalog:fresh-token', 'profiles:fresh-token']);
});

test('catalog synchronization retries once after an unauthorized response', async () => {
  const events = [];
  let requests = 0;
  const result = await synchronizeMobileCatalog({
    connection,
    savedConnection: connection,
    isServerOffline: false,
    now: 100_000,
    refreshCredentials: async (saved) => {
      events.push('refresh');
      return { ...saved, deviceToken: 'fresh-token' };
    },
    initializeProfiles: async () => false,
    refreshProfiles: async () => undefined,
    fetchCatalog: async (activeConnection) => {
      requests += 1;
      events.push(`catalog:${activeConnection.deviceToken}`);
      return requests === 1
        ? { status: 'unauthorized' }
        : { status: 'not-modified' };
    },
  });

  assert.equal(result.status, 'not-modified');
  assert.deepEqual(events, ['catalog:access-token', 'refresh', 'catalog:fresh-token']);
});

test('offline synchronization lets profile initialization own recovery', async () => {
  const events = [];
  const result = await synchronizeMobileCatalog({
    connection,
    savedConnection: connection,
    isServerOffline: true,
    refreshCredentials: async (saved) => saved,
    initializeProfiles: async () => {
      events.push('profiles-initialized');
      return true;
    },
    refreshProfiles: async () => events.push('refresh-profiles'),
    fetchCatalog: async () => {
      events.push('catalog');
      return { status: 'not-modified' };
    },
  });

  assert.deepEqual(result, { status: 'profile-initialized' });
  assert.deepEqual(events, ['profiles-initialized']);
});
