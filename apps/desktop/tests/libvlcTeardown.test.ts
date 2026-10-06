import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import * as ts from 'typescript';
import type { PlaybackState } from '../src/shared/playbackProtocol.ts';
import * as platform from '../src/main/libvlcPlatform.ts';
import * as sessionState from '../src/main/libvlcSessionState.ts';
import { restoreOffscreenTrack } from '../src/main/offscreenVideoRestore.ts';
import * as resumeRewind from '../src/shared/resumeRewind.ts';

function loadModule(name: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}, extra = '') {
  const source = fs.readFileSync(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8')
    .replace('const require = createRequire(__filename);', '');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code + extra, {
    module, exports: module.exports, Buffer, console, __filename: `/mock/${name}.js`,
    require: (id: string) => {
      if (id === '../shared/resumeRewind.ts') return resumeRewind;
      assert.ok(id in dependencies, `Unexpected dependency ${id}`);
      return dependencies[id];
    },
    ...globals,
  });
  return module.exports;
}

const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

test('every LibVLC async teardown binding has an integer return type for Electron 43', async () => {
  const f = fixture();
  const declarations = new Map<string, unknown>();
  const calls: string[] = [];
  const library = {
    func: (name: string, returnType: unknown) => {
      declarations.set(name, returnType);
      return Object.assign(() => name === 'libvlc_get_version' ? '3.0.21' : 1, {
        async: (_handle: number, callback: (error: Error | null, result: number) => void) => {
          assert.equal(returnType, 'int', `${name} .async must not use a void return`);
          calls.push(name);
          callback(null, 0);
        },
      });
    },
  };
  const runtime = f.playback.bindRuntime(library);
  assert.ok(runtime);
  const source = fs.readFileSync(new URL('../src/main/libvlcPlayback.ts', import.meta.url), 'utf8');
  const bindings = new Set([...source.matchAll(/callLibVlcAsync\((?:this\.runtime\.api|api)\.(\w+),/g)]
    .map((match) => match[1]));
  assert.equal(bindings.size, 4);
  for (const binding of bindings) await f.teardown.callLibVlcAsync(runtime.api[binding], 1);

  const warmup = loadModule('libvlcWarmup', {
    electron: {}, 'node:fs': fs, 'node:path': path,
    './libvlcRuntimeConfig.ts': { LIBVLC_INSTANCE_ARGUMENTS: [] },
    './playbackDiagnostics.ts': { recordPlaybackDiagnostic: () => undefined },
    './libvlcTeardown.ts': f.teardown,
  }, {
    process: { platform: 'darwin', arch: 'arm64', env: {} },
  }, 'module.exports.loadCandidate = loadCandidate;') as {
    loadCandidate: (koffi: unknown, libraryPath: string) => {
      instance: number; release: Parameters<typeof f.teardown.callLibVlcAsync>[0];
    };
  };
  const warm = warmup.loadCandidate({ load: () => library }, '/mock/libvlc');
  assert.ok(warm);
  await f.teardown.callLibVlcAsync(warm.release, warm.instance);
  assert.equal(calls.length, 5);
  assert.equal(declarations.get('libvlc_media_add_option'), 'void');
  assert.equal(declarations.get('libvlc_track_description_list_release'), 'void');
});

function fixture(sharedInstance: number | null = null) {
  const events: string[] = [];
  const pending: Array<{ name: string; handle: number; callback: (error: Error | null) => void }> = [];
  const players = new Map<number, { state: number; positionMs: number; durationMs: number; stopping: boolean; releasing: boolean }>();
  const views = new Map<number, boolean>();
  const intervals = new Map<() => void, number>();
  const timeouts = new Set<() => void>();
  const sent: PlaybackState[] = [];
  const powerStates: Array<Pick<PlaybackState, 'status' | 'paused'>> = [];
  const descriptions = new Map<number, { i_id: number; psz_name: string; p_next: number | null }>();
  let audioTracks: Array<{ id: number; title: string }> = [];
  let selectedAudioTrack = 1;
  let trackReads = 0;
  let stateReads = 0;
  let now = 10_000;
  let pauseImmediately = true;
  let handle = 0;
  let playFails = false;
  const livePlayer = (id: number) => {
    const player = players.get(id);
    assert.ok(player, `Use after release: ${id}`);
    assert.equal(player.stopping, false, `Call during stop: ${id}`);
    assert.equal(player.releasing, false, `Call after release was scheduled: ${id}`);
    return player;
  };
  const blocking = (name: string) => Object.assign(() => { assert.fail(`Synchronous ${name}`); }, {
    async: (id: number, callback: (error: Error | null) => void) => {
      if (name === 'stop') livePlayer(id).stopping = true;
      if (name === 'player-release') livePlayer(id).releasing = true;
      events.push(`${name}:queued:${id}`);
      pending.push({ name, handle: id, callback });
    },
  });
  const api = {
    newInstance: () => ++handle,
    releaseInstance: blocking('instance-release'),
    mediaNewPath: () => ++handle,
    mediaAddOption: () => undefined,
    mediaRelease: blocking('media-release'),
    playerNewFromMedia: () => {
      const id = ++handle;
      players.set(id, { state: 3, positionMs: 12000, durationMs: 60000, stopping: false, releasing: false });
      events.push(`create:${id}`);
      return id;
    },
    playerStop: blocking('stop'),
    playerRelease: blocking('player-release'),
    playerPlay: (id: number) => { livePlayer(id).state = 3; events.push(`play:${id}`); return playFails ? -1 : 0; },
    playerGetState: (id: number) => { stateReads++; return livePlayer(id).state; },
    playerGetTime: (id: number) => livePlayer(id).positionMs,
    playerGetLength: (id: number) => livePlayer(id).durationMs,
    playerSetTime: (id: number, value: number) => { livePlayer(id).positionMs = value; events.push(`seek:${id}:${value}`); },
    playerSetPause: (id: number, paused: number) => { if (pauseImmediately) livePlayer(id).state = paused ? 4 : 3; },
    setDrawable: (id: number) => { livePlayer(id); },
    audioSetVolume: (id: number) => { livePlayer(id); return 0; },
    audioSetMute: (id: number) => { livePlayer(id); },
    audioGetTrack: (id: number) => { livePlayer(id); return selectedAudioTrack; },
    audioSetTrack: (id: number, trackId: number) => { livePlayer(id); selectedAudioTrack = trackId; return 0; },
    audioGetTrackDescription: (id: number) => {
      livePlayer(id); trackReads++;
      descriptions.clear();
      audioTracks.forEach((track, index) => descriptions.set(1000 + index, {
        i_id: track.id, psz_name: track.title, p_next: index + 1 < audioTracks.length ? 1001 + index : null,
      }));
      return audioTracks.length > 0 ? 1000 : null;
    },
    trackDescriptionListRelease: () => undefined,
    playerSetRate: (id: number) => { livePlayer(id); return 0; },
  };
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string, state: PlaybackState) => { if (channel === 'libvlc:state') sent.push(state); },
  });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, isFullScreen: () => false,
  });
  const host = () => {
    const id = views.size + 1;
    views.set(id, true);
    return {
      drawable: id, syncBounds: () => undefined, syncHierarchy: () => false,
      setVisible: () => undefined, setAutoresize: () => undefined,
      destroy: () => { assert.equal(views.get(id), true); views.set(id, false); events.push(`destroy:${id}`); },
    };
  };
  const teardown = loadModule('libvlcTeardown', {}, { setTimeout, clearTimeout }) as typeof import('../src/main/libvlcTeardown.ts');
  const warmup = loadModule('libvlcWarmup', {
    electron: {}, 'node:fs': fs, 'node:path': path,
    './libvlcRuntimeConfig.ts': { LIBVLC_INSTANCE_ARGUMENTS: [] },
    './playbackDiagnostics.ts': { recordPlaybackDiagnostic: () => undefined },
    './libvlcTeardown.ts': teardown,
  }, {
    process: { platform: 'darwin', arch: 'arm64', env: {} },
    fixtureWarmInstance: sharedInstance, fixtureWarmRelease: blocking('warm-release'),
  }, `
    warmupStarted = true;
    warmRuntime = fixtureWarmInstance === null ? null : {
      instance: fixtureWarmInstance, release: fixtureWarmRelease, libraries: [], libraryPath: '/mock/libvlc',
    };
  `) as typeof import('../src/main/libvlcWarmup.ts');
  const playback = loadModule('libvlcPlayback', {
    electron: { BrowserWindow: { fromWebContents: () => window } },
    'node:module': { createRequire: () => () => ({}) },
    'node:crypto': { randomUUID: () => `session-${++handle}` },
    'node:fs': fs, 'node:path': path,
    'node:util': { isDeepStrictEqual },
    './offscreenVideoRestore.ts': { restoreOffscreenTrack },
    './nativePlaybackPower': {
      releaseNativePlaybackDisplaySleep: () => undefined,
      syncNativePlaybackDisplaySleep: (_id: string, state: Pick<PlaybackState, 'status' | 'paused'>) => { powerStates.push(state); },
    },
    './libvlcPlatform.ts': platform,
    './libvlcWarmup.ts': warmup,
    './libvlcTeardown.ts': teardown,
    './libvlcRuntimeConfig.ts': { LIBVLC_INSTANCE_ARGUMENTS: [] },
    './playbackDiagnostics.ts': { recordPlaybackDiagnostic: () => undefined, playbackDiagnostics: () => [] },
    './screenLock.ts': { isScreenLocked: () => false },
    './libvlcSessionState.ts': sessionState,
  }, {
    process: { platform: 'darwin', arch: 'arm64', env: {} }, fixtureApi: api, fixtureHost: host,
    fixtureDecode: (pointer: number) => descriptions.get(pointer),
    Date: class extends Date { static now() { return now; } },
    setInterval: (fn: () => void, ms: number) => { intervals.set(fn, ms); return { unref: () => undefined, fn }; },
    clearInterval: (timer: { fn: () => void }) => { intervals.delete(timer.fn); },
    setTimeout: (fn: () => void) => { timeouts.add(fn); return { unref: () => undefined, fn }; },
    clearTimeout: (timer: { fn: () => void }) => { timeouts.delete(timer.fn); },
  }, `
    cachedRuntime = () => ({ runtime: {
      api: fixtureApi, libraryPath: '/mock/libvlc', decode: fixtureDecode, trackDescriptionType: {},
    } });
    createNativeViewHost = fixtureHost;
    loadKoffi = () => ({});
    module.exports.session = () => currentSession;
    module.exports.bindRuntime = (library) => {
      loadKoffi = () => ({ load: () => library, struct: () => ({}), decode: () => ({}) });
      candidateLibraryPaths = () => [{ path: '/mock/libvlc', source: 'environment' }];
      return loadRuntime().runtime;
    };
  `) as typeof import('../src/main/libvlcPlayback.ts') & {
    session: () => { stop: () => boolean; rearmNativeVideoOutput: () => void };
    bindRuntime: (library: unknown) => { api: Record<string, Parameters<typeof teardown.callLibVlcAsync>[0]> };
  };
  const complete = async (name: string, error: Error | null = null) => {
    const item = pending.shift();
    assert.ok(item);
    assert.equal(item.name, name);
    events.push(`${name}:returned:${item.handle}`);
    if (name === 'stop') {
      const player = players.get(item.handle);
      assert.ok(player); player.stopping = false;
      if (!error) player.state = 5;
    }
    if (name === 'player-release' && !error) players.delete(item.handle);
    item.callback(error);
    await flush();
  };
  const drain = async () => {
    await flush();
    while (pending.length) await complete(pending[0].name);
  };
  const start = () => {
    const result = playback.startLibVlcPlayback(owner as never, 'toy.mkv');
    assert.equal(result.ok, true, result.error);
    assert.ok(result.sessionId);
    return { sessionId: result.sessionId, player: handle, session: playback.session() };
  };
  return { playback, teardown, warmup, events, pending, players, views, intervals, timeouts, owner, start, complete, drain, sent, powerStates,
    failPlay: () => { playFails = true; }, poll: () => { for (const fn of [...intervals.keys()]) fn(); },
    advance: (ms: number) => { now += ms; }, deferPause: () => { pauseImmediately = false; },
    stateReads: () => stateReads, trackReads: () => trackReads,
    setAudioTracks: (tracks: typeof audioTracks) => { audioTracks = tracks; },
  };
}

