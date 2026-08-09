import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { LibraryData } from './appContracts.ts';
import { artworkCacheFileName, collectArtworkSourcesForCache } from './artworkCache.ts';

export type CachedArtwork = {
  dataUrl?: string;
  cachePath?: string;
  mimeType: string;
  byteLength: number;
  contentHash?: string;
};

export type FetchedArtworkBytes = {
  bytes: Buffer;
  mimeType: string;
  byteLength: number;
  contentHash: string;
};

type ArtworkRepositoryDependencies = {
  cacheDirectory: string;
  fetchArtworkBytes: (sourceUrl: string) => Promise<FetchedArtworkBytes | null>;
};

export function createDatabaseArtworkRepository(
  database: BetterSqlite3.Database,
  deps: ArtworkRepositoryDependencies,
) {
  const pendingArtwork = new Map<string, Promise<CachedArtwork | null>>();

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
    const row = database.prepare('SELECT data_url, cache_path, mime_type, byte_length, content_hash FROM artwork_cache WHERE source_url = ?').get(sourceUrl) as
      | { data_url: string; cache_path?: string | null; mime_type: string; byte_length: number; content_hash?: string | null }
      | undefined;
    if (!row) return null;
    const cachePath = row.cache_path || undefined;
    let bytes: Buffer;
    if (cachePath && fs.existsSync(cachePath)) {
      bytes = fs.readFileSync(cachePath);
    } else if (row.data_url) {
      const encoded = row.data_url.includes(',') ? row.data_url.slice(row.data_url.indexOf(',') + 1) : '';
      if (!encoded) return null;
      bytes = Buffer.from(encoded, 'base64');
    } else {
      return null;
    }

    try {
      // Artwork is normalized before insertion by the bounded worker. Cache
      // reads verify the immutable bytes without decoding again on Electron's
      // main thread. Legacy/unverifiable rows fail closed and are refetched.
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      if (
        row.mime_type !== 'image/png'
        || row.byte_length !== bytes.byteLength
        || !/^[a-f0-9]{64}$/.test(row.content_hash || '')
        || row.content_hash !== contentHash
      ) throw new Error('Cached artwork integrity check failed.');
      if (cachePath && fs.existsSync(cachePath)) {
        return { cachePath, mimeType: 'image/png', byteLength: bytes.byteLength, contentHash };
      }
      return { dataUrl: row.data_url, mimeType: 'image/png', byteLength: bytes.byteLength, contentHash };
    } catch {
      if (cachePath) {
        try { if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath); } catch { /* best effort */ }
      }
      database.prepare('DELETE FROM artwork_cache WHERE source_url = ?').run(sourceUrl);
      return null;
    }
  }

  function enforceQuota(incomingBytes: number, sourceUrl: string): void {
    const MAX_ENTRIES = 4_096;
    const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
    const current = database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes FROM artwork_cache WHERE source_url <> ?').get(sourceUrl) as { count: number; bytes: number };
    if (current.count + 1 <= MAX_ENTRIES && current.bytes + incomingBytes <= MAX_TOTAL_BYTES) return;
    const rows = database.prepare('SELECT source_url, cache_path, byte_length FROM artwork_cache WHERE source_url <> ? ORDER BY updated_at ASC').all(sourceUrl) as Array<{ source_url: string; cache_path?: string | null; byte_length: number }>;
    let count = current.count;
    let bytes = current.bytes;
    const remove = database.prepare('DELETE FROM artwork_cache WHERE source_url = ?');
    for (const row of rows) {
      if (count + 1 <= MAX_ENTRIES && bytes + incomingBytes <= MAX_TOTAL_BYTES) break;
      if (row.cache_path) {
        try { if (fs.existsSync(row.cache_path)) fs.unlinkSync(row.cache_path); } catch { /* best effort */ }
      }
      remove.run(row.source_url);
      count -= 1;
      bytes -= row.byte_length;
    }
  }

  // The desktop is the LAN artwork source. When an older library entry has not
  // been pre-cached yet, fetch and persist the image here instead of making a
  // paired device follow a redirect to the metadata provider.
  async function cacheArtworkSource(sourceUrl: string): Promise<CachedArtwork | null> {
    const existing = getCachedArtwork(sourceUrl);
    if (existing) return existing;
    const pending = pendingArtwork.get(sourceUrl);
    if (pending) return pending;

    const request = (async () => {
      const cached = await deps.fetchArtworkBytes(sourceUrl);
      if (!cached) return null;

      enforceQuota(cached.byteLength, sourceUrl);
      const cachePath = path.join(deps.cacheDirectory, artworkCacheFileName(sourceUrl, cached.mimeType));
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, cached.bytes);
      database.prepare(`
        INSERT OR REPLACE INTO artwork_cache (source_url, data_url, cache_path, mime_type, byte_length, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sourceUrl, '', cachePath, cached.mimeType, cached.byteLength, cached.contentHash, Date.now());

      return {
        cachePath,
        mimeType: cached.mimeType,
        byteLength: cached.byteLength,
        contentHash: cached.contentHash,
      };
    })().finally(() => {
      pendingArtwork.delete(sourceUrl);
    });
    pendingArtwork.set(sourceUrl, request);
    return request;
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

    const existing = new Set<string>();
    for (const row of rows) {
      if (sourceSet.has(row.source_url) && getCachedArtwork(row.source_url)) existing.add(row.source_url);
    }
    const pending = sources.filter((source) => !existing.has(source));
    let index = 0;
    const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (index < pending.length) {
        const source = pending[index++];
        await cacheArtworkSource(source);
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
