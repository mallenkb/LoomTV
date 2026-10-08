import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mobileErrorPayloadSchema,
  mobileLibrarySchema,
  mobileProgressMapSchema,
  savedConnectionSchema,
} from '../mobileDecoders.ts';

test('library decoder accepts empty valid payloads and rejects wrong collection types', () => {
  assert.equal(mobileLibrarySchema.safeParse({ movies: [], tvShows: [], animeShows: [], others: [] }).success, true);
  assert.equal(mobileLibrarySchema.safeParse({ movies: 'not-an-array', tvShows: [], animeShows: [], others: [] }).success, false);
});

test('progress decoder rejects truncated and wrong-typed records', () => {
  assert.equal(mobileProgressMapSchema.safeParse({ item: { position: 12 } }).success, false);
  assert.equal(mobileProgressMapSchema.safeParse({ item: { position: '12', duration: 100, updatedAt: 1, watched: false } }).success, false);
});

test('error decoder rejects hostile oversized values through an explicit limit', () => {
  const oversized = 'x'.repeat(20_001);
  assert.equal(mobileErrorPayloadSchema.safeParse({ error: oversized }).success, false);
});

test('saved fixed credentials reject expiry dates fabricated by the former refresh adapter', () => {
  const credential = {
    baseUrl: 'https://server', deviceId: 'phone', hostDeviceId: 'host', hostDeviceName: 'Server', clientDeviceName: 'Phone',
    deviceToken: 'id.secret', refreshToken: 'id.secret', certFingerprint: 'ab'.repeat(32),
    accessTokenExpiresAt: 1000000, refreshTokenExpiresAt: 1000000,
  };
  assert.equal(savedConnectionSchema.safeParse(credential).success, true);
  assert.equal(savedConnectionSchema.safeParse({ ...credential, refreshTokenExpiresAt: 2000000 }).success, false);
});
