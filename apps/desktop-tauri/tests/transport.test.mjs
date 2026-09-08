import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTauriTransport } from '../src/bridge/transport.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const pending = [];
  const errors = [];
  const calls = [];
  const native = {
    async invoke(command, args) { calls.push({ command, args }); return null; },
    listen(name, callback) {
      return new Promise((resolve, reject) => pending.push({ name, callback, resolve, reject }));
    },
  };
  return { ...createTauriTransport(native, (...args) => errors.push(args)), native, pending, errors, calls };
}

test('invoke preserves arguments, null, and structured native failures', async () => {
  const f = fixture();
  assert.equal(await f.transport.invoke('library:get', undefined, 0, false), null);
  assert.deepEqual(f.calls, [{ command: 'desktop_invoke', args: { channel: 'library:get', args: [undefined, 0, false] } }]);
  f.native.invoke = async () => { throw { code: 'stale_profile', message: 'Profile changed.', retryable: false }; };
  await assert.rejects(f.transport.invoke('progress:save'), e => e instanceof Error && e.message === 'Profile changed.' && e.code === 'stale_profile' && e.retryable === false);
});

test('removal before native listen resolves disposes the eventual subscription', async () => {
  const f = fixture(); let calls = 0; let stops = 0;
  const listener = () => calls++;
  f.transport.on('libvlc:state', listener);
  f.transport.removeListener('libvlc:state', listener);
  await flush();
  f.pending[0].callback({ payload: [{ position: 1 }] });
  f.pending[0].resolve(() => stops++);
  await flush();
  assert.equal(calls, 0); assert.equal(stops, 1);
  f.dispose(); assert.equal(stops, 1);
});

test('duplicate listeners retire the old registration without cancelling the new one', async () => {
  const f = fixture(); const values = []; const stops = [0, 0];
  const listener = (_, value) => values.push(value);
  f.transport.on('event', listener); f.transport.on('event', listener);
  await flush();
  for (let i = 0; i < 2; i++) f.pending[i].resolve(() => stops[i]++);
  await flush();
  f.pending[0].callback({ payload: ['old'] }); f.pending[1].callback({ payload: ['current'] });
  assert.deepEqual(values, ['current']); assert.deepEqual(stops, [1, 0]);
  f.transport.removeListener('event', listener); f.transport.removeListener('event', listener);
  assert.deepEqual(stops, [1, 1]);
});

test('a failed registration can be retried without leaking the channel', async () => {
  const f = fixture(); const listener = () => {};
  f.transport.on('event', listener); await flush();
  f.pending[0].reject(new Error('denied')); await flush();
  assert.equal(f.errors.length, 1);
  f.transport.on('event', listener); await flush();
  let stops = 0; f.pending[1].resolve(() => stops++); await flush();
  f.dispose(); assert.equal(stops, 1);
});

test('dispose removes resolved and pending subscriptions exactly once', async () => {
  const f = fixture(); const stops = [0, 0];
  f.transport.on('one', () => {}); f.transport.on('two', () => {}); await flush();
  f.pending[0].resolve(() => stops[0]++); await flush();
  f.dispose(); f.dispose(); f.pending[1].resolve(() => stops[1]++); await flush();
  assert.deepEqual(stops, [1, 1]);
  assert.throws(() => f.transport.on('new', () => {}), { code: 'bridge_closed' });
  await assert.rejects(f.transport.invoke('new'), { code: 'bridge_closed' });
});

test('late invoke results are rejected after the WebView is disposed', async () => {
  const f = fixture(); let resolve;
  f.native.invoke = () => new Promise(done => { resolve = done; });
  const result = f.transport.invoke('library:get');
  f.dispose(); resolve({ library: 'stale' });
  await assert.rejects(result, { code: 'bridge_closed' });
});

test('malformed events are reported rather than spread into the listener', async () => {
  const f = fixture(); let calls = 0;
  f.transport.on('event', () => calls++); await flush();
  f.pending[0].callback({ payload: { secret: 'not logged' } });
  assert.equal(calls, 0); assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0][1].message.includes('secret'), false);
  f.dispose();
});

test('one failed native cleanup cannot prevent the other subscriptions from stopping', async () => {
  const f = fixture(); let stopped = false;
  f.transport.on('one', () => {}); f.transport.on('two', () => {}); await flush();
  f.pending[0].resolve(() => { throw new Error('native cleanup failure'); });
  f.pending[1].resolve(() => { stopped = true; }); await flush();
  f.dispose(); assert.equal(stopped, true); assert.equal(f.errors.length, 1);
});

// Load the bridge with native API mocks, without a WebView or Tauri runtime.
async function rendererFixture() {
  const [{ readFile }, { createRequire }, { runInNewContext }] = await Promise.all([
    import('node:fs/promises'), import('node:module'), import('node:vm'),
  ]);
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const source = await readFile(new URL('../src/bridge/tauriBridge.ts', import.meta.url), 'utf8');
  const calls = [];
  let attachResolve;
  let attachReject;
  let pagehide;
  const ready = new Promise((resolve, reject) => { attachResolve = resolve; attachReject = reject; });
  const nativeInvoke = async (command, args) => {
    calls.push({ command, ...args });
    if (args.channel === 'renderer:attach') return ready;
    return true;
  };
  const exports = {};
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require(name) {
      if (name === '@tauri-apps/api/core') return { invoke: nativeInvoke };
      if (name === '@tauri-apps/api/event') return { listen: async () => () => {} };
      if (name === './transport') return { createTauriTransport };
      if (name.endsWith('/createDesktopBridge')) return { createDesktopBridge: transport => transport };
      throw new Error(`Unexpected import: ${name}`);
    },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    window: { addEventListener(name, callback) { assert.equal(name, 'pagehide'); pagehide = callback; } },
  });
  return { transport: exports.createTauriBridge(), calls, attachResolve, attachReject, hide: () => pagehide() };
}

test('renderer waits for attach before sending commands and detaches with its owner ID', async () => {
  const f = await rendererFixture();
  const result = f.transport.invoke('mpv:start', 'movie');
  await flush();
  assert.equal(f.calls.length, 1);
  f.attachResolve(true);
  assert.equal(await result, true);
  assert.equal(f.calls[1].channel, 'mpv:start');
  assert.equal(f.calls[1].rendererId, f.calls[0].args[0]);
  f.hide();
  await flush();
  assert.equal(f.calls[2].channel, 'renderer:detach');
  assert.equal(f.calls[2].args[0], f.calls[0].args[0]);
});

test('pagehide during attach prevents queued playback and still detaches after attach', async () => {
  const f = await rendererFixture();
  const result = f.transport.invoke('mpv:start', 'movie');
  const rejected = assert.rejects(result, { code: 'bridge_closed' });
  f.hide();
  f.attachResolve(true);
  await rejected;
  await flush();
  assert.deepEqual(f.calls.map(call => call.channel), ['renderer:attach', 'renderer:detach']);
});

test('failed renderer handoff rejects playback without sending it', async () => {
  const f = await rendererFixture();
  const result = f.transport.invoke('mpv:start', 'movie');
  const rejected = assert.rejects(result, { code: 'libmpv_error' });
  f.attachReject({ code: 'libmpv_error', message: 'Stop failed.' });
  await rejected;
  f.hide();
  await flush();
  assert.deepEqual(f.calls.map(call => call.channel), ['renderer:attach']);
});