test('unchanged paused LibVLC polls send no state and skip display-sleep sync and extra state reads', async () => {
  const f = fixture();
  const first = f.start();
  f.poll();
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'set-paused', paused: true }), true);
  f.poll();
  assert.deepEqual([...f.intervals.values()], [250]);
  const sends = f.sent.length;
  const syncs = f.powerStates.length;
  const reads = f.stateReads();
  for (let index = 0; index < 100; index++) { f.advance(250); f.poll(); }
  assert.equal(f.sent.length - sends, 0);
  assert.equal(f.powerStates.length - syncs, 0);
  assert.equal(f.stateReads() - reads, 100);
  f.playback.stopLibVlcPlayback();
  await f.drain();
});

test('LibVLC sends each changed control and progress value once, including cleared values and errors', async () => {
  const f = fixture();
  const first = f.start();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].status, 'loading');
  f.poll();
  const commands = [
    { type: 'set-paused', paused: true },
    { type: 'set-volume', volume: 0.5 },
    { type: 'set-muted', muted: true },
    { type: 'set-speed', speed: 1.5 },
  ] as const;
  for (const command of commands) {
    const before = f.sent.length;
    assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, command), true);
    assert.equal(f.sent.length, before + 1, command.type);
    assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, command), true);
    f.poll();
    assert.equal(f.sent.length, before + 1, `Repeated ${command.type}`);
  }
  const player = f.players.get(first.player);
  assert.ok(player);
  for (const [position, duration] of [[13000, 60000], [13000, 61000], [-1, -1]]) {
    player.positionMs = position; player.durationMs = duration;
    const before = f.sent.length;
    f.poll();
    assert.equal(f.sent.length, before + 1);
    f.poll();
    assert.equal(f.sent.length, before + 1);
  }
  assert.equal(f.sent.at(-1)?.position, undefined);
  assert.equal(f.sent.at(-1)?.duration, undefined);
  player.state = 7;
  f.poll();
  assert.equal(f.sent.at(-1)?.status, 'error');
  assert.equal(f.sent.at(-1)?.error, 'LibVLC reported a playback error.');
  await f.drain();
});

