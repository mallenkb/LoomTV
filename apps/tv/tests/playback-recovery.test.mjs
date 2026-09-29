import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackRecoveryGate } from '../src/playback-recovery.ts';

test('duplicate errors and errors from the retry cannot start another retry', () => {
  const gate = createPlaybackRecoveryGate();
  const attempt = gate.begin();
  assert.equal(gate.claim(attempt), true);
  assert.equal(gate.claim(attempt), false);
  assert.equal(gate.claim(attempt), false);
  const next = gate.begin();
  assert.equal(gate.claim(attempt), false);
  assert.equal(gate.claim(next), true);
});

test('closing or signing out invalidates pending playback results', () => {
  const gate = createPlaybackRecoveryGate();
  const attempt = gate.begin();
  assert.equal(gate.claim(attempt), true);
  gate.cancel();
  assert.equal(gate.isCurrent(attempt), false);
  assert.equal(gate.claim(attempt), false);
  assert.equal(gate.claim(gate.begin()), true);
});
