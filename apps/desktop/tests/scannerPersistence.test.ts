import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { migrateDatabase } from '../src/main/databaseMigrations.ts';
import { saveLibrary, saveLibraryItem, saveLibraryScanDelta } from '../src/main/databaseLibraryRepository.ts';
import { isCurrentScanCommit, planScanDelta, scanCommits } from '../src/main/scanning/scanPersistence.ts';
import type { LibraryData } from '../src/main/appContracts.ts';
import type { MediaItem } from '../src/main/metadata/types.ts';
const root = path.resolve('test-library');
function item(id: string, folder: string): MediaItem { return { id, filePath: path.join(root, folder, id + '.mp4'), type: 'movie', title: id, year: 2026, poster: '', backdrop: '', summary: '', rating: 0, genres: [], cast: [] }; }
function fixture(): LibraryData { return { movies: [item('a', 'A'), item('b', 'B')], tvShows: [], animeShows: [], libraryFolders: [path.join(root, 'A'), path.join(root, 'B')], libraryFolderGroups: { movies: [path.join(root, 'A'), path.join(root, 'B')], tvShows: [], anime: [], others: [] }, scanCache: {} }; }

test('scan commits reject stale generations and profile changes', () => {
  const snapshot = fixture();
  assert.equal(isCurrentScanCommit(snapshot, 4, 'profile-a'), false);
  scanCommits.set(snapshot, { generation: 4, profileId: 'profile-a', roots: [path.join(root, 'A')] });
  assert.equal(isCurrentScanCommit(snapshot, 4, 'profile-a'), true);
  assert.equal(isCurrentScanCommit(snapshot, 5, 'profile-a'), false);
  assert.equal(isCurrentScanCommit(snapshot, 4, 'profile-b'), false);
});