test('native pause acknowledgement updates display sleep even when optimistic renderer state is unchanged', async () => {
  const f = fixture();
  const first = f.start();
  f.poll();
  f.deferPause();
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'set-paused', paused: true }), true);
  const sends = f.sent.length;
  const syncs = f.powerStates.length;
  f.poll();
  assert.equal(f.sent.length, sends);
  assert.equal(f.powerStates.length, syncs);
  assert.equal(f.powerStates.at(-1)?.paused, false);
  assert.deepEqual([...f.intervals.values()], [16]);
  const player = f.players.get(first.player);
  assert.ok(player); player.state = 4;
  f.poll();
  assert.equal(f.sent.length, sends);
  assert.equal(f.powerStates.length, syncs + 1);
  assert.equal(f.powerStates.at(-1)?.paused, true);
  assert.deepEqual([...f.intervals.values()], [250]);
  f.playback.stopLibVlcPlayback();
  await f.drain();
});

test('LibVLC resume and paused seek restore 16 ms polling immediately and report the landed seek', async () => {
  const f = fixture();
  const first = f.start();
  f.poll();
  f.playback.commandLibVlcPlayback(first.sessionId, { type: 'set-paused', paused: true });
  f.poll();
  assert.deepEqual([...f.intervals.values()], [250]);
  const sends = f.sent.length;
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'seek', position: 5 }), true);
  assert.deepEqual([...f.intervals.values()], [16]);
  f.poll();
  assert.equal(f.sent.length, sends + 1);
  assert.equal(f.sent.at(-1)?.position, 5);
  assert.equal(f.sent.at(-1)?.paused, true);
  f.advance(749); f.poll();
  assert.deepEqual([...f.intervals.values()], [16]);
  f.advance(1); f.poll();
  assert.deepEqual([...f.intervals.values()], [250]);
  const samePositionSends = f.sent.length;
  f.playback.commandLibVlcPlayback(first.sessionId, { type: 'seek', position: 5 });
  assert.deepEqual([...f.intervals.values()], [16]);
  f.poll();
  assert.equal(f.sent.length, samePositionSends + 1);
  assert.equal(f.sent.at(-1)?.position, 5);
  f.poll();
  assert.equal(f.sent.length, samePositionSends + 1);
  f.advance(750); f.poll();
  assert.deepEqual([...f.intervals.values()], [250]);
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'set-paused', paused: false }), true);
  assert.deepEqual([...f.intervals.values()], [16]);
  assert.equal(f.sent.at(-1)?.paused, false);
  f.poll();
  assert.deepEqual([...f.intervals.values()], [16]);
  f.playback.stopLibVlcPlayback();
  await f.drain();
});

