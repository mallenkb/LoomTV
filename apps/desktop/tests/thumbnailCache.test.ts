import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { THUMBNAIL_CACHE_LIMITS, createThumbnailCache } from '../src/main/thumbnailCache.ts';

const key = (n: number) => n.toString(16).padStart(64, '0');

function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-thumbs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function legacyDatabase(t: test.TestContext, rows: number): BetterSqlite3.Database {
  const database = new BetterSqlite3(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE thumbnail_cache (cache_key TEXT PRIMARY KEY, mime_type TEXT NOT NULL, image_bytes BLOB NOT NULL, updated_at INTEGER NOT NULL)');
  const insert = database.prepare('INSERT INTO thumbnail_cache VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= rows; i++) insert.run(key(i), 'image/jpeg', Buffer.from(`jpeg-${i}`), 1_700_000_000_000 + i);
  return database;
}

test('thumbnails are stored as files and read back', (t) => {
  const cache = createThumbnailCache({ directory: tempDir(t) });
  assert.equal(cache.getCachedThumbnail(key(1)), null);
  cache.saveCachedThumbnail(key(1), Buffer.from('jpeg-bytes'));
  assert.deepEqual(cache.getCachedThumbnail(key(1)), { bytes: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg' });
  cache.saveCachedThumbnail(key(2), Buffer.from('png'), 'image/png');
  assert.equal(cache.getCachedThumbnail(key(2))?.mimeType, 'image/png');
  cache.saveCachedThumbnail(key(3), Buffer.from('gif'), 'image/gif');
  assert.equal(cache.getCachedThumbnail(key(3)), null, 'unknown types are not cached');
});

test('keys that are not hex digests cannot name a path', (t) => {
  const dir = tempDir(t);
  const cache = createThumbnailCache({ directory: dir });
  cache.saveCachedThumbnail('../../escape', Buffer.from('x'));
  assert.equal(cache.getCachedThumbnail('../../escape')?.bytes.toString(), 'x');
  assert.equal(fs.existsSync(path.join(dir, '..', 'escape.jpg')), false);
});

test('the quota removes the least recently used files first', (t) => {
  const dir = tempDir(t);
  const cache = createThumbnailCache({ directory: dir });
  const total = THUMBNAIL_CACHE_LIMITS.entries + 3;
  for (let i = 1; i <= total; i++) cache.saveCachedThumbnail(key(i), Buffer.from('j'));
  // Make the first three the oldest.
  for (let i = 1; i <= 3; i++) {
    const stem = key(i);
    const file = path.join(dir, stem.slice(0, 2), `${stem}.jpg`);
    fs.utimesSync(file, 1, 1);
  }
  cache.enforceQuota();
  for (let i = 1; i <= 3; i++) assert.equal(cache.getCachedThumbnail(key(i)), null);
  assert.ok(cache.getCachedThumbnail(key(total)));
});

test('legacy SQLite thumbnails move to files in batches and keep their age', (t) => {
  const dir = tempDir(t);
  const database = legacyDatabase(t, 5);
  const cache = createThumbnailCache({ directory: dir, database });
  assert.equal(cache.migrateLegacyBatch(2), 2);
  assert.equal(cache.migrateLegacyBatch(10), 3);
  assert.equal(cache.migrateLegacyBatch(10), 0);
  assert.equal((database.prepare('SELECT COUNT(*) AS n FROM thumbnail_cache').get() as { n: number }).n, 0);
  // Check the carried-over age before a read refreshes it.
  const stem = key(1);
  const mtime = fs.statSync(path.join(dir, stem.slice(0, 2), `${stem}.jpg`)).mtimeMs;
  assert.ok(Math.abs(mtime - (1_700_000_000_000 + 1)) < 1_000);
  for (let i = 1; i <= 5; i++) assert.equal(cache.getCachedThumbnail(key(i))?.bytes.toString(), `jpeg-${i}`);
});

test('a legacy row read before migration is served and moved', (t) => {
  const dir = tempDir(t);
  const database = legacyDatabase(t, 2);
  const cache = createThumbnailCache({ directory: dir, database });
  assert.equal(cache.getCachedThumbnail(key(2))?.bytes.toString(), 'jpeg-2');
  assert.equal((database.prepare('SELECT COUNT(*) AS n FROM thumbnail_cache').get() as { n: number }).n, 1);
  assert.equal(cache.getCachedThumbnail(key(2))?.bytes.toString(), 'jpeg-2');
});

test('clear removes every cached thumbnail', (t) => {
  const dir = tempDir(t);
  const cache = createThumbnailCache({ directory: dir });
  cache.saveCachedThumbnail(key(1), Buffer.from('x'));
  cache.clear();
  assert.equal(cache.getCachedThumbnail(key(1)), null);
});
