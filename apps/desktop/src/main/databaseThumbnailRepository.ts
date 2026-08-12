import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { parseDatabaseRow, parseDatabaseRows } from './databaseRows.ts';

export type CachedThumbnail = {
  bytes: Buffer;
  mimeType: string;
};

const MAX_THUMBNAIL_CACHE_ENTRIES = 8_192;
const MAX_THUMBNAIL_CACHE_BYTES = 256 * 1024 * 1024;
const thumbnailRowSchema = z.object({ mime_type: z.string(), image_bytes: z.instanceof(Buffer) });
const thumbnailQuotaRowSchema = z.object({ count: z.number().finite(), bytes: z.number().finite() });
const thumbnailEntryRowSchema = z.object({ cache_key: z.string(), bytes: z.number().finite() });

export function createDatabaseThumbnailRepository(database: BetterSqlite3.Database) {
  function getCachedThumbnail(cacheKey: string): CachedThumbnail | null {
    const row = parseDatabaseRow(
      database.prepare('SELECT mime_type, image_bytes FROM thumbnail_cache WHERE cache_key = ?').get(cacheKey),
      thumbnailRowSchema.optional(),
      'thumbnail cache',
    );
    if (!row?.image_bytes?.byteLength) return null;
    database.prepare('UPDATE thumbnail_cache SET updated_at = ? WHERE cache_key = ?').run(Date.now(), cacheKey);
    return { bytes: Buffer.from(row.image_bytes), mimeType: row.mime_type };
  }

  function trimForIncoming(cacheKey: string, incomingBytes: number): void {
    if (incomingBytes > MAX_THUMBNAIL_CACHE_BYTES) return;
    const current = parseDatabaseRow(
      database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(image_bytes)), 0) AS bytes FROM thumbnail_cache WHERE cache_key <> ?').get(cacheKey),
      thumbnailQuotaRowSchema,
      'thumbnail cache quota',
    );
    if (
      current.count + 1 <= MAX_THUMBNAIL_CACHE_ENTRIES
      && current.bytes + incomingBytes <= MAX_THUMBNAIL_CACHE_BYTES
    ) return;

    const rows = parseDatabaseRows(
      database.prepare('SELECT cache_key, length(image_bytes) AS bytes FROM thumbnail_cache WHERE cache_key <> ? ORDER BY updated_at ASC').all(cacheKey),
      thumbnailEntryRowSchema,
      'thumbnail cache entry',
    );
    let count = current.count;
    let bytes = current.bytes;
    const remove = database.prepare('DELETE FROM thumbnail_cache WHERE cache_key = ?');
    for (const row of rows) {
      if (
        count + 1 <= MAX_THUMBNAIL_CACHE_ENTRIES
        && bytes + incomingBytes <= MAX_THUMBNAIL_CACHE_BYTES
      ) break;
      remove.run(row.cache_key);
      count -= 1;
      bytes -= row.bytes;
    }
  }

  function saveCachedThumbnail(cacheKey: string, bytes: Buffer, mimeType = 'image/jpeg'): void {
    if (!cacheKey || bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_CACHE_BYTES) return;
    trimForIncoming(cacheKey, bytes.byteLength);
    database.prepare(`
      INSERT OR REPLACE INTO thumbnail_cache (cache_key, mime_type, image_bytes, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(cacheKey, mimeType, bytes, Date.now());
  }

  return { getCachedThumbnail, saveCachedThumbnail };
}
