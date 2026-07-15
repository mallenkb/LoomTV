import assert from 'node:assert/strict';
import test from 'node:test';
import { absoluteMediaSeconds, playerSecondsForAbsolute } from '../src/components/VideoPlayer/playbackClock.ts';

test('direct, remux, and seekable HLS use the absolute timeline', () => {
  for (const mode of ['direct', 'remux', 'hls'] as const) {
    void mode;
    assert.equal(absoluteMediaSeconds(125, { mode: 'absolute', offsetSeconds: 90 }), 125);
    assert.equal(playerSecondsForAbsolute(240, { mode: 'absolute', offsetSeconds: 90 }), 240);
  }
});

test('linear offset transcodes map both player position and seeks', () => {
  const clock = { mode: 'offset' as const, offsetSeconds: 600 };
  assert.equal(absoluteMediaSeconds(15, clock), 615);
  assert.equal(playerSecondsForAbsolute(660, clock), 60);
  assert.equal(playerSecondsForAbsolute(500, clock), 0);
});
