import { createHash } from 'node:crypto';

// All input must already be filtered for the active profile. Only the public
// serializer may copy fields from stored media into this response.
/** @typedef {{ id?: string, kind?: string, title?: string, available?: boolean, animeLikely?: boolean, seriesId?: string, year?: number, seasonNumber?: number, episodeNumber?: number, rating?: number, createdAt?: number, updatedAt?: number, sourceIds?: string[], legacyIds?: string[], summary?: string, genres?: string[], providerIds?: Record<string, string> }} PublicCatalogItem */
/**
 * @template {{ kind?: string, seriesId?: string, series?: { title: string }, animeLikely?: boolean }} StoredItem
 * @param {StoredItem[]} source
 * @param {(item: StoredItem) => PublicCatalogItem} serialize
 */
export function publicCatalog(source, serialize) {
  const items = source.map(serialize);
  const series = new Map(items.filter((item) => item.kind === 'series').map((item) => [item.id, item]));
  for (let index = 0; index < source.length; index += 1) {
    const stored = source[index];
    if (stored.kind !== 'episode') continue;
    const title = stored.series?.title;
    const seriesId = stored.seriesId || (title ? `series:${encodeURIComponent(title.toLowerCase())}` : null);
    if (!seriesId) continue;
    items[index] = { ...items[index], seriesId };
    if (!series.has(seriesId)) {
      series.set(seriesId, { id: seriesId, kind: 'series', title: title || 'Untitled', available: true, animeLikely: stored.animeLikely === true });
    } else if (stored.animeLikely) {
      const existing = series.get(seriesId);
      if (existing) series.set(seriesId, { ...existing, animeLikely: true });
    }
  }
  const result = [...items.filter((item) => item.kind !== 'series'), ...series.values()];
  const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return { items: result, etag: `"${digest}"`, revision: Number.parseInt(digest.slice(0, 12), 16) };
}
