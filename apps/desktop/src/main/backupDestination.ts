import fs from 'node:fs';
import path from 'node:path';

const SQLITE_SIDECAR_SUFFIXES = ['', '-wal', '-shm', '-journal'];

function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // The file may not exist yet; resolve its folder so a symlinked or
    // differently spelled folder still compares equal.
    try {
      canonical = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
    } catch {
      canonical = resolved;
    }
  }
  // macOS and Windows volumes are case-insensitive by default.
  return process.platform === 'darwin' || process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function fileIdentity(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return null;
  }
}

/**
 * True when writing a backup to `destination` would replace a live database
 * or one of its SQLite sidecar files, including through a symlink, a
 * differently cased path, or a hard link.
 */
export function backupDestinationOverlapsLiveDatabase(destination: string, liveDatabasePaths: readonly string[]): boolean {
  const target = canonicalPath(destination);
  const targetIdentity = fileIdentity(destination);
  for (const databasePath of liveDatabasePaths) {
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const protectedPath = `${databasePath}${suffix}`;
      if (canonicalPath(protectedPath) === target) return true;
      if (targetIdentity && fileIdentity(protectedPath) === targetIdentity) return true;
    }
  }
  return false;
}
