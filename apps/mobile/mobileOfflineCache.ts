import * as SQLite from 'expo-sqlite';

import type {
  LibraryPayload,
  MobileProfile,
  MobileProfileListEntry,
  StoredProgress,
} from './mobileDomain';

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

type MobileOfflineSnapshotRow = {
  payload: string;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

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
  // A PIN-protected or manually selected profile must never be reopened from a
  // plaintext metadata cache. Legacy hosts without profiles remain supported.
  if (snapshot.activeProfile === null) return snapshot.profiles.length === 0;
  return (
    snapshot.automaticProfileSignIn
    && !snapshot.activeProfile.hasPin
    && !snapshot.activeProfile.isGuest
  );
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
      `);
      return database;
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function saveMobileOfflineSnapshot(
  snapshot: Omit<MobileOfflineSnapshot, 'version' | 'savedAt'>,
): Promise<void> {
  const payload: MobileOfflineSnapshot = {
    ...snapshot,
    version: MOBILE_OFFLINE_CACHE_VERSION,
    savedAt: Date.now(),
  };
  const encoded = JSON.stringify(payload);
  if (encoded.length > MOBILE_OFFLINE_CACHE_MAX_PAYLOAD_BYTES) {
    throw new Error('The saved mobile library is too large for the offline metadata cache.');
  }

  const database = await openMobileOfflineDatabase();
  await database.runAsync(
    `INSERT INTO mobile_offline_snapshots (host_device_id, payload, saved_at)
     VALUES (?, ?, ?)
     ON CONFLICT(host_device_id) DO UPDATE SET
       payload = excluded.payload,
       saved_at = excluded.saved_at`,
    payload.hostDeviceId,
    encoded,
    payload.savedAt,
  );
  await database.runAsync(
    'DELETE FROM mobile_offline_snapshots WHERE saved_at < ?',
    payload.savedAt - MOBILE_OFFLINE_CACHE_MAX_AGE_MS,
  );
}

export async function loadMobileOfflineSnapshot(hostDeviceId: string): Promise<MobileOfflineSnapshot | null> {
  if (!hostDeviceId) return null;
  try {
    const database = await openMobileOfflineDatabase();
    const row = await database.getFirstAsync<MobileOfflineSnapshotRow>(
      'SELECT payload FROM mobile_offline_snapshots WHERE host_device_id = ?',
      hostDeviceId,
    );
    if (!row?.payload || row.payload.length > MOBILE_OFFLINE_CACHE_MAX_PAYLOAD_BYTES) return null;
    const snapshot = normalizeMobileOfflineSnapshot(JSON.parse(row.payload), hostDeviceId);
    if (!snapshot) await clearMobileOfflineSnapshot(hostDeviceId);
    return snapshot;
  } catch {
    return null;
  }
}

export async function clearMobileOfflineSnapshot(hostDeviceId: string): Promise<void> {
  if (!hostDeviceId) return;
  try {
    const database = await openMobileOfflineDatabase();
    await database.runAsync(
      'DELETE FROM mobile_offline_snapshots WHERE host_device_id = ?',
      hostDeviceId,
    );
  } catch {
    // Cache cleanup must never block sign-out or a revoked-session response.
  }
}
