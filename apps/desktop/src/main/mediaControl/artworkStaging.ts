import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Turn the renderer's artwork URL into a local image file.
 *
 * macOS Now Playing wants an `NSImage`, not a URL, so artwork has to exist on
 * disk before it can be published. Only two sources are accepted: a `file:`
 * URL, and LoomTV's own loopback media server. A media key must never become a
 * way to make the main process fetch an arbitrary remote address, and every
 * artwork URL the player produces is already one of those two.
 *
 * Staging is best-effort and asynchronous. Now Playing is published immediately
 * without artwork and refreshed once the file lands.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_ARTWORK_BYTES = 4 * 1024 * 1024;

export type ArtworkStagingOptions = {
  /** Directory for staged images; created on demand. */
  cacheDirectory: string;
  fetchImage?: (url: string) => Promise<ArrayBuffer | null>;
  logWarning?: (message: string, error?: unknown) => void;
};

export type ArtworkStagingResult = {
  /** Local path for this URL, or null when it is not staged (yet or ever). */
  filePathFor: (artworkUrl: string | undefined) => string | null;
  /** Stage the URL if needed; resolves true when a new file became available. */
  stage: (artworkUrl: string | undefined) => Promise<boolean>;
  clear: () => void;
};

/** Whether this URL may be read for artwork. Exported for tests. */
export function isStageableArtworkUrl(artworkUrl: string): boolean {
  try {
    const parsed = new URL(artworkUrl);
    if (parsed.protocol === 'file:') return true;
    if (parsed.protocol !== 'http:') return false;
    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function cacheKey(artworkUrl: string): string {
  return createHash('sha256').update(artworkUrl).digest('hex').slice(0, 32);
}

export function createArtworkStaging(options: ArtworkStagingOptions): ArtworkStagingResult {
  const { cacheDirectory, logWarning } = options;
  const fetchImage = options.fetchImage ?? (async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return buffer.byteLength > MAX_ARTWORK_BYTES ? null : buffer;
  });

  const staged = new Map<string, string>();
  const inFlight = new Set<string>();

  const filePathFor = (artworkUrl: string | undefined): string | null => {
    if (!artworkUrl) return null;
    return staged.get(artworkUrl) ?? null;
  };

  return {
    filePathFor,

    async stage(artworkUrl) {
      if (!artworkUrl || staged.has(artworkUrl) || inFlight.has(artworkUrl)) return false;
      if (!isStageableArtworkUrl(artworkUrl)) return false;

      inFlight.add(artworkUrl);
      try {
        const parsed = new URL(artworkUrl);
        if (parsed.protocol === 'file:') {
          const localPath = decodeURIComponent(parsed.pathname);
          if (!fs.statSync(localPath).isFile()) return false;
          staged.set(artworkUrl, localPath);
          return true;
        }

        const buffer = await fetchImage(artworkUrl);
        if (!buffer || buffer.byteLength === 0 || buffer.byteLength > MAX_ARTWORK_BYTES) return false;

        fs.mkdirSync(cacheDirectory, { recursive: true });
        const target = path.join(cacheDirectory, `${cacheKey(artworkUrl)}.img`);
        fs.writeFileSync(target, Buffer.from(buffer));
        staged.set(artworkUrl, target);
        return true;
      } catch (error) {
        logWarning?.('[media-control] Staging Now Playing artwork failed.', error);
        return false;
      } finally {
        inFlight.delete(artworkUrl);
      }
    },

    clear() {
      staged.clear();
      inFlight.clear();
    },
  };
}
