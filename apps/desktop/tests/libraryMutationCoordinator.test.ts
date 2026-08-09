import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibraryMutationCoordinator } from '../src/contexts/libraryMutationCoordinator.ts';

test('unrelated mutation domains do not supersede each other', () => {
  const coordinator = createLibraryMutationCoordinator();
  const catalog = coordinator.begin('catalog');
  const settings = coordinator.begin('settings');

  assert.equal(coordinator.isCurrent(catalog), true);
  assert.equal(coordinator.isCurrent(settings), true);
});

test('a newer catalog request supersedes only the previous catalog request', () => {
  const coordinator = createLibraryMutationCoordinator();
  const settings = coordinator.begin('settings');
  const firstCatalog = coordinator.begin('catalog');
  const secondCatalog = coordinator.begin('catalog');

  assert.equal(coordinator.isCurrent(firstCatalog), false);
  assert.equal(coordinator.isCurrent(secondCatalog), true);
  assert.equal(coordinator.isCurrent(settings), true);
});