test('LibVLC track discovery slows after startup and still reports additions, selection and removal within a second', async () => {
  const f = fixture();
  f.setAudioTracks([{ id: 1, title: 'English' }]);
  const first = f.start();
  f.poll();
  const initialReads = f.trackReads();
  f.advance(499); f.poll();
  assert.equal(f.trackReads(), initialReads);
  f.advance(1); f.poll();
  assert.equal(f.trackReads(), initialReads + 1);
  f.advance(4500); f.poll();
  const reads = f.trackReads();
  const sends = f.sent.length;
  f.setAudioTracks([{ id: 1, title: 'English' }, { id: 2, title: 'French' }]);
  f.advance(500); f.poll();
  assert.equal(f.trackReads(), reads);
  assert.equal(f.sent.length, sends);
  f.advance(500); f.poll();
  assert.equal(f.trackReads(), reads + 1);
  assert.equal(f.sent.length, sends + 1);
  assert.equal(f.sent.at(-1)?.tracks?.length, 2);
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'set-audio-track', trackId: 2 }), true);
  assert.equal(f.sent.length, sends + 2);
  assert.equal(f.sent.at(-1)?.tracks?.find((track) => track.id === 2)?.selected, true);
  f.playback.commandLibVlcPlayback(first.sessionId, { type: 'set-audio-track', trackId: 2 });
  assert.equal(f.sent.length, sends + 2);
  f.setAudioTracks([]);
  f.advance(1000); f.poll();
  assert.equal(f.sent.length, sends + 3);
  assert.equal(f.sent.at(-1)?.tracks?.length, 0);
  f.playback.stopLibVlcPlayback();
  await f.drain();
});

