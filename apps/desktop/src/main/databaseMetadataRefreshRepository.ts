import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { parseDatabaseRow } from './databaseRows.ts';

export const metadataRefreshCategories = [
  'core',
  'cast',
  'artwork',
  'ratings',
  'episodes',
  'streaming-providers',
] as const;

export type MetadataRefreshCategory = (typeof metadataRefreshCategories)[number];

const metadataRefreshCategorySchema = z.enum(metadataRefreshCategories);

const metadataRefreshRowSchema = z.object({
  media_id: z.string(),
  category: metadataRefreshCategorySchema,
  refreshed_at: z.number().finite().nonnegative().nullable(),
  attempted_at: z.number().finite().nonnegative(),
  last_error: z.string().nullable(),
  locked: z.union([z.literal(0), z.literal(1)]),
});

export type MetadataRefreshState = {
  mediaId: string;
  category: MetadataRefreshCategory;
  refreshedAt: number | null;
  attemptedAt: number;
  lastError: string | null;
  locked: boolean;
};

export function getMetadataRefreshState(
  database: BetterSqlite3.Database,
  mediaId: string,
  category: MetadataRefreshCategory,
): MetadataRefreshState | null {
  const row = parseDatabaseRow(
    database.prepare(`
      SELECT media_id, category, refreshed_at, attempted_at, last_error, locked
      FROM media_metadata_refresh_state
      WHERE media_id = ? AND category = ?
    `).get(mediaId, category),
    metadataRefreshRowSchema.optional(),
    'Metadata refresh state',
  );
  return row
    ? {
        mediaId: row.media_id,
        category: row.category,
        refreshedAt: row.refreshed_at,
        attemptedAt: row.attempted_at,
        lastError: row.last_error,
        locked: row.locked === 1,
      }
    : null;
}

export function recordMetadataRefresh(
  database: BetterSqlite3.Database,
  mediaId: string,
  category: MetadataRefreshCategory,
  result: { refreshedAt?: number; error?: string; locked?: boolean },
): void {
  const attemptedAt = Date.now();
  const locked = result.locked === undefined ? null : result.locked ? 1 : 0;
  database.prepare(`
    INSERT INTO media_metadata_refresh_state (media_id, category, refreshed_at, attempted_at, last_error, locked)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, 0))
    ON CONFLICT(media_id, category) DO UPDATE SET
      refreshed_at = COALESCE(excluded.refreshed_at, media_metadata_refresh_state.refreshed_at),
      attempted_at = excluded.attempted_at,
      last_error = excluded.last_error,
      locked = COALESCE(?, media_metadata_refresh_state.locked)
  `).run(mediaId, category, result.refreshedAt ?? null, attemptedAt, result.error ?? null, locked, locked);
}

export function setMetadataRefreshCategoryLocked(
  database: BetterSqlite3.Database,
  mediaId: string,
  category: MetadataRefreshCategory,
  locked: boolean,
): void {
  database.prepare(`
    INSERT INTO media_metadata_refresh_state (media_id, category, refreshed_at, attempted_at, last_error, locked)
    VALUES (?, ?, NULL, 0, NULL, ?)
    ON CONFLICT(media_id, category) DO UPDATE SET locked = excluded.locked
  `).run(mediaId, category, locked ? 1 : 0);
}
