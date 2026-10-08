import assert from 'node:assert/strict';
import * as resumeRewind from '../src/shared/resumeRewind.ts';
import { EventEmitter } from 'node:events';
import { restoreOffscreenTrack } from '../src/main/offscreenVideoRestore.ts';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import * as ts from 'typescript';
import { z } from 'zod';

const require = createRequire(import.meta.url);
function loadModule(name: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const code = ts.transpileModule(fs.readFileSync(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, process, console,
    require: (id: string) => {
      if (id === '../shared/resumeRewind.ts') return resumeRewind;
      if (id in dependencies) return dependencies[id];
      if (id.startsWith('node:') || id === 'zod') return require(id);
      throw new Error(`Unexpected dependency ${id}`);
    },
    ...globals,
  });
  return module.exports;
}

function pairingFixture() {
  const target = '/mock-data/remote-library-session.secure.json';
  const original = JSON.stringify({ version: 2, encrypted: Buffer.from('legacy').toString('base64') });
  const files = new Map([[target, original]]);
  let failure = 'write';
  let decryptions = 0;
  let writes = 0;
  let temporary = '';
  const saved = {
    baseUrl: 'https://127.0.0.1:3443', certFingerprint: 'test', certificatePem: 'test',
    deviceId: 'paired-device', accessToken: 'toy-access', refreshToken: 'toy-refresh',
    accessTokenExpiresAt: Date.now() + 1000000, refreshTokenExpiresAt: Date.now() + 2000000,
    clientDeviceName: 'toy client',
  };
  const api = loadModule('remoteLibraryClient', {
    electron: { app: { getPath: () => '/mock-data' } },
    '@loom-media-server/lan-protocol': { lanLibraryPayloadSchema: () => z.object({}), lanMediaItemSchema: z.object({}) },
    './runtimeValidation.ts': { parseRequiredJson: (raw: string, schema: z.ZodType) => schema.parse(JSON.parse(raw)) },
    './localSecretStorage.ts': {
      localSecretStorage: { isEncryptionAvailable: () => true },
      decryptLocalSecret: () => { decryptions++; return { plaintext: JSON.stringify(saved), needsMigration: true }; },
      encryptLocalSecret: () => Buffer.from('migrated'),
    },
    'node:fs': {
      existsSync: (file: string) => files.has(file),
      readFileSync: (file: string) => { assert.ok(files.has(file)); return files.get(file); },
      openSync: (file: string, flags: string, mode: number) => {
        assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
        assert.ok(!files.has(file)); files.set(file, ''); temporary = file; return 7;
      },
      writeFileSync: (fd: number, value: string) => {
        assert.equal(fd, 7); writes++; files.set(temporary, 'partial');
        if (failure === 'write') throw new Error('ENOSPC');
        files.set(temporary, value);
      },
      closeSync: () => undefined,
      renameSync: (from: string, to: string) => {
        assert.equal(from, temporary); assert.equal(to, target);
        if (failure === 'rename') throw new Error('EPERM');
        const value = files.get(from);
        assert.ok(value);
        files.set(to, value); files.delete(from);
      },
      unlinkSync: (file: string) => { assert.notEqual(file, target); files.delete(file); },
    },
  }) as typeof import('../src/main/remoteLibraryClient.ts');
  return { client: api.createRemoteLibraryClient(), files, original, target,
    setFailure: (value: string) => { failure = value; },
    counts: () => ({ decryptions, writes }),
  };
}

for (const failure of ['write', 'rename']) {
  test(`pairing survives migration ${failure} failure and retries without moving the original`, () => {
    const f = pairingFixture();
    f.setFailure(failure);
    for (let index = 0; index < 3; index++) {
      assert.equal(f.client.getSession().status, 'connected');
      assert.equal(f.files.get(f.target), f.original);
      assert.equal(f.files.size, 1);
    }
    f.setFailure('');
    f.client.migrateLegacyCredentialStorage();
    assert.notEqual(f.files.get(f.target), f.original);
    assert.equal(f.client.getSession().status, 'connected');
    assert.deepEqual(f.counts(), { decryptions: 1, writes: 4 });
  });
}

test('migration retry does not replace a changed pairing file', () => {
  const f = pairingFixture();
  f.client.getSession();
  f.files.set(f.target, 'replacement pairing');
  f.setFailure('');
  f.client.migrateLegacyCredentialStorage();
  assert.equal(f.files.get(f.target), 'replacement pairing');
  assert.equal(f.counts().writes, 1);
});