test('root delta preserves unrelated rows and timestamps; unchanged scans write no items', () => {
  const database = new BetterSqlite3(':memory:'); database.pragma('foreign_keys = ON'); migrateDatabase(database);
  try {
    const previous = fixture(); saveLibrary(database, previous);
    const b = database.prepare("SELECT * FROM media_items WHERE id='b'").get();
    const before = database.prepare('SELECT total_changes() AS n').get();
    const unchanged = planScanDelta(previous, structuredClone(previous), [path.join(root, 'A')]);
    saveLibraryScanDelta(database, unchanged.changed, unchanged.removed, {});
    assert.deepEqual(database.prepare('SELECT total_changes() AS n').get(), before);
    const next = structuredClone(previous); next.movies[0].title = 'Updated';
    const delta = planScanDelta(previous, next, [path.join(root, 'A')]);
    saveLibraryScanDelta(database, delta.changed, delta.removed, {});
    assert.deepEqual(database.prepare("SELECT * FROM media_items WHERE id='b'").get(), b);
    assert.deepEqual(planScanDelta(delta.published, next, [path.join(root, 'A')]).changed, []);
    const empty = { ...next, movies: [] };
    const removal = planScanDelta(next, empty, [path.join(root, 'A')]);
    assert.deepEqual(removal.removed, ['a']);
    assert.deepEqual(removal.published.movies.map((item) => item.id), ['b']);
    database.exec("CREATE TRIGGER fail_remove BEFORE DELETE ON media_items BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    assert.throws(() => saveLibraryScanDelta(database, [{ ...next.movies[1], title: 'Must roll back' }], ['a'], {}));
    assert.deepEqual(database.prepare("SELECT * FROM media_items WHERE id='b'").get(), b);
  } finally { database.close(); }
});

test('incomplete, overlapping and prefix-colliding roots cannot authorize removal', () => {
  const previous = fixture();
  assert.deepEqual(planScanDelta(previous, { ...previous, movies: [] }, []).removed, []);
  assert.deepEqual(planScanDelta(previous, { ...previous, movies: [] }, [path.join(root, 'AB')]).removed, []);
  const nested = path.join(root, 'A/Nested'); previous.libraryFolderGroups?.movies.push(nested);
  previous.movies.push(item('nested', 'A/Nested'));
  assert.deepEqual(planScanDelta(previous, { ...previous, movies: [] }, [path.join(root, 'A')]).removed, ['a']);
  const spanning = { ...item('span', 'A'), episodeFiles: [{ season: 1, episode: 1, filePath: path.join(root, 'B/part.mp4') }] };
  previous.movies.push(spanning);
  assert.ok(!planScanDelta(previous, { ...previous, movies: [] }, [path.join(root, 'A')]).removed.includes('span'));
});

test('retained episode identities and manual state survive a root update', () => {
  const database = new BetterSqlite3(':memory:'); database.pragma('foreign_keys = ON'); migrateDatabase(database);
  try {
    const data = fixture();
    data.movies[0].seasons = [{ number: 1, title: 'Chosen season', episodeCount: 1 }];
    data.movies[0].episodes = [{ season: 1, number: 1, title: 'Chosen title', summary: '', still: '', rating: 0, airDate: '' }];
    data.movies[0].episodeFiles = [{ season: 1, episode: 1, filePath: path.join(root, 'A/episode.mp4') }];
    saveLibrary(database, data);
    database.prepare('UPDATE media_items SET last_played=123 WHERE id=?').run('a');
    const before = database.prepare('SELECT rowid, * FROM episodes WHERE media_id=?').all('a');
    const delta = planScanDelta(data, { ...data, movies: [{ ...data.movies[0], summary: 'New summary' }, data.movies[1]] }, [path.join(root, 'A')]);
    saveLibraryScanDelta(database, delta.changed, [], {});
    assert.deepEqual(database.prepare('SELECT rowid, * FROM episodes WHERE media_id=?').all('a'), before);
    assert.deepEqual(database.prepare('SELECT last_played FROM media_items WHERE id=?').get('a'), { last_played: 123 });
  } finally { database.close(); }
});

test('a failed later root leaves an earlier committed root and its cache intact', () => {
  const database = new BetterSqlite3(':memory:'); database.pragma('foreign_keys = ON'); migrateDatabase(database);
  try {
    const previous = fixture(); saveLibrary(database, previous);
    const first = structuredClone(previous); first.movies[0].title = 'Committed A';
    const firstDelta = planScanDelta(previous, first, [path.join(root, 'A')]);
    saveLibraryScanDelta(database, firstDelta.changed, firstDelta.removed, {
      [path.join(root, 'A')]: { version: 16, folderKind: 'movies', signature: 'first', subtitleProfile: '', fileCount: 1, itemCount: 1, scannedAt: 100 },
    });
    database.exec("CREATE TRIGGER fail_b BEFORE UPDATE ON media_items WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT, 'later root failed'); END;");
    const second = structuredClone(first); second.movies[1].title = 'Uncommitted B';
    const secondDelta = planScanDelta(first, second, [path.join(root, 'B')]);
    assert.throws(() => saveLibraryScanDelta(database, secondDelta.changed, secondDelta.removed, {
      [path.join(root, 'B')]: { version: 16, folderKind: 'movies', signature: 'second', subtitleProfile: '', fileCount: 1, itemCount: 1, scannedAt: 200 },
    }));
    assert.equal((database.prepare("SELECT title FROM media_items WHERE id='a'").get() as { title: string }).title, 'Committed A');
    assert.equal((database.prepare("SELECT title FROM media_items WHERE id='b'").get() as { title: string }).title, 'b');
    assert.equal((database.prepare("SELECT signature FROM scan_cache WHERE folder_path=?").get(path.join(root, 'A')) as { signature: string }).signature, 'first');
    assert.equal(database.prepare('SELECT signature FROM scan_cache WHERE folder_path=?').get(path.join(root, 'B')), undefined);
  } finally { database.close(); }
});

test('scan removal cleans only confirmed automatic segments in the catalog transaction', () => {
  const database = new BetterSqlite3(':memory:'); database.pragma('foreign_keys = ON'); migrateDatabase(database);
  try {
    const previous = fixture(); saveLibrary(database, previous);
    const removedPath = previous.movies[0].filePath;
    const unrelatedPath = path.join(root, 'offline/old.mp4');
    const insert = database.prepare(`INSERT INTO media_segment_candidates
      (id, media_id, season, episode, file_path, file_revision, type, start_ms, end_ms,
       confidence, source, status, media_duration_ms, updated_at)
      VALUES (?, 'a', 1, 1, ?, ?, 'intro', 0, 3000, 1, ?, 'active', 10000, 100)`);
    insert.run('confirmed', removedPath, 'removed-revision', 'chapter');
    insert.run('manual', removedPath, 'removed-revision', 'manual');
    insert.run('unrelated', unrelatedPath, 'offline-revision', 'chapter');
    const next = { ...previous, movies: [previous.movies[1]] };
    const delta = planScanDelta(previous, next, [path.join(root, 'A')]);
    assert.deepEqual(delta.removedFilePaths, [removedPath]);
    database.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON media_segment_candidates BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END;");
    assert.throws(() => saveLibraryScanDelta(database, delta.changed, delta.removed, {}, undefined, delta.removedFilePaths), /cleanup failed/);
    assert.ok(database.prepare("SELECT id FROM media_items WHERE id='a'").get());
    database.exec('DROP TRIGGER fail_cleanup');
    saveLibraryScanDelta(database, delta.changed, delta.removed, {}, undefined, delta.removedFilePaths);
    assert.deepEqual(database.prepare('SELECT id FROM media_segment_candidates ORDER BY id').all(), [{ id: 'manual' }, { id: 'unrelated' }]);
    assert.equal(database.prepare("SELECT id FROM media_items WHERE id='a'").get(), undefined);
  } finally { database.close(); }
});


test('standalone item writes still roll back all child and parent changes on failure', () => {
  const database = new BetterSqlite3(':memory:'); database.pragma('foreign_keys = ON'); migrateDatabase(database);
  try {
    const data = fixture(); saveLibrary(database, data);
    const before = database.prepare("SELECT * FROM media_items WHERE id='a'").get();
    database.exec("CREATE TRIGGER fail_episode BEFORE INSERT ON episodes BEGIN SELECT RAISE(ABORT, 'episode failed'); END;");
    const next = { ...data.movies[0], title: 'Uncommitted', episodes: [{ season: 1, number: 1, title: 'One', summary: '', still: '', rating: 0, airDate: '' }] };
    assert.throws(() => saveLibraryItem(database, next), /episode failed/);
    assert.deepEqual(database.prepare("SELECT * FROM media_items WHERE id='a'").get(), before);
    assert.equal(database.inTransaction, false);
  } finally { database.close(); }
});
