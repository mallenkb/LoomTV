import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readBoundedUtf8File, TextFileTooLargeError } from '../src/main/boundedTextFile.ts';
import { resolveMediaAccessIdentity } from '../src/main/mediaAccessIdentity.ts';
import { mediaServerRouteAccess } from '../src/main/lanRoutePolicy.ts';
import { registerResource, resolveLocalResource } from '../src/main/resourceRegistry.ts';
import { sanitizeRendererSettingsPatch, settingsForRenderer } from '../src/main/rendererSettings.ts';
import {
  allowedCorsOrigin,
  hasValidLocalAccessToken,
  LOCAL_ACCESS_HEADER,
} from '../src/main/serverSecurity.ts';
import { createSessionBindingStore } from '../src/main/sessionBindingStore.ts';

test('HTTP authorization keeps public, renderer, desktop, and paired-device boundaries distinct', () => {
  const expectedToken = 'local-renderer-token';
  const requestUrl = new URL('http://127.0.0.1:3847/api/renderer/settings');

  assert.equal(hasValidLocalAccessToken(requestUrl, {}, expectedToken), false);
  assert.equal(hasValidLocalAccessToken(requestUrl, { [LOCAL_ACCESS_HEADER]: expectedToken }, expectedToken), true);
  assert.equal(hasValidLocalAccessToken(requestUrl, { [LOCAL_ACCESS_HEADER]: `${expectedToken}-extra` }, expectedToken), false);
  assert.equal(allowedCorsOrigin(undefined, new Set(['http://localhost:5173'])), null);
  assert.equal(allowedCorsOrigin('http://localhost:5173', new Set(['http://localhost:5173'])), 'http://localhost:5173');
  assert.equal(allowedCorsOrigin('http://localhost:5174', new Set(['http://localhost:5173'])), null);

  assert.deepEqual(mediaServerRouteAccess('/api/ping', 'GET'), { kind: 'public' });
  assert.deepEqual(mediaServerRouteAccess('/api/renderer/session', 'POST'), { kind: 'public' });
  assert.deepEqual(mediaServerRouteAccess('/api/renderer/settings', 'GET'), { kind: 'desktop' });
  assert.deepEqual(mediaServerRouteAccess('/api/settings', 'GET'), { kind: 'ipc-only' });
  assert.deepEqual(mediaServerRouteAccess('/api/v2/profiles', 'POST'), { kind: 'scoped', scope: 'playback:write' });
});

test('renderer settings responses and writes omit every server-held credential', () => {
  const secrets = {
    localNetworkHmacSecret: 'hmac',
    localNetworkShareToken: '123456',
    localNetworkSecurityEpoch: 2,
    localNetworkPairedDevices: [{ id: 'phone', accessTokenHash: 'access', refreshTokenHash: 'refresh' }],
  };
  const projected = settingsForRenderer({ ...secrets, appThemeMode: 'dark' });
  const sanitized = sanitizeRendererSettingsPatch({ ...secrets, appThemeMode: 'light' });

  assert.equal(projected.appThemeMode, 'dark');
  assert.deepEqual(sanitized, { appThemeMode: 'light' });
  for (const key of Object.keys(secrets)) {
    assert.equal(Object.hasOwn(projected, key), false, key);
    assert.equal(Object.hasOwn(sanitized, key), false, key);
  }
});

test('media identity comes from credentials and immediately fails after profile revocation', () => {
  let active = { profileId: 'owner', selectionRevision: 7 };
  const activeProfile = () => active;
  const base = {
    boundDeviceId: 'phone-a',
    boundProfileId: 'owner',
    boundSelectionRevision: 7,
    credentialDeviceId: 'phone-a',
    signedRequestValid: false,
  };

  assert.deepEqual(resolveMediaAccessIdentity(base, activeProfile), {
    deviceId: 'phone-a',
    profileId: 'owner',
    selectionRevision: 7,
  });
  assert.equal(resolveMediaAccessIdentity({ ...base, boundDeviceId: 'phone-b' }, activeProfile), null);
  assert.equal(resolveMediaAccessIdentity({ ...base, boundProfileId: 'kid' }, activeProfile), null);
  assert.equal(resolveMediaAccessIdentity({ ...base, boundSelectionRevision: 6 }, activeProfile), null);

  active = { profileId: null, selectionRevision: 8 };
  assert.equal(resolveMediaAccessIdentity(base, activeProfile), null);
  assert.equal(resolveMediaAccessIdentity({
    ...base,
    credentialDeviceId: '',
    signedRequestValid: false,
  }, activeProfile), null);
});

