import type BetterSqlite3 from 'better-sqlite3';

// SQLite keeps pages that deletes free inside the file. Thumbnail and artwork
// cache churn left real libraries with half their file as free pages.
const AUTO_VACUUM_INCREMENTAL = 2;
const MIN_WASTED_BYTES = 32 * 1024 * 1024;
const MIN_WASTED_FRACTION = 0.25;
// Idle trims stay small so a single step never stalls the main thread.
const IDLE_TRIM_PAGES = 2_048;

type PageStats = { pageCount: number; freePages: number; pageSize: number; autoVacuum: number };

function pageStats(database: BetterSqlite3.Database): PageStats {
  return {
    pageCount: Number(database.pragma('page_count', { simple: true })),
    freePages: Number(database.pragma('freelist_count', { simple: true })),
    pageSize: Number(database.pragma('page_size', { simple: true })),
    autoVacuum: Number(database.pragma('auto_vacuum', { simple: true })),
  };
}

/**
 * Rewrite the file once when most of it is free pages, switching it to
 * incremental auto-vacuum on the way. VACUUM blocks for about a second per
 * 100 MB, so this runs only while the app is quitting.
 */
export function compactDatabaseIfWasteful(database: BetterSqlite3.Database): boolean {
  const stats = pageStats(database);
  if (stats.autoVacuum === AUTO_VACUUM_INCREMENTAL || stats.pageCount === 0) return false;
  const wastedBytes = stats.freePages * stats.pageSize;
  if (wastedBytes < MIN_WASTED_BYTES || stats.freePages / stats.pageCount < MIN_WASTED_FRACTION) return false;
  database.pragma('auto_vacuum = INCREMENTAL');
  database.exec('VACUUM');
  return true;
}

/** Return a bounded number of free pages to the filesystem. Cheap enough for idle time. */
export function trimFreePages(database: BetterSqlite3.Database, maxPages = IDLE_TRIM_PAGES): number {
  const stats = pageStats(database);
  if (stats.autoVacuum !== AUTO_VACUUM_INCREMENTAL || stats.freePages === 0) return 0;
  const pages = Math.min(stats.freePages, Math.max(1, Math.floor(maxPages)));
  database.pragma(`incremental_vacuum(${pages})`);
  return pages;
}
