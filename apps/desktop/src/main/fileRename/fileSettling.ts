import fs from 'node:fs';
import path from 'node:path';

/** Minimum quiet window. Stability is evidence, never proof of download completion. */
export const QUIET_MS = 5 * 60_000;
/** Require two observations spanning the quiet window, including after launch. */
export const STABLE_CHECK_MS = QUIET_MS;

/** Names download managers and browsers write to until a download completes. */
export const PARTIAL_EXTENSIONS: ReadonlySet<string> = new Set(['.part', '.partial', '.crdownload', '.download', '.fdmdownload', '.opdownload', '.!qb', '.!ut']);

/** A marker for this file, including aria2's separate progress file. */
export function hasPartialSibling(name: string, entries: readonly string[]): boolean {
  return entries.some((entry) => {
    const extension = path.extname(entry).toLowerCase();
    return (PARTIAL_EXTENSIONS.has(extension) || extension === '.aria2')
      && entry.slice(0, -extension.length) === name;
  });
}

type Observation = { size: number; mtimeMs: number; ctimeMs: number; at: number };

/** Wait for stable observations and known download markers to disappear. */
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
    const entries = listDirectory(path.dirname(filePath));
    if (!entries || current.size <= 0 || PARTIAL_EXTENSIONS.has(path.extname(name).toLowerCase() || name.toLowerCase())
      || hasPartialSibling(name, entries)) {
      observations.delete(filePath);
      return STABLE_CHECK_MS;
    }
    const previous = observations.get(filePath);
    if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs && previous.ctimeMs === current.ctimeMs) {
      const elapsed = now - previous.at;
      return Math.max(0, STABLE_CHECK_MS - elapsed, QUIET_MS - (now - Math.max(current.mtimeMs, current.ctimeMs)));
    }
    observations.set(filePath, { size: current.size, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs, at: now });
    return STABLE_CHECK_MS;
  }

  return { waitMs };
}
