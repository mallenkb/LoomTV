import { Directory, File, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

export type MobileDownloadCapability = {
  id: string;
  mediaId: string;
  sizeBytes: number;
  contentUrl: string;
  credential: { id: string; secret: string; scheme: 'LoomDownload' };
};

export type MobileDownload = {
  hostDeviceId: string;
  profileId: string;
  mediaId: string;
  title: string;
  uri: string;
  sizeBytes: number;
  createdAt: number;
};

type DownloadRow = {
  host_device_id: string;
  profile_id: string;
  media_id: string;
  title: string;
  uri: string;
  size_bytes: number;
  created_at: number;
};

const DATABASE_NAME = 'loomtv-mobile-cache.db';
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let attemptSequence = 0;
const mutations = new Map<string, Promise<unknown>>();
const hostGenerations = new Map<string, number>();
const activeTransfers = new Map<string, Set<AbortController>>();

function cancelledDownload(): Error {
  return Object.assign(new Error('The download was cancelled.'), { name: 'AbortError' });
}

function serializeDownload<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = (mutations.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  mutations.set(key, pending);
  void pending.finally(() => { if (mutations.get(key) === pending) mutations.delete(key); }).catch(() => undefined);
  return pending;
}

export function safeMobileDownloadSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
  return !normalized || normalized === '.' || normalized === '..' ? 'unknown' : normalized;
}

export function mobileDownloadAuthorization(capability: MobileDownloadCapability): string {
  if (capability.credential.scheme !== 'LoomDownload' || !capability.credential.id || !capability.credential.secret) {
    throw new Error('The server returned an invalid download capability.');
  }
  return `LoomDownload ${capability.credential.id}.${capability.credential.secret}`;
}

function fromRow(row: DownloadRow): MobileDownload {
  return {
    hostDeviceId: row.host_device_id,
    profileId: row.profile_id,
    mediaId: row.media_id,
    title: row.title,
    uri: row.uri,
    sizeBytes: Number(row.size_bytes),
    createdAt: Number(row.created_at),
  };
}

