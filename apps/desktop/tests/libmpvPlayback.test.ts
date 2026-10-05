import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import vm from 'node:vm';
import * as ts from 'typescript';
import type { MpvCommand, MpvPlaybackState } from '../src/shared/desktopProtocol.ts';
import * as helpers from '../src/main/mpvPlaybackHelpers.ts';
import { restoreOffscreenTrack } from '../src/main/offscreenVideoRestore.ts';

function fixture() {
  const sent: Array<Partial<MpvPlaybackState>> = [];
  const powerStates: Array<Pick<MpvPlaybackState, 'status' | 'paused'>> = [];
  const intervals = new Map<() => void, number>();
  const queued: unknown[] = [];
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string, state: Partial<MpvPlaybackState>) => { if (channel === 'mpv:state') sent.push(state); },
  });
  const runtime = {
    libraryPath: '/mock/libmpv',
    api: {
      create: () => 1, attach: () => 0, command: () => 0, destroy: () => undefined,
      pollInto: (_engine: number, output: Buffer) => {
        if (queued.length === 0) return 0;
        return output.write(JSON.stringify(queued.splice(0)));
      },
    },
  };
  const dependencies: Record<string, unknown> = {
    electron: { BrowserWindow: {} },
    'node:crypto': { randomUUID: () => 'mpv-session' },
    'node:fs': fs, 'node:path': path, 'node:util': { isDeepStrictEqual },
    './offscreenVideoRestore.ts': { restoreOffscreenTrack },
    './playbackDiagnostics.ts': { recordPlaybackDiagnostic: () => undefined },
    './screenLock.ts': { isScreenLocked: () => false },
    './mpvPlaybackHelpers.ts': helpers,
    './libvlcPlayback.ts': {
      loadKoffi: () => ({}),
      createNativeViewHost: () => ({ drawable: 1, destroy: () => undefined }),
    },
    './nativePlaybackPower.ts': {
      releaseNativePlaybackDisplaySleep: () => undefined,
      syncNativePlaybackDisplaySleep: (_id: string, state: Pick<MpvPlaybackState, 'status' | 'paused'>) => { powerStates.push(state); },
    },
  };
  const source = fs.readFileSync(new URL('../src/main/libmpvPlayback.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code + '\nmodule.exports.LibMpvSession = LibMpvSession;', {
    module, exports: module.exports, Buffer, console, process,
    require: (id: string) => { assert.ok(id in dependencies, `Unexpected dependency ${id}`); return dependencies[id]; },
    setInterval: (fn: () => void, ms: number) => { intervals.set(fn, ms); return { fn, unref: () => undefined }; },
    clearInterval: (timer: { fn: () => void }) => { intervals.delete(timer.fn); },
  });
  const { LibMpvSession } = module.exports as {
    LibMpvSession: new (...args: unknown[]) => { command: (command: MpvCommand) => boolean; stop: () => boolean };
  };
  const session = new LibMpvSession(runtime, owner, {}, 'toy.mkv', {}, () => undefined);
  const poll = () => { for (const fn of [...intervals.keys()]) fn(); };
  const event = (message: unknown) => { queued.push(message); poll(); };
  const property = (name: string, data: unknown) => event({ event: 'property-change', name, data });
  return { session, sent, powerStates, intervals, poll, event, property };
}

test('libmpv sends no state or display-sleep sync for empty polls or unchanged paused properties', () => {
  const f = fixture();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].status, 'loading');
  assert.deepEqual([...f.intervals.values()], [16]);
  f.event({ event: 'file-loaded' });
  f.property('pause', true);
  f.property('time-pos', 12);
  f.property('duration', 60);
  f.property('volume', 100);
  f.property('mute', false);
  f.property('speed', 1);
  const sends = f.sent.length;
  const syncs = f.powerStates.length;
  for (let index = 0; index < 100; index++) {
    f.poll();
    for (const [name, value] of [['pause', true], ['time-pos', 12], ['duration', 60], ['volume', 100], ['mute', false], ['speed', 1]]) {
      f.property(String(name), value);
    }
  }
  assert.equal(f.sent.length - sends, 0);
  assert.equal(f.powerStates.length - syncs, 0);
  f.session.stop();
});