function mpvFixture() {
  let failure = '';
  let syncDestroyCalls = 0;
  let engines = 0;
  let hosts = 0;
  let allocated = 0;
  let destroyed = 0;
  const timers = new Set<() => void>();
  const powers = new Set<string>();
  const states: string[] = [];
  const sent: unknown[][] = [];
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (_channel: string, state: { status: string }) => {
      if (failure === 'emit') throw new Error('emit failed');
      states.push(state.status);
    },
  });
  const native = {
    loom_mpv_bridge_version: () => 1,
    loom_mpv_create: () => {
      if (failure === 'create') return null;
      engines++; allocated++; return allocated;
    },
    loom_mpv_attach: () => failure === 'attach' ? -1 : 0,
    loom_mpv_command: (_engine: unknown, _request: unknown, json: string) => {
      const command = JSON.parse(json) as unknown[];
      sent.push(command);
      // 'no-output' models mpv before its audio output exists.
      if (failure === 'no-output' && String(command[1]).startsWith('ao-')) return -1;
      return failure === 'loadfile' || failure === 'command' ? -1 : 0;
    },
    loom_mpv_poll_into: () => failure === 'poll' ? -1 : 0,
    loom_mpv_destroy: () => {
      engines--; destroyed++;
      if (failure === 'destroy') throw new Error('destroy failed');
    },
  };
  // koffi binds each export as a sync call plus .async, which runs on a worker
  // and reports through a Node-style callback.
  const bound = (name: keyof typeof native) => {
    const fn = native[name] as (...args: unknown[]) => unknown;
    return Object.assign((...args: unknown[]) => {
      if (name === 'loom_mpv_destroy') syncDestroyCalls++;
      return fn(...args);
    }, {
      async: (...args: unknown[]) => {
        const callback = args.pop() as (error: Error | null, result?: unknown) => void;
        if (name === 'loom_mpv_destroy' && failure === 'hang') return;
        setImmediate(() => {
          let result: unknown;
          try { result = fn(...args); } catch (error) { callback(error as Error); return; }
          callback(null, result);
        });
      },
    });
  };
  const koffi = { load: () => ({ func: (name: keyof typeof native) => bound(name) }) };
  const api = loadModule('libmpvPlayback', {
    electron: { BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) } },
    'node:fs': { existsSync: () => true },
    './mpvPlaybackHelpers.ts': { finiteNumber: Number, normalizeMpvTracks: () => [], mpvFlag: (value: unknown) => value === true || value === 1 },
    './playbackDiagnostics.ts': { recordPlaybackDiagnostic: () => undefined },
    './screenLock.ts': { isScreenLocked: () => false },
    './offscreenVideoRestore.ts': { restoreOffscreenTrack },
    './libvlcPlayback.ts': {
      loadKoffi: () => koffi,
      createNativeViewHost: () => {
        if (failure === 'host') throw new Error('host failed');
        hosts++;
        return { drawable: 1, destroy: () => { hosts--; } };
      },
    },
    './nativePlaybackPower.ts': {
      syncNativePlaybackDisplaySleep: (id: string) => { powers.add(id); },
      releaseNativePlaybackDisplaySleep: (id: string) => { powers.delete(id); },
    },
  }, {
    process: { platform: 'darwin', resourcesPath: '/mock-runtime', env: {} },
    console: { warn: () => undefined },
    setInterval: (callback: () => void) => { timers.add(callback); return callback; },
    clearInterval: (callback: () => void) => { timers.delete(callback); },
    setTimeout, clearTimeout,
  }) as typeof import('../src/main/libmpvPlayback.ts');
  const start = () => api.startLibMpvPlayback(owner as never, 'toy.mkv');
  // Native teardown runs on a worker; wait for it before checking ownership.
  const empty = async () => {
    await api.stopAllLibMpvPlayback();
    assert.equal(engines, 0); assert.equal(hosts, 0); assert.equal(timers.size, 0);
    assert.equal(powers.size, 0); assert.equal(owner.listenerCount('destroyed'), 0);
    assert.equal(allocated, destroyed);
  };
  return { api, owner, start, empty, states, timers, sent, setFailure: (value: string) => { failure = value; },
    counts: () => ({ engines, hosts, allocated, destroyed }), syncDestroyCalls: () => syncDestroyCalls };
}

for (const failure of ['create', 'host', 'attach', 'loadfile', 'emit']) {
  test(`libmpv transaction releases every allocation on ${failure} failure`, async () => {
    const f = mpvFixture();
    for (let index = 0; index < 20; index++) {
      f.setFailure(failure); assert.equal(f.start().ok, false); await f.empty();
      f.setFailure(''); assert.equal(f.start().ok, true);
      assert.equal(f.api.stopLibMpvPlayback(), true); await f.empty();
    }
  });
}

