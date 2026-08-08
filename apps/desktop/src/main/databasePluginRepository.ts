import type BetterSqlite3 from 'better-sqlite3';

const STREMIO_STATE_VERSION = 1;
const MAX_STREMIO_ADDONS = 64;
const MAX_STORED_RECORD_BYTES = 1024 * 1024;
const MAX_ADDON_ID_LENGTH = 240;
const INSTALL_STATES = new Set(['pending-review', 'enabled', 'disabled', 'broken']);

export type PersistedStremioInstallState = 'pending-review' | 'enabled' | 'disabled' | 'broken';

export type PersistedStremioAddonRecord = {
  addonId: string;
  state: PersistedStremioInstallState;
  [key: string]: unknown;
};

export type PersistedStremioAddonSnapshot = {
  stateVersion: 1;
  addons: readonly PersistedStremioAddonRecord[];
};

type StremioAddonRow = {
  addon_id: string;
  record_json: string;
  state: PersistedStremioInstallState;
};

export class StremioPluginStorageError extends Error {
  readonly code = 'STREMIO_PLUGIN_STORAGE_INVALID';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StremioPluginStorageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateAddonId(value: unknown): string {
  const addonId = typeof value === 'string' ? value.trim() : '';
  if (!addonId || addonId.length > MAX_ADDON_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(addonId)) {
    throw new StremioPluginStorageError('A persisted Stremio add-on has an invalid identity.');
  }
  return addonId;
}

function validateInstallState(value: unknown): PersistedStremioInstallState {
  if (!INSTALL_STATES.has(String(value))) {
    throw new StremioPluginStorageError('A persisted Stremio add-on has an invalid install state.');
  }
  return value as PersistedStremioInstallState;
}

function validateRecord(value: unknown): PersistedStremioAddonRecord {
  if (!isRecord(value)) {
    throw new StremioPluginStorageError('A persisted Stremio add-on record is malformed.');
  }
  return {
    ...value,
    addonId: validateAddonId(value.addonId),
    state: validateInstallState(value.state),
  };
}

function validateSnapshot(value: unknown): PersistedStremioAddonSnapshot {
  if (!isRecord(value) || value.stateVersion !== STREMIO_STATE_VERSION || !Array.isArray(value.addons)) {
    throw new StremioPluginStorageError('The persisted Stremio add-on snapshot is malformed.');
  }
  if (value.addons.length > MAX_STREMIO_ADDONS) {
    throw new StremioPluginStorageError('The persisted Stremio add-on snapshot exceeds the host limit.');
  }
  const addons = value.addons.map(validateRecord);
  if (new Set(addons.map(({ addonId }) => addonId)).size !== addons.length) {
    throw new StremioPluginStorageError('Persisted Stremio add-on identities must be unique.');
  }
  return { stateVersion: STREMIO_STATE_VERSION, addons };
}

function serializedRecord(record: PersistedStremioAddonRecord): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(record);
  } catch (error) {
    throw new StremioPluginStorageError('A Stremio add-on record could not be serialized.', { cause: error });
  }
  if (serialized === undefined) {
    throw new StremioPluginStorageError('A Stremio add-on record could not be serialized.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORED_RECORD_BYTES) {
    throw new StremioPluginStorageError('A Stremio add-on record exceeds the host storage limit.');
  }
  return serialized;
}