test('libmpv sends each real property change once, including tracks, video size, diagnostics and cleared values', () => {
  const f = fixture();
  f.event({ event: 'file-loaded' });
  const properties: Array<[string, unknown]> = [
    ['time-pos', 12], ['duration', 60], ['pause', true], ['volume', 50], ['speed', 1.5],
    ['track-list', [{ id: 1, type: 'video', codec: 'hevc', selected: true }]],
    ['track-list', [{ id: 1, type: 'video', codec: 'hevc', selected: false }]],
    ['track-list', [{ id: 1, type: 'video', codec: 'hevc', selected: false, title: 'Main' }]],
    ['track-list', []], ['video-params', { w: 1920, h: 1080 }],
    ['video-params', { w: 1280, h: 720 }], ['video-params', {}],
    ['hwdec-current', 'videotoolbox'], ['frame-drop-count', 2], ['decoder-frame-drop-count', 1],
    ['demuxer-cache-duration', 3], ['paused-for-cache', true], ['video-codec', 'hevc'],
    ['estimated-vf-fps', 24], ['hwdec-current', 'no'], ['hwdec-current', null],
    ['time-pos', null], ['duration', null], ['pause', false],
  ];
  for (const [name, value] of properties) {
    const before = f.sent.length;
    f.property(name, value);
    assert.equal(f.sent.length, before + 1, name);
    f.property(name, structuredClone(value));
    assert.equal(f.sent.length, before + 1, `Repeated ${name}`);
  }
  const beforeMute = f.sent.length;
  assert.equal(f.session.command({ type: 'set-muted', muted: true }), true);
  assert.equal(f.sent.length, beforeMute + 1);
  assert.equal(f.sent.at(-1)?.muted, true);
  f.property('mute', true);
  f.session.command({ type: 'set-muted', muted: true });
  assert.equal(f.sent.length, beforeMute + 1);
  f.session.stop();
  assert.equal(f.sent.at(-1)?.status, 'closed');
});

test('libmpv delivers EOF, resume, seek progress and error transitions after deduplicating unchanged state', () => {
  const f = fixture();
  f.event({ event: 'file-loaded' });
  f.property('time-pos', 12);
  f.event({ event: 'end-file', reason: 'eof' });
  assert.equal(f.sent.at(-1)?.status, 'ended');
  assert.equal(f.sent.at(-1)?.paused, true);
  const endedSends = f.sent.length;
  f.event({ event: 'end-file', reason: 'eof' });
  assert.equal(f.sent.length, endedSends);
  assert.equal(f.session.command({ type: 'set-paused', paused: false }), true);
  f.property('pause', false);
  assert.equal(f.sent.length, endedSends + 1);
  assert.equal(f.session.command({ type: 'seek', position: 5 }), true);
  f.property('time-pos', 5);
  assert.equal(f.sent.length, endedSends + 2);
  assert.equal(f.sent.at(-1)?.position, 5);
  const samePositionSyncs = f.powerStates.length;
  assert.equal(f.session.command({ type: 'seek', position: 5 }), true);
  f.property('time-pos', 5);
  assert.equal(f.sent.length, endedSends + 3);
  assert.equal(f.powerStates.length, samePositionSyncs);
  f.property('time-pos', 5);
  assert.equal(f.sent.length, endedSends + 3);
  f.event({ event: 'bridge-error', error: 'Playback failed' });
  assert.equal(f.sent.length, endedSends + 4);
  assert.equal(f.sent.at(-1)?.status, 'error');
  assert.equal(f.sent.at(-1)?.error, 'Playback failed');
  assert.equal(f.intervals.size, 0);
});
