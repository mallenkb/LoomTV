import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { migrateDatabase } from '../src/main/databaseMigrations.ts';
import { createOriginalNameStore } from '../src/main/fileRename/originalNames.ts';

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-original-'));
  const database = new BetterSqlite3(':memory:');
  migrateDatabase(database);
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = (relative: string, bytes = 'video') => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return target;
  };
  const move = (from: string, to: string) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return { from, to };
  };
  return { dir, file, move, store: createOriginalNameStore(() => database) };
}

test('a renamed file keeps its first name through later renames and undo', (t) => {
  const f = fixture(t);
  const first = f.file('The.Godfather.1972.1080p.mp4');
  const second = path.join(f.dir, 'The Godfather (1972)', 'The Godfather (1972).mp4');
  f.store.recordMoves([f.move(first, second)]);
  assert.equal(f.store.originalPath(second), first);

  const third = path.join(f.dir, 'The Godfather (1972)', 'The Godfather (1972) - 1080p.mp4');
  f.store.recordMoves([f.move(second, third)]);
  assert.equal(f.store.originalPath(third), first, 'a second rename never replaces the first name');

  f.store.recordMoves([f.move(third, first)]);
  assert.equal(f.store.originalPath(first), null, 'back at its first name, nothing differs');
});

test('files LoomTV never renamed have no original name', (t) => {
  const f = fixture(t);
  assert.equal(f.store.originalPath(f.file('Movie (2020).mkv')), null);
  assert.equal(f.store.originalPath(path.join(f.dir, 'missing.mkv')), null);
});

test('history is replayed through renamed folders, skipping undone batches', (t) => {
  const f = fixture(t);
  // The files are already where history left them.
  const episode = f.file('Attack on Titan (2013)/SEASON 1/S01E01 - To You.mkv');
  const subtitle = f.file('Attack on Titan (2013)/SEASON 1/S01E01 - To You.en.srt', 'subs');
  const movie = f.file('Movies/Interstellar (2014)/Interstellar (2014).mkv', 'film');
  const recorded = f.store.backfillFromHistory([
    {
      undoneAt: 0,
      operations: [
        { role: 'video', from: path.join(f.dir, 'Attack on Titan/SEASON 1/Shingeki S1 - 01.mkv'), to: path.join(f.dir, 'Attack on Titan/SEASON 1/S01E01 - To You.mkv') },
        { role: 'sidecar', from: path.join(f.dir, 'Attack on Titan/SEASON 1/Shingeki S1 - 01.en.srt'), to: path.join(f.dir, 'Attack on Titan/SEASON 1/S01E01 - To You.en.srt') },
        { role: 'folder', from: path.join(f.dir, 'Attack on Titan'), to: path.join(f.dir, 'Attack on Titan (2013)') },
      ],
    },
    {
      undoneAt: 0,
      operations: [{ role: 'video', from: path.join(f.dir, 'Movies/Interstellar 2014 AV1.mkv'), to: movie }],
    },
    {
      undoneAt: 123,
      operations: [{ role: 'video', from: movie, to: path.join(f.dir, 'Movies/Elsewhere.mkv') }],
    },
  ]);
  assert.equal(recorded, 3);
  assert.equal(f.store.originalPath(episode), path.join(f.dir, 'Attack on Titan/SEASON 1/Shingeki S1 - 01.mkv'));
  assert.equal(f.store.originalPath(subtitle), path.join(f.dir, 'Attack on Titan/SEASON 1/Shingeki S1 - 01.en.srt'));
  assert.equal(f.store.originalPath(movie), path.join(f.dir, 'Movies/Interstellar 2014 AV1.mkv'));
  assert.equal(f.store.isEmpty(), false);
});
