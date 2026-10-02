import fs from 'node:fs';
import path from 'node:path';

/**
 * Chromium's HTTP disk cache only ever holds Loom's own loopback responses:
 * the renderer loads artwork, thumbnails and streams from 127.0.0.1, and the
 * host keeps the real artwork cache on disk. Those URLs carry the per-launch
 * access token, so every launch wrote the same images again under new keys
 * and the cache grew to Chromium's default ceiling (about 1 GB measured).
 * A small cap keeps in-session reuse and bounds the duplicate.
 */
export const HTTP_DISK_CACHE_BYTES = 64 * 1024 * 1024;

const TRIM_MARKER = '.http-cache-budget-v1';

export function httpDiskCacheSwitch(): [string, string] {
  return ['disk-cache-size', String(HTTP_DISK_CACHE_BYTES)];
}

/**
 * Clear the cache once for installs that filled it before the cap existed.
 * Chromium only evicts down to a lowered limit as new entries arrive, so the
 * old gigabyte would otherwise stay on disk indefinitely.
 */
export async function clearOversizedHttpCacheOnce(
  userDataDir: string,
  clearCache: () => Promise<void>,
): Promise<boolean> {
  const marker = path.join(userDataDir, TRIM_MARKER);
  if (fs.existsSync(marker)) return false;
  await clearCache();
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  return true;
}
