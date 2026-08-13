import * as SQLite from 'expo-sqlite';

import type {
  LibraryPayload,
  MobileProfile,
  MobileProfileListEntry,
  StoredProgress,
} from './mobileDomain';
import { activeMobileProgressPaths, sameMobileCatalogIdentity } from './mobileOfflineCachePolicy';
import { reportNonFatal } from './mobileDiagnostics';

const MOBILE_OFFLINE_DATABASE_NAME = 'loomtv-mobile-cache.db';
const MOBILE_OFFLINE_CACHE_VERSION = 1;
const MOBILE_OFFLINE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MOBILE_OFFLINE_CACHE_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

export type MobileOfflineSnapshot = {
  version: 1;
  hostDeviceId: string;
  activeProfile: MobileProfile | null;
  automaticProfileSignIn: boolean;
  profiles: MobileProfile[];
  library: LibraryPayload;
  libraryEtag: string;
  catalogRevision?: number;
  catalogTransport?: 'compact' | 'legacy';
  selectionRevision?: number;
  progress: Record<string, StoredProgress>;
  profileLists: MobileProfileListEntry[];
  savedAt: number;
};

type MobileOfflineSnapshotRow = { payload: string; saved_at: number };
type MobileOfflineProgressRow = { media_path: string; payload: string; last_seen_at: number };
type PersistedSnapshotInput = Omit<MobileOfflineSnapshot, 'version' | 'savedAt'>;
type SnapshotIdentity = {
  activeProfile: MobileProfile | null;
  automaticProfileSignIn: boolean;
  profiles: MobileProfile[];
  library: LibraryPayload;
  libraryEtag: string;
  catalogRevision?: number;
  catalogTransport?: 'compact' | 'legacy';
  selectionRevision?: number;
  profileLists: MobileProfileListEntry[];
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let saveQueue: Promise<void> = Promise.resolve();
const snapshotIdentityByHost = new Map<string, SnapshotIdentity>();
const encodedProgressByHost = new Map<string, Map<string, string>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeLibrary(value: unknown): LibraryPayload | null {
  if (!isRecord(value)) return null;
  for (const key of ['movies', 'tvShows', 'animeShows', 'others'] as const) {
    if (value[key] !== undefined && !Array.isArray(value[key])) return null;
  }
  return {
    movies: Array.isArray(value.movies) ? value.movies as LibraryPayload['movies'] : [],
    tvShows: Array.isArray(value.tvShows) ? value.tvShows as LibraryPayload['tvShows'] : [],
    animeShows: Array.isArray(value.animeShows) ? value.animeShows as LibraryPayload['animeShows'] : [],
    others: Array.isArray(value.others) ? value.others as LibraryPayload['others'] : [],
  };
}

export function normalizeMobileOfflineSnapshot(
  value: unknown,
  expectedHostDeviceId: string,
  now = Date.now(),
): MobileOfflineSnapshot | null {
  if (!isRecord(value) || value.version !== MOBILE_OFFLINE_CACHE_VERSION) return null;
  if (value.hostDeviceId !== expectedHostDeviceId || !expectedHostDeviceId) return null;
  const savedAt = finiteOptionalNumber(value.savedAt);
  if (!savedAt || savedAt > now + 60_000 || now - savedAt > MOBILE_OFFLINE_CACHE_MAX_AGE_MS) return null;
  const library = normalizeLibrary(value.library);
  if (!library || !Array.isArray(value.profiles) || !Array.isArray(value.profileLists) || !isRecord(value.progress)) return null;
  if (value.activeProfile !== null && !isRecord(value.activeProfile)) return null;
  if (typeof value.automaticProfileSignIn !== 'boolean' || typeof value.libraryEtag !== 'string') return null;
  if (value.catalogTransport !== undefined && value.catalogTransport !== 'compact' && value.catalogTransport !== 'legacy') return null;

  return {
    version: MOBILE_OFFLINE_CACHE_VERSION,
    hostDeviceId: expectedHostDeviceId,
    activeProfile: value.activeProfile as MobileProfile | null,
    automaticProfileSignIn: value.automaticProfileSignIn,
    profiles: value.profiles as MobileProfile[],
    library,
    libraryEtag: value.libraryEtag,
    catalogRevision: finiteOptionalNumber(value.catalogRevision),
    catalogTransport: value.catalogTransport,
    selectionRevision: finiteOptionalNumber(value.selectionRevision),
    progress: value.progress as Record<string, StoredProgress>,
    profileLists: value.profileLists as MobileProfileListEntry[],
    savedAt,
  };
}

export function canRestoreMobileOfflineSnapshot(snapshot: MobileOfflineSnapshot): boolean {
  if (snapshot.activeProfile === null) return snapshot.profiles.length === 0;
  return snapshot.automaticProfileSignIn && !snapshot.activeProfile.hasPin && !snapshot.activeProfile.isGuest;
}

async function openMobileOfflineDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync(MOBILE_OFFLINE_DATABASE_NAME).then(async (database) => {
      await database.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS mobile_offline_snapshots (
          host_device_id TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          saved_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mobile_offline_snapshots_saved_at
          ON mobile_offline_snapshots(saved_at);
        CREATE TABLE IF NOT EXISTS mobile_offline_progress (
          host_device_id TEXT NOT NULL,
          media_path TEXT NOT NULL,
          payload TEXT NOT NULL,
          saved_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY (host_device_id, media_path)
        );
        CREATE INDEX IF NOT EXISTS mobile_offline_progress_saved_at
          ON mobile_offline_progress(saved_at);
      `);
      const progressColumns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(mobile_offline_progress)');
      if (!progressColumns.some((column) => column.name === 'last_seen_at')) {
        await database.execAsync('ALTER TABLE mobile_offline_progress ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;');
        await database.execAsync('UPDATE mobile_offline_progress SET last_seen_at = saved_at WHERE last_seen_at = 0;');
      }
      return database;
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function snapshotIdentity(snapshot: PersistedSnapshotInput): SnapshotIdentity {
  return {
    activeProfile: snapshot.activeProfile,
    automaticProfileSignIn: snapshot.automaticProfileSignIn,
    profiles: snapshot.profiles,
    library: snapshot.library,
    libraryEtag: snapshot.libraryEtag,
    catalogRevision: snapshot.catalogRevision,
    catalogTransport: snapshot.catalogTransport,
    selectionRevision: snapshot.selectionRevision,
    profileLists: snapshot.profileLists,
  };
}

function sameSnapshotIdentity(left: SnapshotIdentity | undefined, right: SnapshotIdentity): boolean {
  return Boolean(left)
    && left?.activeProfile === right.activeProfile
    && left?.automaticProfileSignIn === right.automaticProfileSignIn
    && left?.profiles === right.profiles
    && sameMobileCatalogIdentity(left, right)
    && left?.selectionRevision === right.selectionRevision
    && left?.profileLists === right.profileLists;
}

async function saveSnapshotNow(snapshot: PersistedSnapshotInput): Promise<void> {
  const database = await openMobileOfflineDatabase();
  const savedAt = Date.now();
  const nextIdentity = snapshotIdentity(snapshot);
  const metadataChanged = !sameSnapshotIdentity(snapshotIdentityByHost.get(snapshot.hostDeviceId), nextIdentity);
  const nextProgress = new Map(Object.entries(snapshot.progress).map(([mediaPath, value]) => [mediaPath, JSON.stringify(value)]));
  const activeProgressPaths = activeMobileProgressPaths(snapshot.library);
  const previousProgress = encodedProgressByHost.get(snapshot.hostDeviceId) || new Map<string, string>();

  await database.withTransactionAsync(async () => {
    if (metadataChanged) {
      const payload: MobileOfflineSnapshot = { ...snapshot, progress: {}, version: MOBILE_OFFLINE_CACHE_VERSION, savedAt };
      const encoded = JSON.stringify(payload);
      if (encoded.length > MOBILE_OFFLINE_CACHE_MAX_PAYLOAD_BYTES) {
        throw new Error('The saved mobile library is too large for the offline metadata cache.');
      }
      await database.runAsync(
        `INSERT INTO mobile_offline_snapshots (host_device_id, payload, saved_at)
         VALUES (?, ?, ?)
         ON CONFLICT(host_device_id) DO UPDATE SET payload = excluded.payload, saved_at = excluded.saved_at`,
        snapshot.hostDeviceId,
        encoded,
        savedAt,
      );
    } else {
      await database.runAsync('UPDATE mobile_offline_snapshots SET saved_at = ? WHERE host_device_id = ?', savedAt, snapshot.hostDeviceId);
    }

    for (const [mediaPath, encoded] of nextProgress) {
      if (previousProgress.get(mediaPath) === encoded) continue;
      await database.runAsync(
        `INSERT INTO mobile_offline_progress (host_device_id, media_path, payload, saved_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(host_device_id, media_path) DO UPDATE SET
           payload = excluded.payload,
           saved_at = excluded.saved_at,
           last_seen_at = CASE WHEN excluded.last_seen_at > 0 THEN excluded.last_seen_at ELSE mobile_offline_progress.last_seen_at END`,
        snapshot.hostDeviceId,
        mediaPath,
        encoded,
        savedAt,
        activeProgressPaths.has(mediaPath) ? savedAt : 0,
      );
    }
    for (const mediaPath of previousProgress.keys()) {
      if (!nextProgress.has(mediaPath)) {
        await database.runAsync('DELETE FROM mobile_offline_progress WHERE host_device_id = ? AND media_path = ?', snapshot.hostDeviceId, mediaPath);
      }
    }
    for (const mediaPath of activeProgressPaths) {
      await database.runAsync(
        'UPDATE mobile_offline_progress SET last_seen_at = ? WHERE host_device_id = ? AND media_path = ?',
        savedAt,
        snapshot.hostDeviceId,
        mediaPath,
      );
    }
    await database.runAsync('DELETE FROM mobile_offline_snapshots WHERE saved_at < ?', savedAt - MOBILE_OFFLINE_CACHE_MAX_AGE_MS);
    await database.runAsync('DELETE FROM mobile_offline_progress WHERE last_seen_at < ?', savedAt - MOBILE_OFFLINE_CACHE_MAX_AGE_MS);
  });

  snapshotIdentityByHost.set(snapshot.hostDeviceId, nextIdentity);
  encodedProgressByHost.set(snapshot.hostDeviceId, nextProgress);
}

export function saveMobileOfflineSnapshot(snapshot: PersistedSnapshotInput): Promise<void> {
  saveQueue = saveQueue
    .catch((error) => reportNonFatal('offline-cache.previous-save', error))
    .then(() => saveSnapshotNow(snapshot));
  return saveQueue;
}

export async function loadMobileOfflineSnapshot(hostDeviceId: string): Promise<MobileOfflineSnapshot | null> {
  if (!hostDeviceId) return null;
  try {
    const database = await openMobileOfflineDatabase();
    const row = await database.getFirstAsync<MobileOfflineSnapshotRow>(
      'SELECT payload, saved_at FROM mobile_offline_snapshots WHERE host_device_id = ?',
      hostDeviceId,
    );
    if (!row?.payload || row.payload.length > MOBILE_OFFLINE_CACHE_MAX_PAYLOAD_BYTES) return null;
    const parsed = JSON.parse(row.payload) as Record<string, unknown>;
    const snapshot = normalizeMobileOfflineSnapshot({ ...parsed, savedAt: row.saved_at }, hostDeviceId);
    if (!snapshot) {
      await clearMobileOfflineSnapshot(hostDeviceId);
      return null;
    }
    const rows = await database.getAllAsync<MobileOfflineProgressRow>(
      'SELECT media_path, payload, last_seen_at FROM mobile_offline_progress WHERE host_device_id = ? AND last_seen_at >= ?',
      hostDeviceId,
      Date.now() - MOBILE_OFFLINE_CACHE_MAX_AGE_MS,
    );
    const progress = { ...snapshot.progress };
    const encodedProgress = new Map<string, string>();
    for (const row of rows) {
      try {
        const value = JSON.parse(row.payload);
        if (!isRecord(value)) continue;
        progress[row.media_path] = value as StoredProgress;
        encodedProgress.set(row.media_path, row.payload);
      } catch {
        // Ignore one corrupt progress row instead of discarding the catalog.
        reportNonFatal('offline-cache.corrupt-progress-row', new Error('A cached progress row could not be decoded.'));
      }
    }
    encodedProgressByHost.set(hostDeviceId, encodedProgress);
    return { ...snapshot, progress };
  } catch (error) {
    reportNonFatal('offline-cache.load', error);
    return null;
  }
}

export async function clearMobileOfflineSnapshot(hostDeviceId: string): Promise<void> {
  if (!hostDeviceId) return;
  snapshotIdentityByHost.delete(hostDeviceId);
  encodedProgressByHost.delete(hostDeviceId);
  try {
    const database = await openMobileOfflineDatabase();
    await database.withTransactionAsync(async () => {
      await database.runAsync('DELETE FROM mobile_offline_snapshots WHERE host_device_id = ?', hostDeviceId);
      await database.runAsync('DELETE FROM mobile_offline_progress WHERE host_device_id = ?', hostDeviceId);
    });
  } catch (error) {
    // Cache cleanup must never block sign-out or a revoked-session response.
    reportNonFatal('offline-cache.clear', error);
  }
}
