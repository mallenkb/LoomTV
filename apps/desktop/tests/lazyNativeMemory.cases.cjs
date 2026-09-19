const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const ts = require('typescript');

function compile(file, mocks, fakeProcess) {
  const filename = path.resolve(__dirname, '../src', file);
  const nativeRequire = createRequire(filename);
  const localRequire = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'node:module') return { createRequire: () => localRequire };
    if (name.startsWith('node:')) return nativeRequire(name);
    throw new Error(`Unexpected dependency in native-memory fixture: ${name}`);
  };
  // The production ESM source creates its own require for Koffi. Give that
  // local binding a distinct name inside our CommonJS evaluation wrapper.
  const source = fs.readFileSync(filename, 'utf8')
    .replace('class LibMpvSession {', 'export class LibMpvSession {')
    .replace('function commandList(', 'export function commandList(')
    .replace('class LibVlcPlaybackSession {', 'export class LibVlcPlaybackSession {')
    .replace('const require = createRequire(__filename);', 'const runtimeRequire = createRequire(__filename);')
    .replaceAll("require('koffi')", "runtimeRequire('koffi')");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    reportDiagnostics: true,
  });
  assert.equal(diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', outputText)(
    localRequire, module, module.exports, filename, path.dirname(filename), fakeProcess,
  );
  return module.exports;
}

function nativeFs(paths) {
  return {
    existsSync: p => paths.has(p),
    realpathSync: p => p,
    statSync: p => {
      if (!paths.has(p)) throw new Error('ENOENT');
      return { isFile: () => true, isDirectory: () => false };
    },
  };
}

function mpvFixture(present = true) {
  let loads = 0;
  let creates = 0;
  const fakeProcess = { platform: 'darwin', arch: 'arm64', env: {
    LOOMTV_LIBMPV_PATH: '/fixture/libmpv.dylib',
    LOOMTV_LIBMPV_BRIDGE_PATH: '/fixture/bridge.dylib',
  } };
  const module = compile('main/libmpvPlayback.ts', {
    electron: { BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) } },
    'node:fs': nativeFs(new Set(present ? ['/fixture/libmpv.dylib', '/fixture/bridge.dylib'] : [])),
    './mpvPlaybackHelpers.ts': { finiteNumber: v => Number(v), mpvFlag: v => v === true || v === 1, normalizeMpvTracks: () => [] },
    './libvlcPlayback.ts': {
      loadKoffi: () => {
        loads++;
        return { load: () => ({ func: name => {
          if (name === 'loom_mpv_bridge_version') return () => 1;
          if (name === 'loom_mpv_create') return () => { creates++; return null; };
          return () => 0;
        } }) };
      },
      createNativeViewHost: () => { throw new Error('A failed core must not create a view.'); },
    },
    './nativePlaybackPower.ts': { releaseNativePlaybackDisplaySleep: () => {}, syncNativePlaybackDisplaySleep: () => {} },
    './memoryMetrics.ts': { recordMemoryCheckpoint: () => {} },
  }, fakeProcess);
  return { module, loads: () => loads, creates: () => creates };
}

function mpvStartupFixture(options = {}) {
  const sent = [], updates = [], visibility = [];
  let destroyed = 0;
  const owner = new EventEmitter();
  owner.isDestroyed = () => false;
  owner.send = (_channel, value) => updates.push(value);
  const host = { drawable: 1n, setVisible: value => visibility.push(value), destroy: () => {}, syncHierarchy: () => {} };
  const module = compile('main/libmpvPlayback.ts', {
    electron: { BrowserWindow: {} },
    './mpvPlaybackHelpers.ts': { finiteNumber: v => typeof v === 'number' ? v : undefined, mpvFlag: v => v === true || v === 1, normalizeMpvTracks: v => v },
    './libvlcPlayback.ts': { loadKoffi: () => ({}), createNativeViewHost: () => host },
    './nativePlaybackPower.ts': { releaseNativePlaybackDisplaySleep: () => {}, syncNativePlaybackDisplaySleep: () => {} },
    './memoryMetrics.ts': { recordMemoryCheckpoint: () => {} },
  }, { platform: 'darwin', env: {} });
  const session = new module.LibMpvSession({ libraryPath: '/fixture/libmpv.dylib', api: {
    create: () => 1n, attach: () => 0,
    command: (_engine, _id, json) => { sent.push(JSON.parse(json)); return 0; },
    pollInto: () => 0, destroy: () => { destroyed++; },
  } }, owner, { isMinimized: () => false, isVisible: () => true }, '/fixture/movie.mkv', options, () => {});
  const receive = (...messages) => {
    for (const message of messages) session.handle(message);
    session.acceptIfReady();
  };
  const playable = (decoder) => receive(
    { event: 'file-loaded' },
    { event: 'property-change', name: 'track-list', data: [{ id: 1, type: 'video', source: 'embedded' }] },
    { event: 'property-change', name: 'hwdec-current', data: decoder },
    { event: 'property-change', name: 'video-params', data: { w: 3840, h: 2160 } },
    { event: 'playback-restart' },
  );
  return { session, receive, playable, sent, updates, visibility, destroyed: () => destroyed };
}

