import assert from 'node:assert/strict';
import test from 'node:test';
import { playbackDiagnostics, recordPlaybackDiagnostic } from '../src/main/playbackDiagnostics.ts';

test('playback diagnostics retain a bounded independent snapshot', () => {
  for (let index = 0; index < 140; index += 1) recordPlaybackDiagnostic('test.state', index);
  const entries = playbackDiagnostics();
  assert.equal(entries.length, 128);
  assert.equal(entries[0].value, 12);
  assert.equal(entries[127].value, 139);
  entries[0].value = 'modified';
  assert.equal(playbackDiagnostics()[0].value, 12);
  assert.ok(entries.every((entry) => entry.elapsedMs >= 0));
});
