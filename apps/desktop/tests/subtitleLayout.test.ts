import assert from 'node:assert/strict';
import test from 'node:test';
import { subtitleBottom } from '../src/components/VideoPlayer/subtitleLayout.ts';

test('subtitles clear the controls and restore the saved position after hiding', () => {
  for (const height of [360, 720, 1080, 2160]) {
    const position = 95;
    const hidden = subtitleBottom(position, height, 48, 156, false);
    const visible = subtitleBottom(position, height, 48, 156, true);
    assert.ok(visible >= 156);
    assert.ok(Math.abs(hidden - height * 0.05) < 0.001);
    assert.equal(subtitleBottom(position, height, 48, 156, false), hidden);
  }
});

test('controls do not move subtitles that already clear the timeline', () => {
  assert.equal(subtitleBottom(40, 720, 96, 156, true), 432);
  assert.equal(subtitleBottom(40, 720, 96, 156, false), 432);
});

test('large multiline subtitles remain inside a short viewport', () => {
  assert.equal(subtitleBottom(95, 240, 120, 156, true), 104);
  assert.equal(subtitleBottom(100, 120, 160, 156, true), 0);
});
