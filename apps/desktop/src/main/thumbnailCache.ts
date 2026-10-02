import type BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseDatabaseRow, parseDatabaseRows } from './databaseRows.ts';

export type CachedThumbnail = {
  bytes: Buffer;
  mimeType: string;
};

const MAX_THUMBNAIL_CACHE_ENTRIES = 8_192;
const MAX_THUMBNAIL_CACHE_BYTES = 256 * 1024 * 1024;
const THUMBNAIL_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_EVERY_SAVES = 64;
const MIGRATION_START_DELAY_MS = 30_000;
const MIGRATION_BATCH_INTERVAL_MS = 1_000;
const MIGRATION_BATCH_ROWS = 100;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const MIME_BY_EXTENSION = Object.fromEntries(Object.entries(EXTENSION_BY_MIME).map(([mime, ext]) => [ext, mime]));

const legacyRowSchema = z.object({
  cache_key: z.string(),
  mime_type: z.string(),
  image_bytes: z.instanceof(Buffer),
  updated_at: z.number().finite(),
});
const legacyLookupSchema = legacyRowSchema.omit({ cache_key: true });

type Entry = { filePath: string; bytes: number; mtimeMs: number };

/**
 * Video thumbnails and seek previews, stored as files beside the artwork
 * cache. They used to live as BLOBs in loomtv.sqlite, where 64 MB of them made
 * up most of a 139 MB database: every backup copied them, and every save
 * summed the whole table on the main thread to enforce the quota. Rows left
 * in that table are moved here in small batches; quit-time compaction then
 * returns the freed pages.
 */
