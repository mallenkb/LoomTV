import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import {
  acquireFfmpegToolSlot,
  killAllManagedFfmpeg,
  managedFfmpegCounts,
  registerPlaybackProcess,
  touchPlaybackProcess,
} from '../src/main/ffmpegGovernor.ts';

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.exitCode = 9;
    this.emit('exit', 9);
    return true;
  }
}

function fakeProc(): FakeProcess {
  return new FakeProcess();
}

function asChild(proc: FakeProcess): ChildProcess {
  return proc as unknown as ChildProcess;
}

test('a new playback process for the same source replaces the old one', () => {
  killAllManagedFfmpeg();
  const first = fakeProc();
  const second = fakeProc();
  registerPlaybackProcess(asChild(first), 'stream:/a.mkv', 'stream a');
  registerPlaybackProcess(asChild(second), 'stream:/a.mkv', 'stream a (seek)');

  assert.equal(first.killed, true);
  assert.equal(second.killed, false);
  assert.equal(managedFfmpegCounts().playback, 1);
});

test('the playback cap evicts the least recently active process', () => {
  killAllManagedFfmpeg();
  const idle = fakeProc();
  const active = fakeProc();
  const next = fakeProc();

  registerPlaybackProcess(asChild(idle), 'hls:one', 'hls one');
  registerPlaybackProcess(asChild(active), 'hls:two', 'hls two');
  touchPlaybackProcess(asChild(active));
  // `idle` registered first and was never touched again, so it is the LRU.
  registerPlaybackProcess(asChild(next), 'stream:/b.mkv', 'stream b');

  assert.equal(idle.killed, true);
  assert.equal(active.killed, false);
  assert.equal(next.killed, false);
  assert.equal(managedFfmpegCounts().playback, 2);
});

test('exited processes leave the registry', () => {
  killAllManagedFfmpeg();
  const proc = fakeProc();
  registerPlaybackProcess(asChild(proc), 'hls:exit', 'hls exit');
  proc.kill();
  assert.equal(managedFfmpegCounts().playback, 0);
});

test('tool slots cap concurrency and hand released slots to waiters', async () => {
  const releaseA = await acquireFfmpegToolSlot('thumbnail');
  const releaseB = await acquireFfmpegToolSlot('thumbnail');
  assert.equal(managedFfmpegCounts().tools, 2);

  let thirdGranted = false;
  const third = acquireFfmpegToolSlot('thumbnail').then((release) => {
    thirdGranted = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(thirdGranted, false);
  assert.equal(managedFfmpegCounts().queuedTools, 1);

  releaseA();
  const releaseC = await third;
  assert.equal(thirdGranted, true);
  assert.equal(managedFfmpegCounts().tools, 2);

  // Release is idempotent: double release must not free two slots.
  releaseA();
  assert.equal(managedFfmpegCounts().tools, 2);

  releaseB();
  releaseC();
  assert.equal(managedFfmpegCounts().tools, 0);
});
