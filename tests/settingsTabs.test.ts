import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nextSettingsSection,
  remoteLibraryRefreshIdentity,
} from '../src/lib/settingsTabs.ts';

test('settings tab selection keeps the current section when the selected tab is already active', () => {
  assert.equal(nextSettingsSection('network', 'network'), 'network');
  assert.equal(nextSettingsSection('library', 'playback'), 'playback');
});

test('remote library refresh identity ignores refreshed library payload changes', () => {
  const first = remoteLibraryRefreshIdentity({
    baseUrl: 'http://192.168.1.4:3847',
    deviceId: 'device-a',
    deviceToken: 'token-a',
    libraryEtag: 'etag-1',
    library: { movies: [{ id: 'movie-1' }] },
  });
  const refreshed = remoteLibraryRefreshIdentity({
    baseUrl: 'http://192.168.1.4:3847',
    deviceId: 'device-a',
    deviceToken: 'token-a',
    libraryEtag: 'etag-2',
    library: { movies: [{ id: 'movie-1' }, { id: 'movie-2' }] },
  });
  const reconnected = remoteLibraryRefreshIdentity({
    baseUrl: 'http://192.168.1.4:3847',
    deviceId: 'device-b',
    deviceToken: 'token-b',
    libraryEtag: 'etag-2',
    library: { movies: [{ id: 'movie-1' }] },
  });

  assert.equal(first, refreshed);
  assert.notEqual(first, reconnected);
});
