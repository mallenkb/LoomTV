import assert from 'node:assert/strict';
import test from 'node:test';
import { backDestination, moveFocus } from '../src/focus-model.ts';

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
  assert.equal(backDestination('library'), 'profiles');
  assert.equal(backDestination('profiles'), 'connect');
  assert.equal(backDestination('approval'), 'connect');
  assert.equal(backDestination('trust'), 'connect');
  assert.equal(backDestination('connect'), 'exit');
});
