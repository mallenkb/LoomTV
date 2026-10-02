import assert from 'node:assert/strict';
import test from 'node:test';
import { libraryIndexIfChanged } from '../src/main/libraryIndexFingerprint.ts';
import type { LibraryIndexPayload } from '../src/shared/desktopProtocol';

const index = (lastPlayed?: number): LibraryIndexPayload => ({
  catalogVersion: 1,
  revision: 7,
  movies: [{ id: 'm1', title: 'Movie', type: 'movie', lastPlayed } as LibraryIndexPayload['movies'][number]],
  tvShows: [],
  animeShows: [],
  libraryFolderStatuses: [{ path: '/media', status: 'online' } as never],
});

test('an unchanged index is answered with its fingerprint only', () => {
  const first = libraryIndexIfChanged(index(), 'p1:0');
  assert.ok(!('unchanged' in first));
  assert.match(first.fingerprint ?? '', /^[0-9a-f]{32}$/);
  assert.deepEqual(libraryIndexIfChanged(index(), 'p1:0', first.fingerprint), { catalogVersion: 1, unchanged: true, fingerprint: first.fingerprint });
});

test('changes outside the revision number still send the full index', () => {
  const first = libraryIndexIfChanged(index(), 'p1:0');
  const played = libraryIndexIfChanged(index(1_700_000_000_000), 'p1:0', first.fingerprint);
  assert.ok(!('unchanged' in played), 'lastPlayed changed with the same revision');
  const otherProfile = libraryIndexIfChanged(index(), 'p2:0', first.fingerprint);
  assert.ok(!('unchanged' in otherProfile), 'a different profile scope never matches');
});
