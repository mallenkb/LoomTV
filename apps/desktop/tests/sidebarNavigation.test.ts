import assert from 'node:assert/strict';
import test from 'node:test';

import { isCategoryVisible } from '../src/components/sidebarNavigation.ts';

test('remote category navigation stays visible without host folder paths', () => {
  assert.equal(isCategoryVisible('anime', true, []), true);
  assert.equal(isCategoryVisible('tvShows', true, []), true);
  assert.equal(isCategoryVisible('movies', true, []), true);
});

test('local category navigation still follows configured library folders', () => {
  assert.equal(isCategoryVisible('anime', false, []), false);
  assert.equal(isCategoryVisible('anime', false, ['/library/anime']), true);
});
