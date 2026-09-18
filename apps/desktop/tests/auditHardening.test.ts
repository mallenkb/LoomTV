import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  let engines = 0;
  let hosts = 0;
  let allocated = 0;
  let destroyed = 0;
  const timers = new Set<() => void>();
  const powers = new Set<string>();
  const states: string[] = [];
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
    loom_mpv_command: () => failure === 'loadfile' || failure === 'command' ? -1 : 0,
    loom_mpv_poll_into: () => failure === 'poll' ? -1 : 0,
    loom_mpv_destroy: () => {
      engines--; destroyed++;
      if (failure === 'destroy') throw new Error('destroy failed');
    },
  };
  const koffi = { load: () => ({ func: (name: keyof typeof native) => native[name] }) };
  const api = loadModule('libmpvPlayback', {
    electron: { BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) } },
    'node:fs': { existsSync: () => true },
    './mpvPlaybackHelpers.ts': { finiteNumber: Number, normalizeMpvTracks: () => [] },
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
    './memoryMetrics.ts': { recordMemoryCheckpoint: () => undefined },
  }, {
    process: { platform: 'darwin', resourcesPath: '/mock-runtime', env: {} },
    console: { warn: () => undefined },
    setInterval: (callback: () => void) => { timers.add(callback); return callback; },
    clearInterval: (callback: () => void) => { timers.delete(callback); },
  }) as typeof import('../src/main/libmpvPlayback.ts');
  const start = () => api.startLibMpvPlayback(owner as never, 'toy.mkv');
  const empty = () => {
    assert.equal(engines, 0); assert.equal(hosts, 0); assert.equal(timers.size, 0);
    assert.equal(powers.size, 0); assert.equal(owner.listenerCount('destroyed'), 0);
    assert.equal(allocated, destroyed);
  };
  return { api, owner, start, empty, states, timers, setFailure: (value: string) => { failure = value; } };
}

for (const failure of ['create', 'host', 'attach', 'loadfile', 'emit']) {
  test(`libmpv transaction releases every allocation on ${failure} failure`, () => {
    const f = mpvFixture();
    for (let index = 0; index < 20; index++) {
      f.setFailure(failure); assert.equal(f.start().ok, false); f.empty();
      f.setFailure(''); assert.equal(f.start().ok, true);
      assert.equal(f.api.stopLibMpvPlayback(), true); f.empty();
    }
  });
}

test('libmpv repeated stop, replacement, owner destruction and native failures release ownership', () => {
  const f = mpvFixture();
  for (let index = 0; index < 30; index++) {
    const first = f.start(); assert.equal(first.ok, true);
    const second = f.start(); assert.equal(second.ok, true);
    assert.equal(f.owner.listenerCount('destroyed'), 1);
    assert.equal(f.api.stopLibMpvPlayback(first.sessionId), false);
    f.owner.emit('destroyed'); f.empty();
    assert.equal(f.api.stopLibMpvPlayback(), false);
  }
  for (const failure of ['poll', 'command', 'destroy']) {
    f.setFailure(''); const started = f.start();
    assert.ok(started.sessionId);
    f.setFailure(failure);
    if (failure === 'poll') for (const poll of f.timers) poll();
    else if (failure === 'command') f.api.commandLibMpvPlayback(started.sessionId, { type: 'set-paused', paused: true });
    else f.api.stopLibMpvPlayback();
    f.empty();
  }
});
