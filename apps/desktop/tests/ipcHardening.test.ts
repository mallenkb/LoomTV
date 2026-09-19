import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import {
  authorizeFolderReveal,
  boundedIpcRecord,
  externalBrowserUrl,
  playbackCommandSchema,
  playbackStartOptionsSchema,
  playbackTimeSchema,
} from '../src/main/ipcPlaybackValidation.ts';
import { parseIpcArguments } from '../src/main/ipcValidation.ts';
import { createDesktopBridge, type DesktopTransport } from '../src/shared/createDesktopBridge.ts';

test('native commands accept boundary values and reject overflow and fractions', () => {
  for (const command of [
    { type: 'set-volume', volume: 0 },
    { type: 'set-volume', volume: 1 },
    { type: 'set-speed', speed: 0.25 },
    { type: 'set-speed', speed: 3 },
    { type: 'set-audio-delay', seconds: -60 },
    { type: 'set-subtitle-delay', seconds: 60 },
    { type: 'set-audio-track', trackId: -1 },
    { type: 'set-audio-track', trackId: 2_147_483_647 },
    { type: 'set-subtitle-track', trackId: null },
    ...[0, 90, 180, 270].map((degrees) => ({ type: 'set-video-rotation', degrees })),
  ]) assert.equal(playbackCommandSchema.safeParse(command).success, true, JSON.stringify(command));

  for (const command of [
    { type: 'set-volume', volume: 1.01 },
    { type: 'set-volume', volume: -0.01 },
    { type: 'set-speed', speed: 0.24 },
    { type: 'set-speed', speed: 3.01 },
    { type: 'set-audio-delay', seconds: -61 },
    { type: 'set-subtitle-delay', seconds: 61 },
    { type: 'set-audio-track', trackId: 2_147_483_648 },
    { type: 'set-audio-track', trackId: 1.5 },
    { type: 'set-video-rotation', degrees: 45 },
    { type: 'seek', position: Number.MAX_SAFE_INTEGER },
    { type: 'seek', position: Infinity },
    { type: 'seek', position: NaN },
  ]) assert.equal(playbackCommandSchema.safeParse(command).success, false, JSON.stringify(command));
  assert.equal(playbackTimeSchema.safeParse(Math.floor(Number.MAX_SAFE_INTEGER / 1000)).success, true);
});

test('start options retain scaled subtitle sizes and bound native payloads', () => {
  const style = { fontSize: 192, position: 100, borderWidth: 10, color: '#fff', borderColor: '#000', backgroundColor: '#000' };
  assert.equal(playbackStartOptionsSchema.safeParse({ subtitleStyle: style, volume: 1, speed: 3 }).success, true);
  for (const patch of [{ fontSize: 193 }, { position: 101 }, { borderWidth: 11 }]) {
    assert.equal(playbackStartOptionsSchema.safeParse({ subtitleStyle: { ...style, ...patch } }).success, false);
  }
  for (const options of [
    { volume: 2 }, { speed: 4 }, { audioDelay: 61 }, { subtitleDelay: -61 },
    { audioTrackId: 0.5 }, { audioLanguage: 'x'.repeat(33) },
    { subtitleFiles: Array.from({ length: 129 }, () => ({ path: '/video.srt', source: 'sidecar' })) },
    { subtitleFiles: [{ path: 'x'.repeat(8193), source: 'sidecar' }] },
  ]) assert.equal(playbackStartOptionsSchema.safeParse(options).success, false);
});

test('browser links accept arbitrary http hosts but reject credentials and oversized URLs', () => {
  for (const url of ['https://example.org/help', 'http://localhost:9000/help', 'https://custom-provider.example/docs']) {
    assert.equal(externalBrowserUrl(url), url);
  }
  for (const url of ['file:///tmp/file', 'javascript:alert(1)', 'https://user:pass@example.org', 'https://user@example.org', `https://example.org/${'x'.repeat(8192)}`]) {
    assert.throws(() => externalBrowserUrl(url));
  }
});

