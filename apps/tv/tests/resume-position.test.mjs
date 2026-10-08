import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeStartSeconds } from '../src/resume-position.ts';

test('watched or nearly finished titles replay from the start', () => {
  assert.equal(resumeStartSeconds({ positionSeconds: 5400, durationSeconds: 5400, watched: true }), 0);
  assert.equal(resumeStartSeconds({ position: 5000, duration: 5400 }), 0);
});

test('partially watched titles resume at the saved position', () => {
  assert.equal(resumeStartSeconds({ positionSeconds: 600, durationSeconds: 5400, watched: false }), 600);
  assert.equal(resumeStartSeconds({ position: 42 }), 42);
  assert.equal(resumeStartSeconds(null), 0);
  assert.equal(resumeStartSeconds({ positionSeconds: Number.NaN }), 0);
});
