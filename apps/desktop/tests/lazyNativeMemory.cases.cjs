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
  const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
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
    electron: { BrowserWindow: { fromWebContents: () => ({}) } },
    'node:fs': nativeFs(new Set(present ? ['/fixture/libmpv.dylib', '/fixture/bridge.dylib'] : [])),
    './mpvPlaybackHelpers.ts': { finiteNumber: v => Number(v), normalizeMpvTracks: () => [] },
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

test('selecting MPV loads it on demand and reports core startup failure', () => {
  const f = mpvFixture();
  const result = f.module.startLibMpvPlayback(new EventEmitter(), '/fixture/movie.mkv');
  assert.equal(result.ok, false);
  assert.match(result.error, /could not create a playback core/);
  assert.equal(f.loads(), 1);
  assert.equal(f.creates(), 1);
});

function vlcFixture() {
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
  const fakeProcess = { platform: 'darwin', arch: 'arm64', env: { LOOMTV_LIBVLC_PATH: '/fixture/libvlc.dylib' } };
  const filesystem = nativeFs(new Set(['/fixture/libvlc.dylib', '/fixture/libvlccore.dylib']));
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

test('LibVLC still prewarms on app ready and keeps its shared instance until quit', () => {
  const f = vlcFixture();
  assert.equal(f.created(), 0);
  f.app.emit('ready');
  assert.equal(f.created(), 1);
  assert.equal(f.warm.getWarmLibVlcInstance('/fixture/libvlc.dylib'), 42n);
  assert.equal(f.released(), 0);
  f.app.emit('will-quit');
  assert.equal(f.released(), 1);
});

test('LibVLC availability reuses the prewarmed library handles without loading twice', () => {
  const f = vlcFixture();
  f.app.emit('ready');
  assert.equal(f.playback.libVlcAvailability().available, true);
  assert.equal(f.playback.refreshLibVlcAvailability().available, true);
  assert.deepEqual(f.loads, ['/fixture/libvlccore.dylib', '/fixture/libvlc.dylib']);
  assert.equal(f.created(), 1);
  assert.equal(f.warm.getWarmLibVlcLibraries('/different/libvlc.dylib'), null);
  f.app.emit('will-quit');
});

test('idle UI preloads stay removed while LibVLC engine preference and warmup remain', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');
  assert.doesNotMatch(read('components/VideoPlayer/LazyVideoPlayer.tsx'), /requestIdleCallback|setTimeout/);
  assert.doesNotMatch(read('App.tsx'), /component\.preload\?\./);
  assert.doesNotMatch(read('components/VideoPlayer.tsx'), /void MpvPlaybackEngine\.available\(\)/);
  assert.match(read('components/VideoPlayer.tsx'), /\[LibVlcPlaybackEngine, MpvPlaybackEngine\]/);
  assert.match(read('main/libvlcWarmup.ts'), /electronApp\.once\('ready'/);
  assert.match(read('main.ts'), /rendererReadCacheKey\(revision, mediaId\)/);
  assert.match(read('main.ts'), /new IdleValueCache<LibraryData>\(30_000\)/);
});
