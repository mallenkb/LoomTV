import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSyncOffset } from '../src/components/VideoPlayer/syncOffset.ts';

test('sync offsets read as a direction, not a sign', () => {
  assert.equal(formatSyncOffset(0.5), '0.50s later');
  assert.equal(formatSyncOffset(-0.25), '0.25s earlier');
  assert.equal(formatSyncOffset(0), 'In sync');
});

test('float noise around zero and invalid values read as in sync', () => {
  assert.equal(formatSyncOffset(-0.000001), 'In sync');
  assert.equal(formatSyncOffset(Number.NaN), 'In sync');
});