test('stop detaches immediately and retains the view until worker stop and releases return', async () => {
  const f = fixture();
  const first = f.start();
  assert.equal(f.playback.stopLibVlcPlayback(first.sessionId), true);
  assert.equal(first.session.stop(), false);
  assert.equal(f.playback.stopLibVlcPlayback(first.sessionId), false);
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'set-muted', muted: true }), false);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.owner.listenerCount('destroyed'), 0);
  await flush();
  assert.equal(f.views.get(1), true);
  assert.equal(f.pending.length, 1);
  await f.complete('stop');
  assert.equal(f.views.get(1), true);
  await f.complete('player-release');
  await f.complete('media-release');
  assert.equal(f.views.get(1), true);
  await f.complete('instance-release');
  assert.equal(f.views.get(1), false);
  assert.deepEqual(f.events.filter((event) => !event.startsWith('create:') && !event.startsWith('play:')), [
    `stop:queued:${first.player}`, `stop:returned:${first.player}`,
    `player-release:queued:${first.player}`, `player-release:returned:${first.player}`,
    'media-release:queued:3', 'media-release:returned:3',
    'instance-release:queued:2', 'instance-release:returned:2', 'destroy:1',
  ]);
});

test('replacement starts during old teardown and never releases the borrowed instance', async () => {
  const f = fixture(900);
  const first = f.start();
  const second = f.start();
  await flush();
  assert.ok(f.events.includes(`play:${second.player}`));
  assert.equal(f.players.get(first.player)?.stopping, true);
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'seek', position: 2 }), false);
  assert.equal(f.playback.commandLibVlcPlayback(second.sessionId, { type: 'seek', position: 2 }), true);
  await f.drain();
  assert.equal(f.views.get(1), false);
  assert.equal(f.views.get(2), true);
  assert.equal(f.events.some((event) => event.startsWith('instance-release:')), false);
  f.playback.stopLibVlcPlayback();
  await f.drain();
});

