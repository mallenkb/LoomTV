import assert from 'node:assert/strict';
import test from 'node:test';

import { activeMobileProgressPaths, sameMobileCatalogIdentity } from '../mobileOfflineCachePolicy.ts';

test('catalog revisions are authoritative when both snapshots provide them', () => {
  const library = { movies: [] };
  const first = { library, libraryEtag: 'etag', catalogRevision: 4, catalogTransport: 'compact' };
  assert.equal(sameMobileCatalogIdentity(first, { ...first, library: { movies: ['mutated'] } }), true);
  assert.equal(sameMobileCatalogIdentity(first, { ...first, catalogRevision: 5 }), false);
});

test('legacy snapshots fall back to immutable library identity', () => {
  const library = { movies: [] };
  const first = { library, libraryEtag: 'etag', catalogTransport: 'legacy' };
  assert.equal(sameMobileCatalogIdentity(first, { ...first }), true);
  assert.equal(sameMobileCatalogIdentity(first, { ...first, library: { movies: [] } }), false);
});

test('active progress paths include core and Others media plus episodes', () => {
  assert.deepEqual(
    [...activeMobileProgressPaths({
      movies: [{ filePath: 'movie' }],
      tvShows: [{ filePath: 'show', episodeFiles: [{ filePath: 'episode' }] }],
      others: [{ filePath: 'personal-video' }],
    })].sort(),
    ['episode', 'movie', 'personal-video', 'show'],
  );
});
