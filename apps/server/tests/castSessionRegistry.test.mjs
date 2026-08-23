import assert from 'node:assert/strict';
import test from 'node:test';
import { createCastSessionRegistry } from '../src/cast-session-registry.js';

const binding = {
  transport: 'chromecast', receiverName: 'Living room', principalId: 'account-1',
  profileId: 'profile-1', deviceId: 'device-1', selectionRevision: 3,
  mediaId: 'media-1', sourceId: 'source-1', fileVersion: 'version-1', playbackSessionId: 'playback-1',
};

test('cast sessions retain every authority binding and expose a redacted view', () => {
  let now = 10;
  const registry = createCastSessionRegistry({ clock: () => now, ttlMs: 100 });
  const created = registry.create(binding);
  assert.equal(created.record.fileVersion, 'version-1');
  assert.equal(created.record.selectionRevision, 3);
  assert.equal(created.session.mediaId, 'media-1');
  assert.equal('fileVersion' in created.session, false);
  now = 20;
  const updated = registry.update(created.session.id, { state: 'paused', positionSeconds: 42 });
  assert.equal(updated.session.state, 'paused');
  assert.equal(updated.session.positionSeconds, 42);
});

test('cast sessions are bounded and expire', () => {
  let now = 0;
  const registry = createCastSessionRegistry({ clock: () => now, maxSessions: 1, ttlMs: 5 });
  const first = registry.create(binding);
  const second = registry.create({ ...binding, mediaId: 'media-2' });
  assert.equal(registry.read(first.session.id), null);
  assert.ok(registry.read(second.session.id));
  now = 6;
  assert.equal(registry.read(second.session.id), null);
});