test('mpv waits for a real hardware decoder and first restart before accepting the candidate', async () => {
  const f = mpvStartupFixture({ decodeMode: 'hardware', paused: true, muted: false, startSeconds: 900 });
  assert.deepEqual(f.visibility, [false]);
  assert.equal(f.updates.length, 0);
  assert.ok(f.sent.some(command => command[1] === 'hwdec' && command[2] === 'videotoolbox,videotoolbox-copy'));
  assert.ok(f.sent.some(command => command[1] === 'start' && command[2] === 900));
  f.receive({ event: 'file-loaded' }, { event: 'playback-restart' });
  assert.equal(f.updates.length, 0);
  f.playable('videotoolbox');
  assert.deepEqual(await f.session.startup, { ok: true });
  assert.equal(f.updates.at(-1).paused, true);
  assert.equal(f.updates.at(-1).diagnostics.hardwareDecode, true);
  assert.equal(f.visibility.at(-1), true);
  f.session.stop();
  assert.equal(f.destroyed(), 1);
});

test('mpv rejects silent software fallback and releases the failed candidate without flashing an error', async () => {
  const f = mpvStartupFixture({ decodeMode: 'hardware' });
  f.playable('no');
  const result = await f.session.startup;
  assert.equal(result.ok, false);
  assert.match(result.error, /hardware decoder/);
  assert.equal(f.destroyed(), 1);
  assert.equal(f.updates.length, 0);
  assert.deepEqual(f.visibility, [false]);
});

test('mpv software fallback explicitly disables hardware and restores playback state', async () => {
  const f = mpvStartupFixture({ decodeMode: 'software', muted: true, volume: 0.35, speed: 1.5 });
  f.playable('no');
  assert.deepEqual(await f.session.startup, { ok: true });
  assert.ok(f.sent.some(command => command[1] === 'hwdec' && command[2] === 'no'));
  assert.ok(f.sent.some(command => command[1] === 'hwdec-software-fallback' && command[2] === 'yes'));
  assert.ok(f.sent.some(command => command[1] === 'volume' && command[2] === 35));
  assert.equal(f.updates.at(-1).muted, true);
  assert.equal(f.updates.at(-1).paused, false);
  f.session.stop();
});

test('mpv cancellation settles a pending startup and destroys the native core once', async () => {
  const f = mpvStartupFixture();
  f.session.stop();
  assert.equal((await f.session.startup).ok, false);
  f.session.stop();
  assert.equal(f.destroyed(), 1);
});

test('mpv does not accept an audio restart when the video decoder has produced no frame', async () => {
  const f = mpvStartupFixture({ decodeMode: 'software' });
  f.receive({ event: 'file-loaded' }, { event: 'playback-restart' },
    { event: 'property-change', name: 'track-list', data: [{ id: 1, type: 'video' }] },
    { event: 'property-change', name: 'hwdec-current' });
  assert.equal(f.updates.length, 0);
  assert.deepEqual(f.visibility, [false]);
  f.session.stop();
  assert.equal((await f.session.startup).ok, false);
});

test('MPV availability and startup diagnostics never dlopen or create a player', () => {
  const f = mpvFixture();
  for (let i = 0; i < 10; i++) {
    assert.equal(f.module.libMpvAvailability().verification, 'detected');
    assert.equal(f.module.libMpvAvailability(true).available, true);
    assert.match(f.module.libMpvRuntimeSummary(), /loads only when selected/);
  }
  assert.equal(f.loads(), 0);
  assert.equal(f.creates(), 0);
});

