import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MOBILE_DIAGNOSTIC_MAX_AGE_MS,
  MOBILE_DIAGNOSTIC_MAX_BYTES,
  MOBILE_DIAGNOSTIC_MAX_EVENTS,
  createMobileDiagnosticEvent,
  mobileDiagnosticEventBytes,
  mobileDiagnosticIdsToDelete,
} from '../mobileDiagnosticPolicy.ts';

test('diagnostics redact credentials, secret query values, and local media paths', () => {
  const event = createMobileDiagnosticEvent('network', new Error('Bearer abc123 failed at /Users/me/Videos/private.mp4?token=secret'), {
    refreshToken: 'refresh-secret',
    url: 'https://host.test/path?code=1234&key=abcd',
  }, 100);
  const encoded = JSON.stringify(event);
  assert.doesNotMatch(encoded, /abc123|refresh-secret|private\.mp4|code=1234|key=abcd/);
  assert.match(encoded, /redacted/);
  assert.ok(mobileDiagnosticEventBytes(event) > 0);
});

test('diagnostic retention expires old rows and keeps at most the newest 100 events', () => {
  const now = 1_000_000_000;
  const candidates = Array.from({ length: MOBILE_DIAGNOSTIC_MAX_EVENTS + 5 }, (_, index) => ({
    id: `event-${index}`,
    createdAt: now - index,
    bytes: 1,
  }));
  candidates.push({ id: 'expired', createdAt: now - MOBILE_DIAGNOSTIC_MAX_AGE_MS - 1, bytes: 1 });
  const deleted = mobileDiagnosticIdsToDelete(candidates, now);
  assert.equal(deleted.length, 6);
  assert.ok(deleted.includes('expired'));
  assert.deepEqual(deleted.filter((id) => id.startsWith('event-')).sort(), [
    'event-100',
    'event-101',
    'event-102',
    'event-103',
    'event-104',
  ]);
});

test('diagnostic retention never exceeds its persisted byte cap', () => {
  const now = 2_000_000_000;
  const deleted = mobileDiagnosticIdsToDelete([
    { id: 'newest', createdAt: now, bytes: MOBILE_DIAGNOSTIC_MAX_BYTES - 20 },
    { id: 'would-overflow', createdAt: now - 1, bytes: 21 },
    { id: 'still-fits', createdAt: now - 2, bytes: 20 },
  ], now);
  assert.deepEqual(deleted, ['would-overflow']);
});
