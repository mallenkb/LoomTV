import assert from 'node:assert/strict';
import test from 'node:test';

import { activeMobileProgressPaths, mergeOfflineProgressEntry, sameMobileCatalogIdentity } from '../mobileOfflineCachePolicy.ts';

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

test('offline progress merge keeps local entries unless the remote is newer and unfinished', () => {
  const local = { position: 120, duration: 200, watched: false, updatedAt: 50 };
  assert.equal(mergeOfflineProgressEntry(undefined, undefined), undefined);
  assert.equal(mergeOfflineProgressEntry(undefined, local), local);
  assert.equal(mergeOfflineProgressEntry(local, undefined), local);
  assert.equal(mergeOfflineProgressEntry(local, { ...local, updatedAt: 50 }), local);
  const remote = { position: 90, duration: 200, watched: false, updatedAt: 200 };
  assert.equal(mergeOfflineProgressEntry(local, remote), remote);
});

test('offline progress merge preserves an already watched local state', () => {
  const local = { position: 190, duration: 200, watched: true, updatedAt: 10 };
  assert.equal(mergeOfflineProgressEntry(local, { position: 5, duration: 200, watched: false, updatedAt: 999 }), local);
  const remoteNewer = { position: 195, duration: 200, watched: true, updatedAt: 999 };
  assert.equal(mergeOfflineProgressEntry({ ...local, watched: false }, remoteNewer), remoteNewer);
});
