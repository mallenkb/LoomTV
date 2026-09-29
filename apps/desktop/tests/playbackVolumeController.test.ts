import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// The controller uses a constructor parameter property, which Node's type
// stripping cannot run, so compile it the way the engine lifecycle tests do.
type Controller = {
  reset(volume?: number, muted?: boolean): void;
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
};
type ApplyChanges = (volume: number, muted: boolean, changes: { volume: boolean; muted: boolean }) => Promise<void>;
const source = readFileSync(new URL('../src/components/VideoPlayer/engines/PlaybackVolumeController.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleExports: { default?: new (apply: ApplyChanges) => Controller } = {};
runInNewContext(compiled, { exports: moduleExports, module: { exports: moduleExports }, queueMicrotask, Promise });
const PlaybackVolumeController = moduleExports.default as new (apply: ApplyChanges) => Controller;

type Applied = { volume: number; muted: boolean; changes: { volume: boolean; muted: boolean } };

function controller() {
  const applied: Applied[] = [];
  const volume = new PlaybackVolumeController(async (level, muted, changes) => {
    applied.push({ volume: level, muted, changes: { volume: changes.volume, muted: changes.muted } });
  });
  return { volume, applied };
}

test('a mute toggle reaches the engine as a mute change only', async () => {
  const { volume, applied } = controller();
  volume.reset(0.6, false);
  await volume.setMuted(true);
  await volume.setMuted(false);
  assert.deepEqual(applied.map((entry) => entry.changes), [
    { volume: false, muted: true },
    { volume: false, muted: true },
  ]);
  assert.deepEqual(applied.map((entry) => [entry.volume, entry.muted]), [[0.6, true], [0.6, false]]);
});

test('rapid mute presses collapse to the final state', async () => {
  const { volume, applied } = controller();
  volume.reset(1, false);
  void volume.setMuted(true);
  void volume.setMuted(false);
  await volume.setMuted(true);
  assert.deepEqual(applied.map((entry) => entry.muted), [true]);
});

test('unmuting from zero restores the last audible volume', async () => {
  const { volume, applied } = controller();
  volume.reset(0.4, false);
  await volume.setVolume(0);
  await volume.setMuted(false);
  assert.deepEqual(applied.at(-1), { volume: 0.4, muted: false, changes: { volume: true, muted: true } });
});

test('an engine started muted does not resend the mute it already has', async () => {
  const { volume, applied } = controller();
  volume.reset(0.8, true);
  await volume.setMuted(true);
  assert.equal(applied.length, 0);
});
