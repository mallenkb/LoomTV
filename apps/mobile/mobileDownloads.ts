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
  /** Aborting stops the network transfer and removes the partial file. */
  signal?: AbortSignal;
};

/**
 * The file name the server sent in Content-Disposition, or the last URL path
 * segment. Players rely on the extension, so keep it; drop anything that could
 * leave the download directory.
 */
export function mobileDownloadFileName(headers: Record<string, string> | undefined, url: string): string {
  const disposition = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'content-disposition')?.[1] || '';
  const encoded = /filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]+)/i.exec(disposition)?.[1];
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(disposition)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(disposition)?.[1];
  let name: string;
  try { name = encoded ? decodeURIComponent(encoded.trim()) : (quoted || '').trim(); } catch { name = (quoted || '').trim(); }
  if (!name) {
    try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { name = ''; }
  }
  const printable = Array.from(name.split(/[\\/]/).pop() || '')
    .filter((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f).join('');
  const safe = printable.replace(/^\.+/, '').slice(-180);
  return safe || 'media';
}

export function saveMobileDownload(input: SaveDownloadInput): Promise<MobileDownload> {
  const generation = hostGenerations.get(input.hostDeviceId) || 0;
  const isCurrent = () => generation === (hostGenerations.get(input.hostDeviceId) || 0) && (input.isCurrent?.() ?? true);
  return serializeDownload(input.hostDeviceId, () => commitMobileDownload({ ...input, isCurrent }));
}

export function clearMobileDownloads(hostDeviceId: string): Promise<void> {
  hostGenerations.set(hostDeviceId, (hostGenerations.get(hostDeviceId) || 0) + 1);
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
  if (input.isCurrent?.() === false) throw new Error('The download was cancelled.');
  const db = await database();
  const previous = await db.getFirstAsync<{ uri: string }>(
    'SELECT uri FROM mobile_downloads WHERE host_device_id=? AND profile_id=? AND media_id=?',
    input.hostDeviceId, input.profileId, input.capability.mediaId,
  );
  const directory = new Directory(
    Paths.document,
    'loomtv-downloads',
    safeMobileDownloadSegment(input.hostDeviceId),
    safeMobileDownloadSegment(input.profileId),
    safeMobileDownloadSegment(input.capability.mediaId),
    `attempt-${Date.now()}-${++attemptSequence}`,
  );
  directory.create({ idempotent: true, intermediates: true });
  try {
    if (input.signal?.aborted) throw new Error('The download was cancelled.');
    // The legacy resumable download is the one expo-file-system API that can
    // stop a transfer in flight, which a profile change or lock needs.
    const transfer = createDownloadResumable(input.contentUrl, new File(directory, 'download.part').uri, {
      headers: { Authorization: mobileDownloadAuthorization(input.capability) },
    });
    const cancel = () => { void transfer.cancelAsync().catch(() => undefined); };
    input.signal?.addEventListener('abort', cancel, { once: true });
    let result: Awaited<ReturnType<typeof transfer.downloadAsync>>;
    try {
      result = await transfer.downloadAsync();
    } finally {
      input.signal?.removeEventListener('abort', cancel);
    }
    if (!result || input.signal?.aborted) throw new Error('The download was cancelled.');
    if (result.status < 200 || result.status >= 300) throw new Error(`The server refused the download (HTTP ${result.status}).`);
    const file = new File(directory, mobileDownloadFileName(result.headers, input.contentUrl));
    new File(result.uri).move(file);
    if (input.capability.sizeBytes > 0 && file.size !== input.capability.sizeBytes) {
      throw new Error('The downloaded file is incomplete. Please retry.');
    }
    if (input.isCurrent?.() === false) throw new Error('The download was cancelled.');
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
    // This attempt owns only its staging directory, never the shared media root.
    try { if (directory.exists) directory.delete(); } catch { /* Preserve the original failure. */ }
    throw error;
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
