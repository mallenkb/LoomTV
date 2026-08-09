import type BetterSqlite3 from 'better-sqlite3';

const ADAPTER_STATE_VERSION = 1;
const STORAGE_STATE_VERSION = 2;
const MAX_STREMIO_ADDONS = 64;
const MAX_STORED_RECORD_BYTES = 1024 * 1024;
const MAX_ADDON_ID_LENGTH = 240;
const INSTALL_STATES = new Set(['pending-review', 'enabled', 'disabled', 'broken']);

export type PersistedStremioInstallState = 'pending-review' | 'enabled' | 'disabled' | 'broken';
export type PersistedStremioTrustState = 'review-required' | 'update-review-required' | 'trusted' | 'disabled' | 'broken';

export type PersistedStremioAddonRecord = {
  addonId: string;
  state: PersistedStremioInstallState;
  [key: string]: unknown;
};

export type PersistedStremioAddonSnapshot = {
  stateVersion: 1;
  addons: readonly PersistedStremioAddonRecord[];
};

export type StremioStateAuditContext = {
  addonId: string;
  eventType: string;
  actor: string;
  outcome?: 'success' | 'failure';
  detail?: Readonly<Record<string, unknown>>;
  manifestLastChecked?: number;
  lastSuccessfulRequest?: number;
};

export type StremioSecurePersistence = {
  protectManifestUrl(addonId: string, manifestUrl: string): string;
  resolveManifestUrl(addonId: string, secretRef: string): string;
  signState(addonId: string, revision: number, serializedRecord: string): string;
  verifyState(addonId: string, revision: number, serializedRecord: string, integrityMac: string): boolean;
  recordAudit(context: StremioStateAuditContext & { priorRevision: number; newRevision: number; createdAt: number }): void;
};

type StremioAddonRow = {
  addon_id: string;
  record_json: string;
  state: PersistedStremioInstallState;
  record_revision: number;
  integrity_mac: string;
  manifest_secret_ref: string | null;
  manifest_url_redacted: string;
  trust_state: PersistedStremioTrustState;
  last_successful_request: number | null;
  manifest_last_checked: number | null;
};