test('re-arm waits for stop and release before creating a player and blocks JS access while waiting', async () => {
  const f = fixture();
  const first = f.start();
  first.session.rearmNativeVideoOutput();
  f.poll();
  f.playback.syncLibVlcPlaybackSurface(f.owner as never);
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'seek', position: 3 }), false);
  await flush();
  await f.complete('stop');
  assert.equal(f.events.filter((event) => event.startsWith('create:')).length, 1);
  await f.complete('player-release');
  assert.equal(f.events.filter((event) => event.startsWith('create:')).length, 2);
  assert.equal(f.views.get(1), true);
  for (const fn of f.timeouts) fn();
  f.playback.stopLibVlcPlayback();
  await f.drain();
});

test('stopping during re-arm skips recreation and keeps media and view alive until release completes', async () => {
  const f = fixture();
  const first = f.start();
  first.session.rearmNativeVideoOutput();
  first.session.stop();
  await flush();
  await f.complete('stop');
  assert.equal(f.pending[0].name, 'player-release');
  assert.equal(f.views.get(1), true);
  await f.complete('player-release');
  assert.equal(f.events.filter((event) => event.startsWith('create:')).length, 1);
  await f.drain();
  assert.equal(f.views.get(1), false);
});

test('replay waits for worker stop and applies the latest seek and pause after playback resumes', async () => {
  const f = fixture();
  const first = f.start();
  const player = f.players.get(first.player);
  assert.ok(player); player.state = 6;
  f.poll();
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'seek', position: 4 }), true);
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'seek', position: 9 }), true);
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'set-paused', paused: false }), true);
  assert.equal(f.playback.commandLibVlcPlayback(first.sessionId, { type: 'set-volume', volume: 0.5 }), false);
  f.poll();
  f.playback.syncLibVlcPlaybackSurface(f.owner as never);
  await flush();
  assert.equal(f.events.filter((event) => event.startsWith('play:')).length, 1);
  await f.complete('stop');
  assert.equal(f.events.filter((event) => event.startsWith('play:')).length, 2);
  f.poll();
  assert.ok(f.events.includes(`seek:${first.player}:9000`));
  assert.equal(player.state, 3);
  f.playback.stopLibVlcPlayback();
  await f.drain();
});

test('replacement during replay releases the stopped player without restarting or stopping it twice', async () => {
  const f = fixture();
  const first = f.start();
  const player = f.players.get(first.player);
  assert.ok(player); player.state = 6;
  f.playback.commandLibVlcPlayback(first.sessionId, { type: 'set-paused', paused: false });
  f.start();
  await f.drain();
  assert.equal(f.events.filter((event) => event === `stop:queued:${first.player}`).length, 1);
  assert.equal(f.events.filter((event) => event === `play:${first.player}`).length, 1);
  assert.equal(f.views.get(1), false);
  f.playback.stopLibVlcPlayback();
  await f.drain();
});

