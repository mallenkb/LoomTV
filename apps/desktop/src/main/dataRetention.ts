import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rollback copies for a migration that never became the committed one. */
const UNCOMMITTED_CUTOVER_BACKUP_AGE_MS = 30 * DAY_MS;
/** The one-time copy taken before the profiles migration. */
const PRE_PROFILES_BACKUP_AGE_MS = 60 * DAY_MS;
const ORPHANED_STAGE_FILE_AGE_MS = DAY_MS;

const CUTOVER_BACKUP_PATTERN = /^canonical-cutover-(legacy-[0-9a-f]+)$/;
const STAGE_SIDECAR_PATTERN = /^(\.loomtv-canonical\.sqlite\.legacy-[0-9a-f]+\.stage)-(?:shm|wal)$/;

export type RetentionContext = {
  userDataDir: string;
  now: number;
  /** Committed canonical migration id; null when unknown, which keeps every cutover backup. */
  committedMigrationId: string | null;
  /** The profiles migration no longer needs its pre-migration copy. */
  profilesMigrationComplete: boolean;
};

export type RemovedEntry = { path: string; bytes: number; reason: string };

function sizeOf(target: string): number {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); } catch { return 0; }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of fs.readdirSync(target)) total += sizeOf(path.join(target, name));
  return total;
}

function ageMs(target: string, now: number): number {
  try { return now - fs.statSync(target).mtimeMs; } catch { return 0; }
}

/**
 * Remove data that Loom itself created and no longer needs. Only the exact
 * paths listed here are candidates: backups made by hand or by other tools in
 * the same folder are never touched, whatever their names.
 */
export function collectObsoleteData(context: RetentionContext): Array<Omit<RemovedEntry, 'bytes'>> {
  const { userDataDir, now } = context;
  const candidates: Array<Omit<RemovedEntry, 'bytes'>> = [];
  const add = (target: string, reason: string) => {
    if (fs.existsSync(target)) candidates.push({ path: target, reason });
  };

  // The Tauri port was removed; its transcodes and storage are never read.
  add(path.join(userDataDir, 'Cache', 'tauri-transcodes'), 'removed Tauri port');
  add(path.join(userDataDir, 'tauri-shared-storage-v1'), 'removed Tauri port');

  // Only one canonical migration can be committed. Its backup is the rollback
  // point and stays; copies taken for any other migration id cannot be rolled
  // back to and only hold a duplicate of the old database.
  const cutoverDir = path.join(userDataDir, 'loomtv-migration', 'backups');
  if (context.committedMigrationId) {
    let names: string[] = [];
    try { names = fs.readdirSync(cutoverDir); } catch { /* none */ }
    for (const name of names) {
      const match = CUTOVER_BACKUP_PATTERN.exec(name);
      if (!match || match[1] === context.committedMigrationId) continue;
      const target = path.join(cutoverDir, name);
      if (ageMs(target, now) >= UNCOMMITTED_CUTOVER_BACKUP_AGE_MS) add(target, 'uncommitted migration backup');
    }
  }

  // SQLite sidecars of a staging database that was renamed or removed.
  let topLevel: string[] = [];
  try { topLevel = fs.readdirSync(userDataDir); } catch { /* none */ }
  for (const name of topLevel) {
    const match = STAGE_SIDECAR_PATTERN.exec(name);
    if (!match || topLevel.includes(match[1])) continue;
    const target = path.join(userDataDir, name);
    if (ageMs(target, now) >= ORPHANED_STAGE_FILE_AGE_MS) add(target, 'orphaned migration staging file');
  }

  if (context.profilesMigrationComplete) {
    const preProfiles = path.join(userDataDir, 'loomtv-pre-profiles-backup.sqlite');
    if (ageMs(preProfiles, now) >= PRE_PROFILES_BACKUP_AGE_MS) add(preProfiles, 'completed profiles migration');
  }
  return candidates;
}

export function pruneObsoleteData(context: RetentionContext): RemovedEntry[] {
  const removed: RemovedEntry[] = [];
  for (const candidate of collectObsoleteData(context)) {
    const bytes = sizeOf(candidate.path);
    try {
      fs.rmSync(candidate.path, { recursive: true, force: true });
      removed.push({ ...candidate, bytes });
    } catch (error) {
      console.warn(`[retention] Could not remove ${path.basename(candidate.path)}:`, error instanceof Error ? error.message : error);
    }
  }
  return removed;
}
