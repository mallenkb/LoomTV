import path from 'node:path';

const PROBE_CACHE_BUDGET_BYTES = 24 * 1024 * 1024;
const PROBE_CACHE_TTL_MS = 30 * 60 * 1_000;
const PROBE_CACHE_ENTRY_OVERHEAD_BYTES = 256;
const PROBE_CACHE_VARIANT_OVERHEAD_BYTES = 64;
const MAX_ESTIMATE_NODES = 100_000;
const PROBE_CACHE_READ_PRUNE_LIMIT = 8;

export type ProbeCacheVariant = 'media-file' | 'media';

type CachedProbeValue = {
  value: unknown;
  estimatedBytes: number;
};

type SharedProbeCacheEntry = {
  variants: Map<ProbeCacheVariant, CachedProbeValue>;
  estimatedBytes: number;
  lastAccessAt: number;
};

const sharedProbeCache = new Map<string, SharedProbeCacheEntry>();
let sharedProbeCacheBytes = 0;

export function makeProbeCacheKey(filePath: string, size: number, modifiedAtMs: number): string {
  // JSON tuple encoding avoids collisions with valid paths that themselves
  // contain colons or numeric suffixes.
  return JSON.stringify([path.resolve(filePath), size, Math.round(modifiedAtMs)])!;
}

function estimateProbeValueBytes(value: unknown): number {
  const seen = new Set<object>();
  let visitedNodes = 0;

  const visit = (current: unknown): number => {
    if (current === null || current === undefined) return 0;

    switch (typeof current) {
      case 'string':
        return 24 + Buffer.byteLength(current, 'utf8') * 2;
      case 'number':
      case 'boolean':
      case 'bigint':
        return 16;
      case 'function':
      case 'symbol':
        return 0;
      default:
        break;
    }

    if (typeof current !== 'object') return 0;
    if (seen.has(current)) return 0;
    seen.add(current);
    visitedNodes += 1;
    if (visitedNodes > MAX_ESTIMATE_NODES) return PROBE_CACHE_BUDGET_BYTES + 1;

    if (Array.isArray(current)) {
      let total = 64;
      for (const item of current) {
        total += visit(item);
        if (total > PROBE_CACHE_BUDGET_BYTES) return PROBE_CACHE_BUDGET_BYTES + 1;
      }
      return total;
    }

    const record = current as Record<string, unknown>;
    let total = 64;
    for (const key of Object.keys(record)) {
      total += 24 + Buffer.byteLength(key, 'utf8') * 2 + visit(record[key]);
      if (total > PROBE_CACHE_BUDGET_BYTES) return PROBE_CACHE_BUDGET_BYTES + 1;
    }
    return total;
  };

  return Math.max(256, visit(value));
}

function estimateEntryBytes(cacheKey: string, variants: Map<ProbeCacheVariant, CachedProbeValue>): number {
  return PROBE_CACHE_ENTRY_OVERHEAD_BYTES
    + Buffer.byteLength(cacheKey, 'utf8') * 2
    + Array.from(variants.entries()).reduce(
      (total, [variant, cached]) => total
        + PROBE_CACHE_VARIANT_OVERHEAD_BYTES
        + Buffer.byteLength(variant, 'utf8') * 2
        + cached.estimatedBytes,
      0,
    );
}

function removeEntry(cacheKey: string, entry: SharedProbeCacheEntry): void {
  sharedProbeCache.delete(cacheKey);
  sharedProbeCacheBytes -= entry.estimatedBytes;
}

function pruneExpired(now: number, limit = Number.POSITIVE_INFINITY): void {
  // Map order is the LRU queue, so once the oldest entry is still fresh every
  // later entry is fresh too. Reads prune only a bounded number of stale
  // entries; writes can perform the full amortized cleanup before eviction.
  let removed = 0;
  while (sharedProbeCache.size > 0 && removed < limit) {
    const oldestKey = sharedProbeCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    const oldestEntry = sharedProbeCache.get(oldestKey);
    if (!oldestEntry) {
      sharedProbeCache.delete(oldestKey);
      continue;
    }
    if (now - oldestEntry.lastAccessAt < PROBE_CACHE_TTL_MS) return;
    removeEntry(oldestKey, oldestEntry);
    removed += 1;
  }
}

function touchEntry(cacheKey: string, entry: SharedProbeCacheEntry, now: number): void {
  entry.lastAccessAt = now;
  // Map insertion order is the LRU queue; moving the entry to the end marks it hot.
  sharedProbeCache.delete(cacheKey);
  sharedProbeCache.set(cacheKey, entry);
}

export function getSharedProbeResult<T>(
  cacheKey: string | null,
  variant: ProbeCacheVariant,
): T | undefined {
  if (!cacheKey) return undefined;

  const now = Date.now();
  pruneExpired(now, PROBE_CACHE_READ_PRUNE_LIMIT);
  const entry = sharedProbeCache.get(cacheKey);
  if (entry && now - entry.lastAccessAt >= PROBE_CACHE_TTL_MS) {
    removeEntry(cacheKey, entry);
    return undefined;
  }
  const cached = entry?.variants.get(variant);
  if (!entry || !cached) return undefined;

  touchEntry(cacheKey, entry, now);
  return cached.value as T;
}

export function setSharedProbeResult<T>(
  cacheKey: string | null,
  variant: ProbeCacheVariant,
  value: T,
): void {
  if (!cacheKey) return;

  const now = Date.now();
  pruneExpired(now);
  const cachedValue: CachedProbeValue = {
    value,
    estimatedBytes: estimateProbeValueBytes(value),
  };
  const existing = sharedProbeCache.get(cacheKey);
  const candidateVariants = new Map(existing?.variants);
  candidateVariants.set(variant, cachedValue);

  let variants = candidateVariants;
  let estimatedBytes = estimateEntryBytes(cacheKey, variants);
  if (estimatedBytes > PROBE_CACHE_BUDGET_BYTES) {
    // Do not retain two shapes for one file when their combined estimate is too large.
    // If the new result fits alone, cache it as the most recently requested shape.
    variants = new Map([[variant, cachedValue]]);
    estimatedBytes = estimateEntryBytes(cacheKey, variants);
  }
  if (estimatedBytes > PROBE_CACHE_BUDGET_BYTES) return;

  if (existing) removeEntry(cacheKey, existing);
  while (sharedProbeCacheBytes + estimatedBytes > PROBE_CACHE_BUDGET_BYTES) {
    const oldestKey = sharedProbeCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldestEntry = sharedProbeCache.get(oldestKey);
    if (oldestEntry) removeEntry(oldestKey, oldestEntry);
  }

  sharedProbeCache.set(cacheKey, {
    variants,
    estimatedBytes,
    lastAccessAt: now,
  });
  sharedProbeCacheBytes += estimatedBytes;
}
