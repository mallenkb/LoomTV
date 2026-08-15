import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRemoteMediaSource,
  remoteMediaProtocolUrl,
  remoteMediaRoutePath,
  remoteProfileSessionPatch,
} from '../src/lib/remoteDesktop.ts';

test('remote profile state refreshes the cached selection identity used by playback', () => {
  assert.deepEqual(remoteProfileSessionPatch({
    profileId: 'profile-2',
    selectionRevision: 7,
  }), {
    selectedProfileId: 'profile-2',
    selectionRevision: 7,
  });
});

test('remote playback recognizes Electron proxied media URLs', () => {
  assert.equal(isRemoteMediaSource('https://192.168.1.10:3443/stream?resourceId=movie-1'), true);
  assert.equal(isRemoteMediaSource('loomtv://remote/stream?resourceId=movie-1'), true);
  assert.equal(isRemoteMediaSource('plexserver://remote/stream?resourceId=movie-1'), true);
  assert.equal(isRemoteMediaSource('loomtv://localhost/stream?path=%2Fmedia%2Fmovie.mp4'), false);
  assert.equal(isRemoteMediaSource('plexserver://localhost/stream?path=%2Fmedia%2Fmovie.mp4'), false);
  assert.equal(isRemoteMediaSource('C:\\media\\movie.mp4'), false);
});

test('compact remote resource IDs become media routes', () => {
  assert.equal(
    remoteMediaRoutePath('/stream', 'opaque-resource-id'),
    '/stream?resourceId=opaque-resource-id',
  );
  assert.equal(
    remoteMediaRoutePath('/api/thumbnail', 'loomtv://remote/stream?resourceId=opaque-resource-id&sig=test', { t: '30' }),
    '/api/thumbnail?resourceId=opaque-resource-id&sig=test&t=30',
  );
  assert.equal(
    remoteMediaRoutePath('/api/thumbnail', 'plexserver://remote/stream?resourceId=opaque-resource-id&sig=test', { t: '30' }),
    '/api/thumbnail?resourceId=opaque-resource-id&sig=test&t=30',
  );
});

test('new remote media URLs use the LoomTV scheme', () => {
  assert.equal(
    remoteMediaProtocolUrl('/stream?resourceId=movie-1'),
    'loomtv://remote/stream?resourceId=movie-1',
  );
});
