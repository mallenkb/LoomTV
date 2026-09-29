import assert from 'node:assert/strict';
import test from 'node:test';
import { backDestination, moveFocus, preferredFocusableId, preferredFocusId } from '../src/focus-model.ts';

test('D-pad movement stays deterministic at row and screen edges', () => {
  const grid = [['home', 'search'], ['movie-a', 'movie-b', 'movie-c'], ['settings']];
  assert.equal(moveFocus(grid, 'home', 'left'), 'home');
  assert.equal(moveFocus(grid, 'home', 'right'), 'search');
  assert.equal(moveFocus(grid, 'search', 'down'), 'movie-b');
  assert.equal(moveFocus(grid, 'movie-c', 'down'), 'settings');
  assert.equal(moveFocus(grid, 'missing', 'down'), 'home');
});

test('Back has a destination at every navigation depth', () => {
  assert.equal(backDestination('player'), 'detail');
  assert.equal(backDestination('detail'), 'library');
  assert.equal(backDestination('detail', 'my-list'), 'my-list');
  assert.equal(backDestination('library'), 'profiles');
  assert.equal(backDestination('my-list'), 'profiles');
  assert.equal(backDestination('profiles'), 'connect');
  assert.equal(backDestination('approval'), 'connect');
  assert.equal(backDestination('trust'), 'connect');
  assert.equal(backDestination('connect'), 'exit');
});

test('focus restoration keeps the prior item when it still exists', () => {
  assert.equal(preferredFocusId(['movie-a', 'movie-b'], 'movie-b'), 'movie-b');
  assert.equal(preferredFocusId(['movie-a', 'movie-b'], 'missing'), 'movie-a');
  assert.equal(preferredFocusId([], 'movie-b'), '');
});

test('preferred focus skips disabled cards and episodes', () => {
  const candidates = [
    { id: 'unavailable-first', disabled: true },
    { id: 'playable' },
    { id: 'unavailable-last', disabled: true },
  ];
  assert.equal(preferredFocusableId(candidates, 'unavailable-last'), 'playable');
  assert.equal(preferredFocusableId(candidates, 'playable'), 'playable');
  assert.equal(preferredFocusableId(candidates.slice(0, 1), 'unavailable-first'), '');
});
