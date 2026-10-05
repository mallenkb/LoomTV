import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendStartupLaunch, createStartupTimingRecorder } from '../src/main/startupTiming.ts';
import { parseIpcArguments, startupLibraryRenderArgsSchema } from '../src/main/ipcValidation.ts';
import { createDesktopBridge, type DesktopTransport } from '../src/shared/createDesktopBridge.ts';

test('startup ring keeps ten launches and replaces snapshots of the current launch', () => {
  let history: ReturnType<typeof appendStartupLaunch> = [];
  for (let index = 0; index < 15; index++) {
    history = appendStartupLaunch(history, { id: String(index), startedAt: index + 1, marks: { processStart: 0 } });
  }
  assert.deepEqual(history.map((entry) => entry.id), Array.from({ length: 10 }, (_, index) => String(index + 5)));
  history = appendStartupLaunch(history, { ...history[9], marks: { processStart: 0, appReady: 25 } });
  assert.equal(history.length, 10);
  assert.equal(history[9].marks.appReady, 25);
  assert.equal(appendStartupLaunch({ invalid: true }, history[9]).length, 1);
});

test('startup persistence keeps incomplete launches, first marks, and the reveal-to-render gap', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-startup-'));
  try {
    const recorder = createStartupTimingRecorder(directory, { startedAt: 1000, now: () => 700 });
    await recorder.flush();
    const file = path.join(directory, 'startup-timings.json');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8'))[0].marks, { processStart: 0 });
    recorder.record('windowRevealed', 350);
    assert.equal(recorder.record('windowRevealed', 400), false);
    recorder.recordLibraryRender(1620);
    await Promise.all([recorder.flush(), recorder.flush()]);
    const history = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(history.length, 1);
    assert.equal(history[0].marks.firstLibraryRender, 620);
    assert.equal(history[0].windowToLibraryMs, 270);
    assert.throws(() => recorder.recordLibraryRender(999), /Invalid startup/);
    assert.throws(() => recorder.recordLibraryRender(1751), /Invalid startup/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('startup persistence recovers from corrupt history and reports write failures without rejecting', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-startup-'));
  try {
    const file = path.join(directory, 'startup-timings.json');
    await fs.writeFile(file, 'broken');
    const recorder = createStartupTimingRecorder(directory);
    await recorder.flush();
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).length, 1);
    let errors = 0;
    const failed = createStartupTimingRecorder(file, { onError: () => { errors++; } });
    await failed.flush();
    assert.equal(errors, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('startup IPC accepts only a finite timestamp and the bridge uses the validated invoke channel', async () => {
  const channel = 'startup:library-render';
  assert.deepEqual(parseIpcArguments(channel, [1234], startupLibraryRenderArgsSchema), [1234]);
  for (const args of [[], [0], [-1], [NaN], [Infinity], ['1234'], [{}], [1234, 'extra']]) {
    assert.throws(() => parseIpcArguments(channel, args, startupLibraryRenderArgsSchema), /Invalid arguments/);
  }
  const transport: DesktopTransport = {
    async invoke<T>(actualChannel: string, ...args: unknown[]): Promise<T> {
      assert.equal(actualChannel, channel);
      assert.deepEqual(args, [1234]);
      return true as T;
    },
    on() { return undefined; },
    removeListener() { return undefined; },
  };
  assert.equal(await createDesktopBridge(transport).recordFirstLibraryRender(1234), true);
  const handlers = await fs.readFile(new URL('../src/main/ipcHandlers.ts', import.meta.url), 'utf8');
  assert.match(handlers, /handle\('startup:library-render'.+startupLibraryRenderArgsSchema\)/);
  const wrapper = handlers.slice(handlers.indexOf('const handle ='), handlers.indexOf('type NoArgChannel'));
  assert.ok(wrapper.indexOf('deps.isTrustedSender(event)') < wrapper.indexOf('parseIpcArguments(channel'));
});