for (const state of [5, 7]) {
  test(`native state ${state} finishes through worker teardown`, async () => {
    const f = fixture();
    const first = f.start();
    const player = f.players.get(first.player);
    assert.ok(player); player.state = state;
    f.poll();
    assert.equal(f.playback.stopLibVlcPlayback(), false);
    assert.equal(f.views.get(1), true);
    await f.drain();
    assert.equal(f.views.get(1), false);
  });
}

test('owner destruction and failed startup also retain the view during worker teardown', async () => {
  const f = fixture();
  f.start();
  f.owner.emit('destroyed');
  await f.drain();
  f.failPlay();
  assert.equal(f.playback.startLibVlcPlayback(f.owner as never, 'toy.mkv').ok, false);
  assert.equal(f.views.get(2), true);
  await f.drain();
  assert.equal(f.views.get(2), false);
  assert.equal(f.players.size, 0);
});

test('delayed NSView destruction releases the retained views without messaging a destroyed NSWindow', () => {
  const f = fixture();
  let destroyed = false;
  let pointer = 100;
  const selectors = new Map<number, string>();
  const messages: Array<{ receiver: number; selector: string }> = [];
  const library = {
    func: (name: string) => {
      if (name === 'objc_getClass') return () => ++pointer;
      if (name === 'sel_registerName') return (selector: string) => {
        const id = ++pointer; selectors.set(id, selector); return id;
      };
      return (receiver: number, selector: number) => {
        const method = selectors.get(selector) || '';
        messages.push({ receiver, selector: method });
        if (method === 'window') return 50;
        if (method === 'contentView') return 60;
        if (method === 'superview') return 70;
        if (method === 'init') return receiver;
        return ++pointer;
      };
    },
  };
  const nativeWindowHandle = Buffer.alloc(8);
  nativeWindowHandle.writeBigUInt64LE(1n);
  const host = f.playback.createNativeViewHost({
    load: () => library, struct: () => ({}),
  } as never, {
    isDestroyed: () => destroyed, getNativeWindowHandle: () => nativeWindowHandle,
    getContentSize: () => [1000, 700], setBackgroundColor: () => undefined,
  } as never);
  messages.length = 0;
  destroyed = true;
  host.destroy();
  assert.equal(messages.some((message) => message.receiver === 50), false);
  assert.equal(messages.filter((message) => message.selector === 'release').length, 2);
  const count = messages.length;
  host.destroy();
  assert.equal(messages.length, count);
});

for (const operation of ['replay', 're-arm']) {
  test(`failed ${operation} stop retains the native view and media instead of freeing a live drawable`, async () => {
    const f = fixture();
    const first = f.start();
    if (operation === 're-arm') first.session.rearmNativeVideoOutput();
    else {
      const player = f.players.get(first.player);
      assert.ok(player); player.state = 6;
      f.playback.commandLibVlcPlayback(first.sessionId, { type: 'seek', position: 4 });
    }
    await flush();
    await f.complete('stop', new Error('Native stop failed'));
    assert.equal(f.playback.stopLibVlcPlayback(), false);
    assert.equal(f.pending.length, 0);
    assert.equal(f.players.size, 1);
    assert.equal(f.views.get(1), true);
    assert.equal(f.events.some((event) => event.startsWith('media-release:')), false);
  });
}

test('shutdown waits for replaced sessions and releases the warm instance only after all players', async () => {
  const f = fixture(900);
  f.start();
  f.start();
  let finished = false;
  const quit = f.playback.stopAllLibVlcPlayback().then(() => { finished = true; });
  assert.equal(f.playback.startLibVlcPlayback(f.owner as never, 'toy.mkv').ok, false);
  await flush();
  assert.equal(finished, false);
  assert.equal(f.pending.filter((item) => item.name === 'stop').length, 2);
  while (f.pending[0]?.name !== 'warm-release') await f.complete(f.pending[0].name);
  assert.equal(f.players.size, 0);
  assert.equal(f.warmup.getWarmLibVlcInstance('/mock/libvlc'), null);
  assert.equal(finished, false);
  assert.equal(f.pending.length, 1);
  await f.complete('warm-release');
  await quit;
  assert.equal(finished, true);
  assert.equal(f.views.get(1), false);
  assert.equal(f.views.get(2), false);
  const count = f.events.length;
  await f.playback.stopAllLibVlcPlayback();
  assert.equal(f.events.length, count);
});

