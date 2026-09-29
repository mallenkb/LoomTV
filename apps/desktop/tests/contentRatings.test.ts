import assert from 'node:assert/strict';
import test from 'node:test';

import {
  jikanContentRating,
  mergeContentRatings,
  normalizeContentRating,
} from '../src/main/metadata/contentRatings.ts';

test('content ratings normalize supported countries and reject unknown values', () => {
  assert.deepEqual(normalizeContentRating('US', 'PG-13', 'tmdb'), {
    code: 'PG-13',
    minimumAge: 13,
    source: 'tmdb',
  });
  assert.equal(normalizeContentRating('GB', 'unknown', 'tmdb'), null);
  assert.equal(normalizeContentRating('FR', '12', 'tmdb')?.minimumAge, 12);
  assert.equal(normalizeContentRating('CA', '14A', 'tmdb')?.minimumAge, 14);
  assert.equal(normalizeContentRating('AU', 'MA15+', 'tmdb')?.minimumAge, 15);
});

test('duplicate certifications keep the most restrictive recognized value', () => {
  const merged = mergeContentRatings(
    { US: { code: 'PG', minimumAge: 8, source: 'omdb' } },
    { US: { code: 'R', minimumAge: 17, source: 'tmdb' } },
  );
  assert.deepEqual(merged.US, { code: 'R', minimumAge: 17, source: 'tmdb' });
  assert.equal(jikanContentRating('R+ - Mild Nudity').US.minimumAge, 18);
});
