import fs from 'node:fs';
import path from 'node:path';

/** No writes for this long: the file is finished, organize it now. */
export const QUIET_MS = 60_000;
/** Otherwise two looks this far apart with the same size and time. */
export const STABLE_CHECK_MS = 5_000;

/** Names download managers and browsers write to until a download completes. */
const PARTIAL_SUFFIX = /\.(?:part|partial|crdownload|download|fdmdownload|opdownload)$/i;

type Observation = { size: number; mtimeMs: number; at: number };

/**
 * Decides whether a file is still being written, so it is organized the
 * moment it is finished instead of after a fixed wait.
 *
 * A file nothing has written to for a minute is finished. A newer one must
 * look the same (size and modified time) on two looks a few seconds apart.
 * A download manager's partial file for the same name keeps it waiting.
 * The returned number is how long to wait before looking again; 0 means
 * finished.
 */
export function createFileSettling(options: {
  stat?: (filePath: string) => { size: number; mtimeMs: number; ctimeMs: number } | null;
  listDirectory?: (directory: string) => string[] | null;
} = {}) {
  const stat = options.stat ?? ((filePath: string) => {
    try {
      const value = fs.statSync(filePath);
      return { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
    } catch {
      return null;
    }
  });
  const listDirectory = options.listDirectory ?? ((directory: string) => {
    try {
      return fs.readdirSync(directory);
    } catch {
      return null;
    }
  });
  const observations = new Map<string, Observation>();

  function waitMs(filePath: string, now = Date.now()): number {
    const current = stat(filePath);
    if (!current) return STABLE_CHECK_MS;
    const name = path.basename(filePath);
    const partial = (listDirectory(path.dirname(filePath)) || [])
      .some((entry) => PARTIAL_SUFFIX.test(entry) && entry.replace(PARTIAL_SUFFIX, '') === name);
    if (partial) return STABLE_CHECK_MS;
    // ctime also moves when a copy finishes setting the file's dates.
    if (now - Math.max(current.mtimeMs, current.ctimeMs) >= QUIET_MS) {
      observations.delete(filePath);
      return 0;
    }
    const previous = observations.get(filePath);
    if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
      const elapsed = now - previous.at;
      if (elapsed >= STABLE_CHECK_MS) {
        observations.delete(filePath);
        return 0;
      }
      return STABLE_CHECK_MS - elapsed;
    }
    observations.set(filePath, { size: current.size, mtimeMs: current.mtimeMs, at: now });
    return STABLE_CHECK_MS;
  }

  return { waitMs };
}