test('shutdown gives up at the timeout and retains the warm instance and view while stop is pending', async () => {
  const f = fixture(900);
  f.start();
  const quit = f.playback.stopAllLibVlcPlayback(15);
  assert.equal(f.playback.stopAllLibVlcPlayback(), quit);
  await quit;
  assert.equal(f.pending[0].name, 'stop');
  assert.equal(f.views.get(1), true);
  assert.equal(f.warmup.getWarmLibVlcInstance('/mock/libvlc'), 900);
  assert.equal(f.events.some((event) => event.startsWith('warm-release:')), false);
  await f.drain();
  assert.equal(f.views.get(1), false);
});

test('the shutdown deadline also bounds a warm instance release that does not complete', async () => {
  const f = fixture(900);
  const quit = f.playback.stopAllLibVlcPlayback(15);
  await flush();
  assert.equal(f.pending[0].name, 'warm-release');
  await quit;
  assert.equal(f.pending.length, 1);
  await f.drain();
});

test('shutdown settles a failed worker call while retaining its unreleased drawable', async () => {
  const f = fixture();
  f.start();
  const quit = f.playback.stopAllLibVlcPlayback(15);
  await flush();
  await f.complete('stop', new Error('Native stop failed'));
  await quit;
  assert.equal(f.views.get(1), true);
  assert.equal(f.pending.length, 0);
  assert.equal(f.events.some((event) => event.startsWith('player-release:')), false);
});

function quitFixture(f: ReturnType<typeof fixture>) {
  const app = new EventEmitter();
  const quits: boolean[] = [];
  const quit = () => {
    let prevented = false;
    app.emit('before-quit', { preventDefault: () => { prevented = true; } });
    quits.push(prevented);
  };
  Object.assign(app, { quit });
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('let scannerQuitPending = false;'), source.indexOf('// Trim cold data'));
  assert.ok(block.includes("app.on('before-quit'"));
  const code = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const noop = () => undefined;
  vm.runInNewContext(code, {
    app, console, activeScans: [], isAppShuttingDown: false,
    stopAllLibVlcPlayback: () => f.playback.stopAllLibVlcPlayback(15),
    hasScannerProcesses: () => false, stopScannerProcesses: () => Promise.resolve(),
    releaseAllMediaSessions: noop, flushPairedDeviceTouches: noop, clearAllGuestProfiles: noop,
    clearUpdateQuitFallback: noop, destroyServerTray: noop, destroyLanDiscovery: noop, stopAllMpvPlayback: noop,
    stopUnifiedDesktopServer: () => Promise.resolve(), isUpdateInstalling: () => false,
    stopAllTranscodes: noop, stopUpdateCheckTimer: noop, getMediaServer: () => null, getLanMediaServer: () => null,
  });
  return { quit, quits };
}

test('before-quit defers exit and repeated quit requests until worker teardown returns', async () => {
  const f = fixture(900);
  f.start();
  const q = quitFixture(f);
  q.quit();
  q.quit();
  await flush();
  assert.deepEqual(q.quits, [true, true]);
  await f.drain();
  assert.deepEqual(q.quits, [true, true, false]);
});

test('before-quit resumes without blocking the event loop when teardown times out', async () => {
  const f = fixture(900);
  f.start();
  const q = quitFixture(f);
  q.quit();
  await f.playback.stopAllLibVlcPlayback();
  await flush();
  assert.deepEqual(q.quits, [true, false]);
  assert.equal(f.views.get(1), true);
  await f.drain();
});