test('a missing MPV library is detected without loading native code', () => {
  const f = mpvFixture(false);
  assert.equal(f.module.libMpvAvailability().available, false);
  assert.equal(f.loads(), 0);
});

test('selecting MPV loads it on demand and reports core startup failure', async () => {
  const f = mpvFixture();
  const result = await f.module.startLibMpvPlayback(new EventEmitter(), '/fixture/movie.mkv');
  assert.equal(result.ok, false);
  assert.match(result.error, /could not create a playback core/);
  assert.equal(f.loads(), 1);
  assert.equal(f.creates(), 1);
});

function vlcFixture(platform = 'darwin') {
  const app = new EventEmitter();
  app.isReady = () => false;
  let created = 0;
  let released = 0;
  const loads = [];
  const koffi = {
    load: filename => {
      loads.push(filename);
      return { func: name => {
        if (name === 'libvlc_new') return () => { created++; return 42n; };
        if (name === 'libvlc_release') return handle => { assert.equal(handle, 42n); released++; };
        if (name === 'libvlc_get_version') return () => 'fixture-vlc';
        return () => 0;
      } };
    },
    struct: value => value,
    decode: () => ({}),
  };
  const fakeProcess = { platform, arch: 'arm64', env: { LOOMTV_LIBVLC_PATH: '/fixture/libvlc.dylib' } };
  const filesystem = nativeFs(new Set(['/fixture/libvlc.dylib', '/fixture/libvlccore.dylib', '/fixture/libvlccore.dll']));
  const common = {
    electron: { app, BrowserWindow: {} },
    'node:fs': filesystem,
    koffi,
    './libvlcRuntimeConfig.ts': { LIBVLC_INSTANCE_ARGUMENTS: ['--no-plugins-cache', '--quiet'] },
    './playbackDiagnostics.ts': { recordPlaybackDiagnostic: () => {}, playbackDiagnostics: () => {} },
    './memoryMetrics.ts': { recordMemoryCheckpoint: () => {} },
  };
  const warm = compile('main/libvlcWarmup.ts', common, fakeProcess);
  const playback = compile('main/libvlcPlayback.ts', {
    ...common,
    './libvlcWarmup.ts': warm,
    './nativePlaybackPower': { releaseNativePlaybackDisplaySleep: () => {}, syncNativePlaybackDisplaySleep: () => {} },
    './libvlcPlatform.ts': { libVlcPlatformBinding: () => ({ drawableSymbol: 'libvlc_media_player_set_nsobject' }), libVlcPlatformVariants: () => ['darwin'], orderWindowsLibVlcChildren: () => {} },
    './libvlcSessionState.ts': { captureLibVlcTrackSelection: () => ({}), restoreLibVlcTrackSelection: () => {} },
  }, fakeProcess);
  return { app, warm, playback, loads, created: () => created, released: () => released };
}

test('Windows still prewarms LibVLC and keeps its shared instance until quit', () => {
  const f = vlcFixture('win32');
  assert.equal(f.created(), 0);
  f.app.emit('ready');
  assert.equal(f.created(), 1);
  assert.equal(f.warm.getWarmLibVlcInstance('/fixture/libvlc.dylib'), 42n);
  assert.equal(f.released(), 0);
  f.app.emit('will-quit');
  assert.equal(f.released(), 1);
});

test('macOS leaves VLC unloaded until requested and reuses it through quit', () => {
  const f = vlcFixture();
  f.app.emit('ready');
  assert.equal(f.created(), 0);
  assert.deepEqual(f.loads, []);
  assert.equal(f.warm.getWarmLibVlcInstance('/fixture/libvlc.dylib'), 42n);
  assert.equal(f.warm.getWarmLibVlcInstance('/fixture/libvlc.dylib'), 42n);
  assert.equal(f.created(), 1);
  assert.deepEqual(f.loads, ['/fixture/libvlccore.dylib', '/fixture/libvlc.dylib']);
  f.app.emit('will-quit');
  assert.equal(f.released(), 1);
});

test('LibVLC availability reuses the prewarmed library handles without loading twice', () => {
  const f = vlcFixture();
  f.warm.warmLibVlcRuntime();
  assert.equal(f.playback.libVlcAvailability().available, true);
  assert.equal(f.playback.refreshLibVlcAvailability().available, true);
  assert.deepEqual(f.loads, ['/fixture/libvlccore.dylib', '/fixture/libvlc.dylib']);
  assert.equal(f.created(), 1);
  assert.equal(f.warm.getWarmLibVlcLibraries('/different/libvlc.dylib'), null);
  f.app.emit('will-quit');
});

