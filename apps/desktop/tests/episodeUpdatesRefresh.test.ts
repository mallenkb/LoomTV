import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { msUntilNextLocalMidnight } from '../src/lib/localMidnight.ts';

const source = readFileSync(new URL('../src/lib/useEpisodeUpdates.ts', import.meta.url), 'utf8');

test('episode updates reload after progress and folder changes, at midnight and on return', () => {
  assert.match(source, /addEventListener\('loomtv-progress', loadSoon\)/);
  assert.match(source, /addEventListener\('loomtv:library-roots-changed', loadSoon\)/);
  assert.match(source, /addEventListener\('visibilitychange', onVisible\)/);
  assert.match(source, /setTimeout\(\(\) => \{ load\(\); scheduleMidnight\(\); \}, msUntilNextLocalMidnight\(\)\)/);
  for (const event of ['loomtv-progress', 'loomtv:library-roots-changed', 'visibilitychange']) {
    assert.match(source, new RegExp(`removeEventListener\\('${event}'`));
  }
});

test('the midnight reload lands just after the local date changes', () => {
  const evening = new Date(2026, 9, 8, 23, 59, 0);
  const wait = msUntilNextLocalMidnight(evening);
  assert.equal(new Date(evening.getTime() + wait).getDate(), 9);
  assert.ok(wait > 60_000 && wait <= 62_000);
});