test('folder reveal permits authorized media and owner folders while denying other profiles', () => {
  const denied = () => { throw new Error('Denied'); };
  authorizeFolderReveal('/library/movie.mkv', (target) => { assert.equal(target, '/library/movie.mkv'); }, denied);
  for (const target of ['/settings', '/backups']) {
    let ownerChecks = 0;
    authorizeFolderReveal(target, denied, () => { ownerChecks += 1; });
    assert.equal(ownerChecks, 1);
  }
  let probed = false;
  assert.throws(() => {
    authorizeFolderReveal('/private', denied, denied);
    probed = true;
  }, /Denied/);
  assert.equal(probed, false);
});

test('record payloads reject excessive entries, oversized values, and cycles', () => {
  const schema = boundedIpcRecord(z.unknown(), 2, 64);
  assert.equal(schema.safeParse({ first: 'value', second: true }).success, true);
  assert.equal(schema.safeParse({ first: 1, second: 2, third: 3 }).success, false);
  assert.equal(schema.safeParse({ first: 'x'.repeat(65) }).success, false);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(schema.safeParse({ first: cyclic }).success, false);
});

test('typed bridge routes libVLC and window calls and unsubscribes exact event handlers', async () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const listeners = new Map<string, Parameters<DesktopTransport['on']>[1]>();
  const transport: DesktopTransport = {
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      calls.push([channel, ...args]);
      return true as T;
    },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) {
      assert.equal(listeners.get(channel), listener);
      listeners.delete(channel);
    },
  };
  const bridge = createDesktopBridge(transport);
  await bridge.libvlc.start('/movie.mkv');
  await bridge.libvlc.setFullscreenTransition(true);
  await bridge.setFullscreen(true);
  await bridge.setWindowChromeVisible(false);
  assert.deepEqual(calls, [
    ['libvlc:start', '/movie.mkv', {}],
    ['libvlc:set-fullscreen-transition', true, true],
    ['window:set-fullscreen', true],
    ['window:set-chrome-visible', false],
  ]);
  const state = { sessionId: 'session', status: 'ready' };
  let received: unknown;
  const offState = bridge.libvlc.onState((value) => { received = value; });
  listeners.get('libvlc:state')?.({}, state);
  assert.equal(received, state);
  let fullscreen = false;
  const offFullscreen = bridge.onFullscreenChanged((value) => { fullscreen = value; });
  listeners.get('window:fullscreen-changed')?.({}, true);
  assert.equal(fullscreen, true);
  offState();
  offFullscreen();
  assert.equal(listeners.size, 0);
});

test('handler wiring retains sender checks and validates local access before producing URLs or probing folders', () => {
  const source = fs.readFileSync(new URL('../src/main/ipcHandlers.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /handleExperimental/);
  assert.match(source, /if \(!deps\.isTrustedSender\(event\)\) throw new Error\('Untrusted IPC sender\.'\)/);
  const thumbnail = source.slice(source.indexOf("handle('media:get-thumbnail'"), source.indexOf("handle('media:get-file-info'"));
  assert.ok(thumbnail.indexOf('deps.authorizeMediaPath(filePath)') < thumbnail.indexOf('deps.assertLocalMediaPath(filePath)'));
  assert.ok(thumbnail.indexOf('deps.assertLocalMediaPath(filePath)') < thumbnail.indexOf('new URLSearchParams'));
  const mpv = source.slice(source.indexOf("handle('mpv:start'"), source.indexOf("'mpv:command'"));
  assert.match(mpv, /assertSubtitleCanAccessMediaPath\?\.\(mediaPath, subtitleFile.path\)/);
  const reveal = source.slice(source.indexOf('const openFolderPath ='), source.indexOf("handle('shell:open-folder-path'"));
  assert.ok(reveal.indexOf('authorizeFolderReveal(resolvedTarget') < reveal.indexOf('fs.existsSync'));
  assert.ok(reveal.indexOf('authorizeFolderReveal(parent') < reveal.indexOf('existingTarget = parent'));
  assert.throws(() => parseIpcArguments('libvlc:command', ['session', { type: 'set-speed', speed: 4 }], z.tuple([z.string(), playbackCommandSchema])));
  assert.throws(() => parseIpcArguments('window:set-fullscreen', [true, 'extra'], z.tuple([z.boolean()])));
});
