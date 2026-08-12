import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

type ByteRange = { start: number; end: number };
type ByteRangeModule = {
  parseHttpByteRange: (header: string, fileSize: number) => ByteRange | null;
};

type RendererSettingsModule = {
  sanitizeRendererSettingsPatch: (patch: Record<string, unknown>) => Record<string, unknown>;
  settingsForRenderer: (settings: Record<string, unknown>) => Record<string, unknown>;
};

type LanTlsIdentityModule = {
  loadOrCreateLanTlsIdentity: (userDataPath: string, sanAddresses?: readonly string[]) => {
    certificatePem: string;
    privateKeyPem: string;
    certFingerprint: string;
  };
};

async function loadBoundaryModule<T>(relativePath: string): Promise<T> {
  const moduleUrl = new URL(relativePath, import.meta.url).href;
  return import(moduleUrl) as Promise<T>;
}

test('HTTP byte ranges accept only one bounded RFC 9110 range', async () => {
  const { parseHttpByteRange } = await loadBoundaryModule<ByteRangeModule>('../src/main/httpByteRange.ts');
  const accepted: Array<[string, number, ByteRange]> = [
    ['bytes=0-0', 100, { start: 0, end: 0 }],
    ['bytes=10-', 100, { start: 10, end: 99 }],
    ['bytes=-20', 100, { start: 80, end: 99 }],
    ['bytes=95-200', 100, { start: 95, end: 99 }],
  ];
  const rejected: Array<[string, number]> = [
    ['bytes=-', 100],
    ['bytes=10-9', 100],
    ['bytes=100-101', 100],
    ['bytes=0-1,4-5', 100],
    ['items=0-1', 100],
    ['bytes=nan-10', 100],
    ['bytes=0-0', 0],
  ];

  for (const [header, size, expected] of accepted) {
    assert.deepEqual(parseHttpByteRange(header, size), expected, header);
  }
  for (const [header, size] of rejected) {
    assert.equal(parseHttpByteRange(header, size), null, header);
  }
});

test('LAN TLS identity is valid, pinned, private on disk, and stable across restarts', async (t) => {
  const { loadOrCreateLanTlsIdentity } = await loadBoundaryModule<LanTlsIdentityModule>(
    '../src/main/lanTlsIdentity.ts',
  );
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-lan-tls-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const first = loadOrCreateLanTlsIdentity(temporaryRoot, ['192.168.1.25', 'not-an-ip']);
  const certificate = new X509Certificate(first.certificatePem);
  const second = loadOrCreateLanTlsIdentity(temporaryRoot);

  assert.match(first.certFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(certificate.fingerprint256.replaceAll(':', '').toLowerCase(), first.certFingerprint);
  assert.equal(second.certFingerprint, first.certFingerprint);
  assert.equal(second.certificatePem, first.certificatePem);
  assert.equal(second.privateKeyPem, first.privateKeyPem);
  assert.match(certificate.subjectAltName || '', /DNS:localhost/);
  assert.match(certificate.subjectAltName || '', /192\.168\.1\.25/);
  assert.ok(
    Date.parse(certificate.validTo) - Date.parse(certificate.validFrom) <= 398 * 24 * 60 * 60 * 1000,
    'LAN certificate validity must stay within Apple\'s 398-day limit',
  );
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(temporaryRoot, 'lan-tls-identity.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('renderer settings projection and patches cannot carry server-only credentials', async () => {
  const { sanitizeRendererSettingsPatch, settingsForRenderer } = await loadBoundaryModule<RendererSettingsModule>(
    '../src/main/rendererSettings.ts',
  );
  const serverOnly = {
    localNetworkHmacSecret: 'hmac-secret',
    localNetworkShareToken: '123456',
    localNetworkPairedDevices: [{ id: 'phone', accessTokenHash: 'hash', refreshTokenHash: 'refresh-hash' }],
    localNetworkSecurityEpoch: 2,
  };
  const persisted = {
    ...serverOnly,
    appThemeMode: 'dark',
    playbackSkipBackSeconds: 10,
  };

  const projected = settingsForRenderer(persisted);
  const sanitized = sanitizeRendererSettingsPatch({
    ...serverOnly,
    appThemeMode: 'light',
    playbackSkipBackSeconds: 15,
  });

  assert.equal(projected.appThemeMode, 'dark');
  assert.equal(projected.playbackSkipBackSeconds, 10);
  assert.deepEqual(sanitized, {
    appThemeMode: 'light',
    playbackSkipBackSeconds: 15,
  });
  for (const secretKey of Object.keys(serverOnly)) {
    assert.equal(Object.hasOwn(projected, secretKey), false, secretKey);
    assert.equal(Object.hasOwn(sanitized, secretKey), false, secretKey);
  }
});