test('signed media links are bound to an explicit device and its current selection', () => {
  const activeProfile = (deviceId: string) => (
    deviceId === 'tablet' ? { profileId: 'viewer', selectionRevision: 3 } : { profileId: null, selectionRevision: 0 }
  );
  const signed = {
    boundDeviceId: 'tablet',
    boundProfileId: 'viewer',
    boundSelectionRevision: 3,
    credentialDeviceId: '',
    signedRequestValid: true,
  };

  assert.deepEqual(resolveMediaAccessIdentity(signed, activeProfile), {
    deviceId: 'tablet',
    profileId: 'viewer',
    selectionRevision: 3,
  });
  assert.equal(resolveMediaAccessIdentity({ ...signed, boundDeviceId: '' }, activeProfile), null);
  assert.equal(resolveMediaAccessIdentity({ ...signed, signedRequestValid: false }, activeProfile), null);
});

test('resource IDs reject kind substitution, traversal, and cross-media subtitle reuse', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-boundary-resource-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const firstMedia = path.join(temporaryRoot, 'episode-1.mkv');
  const secondMedia = path.join(temporaryRoot, 'episode-2.mkv');
  const subtitle = path.join(temporaryRoot, 'episode-1.srt');
  for (const filePath of [firstMedia, secondMedia, subtitle]) fs.writeFileSync(filePath, 'fixture');

  const subtitleId = registerResource('secret', 'subtitle', subtitle, firstMedia);
  const subtitleKinds = new Set(['subtitle'] as const);
  const mediaKinds = new Set(['media'] as const);
  assert.equal(resolveLocalResource(subtitleId, subtitleKinds, [temporaryRoot], firstMedia), fs.realpathSync.native(subtitle));
  assert.throws(() => resolveLocalResource(subtitleId, subtitleKinds, [temporaryRoot], secondMedia), /does not belong/);
  assert.throws(() => resolveLocalResource(subtitleId, mediaKinds, [temporaryRoot]), /Unknown local resource/);
  assert.throws(() => resolveLocalResource('../episode-1.srt', subtitleKinds, [temporaryRoot]), /Unknown local resource/);
});

test('subtitle reads preserve UTF-8 across chunks and reject oversized or cancelled work', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-boundary-subtitle-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const subtitle = path.join(temporaryRoot, 'subtitle.srt');
  const content = '1\n00:00:01,000 --> 00:00:02,000\nCafé 🎬\n';
  fs.writeFileSync(subtitle, content);

  assert.equal(await readBoundedUtf8File(subtitle, { maxBytes: 1024, chunkBytes: 3 }), content);
  await assert.rejects(
    readBoundedUtf8File(subtitle, { maxBytes: Buffer.byteLength(content) - 1 }),
    TextFileTooLargeError,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readBoundedUtf8File(subtitle, { maxBytes: 1024, signal: controller.signal }), /cancelled/);
});

test('session bindings are capped, touched, and removed by the real disposal callback contract', () => {
  let dispose: ((sessionId: string) => void) | undefined;
  const store = createSessionBindingStore<{ profileId: string; lastAccessAt: number }>(2);
  const unsubscribe = store.bindDisposal((listener) => {
    dispose = listener;
    return () => { dispose = undefined; };
  });

  store.bind('first', { profileId: 'owner' }, 10);
  store.bind('second', { profileId: 'kid' }, 20);
  store.touch('first', 30);
  store.bind('third', { profileId: 'guest' }, 40);
  assert.equal(store.get('second'), undefined);
  assert.equal(store.get('first')?.lastAccessAt, 30);
  assert.equal(store.size(), 2);

  dispose?.('first');
  assert.equal(store.get('first'), undefined);
  assert.equal(store.size(), 1);
  unsubscribe();
  assert.equal(dispose, undefined);
});

test.todo('release signer and notarization verification remains deferred by user request');