export function loadStremioAddonState(database: BetterSqlite3.Database): PersistedStremioAddonSnapshot | null {
  const rows = database.prepare(`
    SELECT addon_id, record_json, state
    FROM stremio_addons
    ORDER BY addon_id COLLATE NOCASE
  `).all() as StremioAddonRow[];
  if (rows.length === 0) return null;
  if (rows.length > MAX_STREMIO_ADDONS) {
    throw new StremioPluginStorageError('The persisted Stremio add-on snapshot exceeds the host limit.');
  }

  const addons = rows.map((row) => {
    if (Buffer.byteLength(row.record_json, 'utf8') > MAX_STORED_RECORD_BYTES) {
      throw new StremioPluginStorageError('A persisted Stremio add-on record exceeds the host storage limit.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.record_json);
    } catch (error) {
      throw new StremioPluginStorageError('A persisted Stremio add-on record contains invalid JSON.', { cause: error });
    }
    const record = validateRecord(parsed);
    const legacyBrokenState = record.state === 'broken' && row.state === 'disabled';
    if (record.addonId !== row.addon_id || (!legacyBrokenState && record.state !== row.state)) {
      throw new StremioPluginStorageError('A persisted Stremio add-on record does not match its storage identity.');
    }
    return record;
  });

  return validateSnapshot({ stateVersion: STREMIO_STATE_VERSION, addons });
}

export function saveStremioAddonState(database: BetterSqlite3.Database, value: unknown): PersistedStremioAddonSnapshot {
  const snapshot = validateSnapshot(value);
  const stored = snapshot.addons.map((record) => ({
    addonId: record.addonId,
    // v8 databases used a CHECK constraint without `broken`. The record JSON
    // remains authoritative while the legacy index column uses disabled.
    state: record.state === 'broken' ? 'disabled' : record.state,
    record,
    recordJson: serializedRecord(record),
  }));
  const nextIds = new Set(stored.map(({ addonId }) => addonId));
  const now = Date.now();

  database.transaction(() => {
    const existing = database.prepare('SELECT addon_id, record_json, state FROM stremio_addons')
      .all() as StremioAddonRow[];
    const incomingById = new Map(stored.map((record) => [record.addonId, record]));
    const revokeProfileAccess = database.prepare('DELETE FROM profile_stremio_access WHERE addon_id = ?');
    for (const row of existing) {
      const incoming = incomingById.get(row.addon_id);
      let previousReviewToken: unknown;
      try {
        previousReviewToken = (JSON.parse(row.record_json) as Record<string, unknown>).reviewToken;
      } catch {
        // A corrupt row will already make the registry unavailable on load.
        // Revoke grants defensively if a direct repository caller replaces it.
      }
      if (
        !incoming
        || incoming.state !== 'enabled'
        || previousReviewToken !== incoming.record.reviewToken
      ) {
        revokeProfileAccess.run(row.addon_id);
      }
    }

    const upsert = database.prepare(`
      INSERT INTO stremio_addons (addon_id, record_json, state, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(addon_id) DO UPDATE SET
        record_json = excluded.record_json,
        state = excluded.state,
        updated_at = excluded.updated_at
    `);
    for (const record of stored) {
      upsert.run(record.addonId, record.recordJson, record.state, now);
    }

    const remove = database.prepare('DELETE FROM stremio_addons WHERE addon_id = ?');
    for (const { addon_id: addonId } of existing) {
      if (!nextIds.has(addonId)) remove.run(addonId);
    }
  })();

  return snapshot;
}

export function listProfileStremioAccess(database: BetterSqlite3.Database, profileId: string): string[] {
  return (database.prepare(`
    SELECT addon_id
    FROM profile_stremio_access
    WHERE profile_id = ?
    ORDER BY addon_id COLLATE NOCASE
  `).all(profileId) as Array<{ addon_id: string }>).map(({ addon_id: addonId }) => addonId);
}

export function hasProfileStremioAccess(
  database: BetterSqlite3.Database,
  profileId: string,
  addonId: string,
): boolean {
  return Boolean(database.prepare(`
    SELECT 1
    FROM profile_stremio_access
    WHERE profile_id = ? AND addon_id = ?
  `).get(profileId, addonId));
}

export function setProfileStremioAccess(
  database: BetterSqlite3.Database,
  profileId: string,
  addonId: string,
  enabled: boolean,
): boolean {
  const safeProfileId = String(profileId || '').trim();
  const safeAddonId = validateAddonId(addonId);
  if (!safeProfileId) throw new StremioPluginStorageError('A profile identity is required for Stremio access.');

  if (!enabled) {
    database.prepare('DELETE FROM profile_stremio_access WHERE profile_id = ? AND addon_id = ?')
      .run(safeProfileId, safeAddonId);
    return false;
  }

  const profileExists = database.prepare('SELECT 1 FROM profiles WHERE id = ?').get(safeProfileId);
  if (!profileExists) throw new StremioPluginStorageError('The selected profile no longer exists.');
  const addonExists = database.prepare('SELECT 1 FROM stremio_addons WHERE addon_id = ?').get(safeAddonId);
  if (!addonExists) throw new StremioPluginStorageError('The selected Stremio add-on is not installed.');

  const now = Date.now();
  database.prepare(`
    INSERT INTO profile_stremio_access (profile_id, addon_id, granted_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, addon_id) DO UPDATE SET updated_at = excluded.updated_at
  `).run(safeProfileId, safeAddonId, now, now);
  return true;
}
