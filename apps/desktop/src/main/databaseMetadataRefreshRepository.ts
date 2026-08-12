import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { parseDatabaseRow } from './databaseRows.ts';

const metadataRefreshRowSchema = z.object({
  media_id: z.string(),
  refreshed_at: z.number().finite().nonnegative().nullable(),
  attempted_at: z.number().finite().nonnegative(),
  last_error: z.string().nullable(),
});

export type MetadataRefreshState = {
  mediaId: string;
  refreshedAt: number | null;
  attemptedAt: number;
  lastError: string | null;
};

export function getMetadataRefreshState(
  database: BetterSqlite3.Database,
  mediaId: string,
): MetadataRefreshState | null {
  const row = parseDatabaseRow(
    database.prepare(`
      SELECT media_id, refreshed_at, attempted_at, last_error
      FROM media_metadata_refresh_state
      WHERE media_id = ?
    `).get(mediaId),
    metadataRefreshRowSchema,
    'Metadata refresh state',
  );
  return row
    ? {
        mediaId: row.media_id,
        refreshedAt: row.refreshed_at,
        attemptedAt: row.attempted_at,
        lastError: row.last_error,
      }
    : null;
}

export function recordMetadataRefresh(
  database: BetterSqlite3.Database,
  mediaId: string,
  result: { refreshedAt?: number; error?: string },
): void {
  const attemptedAt = Date.now();
  database.prepare(`
    INSERT INTO media_metadata_refresh_state (media_id, refreshed_at, attempted_at, last_error)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET
      refreshed_at = COALESCE(excluded.refreshed_at, media_metadata_refresh_state.refreshed_at),
      attempted_at = excluded.attempted_at,
      last_error = excluded.last_error
  `).run(mediaId, result.refreshedAt ?? null, attemptedAt, result.error ?? null);
}
