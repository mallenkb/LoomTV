import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { compactDatabaseIfWasteful, trimFreePages } from '../src/main/databaseCompaction.ts';

function openFixture(t: test.TestContext): BetterSqlite3.Database {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-compaction-'));
  const database = new BetterSqlite3(path.join(directory, 'loomtv.sqlite'));
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  database.pragma('journal_mode = WAL');
  database.exec('CREATE TABLE cache (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)');
  return database;
}

function fill(database: BetterSqlite3.Database, megabytes: number): void {
  const insert = database.prepare('INSERT INTO cache (bytes) VALUES (zeroblob(?))');
  database.transaction(() => {
    for (let index = 0; index < megabytes; index += 1) insert.run(1024 * 1024);
  })();
}

const freePages = (database: BetterSqlite3.Database) => Number(database.pragma('freelist_count', { simple: true }));

test('a mostly free database is compacted once and switched to incremental vacuum', (t) => {
  const database = openFixture(t);
  fill(database, 48);
  database.exec('DELETE FROM cache WHERE id > 8');
  assert.ok(freePages(database) * 4096 >= 32 * 1024 * 1024);

  assert.equal(compactDatabaseIfWasteful(database), true);
  assert.equal(freePages(database), 0);
  assert.equal(Number(database.pragma('auto_vacuum', { simple: true })), 2);
  assert.equal(Number(database.prepare('SELECT COUNT(*) FROM cache').pluck().get()), 8);
  // Already incremental: later quits never rewrite the whole file again.
  assert.equal(compactDatabaseIfWasteful(database), false);

  database.exec('DELETE FROM cache WHERE id > 4');
  const before = freePages(database);
  assert.ok(before > 100);
  assert.equal(trimFreePages(database, 100), 100);
  assert.equal(freePages(database), before - 100);
});

test('a database with little free space is left alone', (t) => {
  const database = openFixture(t);
  fill(database, 48);
  database.exec('DELETE FROM cache WHERE id > 44');
  assert.equal(compactDatabaseIfWasteful(database), false);
  assert.equal(Number(database.pragma('auto_vacuum', { simple: true })), 0);
  assert.equal(trimFreePages(database), 0);
});