test('libmpv repeated stop, replacement, owner destruction and native failures release ownership', async () => {
  const f = mpvFixture();
  for (let index = 0; index < 30; index++) {
    const first = f.start(); assert.equal(first.ok, true);
    const second = f.start(); assert.equal(second.ok, true);
    assert.equal(f.owner.listenerCount('destroyed'), 1);
    assert.equal(f.api.stopLibMpvPlayback(first.sessionId), false);
    f.owner.emit('destroyed'); await f.empty();
    assert.equal(f.api.stopLibMpvPlayback(), false);
  }
  for (const failure of ['poll', 'command', 'destroy']) {
    f.setFailure(''); const started = f.start();
    assert.ok(started.sessionId);
    f.setFailure(failure);
    if (failure === 'poll') for (const poll of f.timers) poll();
    else if (failure === 'command') f.api.commandLibMpvPlayback(started.sessionId, { type: 'set-paused', paused: true });
    else f.api.stopLibMpvPlayback();
    if (failure === 'destroy') {
      // A failed native destroy leaves handle ownership uncertain, so the
      // parent view stays alive instead of being freed under mpv.
      await f.api.stopAllLibMpvPlayback();
      assert.deepEqual(f.counts(), { engines: 0, hosts: 1, allocated: f.counts().allocated, destroyed: f.counts().allocated });
    } else await f.empty();
  }
});

test('a rejected libmpv display preference keeps the session playing', async () => {
  const f = mpvFixture();
  const started = f.start();
  assert.ok(started.sessionId);
  f.setFailure('command');
  assert.equal(f.api.commandLibMpvPlayback(started.sessionId, { type: 'set-video-crop', crop: null }), false);
  assert.ok(!f.states.includes('error'));
  f.setFailure('');
  assert.equal(f.api.stopLibMpvPlayback(started.sessionId), true);
  await f.empty();
});
test('libmpv mutes at the audio output so M takes effect without buffered delay', async () => {
  const f = mpvFixture();
  const started = f.start();
  assert.ok(started.sessionId);
  f.sent.length = 0;
  assert.equal(f.api.commandLibMpvPlayback(started.sessionId, { type: 'set-muted', muted: true }), true);
  // Output-level mute only: the soft mute sits behind mpv's audio buffer.
  assert.deepEqual(f.sent, [['set_property', 'ao-mute', true]]);
  f.sent.length = 0;
  assert.equal(f.api.commandLibMpvPlayback(started.sessionId, { type: 'set-muted', muted: false }), true);
  assert.deepEqual(f.sent, [['set_property', 'ao-mute', false], ['set_property', 'ao-volume', 100]]);

  // Before an audio output exists, the soft mute carries the choice.
  f.setFailure('no-output');
  f.sent.length = 0;
  assert.equal(f.api.commandLibMpvPlayback(started.sessionId, { type: 'set-muted', muted: true }), true);
  assert.deepEqual(f.sent.at(-1), ['set_property', 'mute', true]);
  assert.ok(!f.states.includes('error'));
  f.setFailure('');
  assert.equal(f.api.stopLibMpvPlayback(started.sessionId), true);
  await f.empty();
});

test('libmpv destroy is bound with an int return and only ever runs on a worker', async () => {
  const source = fs.readFileSync(new URL('../src/main/libmpvPlayback.ts', import.meta.url), 'utf8');
  // koffi .async on a void-returning binding crashes Electron 43's main process.
  assert.match(source, /bind\(library, 'loom_mpv_destroy', 'int', \['void \*'\]\)/);
  const bridge = fs.readFileSync(new URL('../native/libmpv/render-bridge/bridge.m', import.meta.url), 'utf8');
  assert.match(bridge, /LM_EXPORT int loom_mpv_destroy\(void \*opaque\)/);

  const f = mpvFixture();
  for (let index = 0; index < 5; index++) {
    assert.equal(f.start().ok, true);
    assert.equal(f.api.stopLibMpvPlayback(), true);
  }
  await f.empty();
  assert.equal(f.syncDestroyCalls(), 0);
});

test('a hung libmpv destroy cannot hold quit past its timeout, and libmpv starts again afterwards', async () => {
  const f = mpvFixture();
  assert.equal(f.start().ok, true);
  f.setFailure('hang');
  const startedAt = Date.now();
  await f.api.stopAllLibMpvPlayback(50);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(f.counts().hosts, 1, 'the view stays alive while mpv may still use it');

  f.setFailure('');
  const restarted = f.start();
  assert.equal(restarted.ok, true, 'a finished shutdown drain must not disable libmpv');
  assert.equal(f.api.stopLibMpvPlayback(), true);
});
