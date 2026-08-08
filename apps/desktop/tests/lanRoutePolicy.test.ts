import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deviceHasLanScope,
  isIpcOnlyHttpRoute,
  isLegacyLanRoute,
  lanRouteScope,
  mediaServerRouteAccess,
} from '../src/main/lanRoutePolicy.ts';

test('LAN v2 routes have explicit least-privilege policies', () => {
  assert.equal(lanRouteScope('/api/v2/library', 'GET'), 'catalog:read');
  assert.equal(lanRouteScope('/api/v2/start-hls', 'POST'), 'media:stream');
  assert.equal(lanRouteScope('/api/v2/progress', 'POST'), 'playback:write');
  assert.equal(lanRouteScope('/api/v2/unpair', 'POST'), 'device:self');
  assert.equal(lanRouteScope('/api/settings', 'GET'), null);
  assert.equal(lanRouteScope('/api/library/scan', 'POST'), null);
});

test('desktop administrative operations are not exposed as HTTP APIs', () => {
  assert.equal(isIpcOnlyHttpRoute('/api/settings'), true);
  assert.equal(isIpcOnlyHttpRoute('/api/library/scan'), true);
  assert.equal(isIpcOnlyHttpRoute('/api/database/clear'), true);
  assert.equal(isIpcOnlyHttpRoute('/api/media/start-transcode'), true);
  assert.equal(isIpcOnlyHttpRoute('/api/renderer/session'), true);
  assert.equal(isIpcOnlyHttpRoute('/api/v2/library'), false);
});

test('legacy LAN protocol routes are identified for upgrade-required responses', () => {
  assert.equal(isLegacyLanRoute('/api/lan/pair'), true);
  assert.equal(isLegacyLanRoute('/api/lan/library'), true);
  assert.equal(isLegacyLanRoute('/api/v2/library'), false);
});

test('LAN scope checks do not allow one capability to imply another', () => {
  assert.equal(deviceHasLanScope(['catalog:read'], 'catalog:read'), true);
  assert.equal(deviceHasLanScope(['catalog:read'], 'media:stream'), false);
  assert.equal(deviceHasLanScope(['media:stream'], 'playback:write'), false);
  assert.equal(deviceHasLanScope([], 'device:self'), true);
});

test('media server dispatch classifies routes and methods before authorization', () => {
  assert.deepEqual(mediaServerRouteAccess('/api/ping', 'GET'), { kind: 'public' });
  assert.deepEqual(mediaServerRouteAccess('/api/ping', 'POST'), { kind: 'desktop' });
  assert.deepEqual(mediaServerRouteAccess('/api/renderer/session', 'POST'), { kind: 'ipc-only' });
  assert.deepEqual(mediaServerRouteAccess('/api/renderer/session', 'GET'), { kind: 'ipc-only' });
  assert.deepEqual(mediaServerRouteAccess('/api/v2/pair', 'POST'), { kind: 'pairing' });
  assert.deepEqual(mediaServerRouteAccess('/api/v2/pair/status', 'POST'), { kind: 'pairing' });
  assert.deepEqual(mediaServerRouteAccess('/api/v2/library', 'GET'), { kind: 'scoped', scope: 'catalog:read' });
  assert.deepEqual(mediaServerRouteAccess('/api/v2/library', 'POST'), { kind: 'desktop' });
  assert.deepEqual(mediaServerRouteAccess('/api/settings', 'GET'), { kind: 'ipc-only' });
  assert.deepEqual(mediaServerRouteAccess('/stream', 'GET'), { kind: 'stream' });
  assert.deepEqual(mediaServerRouteAccess('/api/local-image', 'GET'), { kind: 'artwork' });
  assert.deepEqual(mediaServerRouteAccess('/api/unknown', 'GET'), { kind: 'desktop' });
});