async function database(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync(DATABASE_NAME).then(async (next) => {
      await next.execAsync(`
        CREATE TABLE IF NOT EXISTS mobile_downloads (
          host_device_id TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          media_id TEXT NOT NULL,
          title TEXT NOT NULL,
          uri TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (host_device_id, profile_id, media_id)
        );
        CREATE INDEX IF NOT EXISTS mobile_downloads_created_at ON mobile_downloads(created_at);
      `);
      return next;
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function listMobileDownloads(hostDeviceId: string, profileId: string): Promise<MobileDownload[]> {
  if (!hostDeviceId || !profileId) return [];
  const db = await database();
  const rows = await db.getAllAsync<DownloadRow>(
    `SELECT host_device_id,profile_id,media_id,title,uri,size_bytes,created_at
     FROM mobile_downloads WHERE host_device_id=? AND profile_id=? ORDER BY created_at DESC`,
    hostDeviceId,
    profileId,
  );
  const available: MobileDownload[] = [];
  for (const row of rows) {
    const file = new File(row.uri);
    if (file.exists) available.push(fromRow(row));
    else await db.runAsync(
      'DELETE FROM mobile_downloads WHERE host_device_id=? AND profile_id=? AND media_id=? AND uri=?',
      hostDeviceId,
      profileId,
      row.media_id,
      row.uri,
    );
  }
  return available;
}

type SaveDownloadInput = {
  hostDeviceId: string;
  profileId: string;
  title: string;
  capability: MobileDownloadCapability;
  contentUrl: string;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
};

export function saveMobileDownload(input: SaveDownloadInput): Promise<MobileDownload> {
  const generation = hostGenerations.get(input.hostDeviceId) || 0;
  const controller = new AbortController();
  const transfers = activeTransfers.get(input.hostDeviceId) || new Set<AbortController>();
  transfers.add(controller);
  activeTransfers.set(input.hostDeviceId, transfers);
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const isCurrent = () => !controller.signal.aborted
    && generation === (hostGenerations.get(input.hostDeviceId) || 0) && (input.isCurrent?.() ?? true);
  return serializeDownload(input.hostDeviceId, () => commitMobileDownload({ ...input, signal: controller.signal, isCurrent }))
    .finally(() => {
      input.signal?.removeEventListener('abort', abort);
      transfers.delete(controller);
      if (!transfers.size) activeTransfers.delete(input.hostDeviceId);
    });
}

export function clearMobileDownloads(hostDeviceId: string): Promise<void> {
  hostGenerations.set(hostDeviceId, (hostGenerations.get(hostDeviceId) || 0) + 1);
  for (const controller of activeTransfers.get(hostDeviceId) || []) controller.abort();
  return serializeDownload(hostDeviceId, async () => {
    const db = await database();
    const rows = await db.getAllAsync<DownloadRow>('SELECT * FROM mobile_downloads WHERE host_device_id=?', hostDeviceId);
    for (const row of rows) {
      const file = new File(row.uri);
      if (file.exists) file.delete();
      await db.runAsync('DELETE FROM mobile_downloads WHERE host_device_id=? AND uri=?', hostDeviceId, row.uri);
    }
  });
}

async function commitMobileDownload(input: SaveDownloadInput): Promise<MobileDownload> {
  const assertCurrent = () => {
    if (input.signal?.aborted || input.isCurrent?.() === false) throw cancelledDownload();
  };
  assertCurrent();
  const db = await database();
  const previous = await db.getFirstAsync<DownloadRow>(
    'SELECT * FROM mobile_downloads WHERE host_device_id=? AND profile_id=? AND media_id=?',
    input.hostDeviceId, input.profileId, input.capability.mediaId,
  );
  assertCurrent();
  const directory = new Directory(
    Paths.document,
    'loomtv-downloads',
    safeMobileDownloadSegment(input.hostDeviceId),
    safeMobileDownloadSegment(input.profileId),
    safeMobileDownloadSegment(input.capability.mediaId),
    `attempt-${Date.now()}-${++attemptSequence}`,
  );
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, 'media');
  let cancelTransfer: Promise<void> | undefined;
  let transferring = true;
  let directoryCommitted = false;
  let task: ReturnType<typeof createDownloadResumable> | undefined;
  let rejectCancelled: (error: Error) => void = () => {};
  const cancellation = new Promise<never>((_, reject) => { rejectCancelled = reject; });
  const abort = () => {
    if (!transferring || cancelTransfer || !task) return;
    // Cancellation must release the host queue even if downloadAsync never settles.
    cancelTransfer = task.cancelAsync();
    void cancelTransfer.then(() => rejectCancelled(cancelledDownload()), rejectCancelled);
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    assertCurrent();
    task = createDownloadResumable(input.contentUrl, file.uri, {
      headers: { Authorization: mobileDownloadAuthorization(input.capability) },
    });
    const result = await Promise.race([task.downloadAsync(), cancellation]);
    transferring = false;
    assertCurrent();
    if (!result) throw cancelledDownload();
    if (result.status < 200 || result.status >= 300) throw new Error('The server could not complete this download. Please retry.');
    if (input.capability.sizeBytes > 0 && file.size !== input.capability.sizeBytes) {
      throw new Error('The downloaded file is incomplete. Please retry.');
    }
    assertCurrent();
    const createdAt = Date.now();
    const sizeBytes = Number(file.size || input.capability.sizeBytes || 0);
    await db.runAsync(
      `INSERT INTO mobile_downloads (host_device_id,profile_id,media_id,title,uri,size_bytes,created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(host_device_id,profile_id,media_id) DO UPDATE SET
         title=excluded.title,uri=excluded.uri,size_bytes=excluded.size_bytes,created_at=excluded.created_at`,
      input.hostDeviceId,
      input.profileId,
      input.capability.mediaId,
      input.title,
      file.uri,
      sizeBytes,
      createdAt,
    );
    directoryCommitted = true;
    // A scope change can happen while the asynchronous database write finishes.
    // Restore the preceding copy before cleaning this attempt's file.
    if (input.signal?.aborted || input.isCurrent?.() === false) {
      if (previous) {
        await db.runAsync(
          'UPDATE mobile_downloads SET title=?,uri=?,size_bytes=?,created_at=? WHERE host_device_id=? AND profile_id=? AND media_id=? AND uri=?',
          previous.title, previous.uri, previous.size_bytes, previous.created_at,
          input.hostDeviceId, input.profileId, input.capability.mediaId, file.uri,
        );
      } else {
        await db.runAsync('DELETE FROM mobile_downloads WHERE host_device_id=? AND profile_id=? AND media_id=? AND uri=?',
          input.hostDeviceId, input.profileId, input.capability.mediaId, file.uri);
      }
      directoryCommitted = false;
      throw cancelledDownload();
    }
    // Commit the new file before removing the previous copy.
    if (previous?.uri && previous.uri !== file.uri) {
      try {
        const oldFile = new File(previous.uri);
        if (oldFile.exists) oldFile.delete();
      } catch { /* Recoverable orphan; the new copy is committed. */ }
    }
    return {
      hostDeviceId: input.hostDeviceId,
      profileId: input.profileId,
      mediaId: input.capability.mediaId,
      title: input.title,
      uri: file.uri,
      sizeBytes,
      createdAt,
    };
  } catch (error) {
    // Wait for native cancellation, rather than the original transfer, before
    // deleting files the native task may still be writing.
    if (cancelTransfer) await cancelTransfer.catch(() => undefined);
    // This attempt owns only its staging directory, never the shared media root.
    // If restoring metadata failed, retain the file its database row still owns.
    try { if (!directoryCommitted && directory.exists) directory.delete(); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}

export async function removeMobileDownload(download: MobileDownload): Promise<void> {
  return serializeDownload(download.hostDeviceId, async () => {
    const db = await database();
    // A stale remove must not delete metadata for a replacement download.
    const file = new File(download.uri);
    if (file.exists) file.delete();
    await db.runAsync(
      'DELETE FROM mobile_downloads WHERE host_device_id=? AND profile_id=? AND media_id=? AND uri=?',
      download.hostDeviceId, download.profileId, download.mediaId, download.uri,
    );
  });
}
