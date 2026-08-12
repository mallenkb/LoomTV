import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCertFingerprint } from '../mobileDomain.ts';
import { savedConnectionSchema } from '../mobileDecoders.ts';
import { reconcileSavedHost, validatePairIdentity } from '../mobileHostIdentity.ts';

import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const connectionSource = fs.readFileSync(new URL('../mobileConnection.ts', import.meta.url), 'utf8');
const appConfig = JSON.parse(fs.readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
const lanClientSource = fs.readFileSync(new URL('../mobileLanClient.ts', import.meta.url), 'utf8');
const secureTransportSource = fs.readFileSync(new URL('../mobileSecureTransport.ts', import.meta.url), 'utf8');

function sourceSection(source, sourceName, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected ${sourceName} marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Expected ${sourceName} marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

test('certificate fingerprints normalize to one strict SHA-256 representation', () => {
  const compact = 'ab'.repeat(32);
  const colonSeparated = compact.match(/.{2}/g).join(':').toUpperCase();

  assert.equal(normalizeCertFingerprint(compact), compact);
  assert.equal(normalizeCertFingerprint(`  ${colonSeparated}  `), compact);
  assert.equal(normalizeCertFingerprint('ab'.repeat(31)), '');
  assert.equal(normalizeCertFingerprint('zz'.repeat(32)), '');
  assert.equal(normalizeCertFingerprint(undefined), '');
});

test('mobile LAN traffic rejects cleartext and routes through the pinned native transport', () => {
  const normalizeBaseUrl = sourceSection(connectionSource, 'mobileConnection.ts',
    'function normalizeBaseUrl(value: string)',
    'function discoveredHostFromService',
  );
  const discovery = sourceSection(connectionSource, 'mobileConnection.ts',
    'function discoveredHostFromService',
    'function isLikelyServerOfflineError',
  );

  assert.equal(appConfig.expo.android.usesCleartextTraffic, false);
  assert.equal(appConfig.expo.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.match(normalizeBaseUrl, /parsed\.protocol\s*!==\s*'https:'/);
  assert.match(discovery, /\^\[0-9a-f\]\{64\}\$/i);
  assert.match(discovery, /baseUrl:\s*`https:\/\//);
  assert.match(appSource, /createMobileLanClient\(\(input, init\) => fetch\(secureLanUrl\(input\), init\)\)/);
  assert.match(lanClientSource, /fetch\(input, init\)/);
  assert.match(secureTransportSource, /parsed\.protocol\s*!==\s*'https:'/);
  assert.match(secureTransportSource, /transport\.start\(remoteOrigin, fingerprint\)/);
  assert.match(secureTransportSource, /proxy\.protocol\s*!==\s*'http:'/);
  assert.match(secureTransportSource, /proxy\.hostname\s*!==\s*'localhost'/);
});

test('saved sessions require a pinned fingerprint before restore', () => {
  const valid = {
    baseUrl: 'https://192.168.1.10:3848',
    deviceId: 'phone',
    deviceToken: 'access',
    accessTokenExpiresAt: Date.now() + 1000,
    refreshToken: 'refresh',
    refreshTokenExpiresAt: Date.now() + 2000,
    certFingerprint: 'ab'.repeat(32),
    hostDeviceId: 'desktop-a',
    hostDeviceName: 'Living Room',
    clientDeviceName: 'Phone',
  };
  assert.equal(savedConnectionSchema.safeParse(valid).success, true);
  assert.equal(savedConnectionSchema.safeParse({ ...valid, hostDeviceId: '' }).success, false);
  assert.equal(savedConnectionSchema.safeParse({ ...valid, certFingerprint: '' }).success, false);
});

test('mDNS can update a saved address only when host ID and certificate pin both match', () => {
  const fingerprint = 'ab'.repeat(32);
  const saved = {
    baseUrl: 'https://192.168.1.10:3848',
    deviceId: 'phone',
    deviceToken: 'access',
    accessTokenExpiresAt: Date.now() + 1000,
    refreshToken: 'refresh',
    refreshTokenExpiresAt: Date.now() + 2000,
    certFingerprint: fingerprint,
    hostDeviceId: 'desktop-a',
    hostDeviceName: 'Living Room',
    clientDeviceName: 'Phone',
  };
  const discovered = {
    deviceId: 'desktop-a',
    deviceName: 'Renamed desktop',
    serviceName: 'spoofable-label',
    baseUrl: 'https://192.168.1.11:3848',
    certFingerprint: fingerprint.toUpperCase(),
  };

  assert.deepEqual(reconcileSavedHost(saved, discovered), {
    kind: 'updated',
    connection: { ...saved, baseUrl: discovered.baseUrl },
  });
  assert.deepEqual(reconcileSavedHost(saved, { ...discovered, deviceId: 'desktop-b' }), { kind: 'identity-mismatch' });
  assert.deepEqual(reconcileSavedHost(saved, { ...discovered, certFingerprint: 'cd'.repeat(32) }), { kind: 'identity-mismatch' });
  assert.deepEqual(reconcileSavedHost(saved, { ...discovered, baseUrl: saved.baseUrl }), {
    kind: 'unchanged',
    connection: saved,
  });
});

test('pairing binds the response identity to discovery before credentials are persisted', () => {
  const fingerprint = 'ab'.repeat(32);
  const payload = { certFingerprint: fingerprint, hostDeviceId: 'desktop-a' };
  const discovered = { certFingerprint: fingerprint, deviceId: 'desktop-a' };
  assert.equal(validatePairIdentity(payload, fingerprint, discovered), fingerprint);
  assert.throws(() => validatePairIdentity(payload, 'cd'.repeat(32), discovered), /TLS identity changed/);
  assert.throws(() => validatePairIdentity(payload, fingerprint, { ...discovered, certFingerprint: 'cd'.repeat(32) }), /security fingerprint changed/);
  assert.throws(() => validatePairIdentity(payload, fingerprint, { ...discovered, deviceId: 'desktop-b' }), /desktop identity changed/);
});
