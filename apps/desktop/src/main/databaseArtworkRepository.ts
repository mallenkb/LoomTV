import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { LibraryData } from './appContracts.ts';
import { artworkCacheFileName, collectArtworkSourcesForCache } from './artworkCache.ts';

export type CachedArtwork = {
  dataUrl?: string;
  cachePath?: string;
  mimeType: string;
  byteLength: number;
};

export type FetchedArtworkBytes = {
  bytes: Buffer;
  mimeType: string;
  byteLength: number;
};

type ArtworkRepositoryDependencies = {
  cacheDirectory: string;
  fetchArtworkBytes: (sourceUrl: string) => Promise<FetchedArtworkBytes | null>;
};

export function createDatabaseArtworkRepository(
  database: BetterSqlite3.Database,
  deps: ArtworkRepositoryDependencies,
) {
  function saveCustomArtwork(mediaId: string, target: string, dataUrl: string): void {
    database.prepare(`
      INSERT OR REPLACE INTO custom_artwork (media_id, target, data_url, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(mediaId, target, dataUrl, Date.now());
  }

  function getCustomArtwork(mediaId: string): Record<string, string> {
    return Object.fromEntries((database.prepare('SELECT target, data_url FROM custom_artwork WHERE media_id = ?').all(mediaId) as Array<{ target: string; data_url: string }>)
      .map((row): [string, string] => [row.target, row.data_url]));
  }

  function getCustomArtworkData(mediaId: string, target: string): { dataUrl: string; updatedAt: number } | null {
    const row = database.prepare('SELECT data_url, updated_at FROM custom_artwork WHERE media_id = ? AND target = ?').get(mediaId, target) as
      | { data_url: string; updated_at: number }
      | undefined;
    return row ? { dataUrl: row.data_url, updatedAt: row.updated_at } : null;
  }

  function importCustomArtwork(entries: Record<string, Record<string, string>>): void {
    const tx = database.transaction(() => {
      for (const [mediaId, targets] of Object.entries(entries || {})) {
        for (const [target, dataUrl] of Object.entries(targets || {})) {
          if (dataUrl) saveCustomArtwork(mediaId, target, dataUrl);
        }
      }
    });
    tx();
  }

  function getCustomArtworkMap(): Map<string, Map<string, string>> {
    const result = new Map<string, Map<string, string>>();
    const rows = database
      .prepare('SELECT media_id, target, data_url FROM custom_artwork')
      .all() as Array<{ media_id: string; target: string; data_url: string }>;
    for (const row of rows) {
      let targetMap = result.get(row.media_id);
      if (!targetMap) {
        targetMap = new Map();
        result.set(row.media_id, targetMap);
      }
      targetMap.set(row.target, row.data_url);
    }
    return result;
  }

  function getCachedArtwork(sourceUrl: string): CachedArtwork | null {
    const row = database.prepare('SELECT data_url, cache_path, mime_type, byte_length FROM artwork_cache WHERE source_url = ?').get(sourceUrl) as
      | { data_url: string; cache_path?: string | null; mime_type: string; byte_length: number }
      | undefined;
    if (!row) return null;
    const cachePath = row.cache_path || undefined;
    if (cachePath && fs.existsSync(cachePath)) {
      return { cachePath, mimeType: row.mime_type, byteLength: row.byte_length };
    }
    return row.data_url ? { dataUrl: row.data_url, mimeType: row.mime_type, byteLength: row.byte_length } : null;
  }

  // The desktop is the LAN artwork source. When an older library entry has not
  // been pre-cached yet, fetch and persist the image here instead of making a
  // paired device follow a redirect to the metadata provider.
  async function cacheArtworkSource(sourceUrl: string): Promise<CachedArtwork | null> {
    const existing = getCachedArtwork(sourceUrl);
    if (existing) return existing;

    const cached = await deps.fetchArtworkBytes(sourceUrl);
    if (!cached) return null;

    const cachePath = path.join(deps.cacheDirectory, artworkCacheFileName(sourceUrl, cached.mimeType));
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, cached.bytes);
    database.prepare(`
      INSERT OR REPLACE INTO artwork_cache (source_url, data_url, cache_path, mime_type, byte_length, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sourceUrl, '', cachePath, cached.mimeType, cached.byteLength, Date.now());

    return {
      cachePath,
      mimeType: cached.mimeType,
      byteLength: cached.byteLength,
    };
  }

  async function cacheLibraryArtwork(data: LibraryData): Promise<void> {
    const sources = collectArtworkSourcesForCache(data);

    const cacheDir = deps.cacheDirectory;
    fs.mkdirSync(cacheDir, { recursive: true });
    const sourceSet = new Set(sources);
    const rows = database.prepare('SELECT source_url, cache_path FROM artwork_cache').all() as Array<{ source_url: string; cache_path?: string | null }>;
    const deleteStale = database.prepare('DELETE FROM artwork_cache WHERE source_url = ?');
    const pruneStale = database.transaction(() => {
      for (const row of rows) {
        if (!sourceSet.has(row.source_url)) {
          if (row.cache_path) {
            try {
              if (fs.existsSync(row.cache_path)) fs.unlinkSync(row.cache_path);
            } catch {
              // Cache file cleanup is best-effort; the database row is authoritative.
            }
          }
          deleteStale.run(row.source_url);
        }
      }
    });
    pruneStale();

    if (sources.length === 0) return;

    const existing = new Set(rows.map((row) => row.source_url).filter((source) => sourceSet.has(source)));
    const pending = sources.filter((source) => !existing.has(source));
    const insert = database.prepare(`
      INSERT OR REPLACE INTO artwork_cache (source_url, data_url, cache_path, mime_type, byte_length, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let index = 0;
    const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (index < pending.length) {
        const source = pending[index++];
        const cached = await deps.fetchArtworkBytes(source);
        if (cached) {
          const cachePath = path.join(cacheDir, artworkCacheFileName(source, cached.mimeType));
          fs.writeFileSync(cachePath, cached.bytes);
          insert.run(source, '', cachePath, cached.mimeType, cached.byteLength, Date.now());
        }
      }
    });
    await Promise.all(workers);
  }

  return {
    cacheArtworkSource,
    cacheLibraryArtwork,
    getCachedArtwork,
    getCustomArtwork,
    getCustomArtworkData,
    getCustomArtworkMap,
    importCustomArtwork,
    saveCustomArtwork,
  };
}
