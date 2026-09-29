import assert from 'node:assert/strict';
import test from 'node:test';

import {
  issueLibraryFilterOptions,
  primaryLibraryFilterOptions,
} from '../src/lib/libraryFilters.ts';

test('library filters keep maintenance filters out of the primary row', () => {
  assert.deepEqual(primaryLibraryFilterOptions.map((option) => option.id), [
    'all',
    'in-progress',
    'unwatched',
    'watched',
  ]);

  assert.deepEqual(issueLibraryFilterOptions.map((option) => option.id), [
    'missing-metadata',
    'missing-artwork',
  ]);
});