type StoredV2Envelope = {
  persistenceVersion: 2;
  record: Omit<PersistedStremioAddonRecord, 'manifestUrl'>;
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

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function validateAddonId(value: unknown): string {
  const addonId = typeof value === 'string' ? value.trim() : '';
  if (!addonId || addonId.length > MAX_ADDON_ID_LENGTH || hasControlCharacters(addonId)) {
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
  if (!isRecord(value)) throw new StremioPluginStorageError('A persisted Stremio add-on record is malformed.');
  return { ...value, addonId: validateAddonId(value.addonId), state: validateInstallState(value.state) };
}

function validateSnapshot(value: unknown): PersistedStremioAddonSnapshot {
  if (!isRecord(value) || value.stateVersion !== ADAPTER_STATE_VERSION || !Array.isArray(value.addons)) {
    throw new StremioPluginStorageError('The persisted Stremio add-on snapshot is malformed.');
  }
  if (value.addons.length > MAX_STREMIO_ADDONS) {
    throw new StremioPluginStorageError('The persisted Stremio add-on snapshot exceeds the host limit.');
  }
  const addons = value.addons.map(validateRecord);
  if (new Set(addons.map(({ addonId }) => addonId)).size !== addons.length) {
    throw new StremioPluginStorageError('Persisted Stremio add-on identities must be unique.');
  }
  return { stateVersion: ADAPTER_STATE_VERSION, addons };
}

function serialized(value: unknown): string {
  let result: string | undefined;
  try { result = JSON.stringify(value); } catch (error) {
    throw new StremioPluginStorageError('A Stremio add-on record could not be serialized.', { cause: error });
  }
  if (result === undefined || Buffer.byteLength(result, 'utf8') > MAX_STORED_RECORD_BYTES) {
    throw new StremioPluginStorageError('A Stremio add-on record exceeds the host storage limit.');
  }
  return result;
}

function publicManifestLocation(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}/…/manifest.json`;
  } catch {
    return '[protected manifest endpoint]';
  }
}

function trustStateFor(record: PersistedStremioAddonRecord, previous?: StremioAddonRow): PersistedStremioTrustState {
  if (record.state === 'enabled') return 'trusted';
  if (record.state === 'broken') return 'broken';
  if (record.state === 'disabled') return 'disabled';
  return previous && previous.trust_state !== 'review-required' ? 'update-review-required' : 'review-required';
}

function validateTrustState(row: StremioAddonRow, record: PersistedStremioAddonRecord): void {
  const valid = (row.trust_state === 'trusted' && record.state === 'enabled' && record.trusted === true)
    || (row.trust_state === 'broken' && record.state === 'broken' && record.trusted === false)
    || (row.trust_state === 'disabled' && record.state === 'disabled' && record.trusted === false)
    || ((row.trust_state === 'review-required' || row.trust_state === 'update-review-required')
      && record.state === 'pending-review' && record.trusted === false);
  if (!valid) throw new StremioPluginStorageError('Persisted Stremio trust state is inconsistent.');
}

function rowRecord(row: StremioAddonRow, secure?: StremioSecurePersistence): PersistedStremioAddonRecord {
  if (Buffer.byteLength(row.record_json, 'utf8') > MAX_STORED_RECORD_BYTES) {
    throw new StremioPluginStorageError('A persisted Stremio add-on record exceeds the host storage limit.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(row.record_json); } catch (error) {
    throw new StremioPluginStorageError('A persisted Stremio add-on record contains invalid JSON.', { cause: error });
  }

  if (isRecord(parsed) && parsed.persistenceVersion === STORAGE_STATE_VERSION && isRecord(parsed.record)) {
    if (!secure || !row.manifest_secret_ref || !Number.isSafeInteger(row.record_revision) || row.record_revision < 1) {
      throw new StremioPluginStorageError('Protected Stremio state cannot be recovered without the host secret store.');
    }
    if (!secure.verifyState(row.addon_id, row.record_revision, row.record_json, row.integrity_mac)) {
      throw new StremioPluginStorageError('Persisted Stremio state failed its integrity check.');
    }
    const record = validateRecord({ ...parsed.record, manifestUrl: secure.resolveManifestUrl(row.addon_id, row.manifest_secret_ref) });
    validateTrustState(row, record);
    return record;
  }

  // v1 is accepted only as migration input. Production load immediately
  // rewrites it through saveStremioAddonState with protected URL material.
  return validateRecord(parsed);
}

function selectRows(database: BetterSqlite3.Database): StremioAddonRow[] {
  return database.prepare(`
    SELECT addon_id, record_json, state, record_revision, integrity_mac,
      manifest_secret_ref, manifest_url_redacted, trust_state,
      last_successful_request, manifest_last_checked
    FROM stremio_addons ORDER BY addon_id COLLATE NOCASE
  `).all() as StremioAddonRow[];
}

export function hasLegacyStremioAddonState(database: BetterSqlite3.Database): boolean {
  return Boolean(database.prepare(`
    SELECT 1 FROM stremio_addons
    WHERE record_revision < 1 OR integrity_mac = '' OR manifest_secret_ref IS NULL
    LIMIT 1
  `).get());
}

export function loadStremioAddonState(
  database: BetterSqlite3.Database,
  secure?: StremioSecurePersistence,
): PersistedStremioAddonSnapshot | null {
  const rows = selectRows(database);
  if (rows.length === 0) return null;
  if (rows.length > MAX_STREMIO_ADDONS) throw new StremioPluginStorageError('The persisted Stremio add-on snapshot exceeds the host limit.');
  const addons = rows.map((row) => {
    const record = rowRecord(row, secure);
    const legacyBrokenState = record.state === 'broken' && row.state === 'disabled';
    if (record.addonId !== row.addon_id || (!legacyBrokenState && record.state !== row.state)) {
      throw new StremioPluginStorageError('A persisted Stremio add-on record does not match its storage identity.');
    }
    return record;
  });
  return validateSnapshot({ stateVersion: ADAPTER_STATE_VERSION, addons });
}

export function saveStremioAddonState(
  database: BetterSqlite3.Database,
  value: unknown,
  secure?: StremioSecurePersistence,
  audit?: StremioStateAuditContext,
): PersistedStremioAddonSnapshot {
  const snapshot = validateSnapshot(value);
  const now = Date.now();

  database.transaction(() => {
    const existing = selectRows(database);
    const incomingIds = new Set(snapshot.addons.map(({ addonId }) => addonId));
    const incomingById = new Map(snapshot.addons.map((record) => [record.addonId, record]));
    const priorGlobal = (database.prepare('SELECT revision FROM stremio_plugin_state_metadata WHERE id = 1').get() as { revision: number } | undefined)?.revision || 0;
    const newGlobal = priorGlobal + 1;
    database.prepare('UPDATE stremio_plugin_state_metadata SET revision = ?, updated_at = ? WHERE id = 1').run(newGlobal, now);

    const revokeProfileAccess = database.prepare('DELETE FROM profile_stremio_access WHERE addon_id = ?');
    const previousById = new Map(existing.map((row) => [row.addon_id, row]));
    for (const row of existing) {
      const incoming = incomingById.get(row.addon_id);
      let prior: PersistedStremioAddonRecord | undefined;
      try { prior = rowRecord(row, secure); } catch { /* fail closed by revoking stale grants */ }
      if (!incoming || incoming.state !== 'enabled' || prior?.reviewToken !== incoming.reviewToken) revokeProfileAccess.run(row.addon_id);
    }

    const upsert = database.prepare(`
      INSERT INTO stremio_addons
        (addon_id, record_json, state, updated_at, record_revision, integrity_mac,
         manifest_secret_ref, manifest_url_redacted, trust_state,
         last_successful_request, manifest_last_checked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(addon_id) DO UPDATE SET
        record_json = excluded.record_json, state = excluded.state, updated_at = excluded.updated_at,
        record_revision = excluded.record_revision, integrity_mac = excluded.integrity_mac,
        manifest_secret_ref = excluded.manifest_secret_ref,
        manifest_url_redacted = excluded.manifest_url_redacted, trust_state = excluded.trust_state,
        last_successful_request = excluded.last_successful_request,
        manifest_last_checked = excluded.manifest_last_checked
    `);
    const stageNewAddon = database.prepare(`
      INSERT OR IGNORE INTO stremio_addons (addon_id, record_json, state, updated_at)
      VALUES (?, '{"persistenceVersion":2,"record":{}}', ?, ?)
    `);

    for (const record of snapshot.addons) {
      const previous = previousById.get(record.addonId);
      const rawManifestUrl = typeof record.manifestUrl === 'string' ? record.manifestUrl : '';
      if (secure && !rawManifestUrl) throw new StremioPluginStorageError('A protected manifest endpoint is required.');
      // plugin_secrets is FK-bound to stremio_addons. Stage only the identity
      // for a new add-on inside this same transaction, then protect the URL and
      // replace the placeholder with the signed v2 envelope below. No raw URL
      // is ever written to SQLite and any failure rolls the placeholder back.
      if (!previous) stageNewAddon.run(record.addonId, record.state === 'broken' ? 'disabled' : record.state, now);
      const manifestSecretRef = secure
        ? secure.protectManifestUrl(record.addonId, rawManifestUrl)
        : previous?.manifest_secret_ref || null;
      const { manifestUrl: _manifestUrl, ...publicRecord } = record;
      const envelope: StoredV2Envelope | PersistedStremioAddonRecord = secure
        ? { persistenceVersion: STORAGE_STATE_VERSION, record: publicRecord }
        : record;
      const recordJson = serialized(envelope);
      const recordRevision = secure ? Math.max(0, previous?.record_revision || 0) + 1 : 0;
      const integrityMac = secure ? secure.signState(record.addonId, recordRevision, recordJson) : '';
      const trustState = trustStateFor(record, previous);
      const lastSuccessfulRequest = audit?.addonId === record.addonId && audit.lastSuccessfulRequest !== undefined
        ? audit.lastSuccessfulRequest
        : previous?.last_successful_request ?? null;
      const manifestLastChecked = audit?.addonId === record.addonId && audit.manifestLastChecked !== undefined
        ? audit.manifestLastChecked
        : previous?.manifest_last_checked ?? null;
      upsert.run(
        record.addonId,
        recordJson,
        record.state === 'broken' ? 'disabled' : record.state,
        now,
        recordRevision,
        integrityMac,
        manifestSecretRef,
        publicManifestLocation(rawManifestUrl),
        trustState,
        lastSuccessfulRequest,
        manifestLastChecked,
      );
    }

    const remove = database.prepare('DELETE FROM stremio_addons WHERE addon_id = ?');
    for (const row of existing) if (!incomingIds.has(row.addon_id)) remove.run(row.addon_id);

    if (secure && audit) secure.recordAudit({
      ...audit,
      priorRevision: priorGlobal,
      newRevision: newGlobal,
      createdAt: now,
    });
  })();

  return snapshot;
}

export function listProfileStremioAccess(database: BetterSqlite3.Database, profileId: string): string[] {
  return (database.prepare(`
    SELECT addon_id FROM profile_stremio_access WHERE profile_id = ? ORDER BY addon_id COLLATE NOCASE
  `).all(profileId) as Array<{ addon_id: string }>).map(({ addon_id: addonId }) => addonId);
}

export function hasProfileStremioAccess(database: BetterSqlite3.Database, profileId: string, addonId: string): boolean {
  return Boolean(database.prepare('SELECT 1 FROM profile_stremio_access WHERE profile_id = ? AND addon_id = ?').get(profileId, addonId));
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
    database.prepare('DELETE FROM profile_stremio_access WHERE profile_id = ? AND addon_id = ?').run(safeProfileId, safeAddonId);
    return false;
  }
  if (!database.prepare('SELECT 1 FROM profiles WHERE id = ?').get(safeProfileId)) {
    throw new StremioPluginStorageError('The selected profile no longer exists.');
  }
  if (!database.prepare("SELECT 1 FROM stremio_addons WHERE addon_id = ? AND trust_state = 'trusted'").get(safeAddonId)) {
    throw new StremioPluginStorageError('The selected Stremio add-on is not approved and enabled.');
  }
  const now = Date.now();
  database.prepare(`
    INSERT INTO profile_stremio_access (profile_id, addon_id, granted_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, addon_id) DO UPDATE SET updated_at = excluded.updated_at
  `).run(safeProfileId, safeAddonId, now, now);
  return true;
}
