import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { normalizeCertFingerprint } from '../mobileDomain.ts';
import { reconcileSavedHost } from '../mobileHostIdentity.ts';

const appSource = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const appConfig = JSON.parse(fs.readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
const lanClientSource = fs.readFileSync(new URL('../mobileLanClient.ts', import.meta.url), 'utf8');
const secureTransportSource = fs.readFileSync(new URL('../mobileSecureTransport.ts', import.meta.url), 'utf8');

function sourceSection(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected App.tsx marker: ${startMarker}`);
  const end = appSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Expected App.tsx marker after ${startMarker}: ${endMarker}`);
  return appSource.slice(start, end);
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
  const normalizeBaseUrl = sourceSection(
    'function normalizeBaseUrl(value: string)',
    'function discoveredHostFromService',
  );
  const discovery = sourceSection(
    'function discoveredHostFromService',
    'function compactErrorMessage',
  );

  assert.equal(appConfig.expo.android.usesCleartextTraffic, false);
  assert.equal(appConfig.expo.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.match(normalizeBaseUrl, /parsed\.protocol\s*!==\s*'https:'/);
  assert.match(discovery, /\^\[0-9a-f\]\{64\}\$/i);
  assert.match(discovery, /baseUrl:\s*`https:\/\//);
  assert.match(lanClientSource, /import \{ secureLanUrl \} from '\.\/mobileSecureTransport'/);
  assert.match(lanClientSource, /fetch\(secureLanUrl\(input\), init\)/);
  assert.match(secureTransportSource, /parsed\.protocol\s*!==\s*'https:'/);
  assert.match(secureTransportSource, /transport\.start\(remoteOrigin, fingerprint\)/);
  assert.match(secureTransportSource, /proxy\.protocol\s*!==\s*'http:'/);
  assert.match(secureTransportSource, /proxy\.hostname\s*!==\s*'localhost'/);
});

test('saved sessions require a pinned fingerprint before restore', () => {
  const restore = sourceSection(
    'const saved = JSON.parse(stored) as SavedConnection;',
    '.finally(() => {',
  );

  assert.match(restore, /normalizeCertFingerprint\(saved\.certFingerprint\)/);
  assert.match(restore, /!certFingerprint\s*\|\|\s*!saved\.hostDeviceId/);
  assert.match(restore, /SecureStore\.deleteItemAsync\(SAVED_CONNECTION_KEY\)/);
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
  const pairing = sourceSection(
    'const payload = (await response.json()) as PairResponse;',
    'await initializeProfiles(nextConnection)',
  );

  assert.match(pairing, /normalizeCertFingerprint\(payload\.certFingerprint\)/);
  assert.match(pairing, /discoveredFingerprint\s*&&\s*discoveredFingerprint\s*!==\s*certFingerprint/);
  assert.match(pairing, /discoveredPairHost\?\.deviceId\s*&&\s*payload\.hostDeviceId/);
  assert.match(pairing, /certFingerprint:\s*nextConnection\.certFingerprint/);
  assert.match(pairing, /SecureStore\.setItemAsync\(SAVED_CONNECTION_KEY/);
});