test('paused LibVLC stops duplicate IPC and wakes immediately for seek and resume', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1000 });
  const f = vlcFixture();
  const session = Object.create(f.playback.LibVlcPlaybackSession.prototype);
  const messages = [];
  let nativeState = 4;
  let positionMs = 20_000;
  Object.assign(session, {
    id: 'paused-session', player: 1n, stopped: false, ended: false, verified: true,
    state: { sessionId: 'paused-session', status: 'ready', paused: true, position: 20, duration: 60 },
    requestedPaused: true, pauseAcknowledgementDeadline: 0, rapidPollUntil: 0,
    replaySeek: null, startSeconds: 0, timer: null, pollIntervalMs: 16,
    owner: { isDestroyed: () => false, send: (_channel, state) => messages.push(state) },
    runtime: { api: {
      playerGetState: () => nativeState,
      playerGetTime: () => positionMs,
      playerGetLength: () => 60_000,
      playerSetTime: (_player, position) => { positionMs = position; },
      playerSetPause: (_player, paused) => { nativeState = paused ? 4 : 3; },
    } },
    applyPendingRearmTrackSelection: () => {}, applyInitialAudioSelection: () => {}, refreshNativeTracks: () => {},
  });
  session.poll();
  assert.equal(session.pollIntervalMs, 250);
  t.mock.timers.tick(60_000);
  assert.equal(messages.length, 0);
  // Seeking to the current timestamp must still acknowledge the renderer's
  // optimistic loading state, even though its numeric position is unchanged.
  assert.equal(session.command({ type: 'seek', position: 20 }), true);
  assert.equal(session.pollIntervalMs, 16);
  assert.equal(messages.at(-1).status, 'loading');
  session.poll();
  assert.equal(messages.at(-1).status, 'ready');
  assert.equal(session.command({ type: 'set-paused', paused: false }), true);
  session.poll();
  assert.equal(session.pollIntervalMs, 16);
  positionMs += 16;
  session.poll();
  assert.equal(messages.at(-1).position, 20.016);
  assert.equal(messages.at(-1).paused, false);
  clearInterval(session.timer);
});

test('idle UI preloads stay removed while platform engine preferences remain', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');
  assert.doesNotMatch(read('components/VideoPlayer/LazyVideoPlayer.tsx'), /requestIdleCallback|setTimeout/);
  assert.doesNotMatch(read('App.tsx'), /component\.preload\?\./);
  assert.doesNotMatch(read('components/VideoPlayer.tsx'), /void MpvPlaybackEngine\.available\(\)/);
  assert.doesNotMatch(read('components/VideoPlayer.tsx'), /void LibVlcPlaybackEngine\.available\(\)/);
  assert.match(read('components/VideoPlayer.tsx'), /LibVlcPlaybackEngine/);
  assert.match(read('components/VideoPlayer.tsx'), /MpvPlaybackEngine/);
  assert.match(read('main/libvlcWarmup.ts'), /electronApp\.once\('ready'/);
  assert.match(read('main.ts'), /rendererReadCacheKey\(revision, mediaId\)/);
  assert.match(read('main.ts'), /new IdleValueCache<LibraryData>\(30_000\)/);
});

test('mpv clears cropping with an empty geometry accepted by libmpv', () => {
  const { module } = mpvFixture();
  assert.deepEqual(module.commandList({ type: 'set-video-crop', crop: null }), [['set_property', 'video-crop', '']]);
});

test('mpv recognizes keep-open EOF and clears ended status after seeking', () => {
  const { module } = mpvFixture();
  const session = Object.create(module.LibMpvSession.prototype);
  const updates = [];
  session.accepted = true;
  session.emit = patch => updates.push(patch);
  session.handle({ event: 'property-change', name: 'eof-reached', data: 1 });
  session.handle({ event: 'playback-restart' });
  session.handle({ event: 'property-change', name: 'pause', data: 1 });
  session.handle({ event: 'property-change', name: 'pause', data: 0 });
  assert.deepEqual(updates, [{ status: 'ended', paused: true }, { status: 'ready' }, { paused: true }, { paused: false }]);
});