export function createThumbnailCache(options: {
  directory: string;
  database?: BetterSqlite3.Database;
  /** Starts the legacy-table migration; tests drive it with migrateLegacyBatch. */
  scheduleMigration?: boolean;
}) {
  const { directory, database } = options;
  let savesSinceSweep = 0;
  let legacyRowsRemain = Boolean(database && legacyTableExists(database));
  let migrationTimer: NodeJS.Timeout | null = null;

  function legacyTableExists(db: BetterSqlite3.Database): boolean {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thumbnail_cache'").get());
  }

  function fileStem(cacheKey: string): string {
    // Keys are SHA-256 hex today; hash anything else so it cannot name a path.
    return /^[a-f0-9]{16,128}$/.test(cacheKey) ? cacheKey : createHash('sha256').update(cacheKey).digest('hex');
  }

  function filePathFor(cacheKey: string, mimeType: string): string | null {
    const extension = EXTENSION_BY_MIME[mimeType.toLowerCase()];
    if (!extension) return null;
    const stem = fileStem(cacheKey);
    return path.join(directory, stem.slice(0, 2), `${stem}${extension}`);
  }

  function writeFile(target: string, bytes: Buffer, mtimeMs?: number): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
    if (mtimeMs !== undefined) {
      const seconds = mtimeMs / 1000;
      fs.utimesSync(target, seconds, seconds);
    }
  }

  function readFile(cacheKey: string): CachedThumbnail | null {
    for (const [mimeType] of Object.entries(EXTENSION_BY_MIME)) {
      const target = filePathFor(cacheKey, mimeType);
      if (!target) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(target);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;
      const bytes = fs.readFileSync(target);
      // File times are the LRU order; refresh at most hourly.
      const now = Date.now();
      if (now - stat.mtimeMs >= THUMBNAIL_TOUCH_INTERVAL_MS) {
        try { fs.utimesSync(target, now / 1000, now / 1000); } catch { /* order only */ }
      }
      return { bytes, mimeType };
    }
    return null;
  }

  function readLegacy(cacheKey: string): CachedThumbnail | null {
    if (!database || !legacyRowsRemain) return null;
    const row = parseDatabaseRow(
      database.prepare('SELECT mime_type, image_bytes, updated_at FROM thumbnail_cache WHERE cache_key = ?').get(cacheKey),
      legacyLookupSchema.optional(),
      'thumbnail cache',
    );
    if (!row?.image_bytes?.byteLength) return null;
    const target = filePathFor(cacheKey, row.mime_type);
    if (target) {
      writeFile(target, row.image_bytes);
      database.prepare('DELETE FROM thumbnail_cache WHERE cache_key = ?').run(cacheKey);
    }
    return { bytes: row.image_bytes, mimeType: row.mime_type };
  }

  function listEntries(): Entry[] {
    const entries: Entry[] = [];
    let shards: string[];
    try {
      shards = fs.readdirSync(directory);
    } catch {
      return entries;
    }
    for (const shard of shards) {
      const shardPath = path.join(directory, shard);
      let names: string[];
      try {
        names = fs.readdirSync(shardPath);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!MIME_BY_EXTENSION[path.extname(name)]) continue;
        const filePath = path.join(shardPath, name);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) entries.push({ filePath, bytes: stat.size, mtimeMs: stat.mtimeMs });
        } catch { /* removed meanwhile */ }
      }
    }
    return entries;
  }

  /** Delete least recently used files until the cache is within both limits. */
  function enforceQuota(): number {
    const entries = listEntries();
    let count = entries.length;
    let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    if (count <= MAX_THUMBNAIL_CACHE_ENTRIES && bytes <= MAX_THUMBNAIL_CACHE_BYTES) return 0;
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let removed = 0;
    for (const entry of entries) {
      if (count <= MAX_THUMBNAIL_CACHE_ENTRIES && bytes <= MAX_THUMBNAIL_CACHE_BYTES) break;
      try { fs.rmSync(entry.filePath, { force: true }); } catch { continue; }
      count -= 1;
      bytes -= entry.bytes;
      removed += 1;
    }
    return removed;
  }

  function getCachedThumbnail(cacheKey: string): CachedThumbnail | null {
    if (!cacheKey) return null;
    return readFile(cacheKey) ?? readLegacy(cacheKey);
  }

  function saveCachedThumbnail(cacheKey: string, bytes: Buffer, mimeType = 'image/jpeg'): void {
    if (!cacheKey || bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_CACHE_BYTES) return;
    const target = filePathFor(cacheKey, mimeType);
    if (!target) return;
    writeFile(target, bytes);
    savesSinceSweep += 1;
    if (savesSinceSweep >= SWEEP_EVERY_SAVES) {
      savesSinceSweep = 0;
      enforceQuota();
    }
  }

  /** Move one batch of legacy rows to files. Returns how many rows moved. */
  function migrateLegacyBatch(limit = MIGRATION_BATCH_ROWS): number {
    if (!database || !legacyRowsRemain) return 0;
    const rows = parseDatabaseRows(
      database.prepare('SELECT cache_key, mime_type, image_bytes, updated_at FROM thumbnail_cache ORDER BY updated_at DESC LIMIT ?').all(limit),
      legacyRowSchema,
      'thumbnail cache migration',
    );
    if (rows.length === 0) {
      legacyRowsRemain = false;
      enforceQuota();
      return 0;
    }
    const remove = database.prepare('DELETE FROM thumbnail_cache WHERE cache_key = ?');
    const moved: string[] = [];
    for (const row of rows) {
      const target = filePathFor(row.cache_key, row.mime_type);
      try {
        if (target && row.image_bytes.byteLength > 0 && !fs.existsSync(target)) writeFile(target, row.image_bytes, row.updated_at);
      } catch (error) {
        // Leave the row for a later launch rather than lose the thumbnail.
        console.warn('[thumbnails] Could not move a cached thumbnail to disk:', error instanceof Error ? error.message : error);
        continue;
      }
      moved.push(row.cache_key);
    }
    database.transaction(() => { for (const key of moved) remove.run(key); })();
    if (moved.length === 0) legacyRowsRemain = false;
    return moved.length;
  }

  function scheduleNextBatch(delayMs: number): void {
    if (!legacyRowsRemain || migrationTimer) return;
    migrationTimer = setTimeout(() => {
      migrationTimer = null;
      try {
        if (migrateLegacyBatch() > 0) scheduleNextBatch(MIGRATION_BATCH_INTERVAL_MS);
      } catch (error) {
        console.warn('[thumbnails] Thumbnail cache migration stopped:', error instanceof Error ? error.message : error);
      }
    }, delayMs);
    migrationTimer.unref?.();
  }

  /** Remove every cached thumbnail, for "clear app data". */
  function clear(): void {
    if (migrationTimer) clearTimeout(migrationTimer);
    migrationTimer = null;
    fs.rmSync(directory, { recursive: true, force: true });
    legacyRowsRemain = false;
  }

  if (options.scheduleMigration) scheduleNextBatch(MIGRATION_START_DELAY_MS);

  return { getCachedThumbnail, saveCachedThumbnail, migrateLegacyBatch, enforceQuota, clear };
}

export const THUMBNAIL_CACHE_LIMITS = {
  entries: MAX_THUMBNAIL_CACHE_ENTRIES,
  bytes: MAX_THUMBNAIL_CACHE_BYTES,
} as const;
