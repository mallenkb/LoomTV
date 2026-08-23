import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ACCOUNT_PERMISSIONS } from '@loom-media-server/video-contracts';
import {
  CANONICAL_BACKUP_DURABLE_TABLES,
  CANONICAL_BACKUP_TRANSIENT_TABLES,
  CANONICAL_STATE_SNAPSHOT_FORMAT,
  CANONICAL_STATE_SNAPSHOT_VERSION,
} from '@loom-media-server/video-contracts/server';

export const CANONICAL_STATE_FILENAME = 'loomtv-canonical.sqlite';
export const CANONICAL_SCHEMA_VERSION = 1;
export const CANONICAL_MIGRATION_FORMAT = 'loomtv-canonical-migration-v1';

const LEGACY_STATE_FILENAMES = ['headless-admin.json', 'headless-client.sqlite', 'headless-client.json'];
const SAFE_MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const LIVE_TABLES = Object.freeze({
  accounts: 'accounts', accountCredentials: 'account_credentials', sessions: 'account_sessions', loginAttempts: 'login_attempts',
  roots: 'library_roots', catalogItems: 'catalog_items', mediaSources: 'media_sources',
  mediaIdentityAliases: 'media_identity_aliases', mediaIdentityEvidence: 'media_identity_evidence', profiles: 'profiles',
  profileCredentials: 'profile_credentials', profileAssignments: 'profile_assignments',
  profileSelections: 'profile_selections', progress: 'watch_progress', profileRestrictions: 'profile_restrictions',
  profilePreferences: 'profile_preferences', profileListEntries: 'profile_list_entries', trackPreferences: 'track_preferences',
  history: 'watch_history',
  devices: 'devices', deviceCredentials: 'device_credentials', pairingRequests: 'pairing_requests',
  backupState: 'backup_state', scanState: 'scan_state',
  operationalLogs: 'operational_logs',
});
const CANONICAL_BACKUP_TABLES = CANONICAL_BACKUP_DURABLE_TABLES;
const CANONICAL_RESTORE_DELETE_ORDER = Object.freeze([
  'offline_download_leases', 'invitation_sessions', 'invitations',
  'pairing_requests', 'device_credentials', 'account_sessions', 'login_attempts', 'devices',
  'track_preferences', 'profile_list_entries', 'profile_restrictions', 'profile_preferences',
  'watch_history', 'watch_progress', 'profile_selections', 'profile_assignments', 'profile_credentials', 'profiles',
  'media_identity_evidence', 'media_identity_aliases', 'media_sources', 'catalog_items', 'library_roots',
  'account_credentials', 'owner_account', 'accounts', 'audit_events', 'operational_logs',
  'scan_state', 'backup_state', 'remote_policy', 'migration_markers',
]);
const CANONICAL_TRANSIENT_TABLES = CANONICAL_BACKUP_TRANSIENT_TABLES;

const json = (value) => JSON.stringify(value ?? null);
function parseRequiredJson(value, field) {
  if (typeof value !== 'string') throw codedError('canonical_state_invalid', `Canonical ${field} JSON is missing.`);
  try { return JSON.parse(value); } catch {
    throw codedError('canonical_state_invalid', `Canonical ${field} JSON is corrupt.`);
  }
}

function parseOptionalRowJson(row, fallback, field) {
  return row ? parseRequiredJson(row.payload_json, field) : fallback;
}

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function inTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function extensionFrom(item, authoritative) {
  return Object.fromEntries(Object.entries(item || {}).filter(([key]) => !authoritative.has(key)));
}

function initializeSchema(database) {
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK (account_type IN ('owner','user')),
      role TEXT NOT NULL CHECK (role IN ('owner','admin','user','viewer')),
      permissions_json TEXT NOT NULL, root_ids_json TEXT, device_ids_json TEXT,
      max_sessions INTEGER CHECK (max_sessions IS NULL OR max_sessions BETWEEN 1 AND 32),
      disabled INTEGER NOT NULL CHECK (disabled IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_single_owner ON accounts(account_type) WHERE account_type='owner';
    CREATE TABLE IF NOT EXISTS owner_account (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS account_credentials (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      password_algorithm TEXT NOT NULL CHECK (password_algorithm='scrypt'), updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL, disabled INTEGER NOT NULL CHECK (disabled IN (0,1)),
      permissions_json TEXT NOT NULL DEFAULT '[]', certificate_fingerprint TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_seen_at INTEGER,
      revoked_at INTEGER, revoked_reason TEXT,
      CHECK ((revoked_at IS NULL AND revoked_reason IS NULL) OR revoked_at IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS device_credentials (
      id TEXT NOT NULL UNIQUE, device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      secret_hash TEXT NOT NULL, algorithm TEXT NOT NULL CHECK (algorithm IN ('sha256','scrypt')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pairing_requests (
      id TEXT PRIMARY KEY, request_secret_hash TEXT NOT NULL UNIQUE,
      credential_id TEXT NOT NULL UNIQUE, credential_secret_hash TEXT NOT NULL,
      credential_ciphertext TEXT, credential_iv TEXT, credential_tag TEXT,
      device_id TEXT NOT NULL UNIQUE, requested_name TEXT NOT NULL, requested_kind TEXT NOT NULL,
      requested_permissions_json TEXT NOT NULL, approved_permissions_json TEXT,
      certificate_fingerprint TEXT, account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','consumed','expired')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, consumed_at INTEGER,
      CHECK ((state='approved' AND account_id IS NOT NULL AND approved_permissions_json IS NOT NULL)
        OR state!='approved'),
      CHECK ((credential_ciphertext IS NULL AND credential_iv IS NULL AND credential_tag IS NULL)
        OR (credential_ciphertext IS NOT NULL AND credential_iv IS NOT NULL AND credential_tag IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS pairing_requests_expiry ON pairing_requests(state,expires_at);
    CREATE TABLE IF NOT EXISTS account_sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_id TEXT REFERENCES devices(id) ON DELETE SET NULL, created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL,
      revoked_at INTEGER, revoked_reason TEXT,
      CHECK (idle_expires_at <= absolute_expires_at),
      CHECK ((revoked_at IS NULL AND revoked_reason IS NULL) OR revoked_at IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS sessions_account ON account_sessions(account_id, absolute_expires_at);
    CREATE TABLE IF NOT EXISTS login_attempts (
      key TEXT PRIMARY KEY, failures INTEGER NOT NULL CHECK (failures>=0), first_attempt_at INTEGER NOT NULL,
      last_attempt_at INTEGER NOT NULL, locked_until INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_roots (
      id TEXT PRIMARY KEY, locator TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('movies','tvShows','anime','others')),
      state TEXT NOT NULL DEFAULT 'available' CHECK (state IN ('available','offline','removed')),
      created_at INTEGER NOT NULL, last_scan_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS catalog_items (
      id TEXT PRIMARY KEY, media_type TEXT NOT NULL, media_kind TEXT NOT NULL, title TEXT NOT NULL,
      year INTEGER, anime_likely INTEGER NOT NULL CHECK (anime_likely IN (0,1)),
      series_title TEXT, series_season INTEGER, series_episode INTEGER,
      extension_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_sources (
      id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      root_id TEXT REFERENCES library_roots(id) ON DELETE SET NULL,
      relative_path TEXT NOT NULL, locator TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('online','offline','unreadable','missing')),
      file_extension TEXT, size_bytes INTEGER, modified_at_ms REAL, indexed_at INTEGER NOT NULL,
      last_seen_at INTEGER, probe_json TEXT, extension_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS media_sources_media ON media_sources(media_id,state);
    CREATE INDEX IF NOT EXISTS media_sources_root ON media_sources(root_id,state);
    CREATE TABLE IF NOT EXISTS media_identity_aliases (
      namespace TEXT NOT NULL CHECK (namespace IN ('desktop-path-hash','headless-path-hash','legacy-media-id','provider')),
      alias TEXT NOT NULL, media_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, PRIMARY KEY(namespace,alias)
    );
    CREATE TABLE IF NOT EXISTS media_identity_evidence (
      source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('content-sha256','filesystem-id','quick-hash','legacy-path-hash')),
      value TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(source_id,kind,value)
    );
    CREATE TABLE IF NOT EXISTS scan_state (singleton INTEGER PRIMARY KEY CHECK (singleton=1), payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('adult','child','guest')),
      avatar_key TEXT NOT NULL, color_key TEXT NOT NULL, has_pin INTEGER NOT NULL CHECK (has_pin IN (0,1)),
      guest_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL, sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS profile_credentials (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, pin_algorithm TEXT NOT NULL CHECK (pin_algorithm='scrypt'),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile_assignments (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      access TEXT NOT NULL CHECK (access IN ('use','manage')), created_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id,account_id)
    );
    CREATE INDEX IF NOT EXISTS assignments_account ON profile_assignments(account_id,profile_id);
    CREATE TABLE IF NOT EXISTS profile_selections (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, device_id TEXT NOT NULL,
      profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL, revision INTEGER NOT NULL CHECK (revision>=0),
      automatic_sign_in INTEGER NOT NULL CHECK (automatic_sign_in IN (0,1)), selected_at INTEGER,
      PRIMARY KEY(account_id,device_id), UNIQUE(device_id)
    );
    CREATE TABLE IF NOT EXISTS watch_progress (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, media_id TEXT NOT NULL,
      position_seconds REAL NOT NULL CHECK (position_seconds>=0), duration_seconds REAL NOT NULL CHECK (duration_seconds>=0),
      watched INTEGER NOT NULL CHECK (watched IN (0,1)), updated_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id,media_id)
    );
    CREATE INDEX IF NOT EXISTS progress_recent ON watch_progress(profile_id,updated_at DESC);
    CREATE TABLE IF NOT EXISTS watch_history (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      media_id TEXT NOT NULL, event TEXT NOT NULL CHECK (event IN ('started','progressed','completed','unwatched')),
      position_seconds REAL NOT NULL CHECK (position_seconds>=0), occurred_at INTEGER NOT NULL,
      UNIQUE(profile_id,media_id,event,occurred_at)
    );
    CREATE INDEX IF NOT EXISTS history_recent ON watch_history(profile_id,occurred_at DESC);
    CREATE TABLE IF NOT EXISTS profile_preferences (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile_restrictions (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      allowed_root_ids_json TEXT, payload_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision>=0)
    );
    CREATE TABLE IF NOT EXISTS profile_list_entries (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, media_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('watchlist','favorite','watched')), created_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id,media_id,kind)
    );
    CREATE TABLE IF NOT EXISTS track_preferences (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, scope TEXT NOT NULL,
      payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(profile_id,scope)
    );
    CREATE TABLE IF NOT EXISTS backup_state (singleton INTEGER PRIMARY KEY CHECK (singleton=1), payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operational_logs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, payload_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS logs_timestamp ON operational_logs(timestamp DESC);
    CREATE TABLE IF NOT EXISTS migration_markers (
      id TEXT PRIMARY KEY, format TEXT NOT NULL CHECK (format='loomtv-canonical-migration-v1'), schema_version INTEGER NOT NULL,
      source_fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('prepared','committed','rolled-back')),
      backup_path TEXT, backup_sha256 TEXT, backup_size_bytes INTEGER,
      report_path TEXT, report_sha256 TEXT, report_size_bytes INTEGER,
      source_counts_json TEXT NOT NULL, reconciliation_json TEXT NOT NULL, target_counts_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, committed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS migration_single_committed ON migration_markers(state) WHERE state='committed';
  `);
  ensureRemoteSchema(database);
  database.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('schema_version', String(CANONICAL_SCHEMA_VERSION));
}

function ensureRemoteSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS remote_policy (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1), enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
      download_quota_bytes INTEGER NOT NULL CHECK (download_quota_bytes BETWEEN 0 AND 1099511627776),
      download_lease_ttl_ms INTEGER NOT NULL CHECK (download_lease_ttl_ms BETWEEN 60000 AND 2592000000),
      invitation_ttl_ms INTEGER NOT NULL CHECK (invitation_ttl_ms BETWEEN 60000 AND 2592000000),
      updated_at INTEGER NOT NULL, updated_by TEXT REFERENCES accounts(id) ON DELETE SET NULL
    );
    INSERT OR IGNORE INTO remote_policy(singleton,enabled,download_quota_bytes,download_lease_ttl_ms,invitation_ttl_ms,updated_at)
      VALUES(1,0,26843545600,604800000,604800000,0);
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL,
      request_class TEXT NOT NULL CHECK (request_class IN ('local','remote')),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('anonymous','account','device','invitation')),
      actor_id TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL
        CHECK (outcome IN ('allowed','denied','created','revoked','expired','failed')),
      address_hash TEXT, details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS audit_events_recent ON audit_events(occurred_at DESC);
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, issuer_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      secret_hash TEXT NOT NULL UNIQUE, scope_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','accepted','revoked','expired')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, revoked_at INTEGER, revoked_reason TEXT,
      CHECK ((state='revoked' AND revoked_at IS NOT NULL) OR state!='revoked')
    );
    CREATE INDEX IF NOT EXISTS invitations_issuer ON invitations(issuer_account_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS invitations_expiry ON invitations(state,expires_at);
    CREATE TABLE IF NOT EXISTS invitation_sessions (
      id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL UNIQUE REFERENCES invitations(id) ON DELETE CASCADE,
      secret_hash TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      idle_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL, revoked_at INTEGER, revoked_reason TEXT,
      CHECK (idle_expires_at <= absolute_expires_at),
      CHECK ((revoked_at IS NULL AND revoked_reason IS NULL) OR revoked_at IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS invitation_sessions_expiry ON invitation_sessions(absolute_expires_at);
    CREATE TABLE IF NOT EXISTS offline_download_leases (
      id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      invitation_session_id TEXT REFERENCES invitation_sessions(id) ON DELETE CASCADE,
      quota_owner TEXT NOT NULL, device_id TEXT NOT NULL,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      selection_revision INTEGER NOT NULL CHECK (selection_revision>=0),
      root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
      media_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
      file_version TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK (size_bytes>=0),
      allow_ranges INTEGER NOT NULL CHECK (allow_ranges IN (0,1)),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, revoked_reason TEXT,
      CHECK ((account_id IS NOT NULL AND invitation_session_id IS NULL)
        OR (account_id IS NULL AND invitation_session_id IS NOT NULL)),
      CHECK ((revoked_at IS NULL AND revoked_reason IS NULL) OR revoked_at IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS offline_downloads_owner ON offline_download_leases(quota_owner,expires_at);
    CREATE INDEX IF NOT EXISTS offline_downloads_account ON offline_download_leases(account_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS offline_downloads_invitation ON offline_download_leases(invitation_session_id,created_at DESC);
  `);
}

function addColumnIfMissing(database, table, name, declaration) {
  if (!database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
}

function ensureRuntimeSchema(database) {
  addColumnIfMissing(database, 'devices', 'permissions_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(database, 'devices', 'certificate_fingerprint', 'TEXT');
  addColumnIfMissing(database, 'devices', 'revoked_at', 'INTEGER');
  addColumnIfMissing(database, 'devices', 'revoked_reason', 'TEXT');
  addColumnIfMissing(database, 'device_credentials', 'id', 'TEXT');
  addColumnIfMissing(database, 'device_credentials', 'created_at', 'INTEGER');
  addColumnIfMissing(database, 'device_credentials', 'expires_at', 'INTEGER');
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS device_credentials_id ON device_credentials(id);
    CREATE TABLE IF NOT EXISTS pairing_requests (
      id TEXT PRIMARY KEY, request_secret_hash TEXT NOT NULL UNIQUE,
      credential_id TEXT NOT NULL UNIQUE, credential_secret_hash TEXT NOT NULL,
      credential_ciphertext TEXT, credential_iv TEXT, credential_tag TEXT,
      device_id TEXT NOT NULL UNIQUE, requested_name TEXT NOT NULL, requested_kind TEXT NOT NULL,
      requested_permissions_json TEXT NOT NULL, approved_permissions_json TEXT,
      certificate_fingerprint TEXT, account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','consumed','expired')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, consumed_at INTEGER,
      CHECK ((state='approved' AND account_id IS NOT NULL AND approved_permissions_json IS NOT NULL)
        OR state!='approved'),
      CHECK ((credential_ciphertext IS NULL AND credential_iv IS NULL AND credential_tag IS NULL)
        OR (credential_ciphertext IS NOT NULL AND credential_iv IS NOT NULL AND credential_tag IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS pairing_requests_expiry ON pairing_requests(state,expires_at);
  `);
  const now = Date.now();
  database.prepare("UPDATE device_credentials SET id='legacy-' || device_id WHERE id IS NULL").run();
  database.prepare('UPDATE device_credentials SET created_at=COALESCE(created_at,updated_at,?)').run(now);
  database.prepare('UPDATE device_credentials SET expires_at=COALESCE(expires_at,?)').run(Number.MAX_SAFE_INTEGER);
  ensureRemoteSchema(database);
}

function migrationMarker(database) {
  const row = database.prepare("SELECT * FROM migration_markers WHERE state='committed'").get();
  if (!row) return null;
  return {
    id: row.id, format: row.format, schemaVersion: Number(row.schema_version), sourceFingerprint: row.source_fingerprint,
    backupPath: row.backup_path || null, backupSha256: row.backup_sha256 || null,
    backupSizeBytes: row.backup_size_bytes === null ? null : Number(row.backup_size_bytes),
    reportPath: row.report_path || null, reportSha256: row.report_sha256 || null,
    reportSizeBytes: row.report_size_bytes === null ? null : Number(row.report_size_bytes),
    sourceCounts: parseRequiredJson(row.source_counts_json, 'migration source counts'),
    reconciliation: parseRequiredJson(row.reconciliation_json, 'migration reconciliation'),
    targetCounts: parseRequiredJson(row.target_counts_json, 'migration target counts'),
    createdAt: Number(row.created_at), committedAt: Number(row.committed_at),
  };
}

function verifyOpenDatabase(database) {
  const integrity = database.prepare('PRAGMA quick_check').get();
  if (integrity?.quick_check !== 'ok') throw codedError('canonical_state_invalid', 'Canonical state failed its integrity check.');
  if (database.prepare('PRAGMA foreign_key_check').all().length) {
    throw codedError('canonical_state_invalid', 'Canonical state has invalid references.');
  }
  const marker = migrationMarker(database);
  if (!marker) throw codedError('canonical_cutover_incomplete', 'The canonical database has no committed cutover marker.');
  if (marker.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
    throw codedError('canonical_schema_unsupported', 'The canonical state schema requires migration.');
  }
  return marker;
}

function upsertAccount(database, account, accountType) {
  database.prepare(`INSERT INTO accounts(
    id,name,account_type,role,permissions_json,root_ids_json,device_ids_json,max_sessions,disabled,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,account_type=excluded.account_type,role=excluded.role,permissions_json=excluded.permissions_json,
    root_ids_json=excluded.root_ids_json,device_ids_json=excluded.device_ids_json,max_sessions=excluded.max_sessions,
    disabled=excluded.disabled,updated_at=excluded.updated_at`).run(
    account.id, account.name, accountType, accountType === 'owner' ? 'owner' : account.role,
    json(accountType === 'owner' ? ['*'] : account.permissions || []),
    accountType === 'owner' || account.rootIds === null ? null : json(account.rootIds || []),
    accountType === 'owner' || account.deviceIds === null ? null : json(account.deviceIds || []),
    accountType === 'owner' ? null : account.maxSessions ?? null,
    accountType === 'owner' ? 0 : account.disabled === true ? 1 : 0,
    Number(account.createdAt) || Date.now(), Number(account.updatedAt) || Number(account.createdAt) || Date.now(),
  );
  database.prepare(`INSERT INTO account_credentials(account_id,password_salt,password_hash,password_algorithm,updated_at)
    VALUES(?,?,?,'scrypt',?) ON CONFLICT(account_id) DO UPDATE SET
    password_salt=excluded.password_salt,password_hash=excluded.password_hash,updated_at=excluded.updated_at`)
    .run(account.id, account.salt, account.hash, Number(account.updatedAt) || Date.now());
}

function replaceAdminState(database, state) {
  const currentOwnerId = database.prepare('SELECT account_id FROM owner_account WHERE singleton=1').get()?.account_id;
  if (currentOwnerId && state.owner?.id && currentOwnerId !== state.owner.id) {
    throw codedError('owner_identity_change_forbidden', 'A restore cannot replace the configured owner identity.');
  }
  const desiredAccounts = new Set();
  if (state.owner) {
    upsertAccount(database, state.owner, 'owner');
    desiredAccounts.add(state.owner.id);
    database.prepare('INSERT INTO owner_account(singleton,account_id) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET account_id=excluded.account_id').run(state.owner.id);
  } else if (database.prepare('SELECT 1 FROM owner_account').get()) {
    throw codedError('owner_required', 'A configured owner account cannot be removed.');
  }
  for (const user of state.users || []) { upsertAccount(database, user, 'user'); desiredAccounts.add(user.id); }
  for (const { id, account_type: type } of database.prepare('SELECT id,account_type FROM accounts').all()) {
    if (!desiredAccounts.has(id) && type !== 'owner') database.prepare('DELETE FROM accounts WHERE id=?').run(id);
  }

  database.exec('DELETE FROM account_sessions; DELETE FROM login_attempts;');
  const insertSession = database.prepare(`INSERT INTO account_sessions(
    id,token_hash,account_id,device_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at,revoked_reason
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  for (const session of state.sessions || []) {
    if (!desiredAccounts.has(session.userId)) continue;
    const absolute = Number(session.absoluteExpiresAt ?? session.expiresAt);
    const idle = Math.min(Number(session.idleExpiresAt ?? absolute), absolute);
    const sessionId = session.id || `legacy-${createHash('sha256').update(`session:${session.tokenHash}`).digest('hex')}`;
    insertSession.run(sessionId, session.tokenHash, session.userId, session.deviceId || null, session.createdAt, session.lastSeenAt ?? session.createdAt,
      idle, absolute, session.revokedAt ?? null, session.revokedReason ?? null);
  }
  const insertAttempt = database.prepare('INSERT INTO login_attempts(key,failures,first_attempt_at,last_attempt_at,locked_until) VALUES(?,?,?,?,?)');
  for (const attempt of state.loginAttempts || []) insertAttempt.run(attempt.key, attempt.failures, attempt.firstAttemptAt, attempt.lastAttemptAt, attempt.lockedUntil);

  const desiredRoots = new Set();
  const upsertRoot = database.prepare(`INSERT INTO library_roots(id,locator,kind,state,created_at,last_scan_at)
    VALUES(?,?,?,'available',?,?) ON CONFLICT(id) DO UPDATE SET locator=excluded.locator,kind=excluded.kind,state='available',last_scan_at=excluded.last_scan_at`);
  for (const root of state.roots || []) {
    desiredRoots.add(root.id);
    upsertRoot.run(root.id, root.path, root.kind, root.createdAt, root.lastScanAt ?? null);
  }
  for (const { id } of database.prepare('SELECT id FROM library_roots').all()) {
    if (!desiredRoots.has(id)) {
      database.prepare("UPDATE media_sources SET state='offline' WHERE root_id=?").run(id);
      database.prepare("UPDATE library_roots SET state='removed' WHERE id=?").run(id);
    }
  }

  const itemFields = new Set([
    'id','rootId','path','relativePath','type','kind','title','year','animeLikely','series','seriesId','seasonNumber','episodeNumber',
    'extension','sizeBytes','modifiedAtMs','available','indexedAt','sourceId','sourceIds','legacyIds','localMetadata','createdAt','updatedAt',
  ]);
  const upsertItem = database.prepare(`INSERT INTO catalog_items(
    id,media_type,media_kind,title,year,anime_likely,series_title,series_season,series_episode,extension_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET media_type=excluded.media_type,media_kind=excluded.media_kind,
    title=excluded.title,year=excluded.year,anime_likely=excluded.anime_likely,series_title=excluded.series_title,
    series_season=excluded.series_season,series_episode=excluded.series_episode,extension_json=excluded.extension_json,updated_at=excluded.updated_at`);
  const upsertSource = database.prepare(`INSERT INTO media_sources(
    id,media_id,root_id,relative_path,locator,state,file_extension,size_bytes,modified_at_ms,indexed_at,last_seen_at,probe_json,extension_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET media_id=excluded.media_id,root_id=excluded.root_id,
    relative_path=excluded.relative_path,locator=excluded.locator,state=excluded.state,file_extension=excluded.file_extension,
    size_bytes=excluded.size_bytes,modified_at_ms=excluded.modified_at_ms,indexed_at=excluded.indexed_at,
    last_seen_at=excluded.last_seen_at,probe_json=COALESCE(excluded.probe_json,media_sources.probe_json),extension_json=excluded.extension_json`);
  for (const item of state.catalog || []) {
    if (!desiredRoots.has(item.rootId)) continue;
    const now = Number(item.indexedAt) || Date.now();
    upsertItem.run(item.id, item.type, item.kind, item.title, item.year ?? null, item.animeLikely === true ? 1 : 0,
      item.series?.title ?? null, item.series?.season ?? null, item.series?.episode ?? null,
      json(extensionFrom(item, itemFields)), now, now);
    const sourceId = item.sourceId || `${item.id}:primary`;
    upsertSource.run(sourceId, item.id, item.rootId, item.relativePath, item.path,
      item.available === false ? 'offline' : 'online', item.extension || null, item.sizeBytes ?? null,
      item.modifiedAtMs ?? null, now, item.available === false ? null : now,
      item.localMetadata ? json(item.localMetadata) : null, '{}');
  }
  // Scans carry one projected source per catalog item. Secondary canonical
  // sources are not absent merely because that legacy projection omitted them.
  database.prepare('INSERT OR REPLACE INTO scan_state(singleton,payload_json) VALUES(1,?)').run(json(state.scan || { state: 'idle' }));
  database.prepare('INSERT OR REPLACE INTO backup_state(singleton,payload_json) VALUES(1,?)').run(json(state.backup || { state: 'never' }));
  database.exec('DELETE FROM operational_logs');
  const insertLog = database.prepare('INSERT INTO operational_logs(timestamp,payload_json) VALUES(?,?)');
  for (const entry of state.logs || []) insertLog.run(Number(entry.timestamp) || Date.now(), json(entry));
}

function accountView(row) {
  return {
    id: row.id, name: row.name, salt: row.password_salt, hash: row.password_hash,
    ...(row.account_type === 'user' ? {
      role: row.role, permissions: parseRequiredJson(row.permissions_json, 'account permissions'),
      rootIds: row.root_ids_json === null ? null : parseRequiredJson(row.root_ids_json, 'account roots'),
      deviceIds: row.device_ids_json === null ? null : parseRequiredJson(row.device_ids_json, 'account devices'),
      maxSessions: row.max_sessions === null ? null : Number(row.max_sessions), disabled: row.disabled === 1,
    } : {}),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function readAdminState(database) {
  const credentialsJoin = 'JOIN account_credentials c ON c.account_id=a.id';
  const owner = database.prepare(`SELECT a.*,c.password_salt,c.password_hash FROM owner_account o JOIN accounts a ON a.id=o.account_id ${credentialsJoin} WHERE o.singleton=1`).get();
  const legacyIdsByMedia = new Map();
  for (const alias of database.prepare('SELECT media_id,alias FROM media_identity_aliases ORDER BY created_at').all()) {
    const legacyIds = legacyIdsByMedia.get(alias.media_id) || [];
    legacyIds.push(alias.alias);
    legacyIdsByMedia.set(alias.media_id, legacyIds);
  }
  const catalog = database.prepare(`SELECT c.*,s.id source_id,s.root_id,s.relative_path,s.locator,s.state source_state,
    s.file_extension,s.size_bytes,s.modified_at_ms,s.indexed_at,s.probe_json FROM catalog_items c
    LEFT JOIN media_sources s ON s.id=(SELECT s2.id FROM media_sources s2 WHERE s2.media_id=c.id ORDER BY s2.state='online' DESC,s2.indexed_at DESC LIMIT 1)
    ORDER BY c.title`).all().map((row) => ({
      ...parseRequiredJson(row.extension_json, 'catalog extension'), id: row.id, rootId: row.root_id, path: row.locator,
      relativePath: row.relative_path, type: row.media_type, kind: row.media_kind, title: row.title,
      ...(row.year === null ? {} : { year: Number(row.year) }), ...(row.anime_likely === 1 ? { animeLikely: true } : {}),
      ...(row.series_title ? { series: { title: row.series_title, season: row.series_season, episode: row.series_episode } } : {}),
      extension: row.file_extension, ...(row.size_bytes === null ? {} : { sizeBytes: Number(row.size_bytes) }),
      ...(row.modified_at_ms === null ? {} : { modifiedAtMs: Number(row.modified_at_ms) }),
      ...(row.probe_json ? { localMetadata: parseRequiredJson(row.probe_json, 'media probe') } : {}),
      available: row.source_state === 'online', indexedAt: Number(row.indexed_at), sourceId: row.source_id,
      legacyIds: legacyIdsByMedia.get(row.id) || [], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      ...(row.series_season === null ? {} : { seasonNumber: Number(row.series_season) }),
      ...(row.series_episode === null ? {} : { episodeNumber: Number(row.series_episode) }),
    }));
  return {
    owner: owner ? accountView(owner) : null,
    users: database.prepare(`SELECT a.*,c.password_salt,c.password_hash FROM accounts a ${credentialsJoin} WHERE a.account_type='user' ORDER BY a.created_at`).all().map(accountView),
    sessions: database.prepare('SELECT * FROM account_sessions ORDER BY created_at').all().map((row) => ({
      id: row.id, tokenHash: row.token_hash, userId: row.account_id, deviceId: row.device_id, createdAt: Number(row.created_at),
      lastSeenAt: Number(row.last_seen_at), idleExpiresAt: Number(row.idle_expires_at),
      absoluteExpiresAt: Number(row.absolute_expires_at), expiresAt: Number(row.absolute_expires_at),
      ...(row.revoked_at === null ? {} : { revokedAt: Number(row.revoked_at), revokedReason: row.revoked_reason }),
    })),
    loginAttempts: database.prepare('SELECT * FROM login_attempts ORDER BY last_attempt_at').all().map((row) => ({
      key: row.key, failures: Number(row.failures), firstAttemptAt: Number(row.first_attempt_at),
      lastAttemptAt: Number(row.last_attempt_at), lockedUntil: Number(row.locked_until),
    })),
    roots: database.prepare("SELECT * FROM library_roots WHERE state!='removed' ORDER BY created_at").all().map((row) => ({
      id: row.id, path: row.locator, kind: row.kind, createdAt: Number(row.created_at),
      ...(row.last_scan_at === null ? {} : { lastScanAt: Number(row.last_scan_at) }),
    })),
    catalog, profiles: [], watchState: {},
    scan: parseOptionalRowJson(database.prepare('SELECT payload_json FROM scan_state WHERE singleton=1').get(), { state: 'idle' }, 'scan state'),
    backup: parseOptionalRowJson(database.prepare('SELECT payload_json FROM backup_state WHERE singleton=1').get(), { state: 'never' }, 'backup state'),
    logs: database.prepare('SELECT payload_json FROM operational_logs ORDER BY sequence').all().map((row) => parseRequiredJson(row.payload_json, 'operational log')),
  };
}

function replaceClientState(database, state) {
  const managedProfiles = new Set((state.assignments || []).filter((item) => item.access === 'manage').map((item) => item.profileId));
  const unmanaged = (state.profiles || []).find((profile) => !managedProfiles.has(profile.id));
  if (unmanaged) throw codedError('profile_manager_required', 'Every profile must retain at least one manage assignment.');
  const desired = new Set();
  const upsertProfile = database.prepare(`INSERT INTO profiles(
    id,name,kind,avatar_key,color_key,has_pin,guest_device_id,sort_order,created_at,updated_at,last_used_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,
    avatar_key=excluded.avatar_key,color_key=excluded.color_key,has_pin=excluded.has_pin,
    guest_device_id=excluded.guest_device_id,sort_order=excluded.sort_order,updated_at=excluded.updated_at,last_used_at=excluded.last_used_at`);
  for (const profile of state.profiles || []) {
    desired.add(profile.id);
    upsertProfile.run(profile.id, profile.name, profile.kind, profile.avatarKey || 'glyph-01', profile.colorKey || 'ember',
      profile.hasPin === true ? 1 : 0, profile.guestDeviceId || null, Number(profile.sortOrder) || 0,
      Number(profile.createdAt) || Date.now(), Number(profile.updatedAt) || Date.now(), profile.lastUsedAt ?? null);
  }
  for (const { id } of database.prepare('SELECT id FROM profiles').all()) if (!desired.has(id)) database.prepare('DELETE FROM profiles WHERE id=?').run(id);
  database.exec(`DELETE FROM profile_credentials; DELETE FROM profile_assignments; DELETE FROM profile_selections;
    DELETE FROM watch_progress; DELETE FROM watch_history; DELETE FROM profile_preferences; DELETE FROM profile_restrictions;
    DELETE FROM profile_list_entries; DELETE FROM track_preferences;`);
  const credentials = database.prepare("INSERT INTO profile_credentials(profile_id,pin_salt,pin_hash,pin_algorithm,updated_at) VALUES(?,?,?,'scrypt',?)");
  for (const item of state.profileCredentials || []) credentials.run(item.profileId, item.pinSalt, item.pinHash, item.updatedAt);
  const assignments = database.prepare('INSERT INTO profile_assignments(profile_id,account_id,access,created_at) VALUES(?,?,?,?)');
  for (const item of state.assignments || []) assignments.run(item.profileId, item.accountId, item.access, item.createdAt);
  const selections = database.prepare('INSERT INTO profile_selections(account_id,device_id,profile_id,revision,automatic_sign_in,selected_at) VALUES(?,?,?,?,?,?)');
  for (const item of state.selections || []) selections.run(item.accountId, item.deviceId, item.profileId || null, item.revision || 0, item.automaticSignIn ? 1 : 0, item.selectedAt ?? null);
  const progress = database.prepare('INSERT INTO watch_progress(profile_id,media_id,position_seconds,duration_seconds,watched,updated_at) VALUES(?,?,?,?,?,?)');
  for (const item of state.progress || []) progress.run(item.profileId, item.mediaId, item.positionSeconds, item.durationSeconds, item.watched ? 1 : 0, item.updatedAt);
  const history = database.prepare('INSERT INTO watch_history(id,profile_id,media_id,event,position_seconds,occurred_at) VALUES(?,?,?,?,?,?)');
  for (const item of state.history || []) history.run(item.id, item.profileId, item.mediaId, item.event, item.positionSeconds || 0, item.occurredAt);
  const preferences = database.prepare('INSERT INTO profile_preferences(profile_id,payload_json,updated_at) VALUES(?,?,?)');
  for (const item of state.profilePreferences || []) preferences.run(item.profileId, json(item.preferences || {}), item.updatedAt);
  const restrictions = database.prepare('INSERT INTO profile_restrictions(profile_id,allowed_root_ids_json,payload_json,revision) VALUES(?,?,?,?)');
  for (const item of state.profileRestrictions || []) {
    const { profileId, allowedRootIds, revision, ...rest } = item;
    restrictions.run(profileId, allowedRootIds === null ? null : json(allowedRootIds || []), json(rest), revision || 0);
  }
  const entries = database.prepare('INSERT INTO profile_list_entries(profile_id,media_id,kind,created_at) VALUES(?,?,?,?)');
  for (const item of state.profileListEntries || []) entries.run(item.profileId, item.mediaId, item.kind, item.createdAt);
  const tracks = database.prepare('INSERT INTO track_preferences(profile_id,scope,payload_json,updated_at) VALUES(?,?,?,?)');
  for (const item of state.trackPreferences || []) {
    const { profileId, scope, updatedAt, preferences, ...canonicalPreferences } = item;
    tracks.run(profileId, scope, json(preferences || canonicalPreferences), updatedAt);
  }
}

function readClientState(database) {
  return {
    profiles: database.prepare('SELECT * FROM profiles ORDER BY sort_order,created_at').all().map((row) => ({
      id: row.id, name: row.name, kind: row.kind, avatarKey: row.avatar_key, colorKey: row.color_key,
      hasPin: row.has_pin === 1, isGuest: row.kind === 'guest', ...(row.guest_device_id ? { guestDeviceId: row.guest_device_id } : {}),
      sortOrder: Number(row.sort_order), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      ...(row.last_used_at === null ? {} : { lastUsedAt: Number(row.last_used_at) }),
    })),
    profileCredentials: database.prepare('SELECT * FROM profile_credentials').all().map((row) => ({
      profileId: row.profile_id, pinSalt: row.pin_salt, pinHash: row.pin_hash, pinAlgorithm: row.pin_algorithm, updatedAt: Number(row.updated_at),
    })),
    assignments: database.prepare('SELECT * FROM profile_assignments ORDER BY created_at').all().map((row) => ({
      profileId: row.profile_id, accountId: row.account_id, access: row.access, createdAt: Number(row.created_at),
    })),
    selections: database.prepare('SELECT * FROM profile_selections').all().map((row) => ({
      accountId: row.account_id, deviceId: row.device_id, profileId: row.profile_id, revision: Number(row.revision),
      automaticSignIn: row.automatic_sign_in === 1, ...(row.selected_at === null ? {} : { selectedAt: Number(row.selected_at) }),
    })),
    progress: database.prepare('SELECT * FROM watch_progress').all().map((row) => ({
      profileId: row.profile_id, mediaId: row.media_id, positionSeconds: Number(row.position_seconds),
      durationSeconds: Number(row.duration_seconds), watched: row.watched === 1, updatedAt: Number(row.updated_at),
    })),
    history: database.prepare('SELECT * FROM watch_history ORDER BY occurred_at').all().map((row) => ({
      id: row.id, profileId: row.profile_id, mediaId: row.media_id, event: row.event,
      positionSeconds: Number(row.position_seconds), occurredAt: Number(row.occurred_at),
    })),
    profilePreferences: database.prepare('SELECT * FROM profile_preferences').all().map((row) => ({
      profileId: row.profile_id, preferences: parseRequiredJson(row.payload_json, 'profile preferences'), updatedAt: Number(row.updated_at),
    })),
    profileRestrictions: database.prepare('SELECT * FROM profile_restrictions').all().map((row) => ({
      ...parseRequiredJson(row.payload_json, 'profile restrictions'), profileId: row.profile_id,
      allowedRootIds: row.allowed_root_ids_json === null ? null : parseRequiredJson(row.allowed_root_ids_json, 'profile restriction roots'),
      revision: Number(row.revision),
    })),
    profileListEntries: database.prepare('SELECT * FROM profile_list_entries').all().map((row) => ({
      profileId: row.profile_id, mediaId: row.media_id, kind: row.kind, createdAt: Number(row.created_at),
    })),
    trackPreferences: database.prepare('SELECT * FROM track_preferences').all().map((row) => ({
      ...parseRequiredJson(row.payload_json, 'track preferences'), profileId: row.profile_id, scope: row.scope,
      updatedAt: Number(row.updated_at),
    })),
  };
}

function replaceIdentityState(database, state = {}) {
  if (Array.isArray(state.mediaIdentityAliases)) {
    database.exec('DELETE FROM media_identity_aliases');
    const insert = database.prepare('INSERT INTO media_identity_aliases(namespace,alias,media_id,created_at) VALUES(?,?,?,?)');
    for (const item of state.mediaIdentityAliases) insert.run(item.namespace, item.alias, item.mediaId, item.createdAt);
  }
  if (Array.isArray(state.mediaIdentityEvidence)) {
    database.exec('DELETE FROM media_identity_evidence');
    const insert = database.prepare('INSERT INTO media_identity_evidence(source_id,kind,value,observed_at) VALUES(?,?,?,?)');
    for (const item of state.mediaIdentityEvidence) insert.run(item.sourceId, item.kind, item.value, item.observedAt);
  }
}

function replaceProjectedMediaState(database, state = {}) {
  const itemFields = new Set(['id','kind','title','year','seasonNumber','episodeNumber','animeLikely','available','sourceIds','legacyIds','createdAt','updatedAt']);
  const upsertItem = database.prepare(`INSERT INTO catalog_items(
    id,media_type,media_kind,title,year,anime_likely,series_title,series_season,series_episode,extension_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET media_type=excluded.media_type,media_kind=excluded.media_kind,
    title=excluded.title,year=excluded.year,anime_likely=excluded.anime_likely,series_title=excluded.series_title,
    series_season=excluded.series_season,series_episode=excluded.series_episode,extension_json=excluded.extension_json,updated_at=excluded.updated_at`);
  for (const item of state.catalogItems || []) upsertItem.run(
    item.id, ['series','episode'].includes(item.kind) ? 'tv' : 'movie', item.kind, item.title, item.year ?? null,
    item.animeLikely === true ? 1 : 0, null, item.seasonNumber ?? null, item.episodeNumber ?? null,
    json(extensionFrom(item, itemFields)), item.createdAt, item.updatedAt,
  );
  const upsertSource = database.prepare(`INSERT INTO media_sources(
    id,media_id,root_id,relative_path,locator,state,file_extension,size_bytes,modified_at_ms,indexed_at,last_seen_at,probe_json,extension_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET media_id=excluded.media_id,root_id=excluded.root_id,
    relative_path=excluded.relative_path,locator=excluded.locator,state=excluded.state,file_extension=excluded.file_extension,
    size_bytes=excluded.size_bytes,modified_at_ms=excluded.modified_at_ms,indexed_at=excluded.indexed_at,
    last_seen_at=excluded.last_seen_at,probe_json=excluded.probe_json,extension_json=excluded.extension_json`);
  for (const source of state.mediaSources || []) upsertSource.run(
    source.id, source.mediaId, source.rootId, source.relativePath, source.locator, source.state,
    source.fileExtension || null, source.sizeBytes ?? null, source.modifiedAtMs ?? null, source.indexedAt,
    source.lastSeenAt ?? null, source.probe ? json(source.probe) : null, json(source.extension || {}),
  );
}

function replaceDeviceState(database, state = {}) {
  if (!Array.isArray(state.devices)) return;
  database.exec('DELETE FROM pairing_requests; DELETE FROM device_credentials; DELETE FROM devices;');
  const insertDevice = database.prepare(`INSERT INTO devices(
    id,account_id,name,kind,disabled,permissions_json,certificate_fingerprint,created_at,updated_at,last_seen_at,revoked_at,revoked_reason
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const item of state.devices) insertDevice.run(
    item.id, item.accountId || null, item.name || 'Device', item.kind || 'unknown', item.disabled === true ? 1 : 0,
    json(item.permissions || item.scopes || []), item.certificateFingerprint || null,
    Number(item.createdAt) || Date.now(), Number(item.updatedAt) || Date.now(), item.lastSeenAt ?? null,
    item.revokedAt ?? null, item.revokedReason || null,
  );
  const insertCredential = database.prepare(`INSERT INTO device_credentials(
    id,device_id,secret_hash,algorithm,created_at,expires_at,updated_at
  ) VALUES(?,?,?,?,?,?,?)`);
  for (const item of state.deviceCredentials || []) insertCredential.run(
    item.id || `legacy-${item.deviceId}`, item.deviceId, item.secretHash, item.algorithm,
    item.createdAt || item.updatedAt, item.expiresAt || Number.MAX_SAFE_INTEGER, item.updatedAt,
  );
}

function replaceAllState(database, state) {
  replaceAdminState(database, state.adminState || {});
  replaceDeviceState(database, state);
  replaceProjectedMediaState(database, state);
  replaceClientState(database, state.clientState || {});
  replaceIdentityState(database, state);
}

function targetCounts(database) {
  return Object.fromEntries(Object.entries(LIVE_TABLES).map(([category, table]) => [category,
    Number(database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count)]));
}

function validateReconciliation(sourceCounts, reconciliation, actualTargetCounts) {
  for (const [category, sourceValue] of Object.entries(sourceCounts || {})) {
    const source = Number(sourceValue);
    const row = reconciliation?.[category];
    if (!row || Number(row.source) !== source) throw codedError('migration_reconciliation_missing', `Migration reconciliation is missing category ${category}.`);
    const rejected = Array.isArray(row.rejected) ? row.rejected.reduce((sum, item) => sum + Number(item.count || 0), 0) : 0;
    if (Number(row.imported || 0) + Number(row.merged || 0) + Number(row.legacyOnly || 0) + rejected !== source) {
      throw codedError('migration_reconciliation_mismatch', `Migration reconciliation does not balance category ${category}.`);
    }
    if (actualTargetCounts[category] !== undefined && Number(row.imported || 0) + Number(row.generated || 0) !== actualTargetCounts[category]) {
      throw codedError('migration_target_count_mismatch', `Canonical target count does not match imported category ${category}.`);
    }
  }
}

async function digestPath(targetPath) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(targetPath, { highWaterMark: 1024 * 1024 })) {
    sizeBytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { path: targetPath, sha256: hash.digest('hex'), sizeBytes };
}

async function syncDirectory(directoryPath) {
  const directory = await fs.open(directoryPath, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function evidenceAvailability(marker) {
  async function matches(targetPath, expectedDigest, expectedSize) {
    if (!targetPath) return null;
    try {
      const actual = await digestPath(targetPath);
      return actual.sha256 === expectedDigest && actual.sizeBytes === expectedSize;
    } catch { return false; }
  }
  return {
    backup: await matches(marker.backupPath, marker.backupSha256, marker.backupSizeBytes),
    report: await matches(marker.reportPath, marker.reportSha256, marker.reportSizeBytes),
  };
}

function redactedMarker(marker, availability) {
  if (!marker) return null;
  const { backupPath, reportPath, ...safe } = marker;
  return { ...safe, backupPath: backupPath ? '[redacted]' : null, reportPath: reportPath ? '[redacted]' : null, evidenceAvailable: availability };
}

function tableColumns(database, table) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.length) throw codedError('canonical_backup_incompatible', `Canonical backup table ${table} is unavailable.`);
  return columns;
}

function exportCanonicalSnapshot(database, createdAt = Date.now()) {
  const tables = {};
  database.exec('BEGIN');
  try {
    for (const table of CANONICAL_BACKUP_TABLES) {
      tables[table] = database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return {
    format: CANONICAL_STATE_SNAPSHOT_FORMAT,
    version: CANONICAL_STATE_SNAPSHOT_VERSION,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    createdAt,
    policy: {
      durableTables: [...CANONICAL_BACKUP_TABLES],
      excludedTransientTables: [...CANONICAL_TRANSIENT_TABLES],
      invitationsRestoredAsRevoked: true,
    },
    tables,
  };
}

function validateCanonicalSnapshot(snapshot, database) {
  if (!snapshot || snapshot.format !== CANONICAL_STATE_SNAPSHOT_FORMAT
    || snapshot.version !== CANONICAL_STATE_SNAPSHOT_VERSION
    || snapshot.schemaVersion !== CANONICAL_SCHEMA_VERSION
    || !snapshot.tables || typeof snapshot.tables !== 'object') {
    throw codedError('canonical_backup_incompatible', 'The canonical backup format or schema is not supported.');
  }
  const declared = snapshot.policy?.durableTables;
  const excluded = snapshot.policy?.excludedTransientTables;
  if (json(declared) !== json(CANONICAL_BACKUP_TABLES)
    || json(excluded) !== json(CANONICAL_TRANSIENT_TABLES)
    || snapshot.policy?.invitationsRestoredAsRevoked !== true) {
    throw codedError('canonical_backup_incompatible', 'The canonical backup retention policy does not match this server.');
  }
  const tableNames = Object.keys(snapshot.tables).sort();
  if (json(tableNames) !== json([...CANONICAL_BACKUP_TABLES].sort())) {
    throw codedError('canonical_backup_incompatible', 'The canonical backup table inventory is incomplete.');
  }
  const columnsByTable = {};
  for (const table of CANONICAL_BACKUP_TABLES) {
    const columns = tableColumns(database, table);
    columnsByTable[table] = columns;
    const rows = snapshot.tables[table];
    if (!Array.isArray(rows)) throw codedError('canonical_backup_invalid', `Canonical backup table ${table} is invalid.`);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || json(Object.keys(row).sort()) !== json([...columns].sort())) {
        throw codedError('canonical_backup_invalid', `Canonical backup table ${table} has an invalid row shape.`);
      }
    }
  }
  return columnsByTable;
}

function validateCanonicalJsonState(database) {
  const permissionSet = new Set(ACCOUNT_PERMISSIONS);
  const rootIds = new Set(database.prepare('SELECT id FROM library_roots').all().map((row) => row.id));
  const profileIds = new Set(database.prepare('SELECT id FROM profiles').all().map((row) => row.id));
  const mediaIds = new Set(database.prepare('SELECT id FROM catalog_items').all().map((row) => row.id));
  const objectJson = (value, field) => {
    let parsed;
    try { parsed = parseRequiredJson(value, field); } catch {
      throw codedError('canonical_backup_invalid', `Canonical ${field} JSON is corrupt.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw codedError('canonical_backup_invalid', `Canonical ${field} JSON must be an object.`);
    }
    return parsed;
  };
  const arrayJson = (value, field) => {
    let parsed;
    try { parsed = parseRequiredJson(value, field); } catch {
      throw codedError('canonical_backup_invalid', `Canonical ${field} JSON is corrupt.`);
    }
    if (!Array.isArray(parsed)) throw codedError('canonical_backup_invalid', `Canonical ${field} JSON must be an array.`);
    return parsed;
  };
  for (const row of database.prepare('SELECT account_type,permissions_json,root_ids_json,device_ids_json FROM accounts').all()) {
    const permissions = arrayJson(row.permissions_json, 'account permissions');
    const validOwnerWildcard = row.account_type === 'owner' && permissions.length === 1 && permissions[0] === '*';
    if (!validOwnerWildcard && permissions.some((value) => typeof value !== 'string' || !permissionSet.has(value))) {
      throw codedError('canonical_backup_invalid', 'Canonical account permissions are invalid.');
    }
    if (row.root_ids_json !== null && arrayJson(row.root_ids_json, 'account roots').some((value) => typeof value !== 'string' || !rootIds.has(value))) {
      throw codedError('canonical_backup_invalid', 'Canonical account roots are invalid.');
    }
    if (row.device_ids_json !== null && arrayJson(row.device_ids_json, 'account devices').some((value) => typeof value !== 'string')) {
      throw codedError('canonical_backup_invalid', 'Canonical account devices are invalid.');
    }
  }
  for (const row of database.prepare('SELECT extension_json FROM catalog_items').all()) {
    const extension = objectJson(row.extension_json, 'catalog extension');
    const authoritative = new Set(['id','rootId','path','relativePath','locator','type','kind','title','year','animeLikely','series','seriesId','seasonNumber','episodeNumber','extension','sizeBytes','modifiedAtMs','available','indexedAt','sourceId','sourceIds','legacyIds','localMetadata','createdAt','updatedAt']);
    if (Object.keys(extension).some((key) => authoritative.has(key))) {
      throw codedError('canonical_backup_invalid', 'Canonical catalog extension JSON duplicates authoritative state.');
    }
  }
  for (const row of database.prepare('SELECT extension_json FROM media_sources').all()) objectJson(row.extension_json, 'media source extension');
  for (const row of database.prepare('SELECT id,probe_json FROM media_sources WHERE probe_json IS NOT NULL').all()) {
    const probe = objectJson(row.probe_json, 'media probe');
    const probeFields = new Set(['sourceId','container','durationSeconds','bitrateKbps','width','height','videoCodec','audioCodec','hdr','hdrFormat','tracks','chapters','adapterGaps','probedAt']);
    const trackFields = new Set(['id','index','kind','codec','language','title','channels','width','height','profile','pixelFormat','colorTransfer','colorPrimaries','colorSpace','frameRate','default','forced','external']);
    if (Object.keys(probe).some((key) => !probeFields.has(key))
      || probe.sourceId !== row.id || typeof probe.hdr !== 'boolean' || !Array.isArray(probe.tracks)
      || !Number.isSafeInteger(probe.probedAt) || probe.probedAt < 0
      || probe.tracks.some((track) => !track || typeof track !== 'object' || Array.isArray(track)
        || Object.keys(track).some((key) => !trackFields.has(key))
        || typeof track.id !== 'string' || !Number.isSafeInteger(track.index) || track.index < 0
        || !['video','audio','subtitle','data','unknown'].includes(track.kind)
        || typeof track.default !== 'boolean' || typeof track.forced !== 'boolean')
      || (probe.hdrFormat !== undefined && !['hdr10','hdr10-plus','hlg','dolby-vision'].includes(probe.hdrFormat))
      || ['container','videoCodec','audioCodec'].some((key) => probe[key] !== undefined && typeof probe[key] !== 'string')
      || ['durationSeconds','bitrateKbps','width','height'].some((key) => probe[key] !== undefined
        && (!Number.isFinite(probe[key]) || probe[key] < 0))
      || probe.tracks.some((track) => ['codec','language','title','profile','pixelFormat','colorTransfer','colorPrimaries','colorSpace']
        .some((key) => track[key] !== undefined && typeof track[key] !== 'string')
        || ['channels','width','height','frameRate'].some((key) => track[key] !== undefined
          && (!Number.isFinite(track[key]) || track[key] < 0))
        || (track.external !== undefined && typeof track.external !== 'boolean'))
      || (probe.chapters !== undefined && (!Array.isArray(probe.chapters)
        || probe.chapters.some((chapter) => !chapter || typeof chapter !== 'object' || Array.isArray(chapter)
          || !Number.isFinite(chapter.startMs) || !Number.isFinite(chapter.endMs)
          || chapter.startMs < 0 || chapter.endMs <= chapter.startMs || typeof chapter.title !== 'string')))
      || (probe.adapterGaps !== undefined && (!Array.isArray(probe.adapterGaps)
        || probe.adapterGaps.some((gap) => typeof gap !== 'string')))) {
      throw codedError('canonical_backup_invalid', 'Canonical media probe JSON is invalid.');
    }
  }
  for (const row of database.prepare('SELECT payload_json FROM scan_state').all()) objectJson(row.payload_json, 'scan state');
  for (const row of database.prepare('SELECT payload_json FROM backup_state').all()) objectJson(row.payload_json, 'backup state');
  for (const row of database.prepare('SELECT payload_json FROM operational_logs').all()) objectJson(row.payload_json, 'operational log');
  for (const row of database.prepare('SELECT payload_json FROM profile_preferences').all()) {
    const preferences = objectJson(row.payload_json, 'profile preferences');
    const allowed = new Set(['themeMode','themeColor','showProviderRatingBadges','sidebarNavOrder','autoplayNextEnabled','skipBackSeconds','skipForwardSeconds']);
    if (Object.keys(preferences).some((key) => !allowed.has(key))
      || (preferences.themeMode !== undefined && !['dark','light'].includes(preferences.themeMode))
      || (preferences.themeColor !== undefined && !['orange','yellow','red','blue','twitch'].includes(preferences.themeColor))
      || (preferences.showProviderRatingBadges !== undefined && typeof preferences.showProviderRatingBadges !== 'boolean')
      || (preferences.autoplayNextEnabled !== undefined && typeof preferences.autoplayNextEnabled !== 'boolean')
      || (preferences.skipBackSeconds !== undefined && (!Number.isSafeInteger(preferences.skipBackSeconds) || preferences.skipBackSeconds < 0 || preferences.skipBackSeconds > 600))
      || (preferences.skipForwardSeconds !== undefined && (!Number.isSafeInteger(preferences.skipForwardSeconds) || preferences.skipForwardSeconds < 0 || preferences.skipForwardSeconds > 600))
      || (preferences.sidebarNavOrder !== undefined && (!Array.isArray(preferences.sidebarNavOrder)
        || preferences.sidebarNavOrder.length > 32
        || preferences.sidebarNavOrder.some((value) => typeof value !== 'string' || !value.trim() || value.length > 64)))) {
      throw codedError('canonical_backup_invalid', 'Canonical profile preferences are invalid.');
    }
  }
  for (const row of database.prepare('SELECT allowed_root_ids_json,payload_json FROM profile_restrictions').all()) {
    if (row.allowed_root_ids_json !== null
      && arrayJson(row.allowed_root_ids_json, 'profile restriction roots').some((value) => typeof value !== 'string' || !rootIds.has(value))) {
      throw codedError('canonical_backup_invalid', 'Canonical profile restriction roots are invalid.');
    }
    const restrictions = objectJson(row.payload_json, 'profile restrictions');
    if (Object.keys(restrictions).some((key) => !['country','maximumAge','allowUnrated'].includes(key))
      || typeof restrictions.country !== 'string' || !restrictions.country.trim() || restrictions.country.length > 8
      || !(restrictions.maximumAge === null || (Number.isFinite(restrictions.maximumAge) && restrictions.maximumAge >= 0))
      || typeof restrictions.allowUnrated !== 'boolean') {
      throw codedError('canonical_backup_invalid', 'Canonical profile restrictions are invalid.');
    }
  }
  for (const row of database.prepare('SELECT payload_json FROM track_preferences').all()) {
    const preferences = objectJson(row.payload_json, 'track preferences');
    const validTrack = (track) => track === undefined || (track && typeof track === 'object' && !Array.isArray(track)
      && typeof track.enabled === 'boolean'
      && (track.trackId === undefined || typeof track.trackId === 'string')
      && (track.index === undefined || (Number.isSafeInteger(track.index) && track.index >= 0))
      && ['trackId','language','title','codec'].every((key) => track[key] === undefined
        || (typeof track[key] === 'string' && track[key].length <= 128 && !track[key].includes('\u0000')))
      && (track.forced === undefined || typeof track.forced === 'boolean'));
    if (Object.keys(preferences).some((key) => !['audio','subtitle'].includes(key))
      || !validTrack(preferences.audio) || !validTrack(preferences.subtitle)) {
      throw codedError('canonical_backup_invalid', 'Canonical track preferences are invalid.');
    }
  }
  for (const row of database.prepare('SELECT permissions_json FROM devices').all()) {
    const permissions = arrayJson(row.permissions_json, 'device permissions');
    if (permissions.some((value) => typeof value !== 'string' || !permissionSet.has(value))) {
      throw codedError('canonical_backup_invalid', 'Canonical device permissions are invalid.');
    }
  }
  for (const row of database.prepare('SELECT source_counts_json,reconciliation_json,target_counts_json FROM migration_markers').all()) {
    const sourceCounts = objectJson(row.source_counts_json, 'migration source counts');
    const reconciliation = objectJson(row.reconciliation_json, 'migration reconciliation');
    const targetCounts = objectJson(row.target_counts_json, 'migration target counts');
    const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
    const accountingTyped = Object.values(sourceCounts).every(validCount)
      && Object.values(targetCounts).every(validCount)
      && Object.values(reconciliation).every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
        && validCount(entry.source) && validCount(entry.imported || 0) && validCount(entry.merged || 0) && validCount(entry.generated || 0)
        && validCount(entry.legacyOnly || 0) && Array.isArray(entry.rejected)
        && entry.rejected.every((rejection) => rejection && typeof rejection === 'object' && !Array.isArray(rejection)
          && typeof rejection.reason === 'string' && validCount(rejection.count)));
    if (!accountingTyped) throw codedError('canonical_backup_invalid', 'Canonical migration accounting JSON is invalid.');
    try { validateReconciliation(sourceCounts, reconciliation, targetCounts); } catch {
      throw codedError('canonical_backup_invalid', 'Canonical migration reconciliation JSON is invalid.');
    }
  }
  for (const row of database.prepare('SELECT scope_json FROM invitations').all()) {
    const scope = objectJson(row.scope_json, 'invitation scope');
    if (Object.keys(scope).some((key) => !['profileId','rootIds','mediaIds','permissions','downloadQuotaBytes'].includes(key))
      || typeof scope.profileId !== 'string' || !profileIds.has(scope.profileId) || !Array.isArray(scope.rootIds)
      || scope.rootIds.some((value) => typeof value !== 'string' || !rootIds.has(value))
      || !(scope.mediaIds === null || Array.isArray(scope.mediaIds)) || !Array.isArray(scope.permissions)
      || (Array.isArray(scope.mediaIds) && scope.mediaIds.some((value) => typeof value !== 'string' || !mediaIds.has(value)))
      || scope.permissions.some((value) => !['library.read','stream','downloads'].includes(value))
      || !Number.isSafeInteger(scope.downloadQuotaBytes) || scope.downloadQuotaBytes < 0) {
      throw codedError('canonical_backup_invalid', 'Canonical invitation scope JSON is invalid.');
    }
  }
  for (const row of database.prepare('SELECT details_json FROM audit_events').all()) objectJson(row.details_json, 'audit details');
  if (database.prepare(`SELECT 1 FROM accounts a WHERE NOT EXISTS (
    SELECT 1 FROM account_credentials c WHERE c.account_id=a.id
  ) LIMIT 1`).get()) throw codedError('canonical_backup_invalid', 'Every restored account requires a credential.');
  if (database.prepare(`SELECT 1 FROM profiles p WHERE NOT EXISTS (
    SELECT 1 FROM profile_assignments a JOIN accounts account ON account.id=a.account_id
    WHERE a.profile_id=p.id AND a.access='manage' AND account.disabled=0
  ) LIMIT 1`).get()) throw codedError('canonical_backup_invalid', 'Every restored profile requires a manage assignment.');
  if (database.prepare(`SELECT 1 FROM profiles p WHERE p.has_pin != EXISTS (
    SELECT 1 FROM profile_credentials c WHERE c.profile_id=p.id
  ) LIMIT 1`).get()) throw codedError('canonical_backup_invalid', 'Restored profile PIN state is inconsistent.');
}

function replaceFromCanonicalSnapshot(database, snapshot, restoredAt = Date.now()) {
  const columnsByTable = validateCanonicalSnapshot(snapshot, database);
  const currentOwnerId = database.prepare('SELECT account_id FROM owner_account WHERE singleton=1').get()?.account_id;
  const snapshotOwnerRows = snapshot.tables.owner_account;
  if (!currentOwnerId || snapshotOwnerRows.length !== 1 || snapshotOwnerRows[0].account_id !== currentOwnerId) {
    throw codedError('canonical_owner_mismatch', 'A backup cannot replace the configured owner identity.');
  }
  return inTransaction(database, () => {
    for (const table of CANONICAL_RESTORE_DELETE_ORDER) database.exec(`DELETE FROM ${table}`);
    for (const table of CANONICAL_BACKUP_TABLES) {
      const columns = columnsByTable[table];
      const placeholders = columns.map(() => '?').join(',');
      const insert = database.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${placeholders})`);
      for (const sourceRow of snapshot.tables[table]) {
        const row = table === 'invitations' && ['pending', 'accepted'].includes(sourceRow.state)
          ? { ...sourceRow, state: 'revoked', revoked_at: sourceRow.revoked_at ?? restoredAt,
            revoked_reason: sourceRow.revoked_reason || 'backup_restored' }
          : sourceRow;
        insert.run(...columns.map((column) => row[column]));
      }
    }
    const ownerCount = Number(database.prepare('SELECT COUNT(*) count FROM owner_account').get()?.count || 0);
    const ownerAccountCount = Number(database.prepare("SELECT COUNT(*) count FROM accounts WHERE account_type='owner' AND disabled=0").get()?.count || 0);
    if (ownerCount !== 1 || ownerAccountCount !== 1) {
      throw codedError('canonical_backup_invalid', 'The canonical backup must contain exactly one enabled owner.');
    }
    validateCanonicalJsonState(database);
    verifyOpenDatabase(database);
    readAdminState(database);
    readClientState(database);
    if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
      || database.prepare('PRAGMA foreign_key_check').all().length) {
      throw codedError('canonical_backup_invalid', 'The canonical backup failed database integrity verification.');
    }
    return true;
  });
}

function pruneRemoteState(database, currentTime = Date.now()) {
  database.prepare("UPDATE invitations SET state='expired' WHERE state='pending' AND expires_at<=?").run(currentTime);
  database.prepare(`UPDATE invitation_sessions SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,'expired')
    WHERE revoked_at IS NULL AND (idle_expires_at<=? OR absolute_expires_at<=?
      OR invitation_id IN (SELECT id FROM invitations WHERE state IN ('expired','revoked')))`)
    .run(currentTime, currentTime, currentTime);
  database.prepare(`UPDATE offline_download_leases SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,'expired')
    WHERE revoked_at IS NULL AND (expires_at<=? OR invitation_session_id IN
      (SELECT id FROM invitation_sessions WHERE revoked_at IS NOT NULL))`).run(currentTime, currentTime);
}

function remotePolicyView(row) {
  return {
    enabled: row.enabled === 1,
    downloadQuotaBytes: Number(row.download_quota_bytes),
    downloadLeaseTtlMs: Number(row.download_lease_ttl_ms),
    invitationTtlMs: Number(row.invitation_ttl_ms),
    updatedAt: Number(row.updated_at),
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
  };
}

function invitationView(row, includeSecretHash = false) {
  return {
    id: row.id, issuerAccountId: row.issuer_account_id,
    scope: parseRequiredJson(row.scope_json, 'invitation scope'), state: row.state,
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    ...(row.accepted_at === null ? {} : { acceptedAt: Number(row.accepted_at) }),
    ...(row.revoked_at === null ? {} : { revokedAt: Number(row.revoked_at), revokedReason: row.revoked_reason }),
    ...(includeSecretHash ? { secretHash: row.secret_hash } : {}),
  };
}

function invitationSessionView(row, includeSecretHash = false) {
  return {
    id: row.id, invitationId: row.invitation_id, issuerAccountId: row.issuer_account_id,
    deviceId: row.device_id, scope: parseRequiredJson(row.scope_json, 'invitation session scope'),
    createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at),
    idleExpiresAt: Number(row.idle_expires_at), absoluteExpiresAt: Number(row.absolute_expires_at),
    ...(row.revoked_at === null ? {} : { revokedAt: Number(row.revoked_at), revokedReason: row.revoked_reason }),
    ...(includeSecretHash ? { secretHash: row.secret_hash } : {}),
  };
}

function downloadLeaseView(row, includeSecretHash = false) {
  return {
    id: row.id, ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.invitation_session_id ? { invitationSessionId: row.invitation_session_id } : {}),
    deviceId: row.device_id, profileId: row.profile_id, selectionRevision: Number(row.selection_revision),
    rootId: row.root_id, mediaId: row.media_id, sourceId: row.source_id,
    fileVersion: row.file_version, sizeBytes: Number(row.size_bytes), allowRanges: row.allow_ranges === 1,
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    ...(row.revoked_at === null ? {} : { revokedAt: Number(row.revoked_at), revokedReason: row.revoked_reason }),
    ...(includeSecretHash ? { secretHash: row.secret_hash, quotaOwner: row.quota_owner } : {}),
  };
}

export function createCanonicalStateStore({ dataDir }) {
  const databasePath = path.join(path.resolve(dataDir), CANONICAL_STATE_FILENAME);
  let database = null;
  let marker = null;
  let availability = { backup: null, report: null };
  const requireDatabase = () => {
    if (!database) throw codedError('canonical_state_closed', 'Canonical state is not open.');
    return database;
  };
  return {
    databasePath,
    async start() {
      if (database) return redactedMarker(marker, availability);
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const exists = await fs.access(databasePath).then(() => true, () => false);
      if (!exists) {
        const legacySources = [];
        for (const fileName of LEGACY_STATE_FILENAMES) if (await fs.access(path.join(path.dirname(databasePath), fileName)).then(() => true, () => false)) legacySources.push(fileName);
        if (legacySources.length) throw codedError('canonical_migration_required', 'Legacy state requires a verified canonical migration before startup.', { sourceKinds: legacySources.map((name) => name.replace(/^headless-/,'').replace(/\..*$/,'')) });
        const stagedPath = path.join(path.dirname(databasePath), `.${CANONICAL_STATE_FILENAME}.fresh-${randomUUID()}.stage`);
        const staged = new DatabaseSync(stagedPath);
        try {
          initializeSchema(staged);
          const now = Date.now();
          staged.prepare(`INSERT INTO migration_markers(id,format,schema_version,source_fingerprint,state,
            source_counts_json,reconciliation_json,target_counts_json,created_at,committed_at)
            VALUES(?,?,?,'fresh-install','committed','{}','{}','{}',?,?)`)
            .run(`fresh-${randomUUID()}`, CANONICAL_MIGRATION_FORMAT, CANONICAL_SCHEMA_VERSION, now, now);
          staged.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } finally { staged.close(); }
        await fs.rename(stagedPath, databasePath);
        await syncDirectory(path.dirname(databasePath));
      }
      const next = new DatabaseSync(databasePath);
      try {
        next.exec('PRAGMA foreign_keys=ON');
        marker = verifyOpenDatabase(next);
        ensureRuntimeSchema(next);
        availability = marker.sourceFingerprint === 'fresh-install' ? { backup: null, report: null } : await evidenceAvailability(marker);
        database = next;
        return redactedMarker(marker, availability);
      } catch (error) { next.close(); throw error; }
    },
    marker: () => redactedMarker(marker, availability),
    exportCanonicalSnapshot() {
      return exportCanonicalSnapshot(requireDatabase());
    },
    async restoreCanonicalSnapshot(snapshot, restoredAt = Date.now()) {
      const active = requireDatabase();
      replaceFromCanonicalSnapshot(active, snapshot, restoredAt);
      marker = verifyOpenDatabase(active);
      availability = marker.sourceFingerprint === 'fresh-install'
        ? { backup: null, report: null }
        : await evidenceAvailability(marker);
      return { marker: redactedMarker(marker, availability), restoredAt };
    },
    readAdminState: () => readAdminState(requireDatabase()),
    updateBackupState(state) {
      requireDatabase().prepare('INSERT OR REPLACE INTO backup_state(singleton,payload_json) VALUES(1,?)').run(json(state));
      return true;
    },
    appendOperationalLog(entry, currentTime = Date.now()) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        active.prepare('INSERT INTO operational_logs(timestamp,payload_json) VALUES(?,?)')
          .run(Number(entry.timestamp) || currentTime, json(entry));
        active.prepare('DELETE FROM operational_logs WHERE timestamp<?').run(currentTime - 30 * 24 * 60 * 60 * 1000);
        active.prepare(`DELETE FROM operational_logs WHERE sequence IN (
          SELECT sequence FROM operational_logs ORDER BY timestamp DESC,sequence DESC LIMIT -1 OFFSET 250
        )`).run();
        return true;
      });
    },
    readRemotePolicy() {
      return remotePolicyView(requireDatabase().prepare('SELECT * FROM remote_policy WHERE singleton=1').get());
    },
    updateRemotePolicy(input, actorId, updatedAt = Date.now()) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        const current = remotePolicyView(active.prepare('SELECT * FROM remote_policy WHERE singleton=1').get());
        const next = {
          enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
          downloadQuotaBytes: input.downloadQuotaBytes ?? current.downloadQuotaBytes,
          downloadLeaseTtlMs: input.downloadLeaseTtlMs ?? current.downloadLeaseTtlMs,
          invitationTtlMs: input.invitationTtlMs ?? current.invitationTtlMs,
        };
        active.prepare(`UPDATE remote_policy SET enabled=?,download_quota_bytes=?,download_lease_ttl_ms=?,
          invitation_ttl_ms=?,updated_at=?,updated_by=? WHERE singleton=1`).run(
          next.enabled ? 1 : 0, next.downloadQuotaBytes, next.downloadLeaseTtlMs,
          next.invitationTtlMs, updatedAt, actorId || null,
        );
        return remotePolicyView(active.prepare('SELECT * FROM remote_policy WHERE singleton=1').get());
      });
    },
    appendAuditEvent(event) {
      requireDatabase().prepare(`INSERT INTO audit_events(id,occurred_at,request_class,actor_type,actor_id,action,outcome,address_hash,details_json)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(event.id, event.occurredAt, event.requestClass, event.actorType,
        event.actorId || null, event.action, event.outcome, event.addressHash || null, json(event.details || {}));
      requireDatabase().prepare('DELETE FROM audit_events WHERE occurred_at<?').run(event.occurredAt - 90 * 24 * 60 * 60 * 1000);
      requireDatabase().prepare(`DELETE FROM audit_events WHERE id IN (
        SELECT id FROM audit_events ORDER BY occurred_at DESC LIMIT -1 OFFSET 100000
      )`).run();
      return true;
    },
    listAuditEvents({ limit = 100, before = Number.MAX_SAFE_INTEGER } = {}) {
      return requireDatabase().prepare('SELECT * FROM audit_events WHERE occurred_at<? ORDER BY occurred_at DESC LIMIT ?')
        .all(before, limit).map((row) => ({ id: row.id, occurredAt: Number(row.occurred_at), requestClass: row.request_class,
          actorType: row.actor_type, ...(row.actor_id ? { actorId: row.actor_id } : {}), action: row.action,
          outcome: row.outcome, details: parseRequiredJson(row.details_json, 'audit details') }));
    },
    createInvitation(input) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        pruneRemoteState(active, input.createdAt);
        const count = Number(active.prepare("SELECT COUNT(*) count FROM invitations WHERE issuer_account_id=? AND state='pending'").get(input.issuerAccountId)?.count || 0);
        if (count >= 128) throw codedError('invitation_capacity_exceeded', 'Too many invitations are pending.');
        active.prepare(`INSERT INTO invitations(id,issuer_account_id,secret_hash,scope_json,state,created_at,expires_at)
          VALUES(?,?,?,?,'pending',?,?)`).run(input.id, input.issuerAccountId, input.secretHash, json(input.scope), input.createdAt, input.expiresAt);
        return invitationView(active.prepare('SELECT * FROM invitations WHERE id=?').get(input.id));
      });
    },
    readInvitation(id, includeSecretHash = false) {
      const row = requireDatabase().prepare('SELECT * FROM invitations WHERE id=?').get(id);
      return row ? invitationView(row, includeSecretHash) : null;
    },
    listInvitations(issuerAccountId) {
      pruneRemoteState(requireDatabase());
      return requireDatabase().prepare('SELECT * FROM invitations WHERE issuer_account_id=? ORDER BY created_at DESC LIMIT 256')
        .all(issuerAccountId).map((row) => invitationView(row));
    },
    acceptInvitation(input) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        pruneRemoteState(active, input.createdAt);
        const invitation = active.prepare('SELECT * FROM invitations WHERE id=? AND secret_hash=?').get(input.invitationId, input.invitationSecretHash);
        if (!invitation) throw codedError('invitation_not_found', 'Invitation was not found.');
        if (invitation.state === 'expired' || invitation.expires_at <= input.createdAt) throw codedError('invitation_expired', 'Invitation expired.');
        if (invitation.state !== 'pending') throw codedError('invitation_unavailable', 'Invitation is no longer available.');
        active.prepare(`INSERT INTO invitation_sessions(id,invitation_id,secret_hash,device_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(input.sessionId, input.invitationId, input.sessionSecretHash, input.deviceId,
          input.createdAt, input.createdAt, input.idleExpiresAt, Math.min(input.absoluteExpiresAt, invitation.expires_at));
        active.prepare("UPDATE invitations SET state='accepted',accepted_at=? WHERE id=? AND state='pending'").run(input.createdAt, input.invitationId);
        return this.readInvitationSession(input.sessionId, true);
      });
    },
    readInvitationSession(id, includeSecretHash = false) {
      const row = requireDatabase().prepare(`SELECT s.*,i.issuer_account_id,i.scope_json FROM invitation_sessions s
        JOIN invitations i ON i.id=s.invitation_id WHERE s.id=?`).get(id);
      return row ? invitationSessionView(row, includeSecretHash) : null;
    },
    touchInvitationSession(id, seenAt, idleExpiresAt) {
      return requireDatabase().prepare(`UPDATE invitation_sessions SET last_seen_at=?,idle_expires_at=MIN(absolute_expires_at,?)
        WHERE id=? AND revoked_at IS NULL AND idle_expires_at>? AND absolute_expires_at>?`).run(seenAt, idleExpiresAt, id, seenAt, seenAt).changes === 1;
    },
    revokeInvitation(id, issuerAccountId, reason = 'revoked', revokedAt = Date.now()) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        const row = active.prepare('SELECT id FROM invitations WHERE id=? AND issuer_account_id=?').get(id, issuerAccountId);
        if (!row) throw codedError('invitation_not_found', 'Invitation was not found.');
        active.prepare("UPDATE invitations SET state='revoked',revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,?) WHERE id=?")
          .run(revokedAt, reason, id);
        active.prepare('UPDATE invitation_sessions SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,?) WHERE invitation_id=?')
          .run(revokedAt, reason, id);
        active.prepare(`UPDATE offline_download_leases SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,?)
          WHERE invitation_session_id IN (SELECT id FROM invitation_sessions WHERE invitation_id=?)`).run(revokedAt, reason, id);
        return true;
      });
    },
    revokeInvitationSession(id, reason = 'revoked', revokedAt = Date.now()) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        const changed = active.prepare('UPDATE invitation_sessions SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,?) WHERE id=?')
          .run(revokedAt, reason, id).changes === 1;
        active.prepare('UPDATE offline_download_leases SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,?) WHERE invitation_session_id=?')
          .run(revokedAt, reason, id);
        return changed;
      });
    },
    createDownloadLease(input, quotaBytes) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        pruneRemoteState(active, input.createdAt);
        const reserved = Number(active.prepare(`SELECT COALESCE(SUM(size_bytes),0) total FROM offline_download_leases
          WHERE quota_owner=? AND revoked_at IS NULL AND expires_at>?`).get(input.quotaOwner, input.createdAt)?.total || 0);
        if (reserved + input.sizeBytes > quotaBytes) throw codedError('download_quota_exceeded', 'The offline download quota is exhausted.');
        active.prepare(`INSERT INTO offline_download_leases(id,secret_hash,account_id,invitation_session_id,quota_owner,device_id,
          profile_id,selection_revision,root_id,media_id,source_id,file_version,size_bytes,allow_ranges,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.secretHash, input.accountId || null,
          input.invitationSessionId || null, input.quotaOwner, input.deviceId, input.profileId, input.selectionRevision,
          input.rootId, input.mediaId, input.sourceId, input.fileVersion, input.sizeBytes, input.allowRanges ? 1 : 0,
          input.createdAt, input.expiresAt);
        return downloadLeaseView(active.prepare('SELECT * FROM offline_download_leases WHERE id=?').get(input.id));
      });
    },
    readDownloadLease(id, includeSecretHash = false) {
      pruneRemoteState(requireDatabase());
      const row = requireDatabase().prepare('SELECT * FROM offline_download_leases WHERE id=?').get(id);
      return row ? downloadLeaseView(row, includeSecretHash) : null;
    },
    listDownloadLeases({ accountId, invitationSessionId }) {
      pruneRemoteState(requireDatabase());
      const rows = invitationSessionId
        ? requireDatabase().prepare('SELECT * FROM offline_download_leases WHERE invitation_session_id=? ORDER BY created_at DESC LIMIT 512').all(invitationSessionId)
        : requireDatabase().prepare('SELECT * FROM offline_download_leases WHERE account_id=? ORDER BY created_at DESC LIMIT 512').all(accountId);
      return rows.map((row) => downloadLeaseView(row));
    },
    revokeDownloadLease(id, owner, reason = 'revoked', revokedAt = Date.now()) {
      const clause = owner.invitationSessionId ? 'invitation_session_id=?' : 'account_id=?';
      const ownerId = owner.invitationSessionId || owner.accountId;
      return requireDatabase().prepare(`UPDATE offline_download_leases SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,?)
        WHERE id=? AND ${clause}`).run(revokedAt, reason, id, ownerId).changes === 1;
    },
    createPairingRequest(input) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        const now = Number(input.createdAt) || Date.now();
        for (const expired of active.prepare("SELECT device_id FROM pairing_requests WHERE state='approved' AND expires_at<=?").all(now)) {
          active.prepare('DELETE FROM devices WHERE id=?').run(expired.device_id);
        }
        active.prepare(`UPDATE pairing_requests SET state='expired',credential_ciphertext=NULL,credential_iv=NULL,credential_tag=NULL
          WHERE state IN ('pending','approved') AND expires_at<=?`).run(now);
        const pendingCount = Number(active.prepare("SELECT COUNT(*) count FROM pairing_requests WHERE state='pending' AND expires_at>?").get(now)?.count || 0);
        if (pendingCount >= 64) throw codedError('pairing_capacity_exceeded', 'Too many pairing requests are pending.');
        active.prepare(`INSERT INTO pairing_requests(
          id,request_secret_hash,credential_id,credential_secret_hash,credential_ciphertext,credential_iv,credential_tag,
          device_id,requested_name,requested_kind,requested_permissions_json,certificate_fingerprint,state,created_at,expires_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(
          input.id, input.requestSecretHash, input.credentialId, input.credentialSecretHash,
          input.credentialCiphertext, input.credentialIv, input.credentialTag,
          input.deviceId, input.name, input.kind, json(input.permissions || []), input.certificateFingerprint || null,
          now, input.expiresAt,
        );
        return { id: input.id, expiresAt: input.expiresAt, state: 'pending' };
      });
    },
    readPairingRequest(requestId) {
      const row = requireDatabase().prepare('SELECT * FROM pairing_requests WHERE id=?').get(requestId);
      if (!row) return null;
      return {
        id: row.id, requestSecretHash: row.request_secret_hash, credentialId: row.credential_id,
        credentialSecretHash: row.credential_secret_hash, credentialCiphertext: row.credential_ciphertext,
        credentialIv: row.credential_iv, credentialTag: row.credential_tag, deviceId: row.device_id,
        name: row.requested_name, kind: row.requested_kind,
        requestedPermissions: parseRequiredJson(row.requested_permissions_json, 'pairing requested permissions'),
        approvedPermissions: row.approved_permissions_json === null ? null : parseRequiredJson(row.approved_permissions_json, 'pairing approved permissions'),
        certificateFingerprint: row.certificate_fingerprint || undefined,
        accountId: row.account_id || undefined, state: row.state,
        createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
        ...(row.decided_at === null ? {} : { decidedAt: Number(row.decided_at) }),
        ...(row.consumed_at === null ? {} : { consumedAt: Number(row.consumed_at) }),
      };
    },
    approvePairingRequest(input) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        const row = active.prepare('SELECT * FROM pairing_requests WHERE id=?').get(input.requestId);
        if (!row) throw codedError('pairing_request_not_found', 'Pairing request was not found.');
        const now = Number(input.approvedAt) || Date.now();
        if (row.expires_at <= now) {
          active.prepare("UPDATE pairing_requests SET state='expired',credential_ciphertext=NULL,credential_iv=NULL,credential_tag=NULL WHERE id=? AND state='pending'").run(input.requestId);
          throw codedError('pairing_request_expired', 'Pairing request expired.');
        }
        if (row.state !== 'pending') throw codedError('pairing_request_decided', 'Pairing request was already decided.');
        const account = active.prepare('SELECT id,disabled FROM accounts WHERE id=?').get(input.accountId);
        if (!account || account.disabled === 1) throw codedError('account_not_found', 'The target account is unavailable or disabled.');
        active.prepare(`INSERT INTO devices(
          id,account_id,name,kind,disabled,permissions_json,certificate_fingerprint,created_at,updated_at,last_seen_at
        ) VALUES(?,?,?,?,0,?,?,?,?,NULL)`).run(
          row.device_id, input.accountId, row.requested_name, row.requested_kind,
          json(input.permissions || []), row.certificate_fingerprint, now, now,
        );
        active.prepare(`INSERT INTO device_credentials(
          id,device_id,secret_hash,algorithm,created_at,expires_at,updated_at
        ) VALUES(?,?,?,'sha256',?,?,?)`).run(
          row.credential_id, row.device_id, row.credential_secret_hash, now, input.credentialExpiresAt, now,
        );
        active.prepare(`UPDATE pairing_requests SET state='approved',account_id=?,approved_permissions_json=?,decided_at=?
          WHERE id=? AND state='pending'`).run(input.accountId, json(input.permissions || []), now, input.requestId);
        return { requestId: input.requestId, deviceId: row.device_id, credentialId: row.credential_id, accountId: input.accountId,
          permissions: [...(input.permissions || [])], certificateFingerprint: row.certificate_fingerprint || undefined,
          createdAt: now, expiresAt: input.credentialExpiresAt };
      });
    },
    denyPairingRequest(requestId, decidedAt = Date.now()) {
      return inTransaction(requireDatabase(), () => {
        const result = requireDatabase().prepare(`UPDATE pairing_requests SET state='denied',decided_at=?,
          credential_ciphertext=NULL,credential_iv=NULL,credential_tag=NULL WHERE id=? AND state='pending' AND expires_at>?`)
          .run(decidedAt, requestId, decidedAt);
        if (result.changes !== 1) throw codedError('pairing_request_not_pending', 'Pairing request is unavailable or already decided.');
        return true;
      });
    },
    consumePairingRequest(requestId, requestSecretHash, consumedAt = Date.now()) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        const row = active.prepare('SELECT * FROM pairing_requests WHERE id=? AND request_secret_hash=?').get(requestId, requestSecretHash);
        if (!row) return null;
        if (row.expires_at <= consumedAt && (row.state === 'pending' || row.state === 'approved')) {
          if (row.state === 'approved') active.prepare('DELETE FROM devices WHERE id=?').run(row.device_id);
          active.prepare("UPDATE pairing_requests SET state='expired',credential_ciphertext=NULL,credential_iv=NULL,credential_tag=NULL WHERE id=?").run(requestId);
          return { state: 'expired', expiresAt: Number(row.expires_at) };
        }
        if (row.state === 'pending') return { state: 'pending', expiresAt: Number(row.expires_at) };
        if (row.state === 'approved') {
          const claimed = active.prepare(`UPDATE pairing_requests SET state='consumed',consumed_at=?,
            credential_ciphertext=NULL,credential_iv=NULL,credential_tag=NULL WHERE id=? AND state='approved'`)
            .run(consumedAt, requestId);
          if (claimed.changes !== 1) return null;
          return { state: 'approved', deviceId: row.device_id, credentialId: row.credential_id,
            accountId: row.account_id, permissions: parseRequiredJson(row.approved_permissions_json, 'pairing approved permissions'),
            certificateFingerprint: row.certificate_fingerprint || undefined,
            encryptedSecret: { ciphertext: row.credential_ciphertext, iv: row.credential_iv, tag: row.credential_tag } };
        }
        if (row.state === 'denied') {
          active.prepare("UPDATE pairing_requests SET state='consumed',consumed_at=? WHERE id=? AND state='denied'").run(consumedAt, requestId);
          return { state: 'denied' };
        }
        return null;
      });
    },
    listDevices(accountId = undefined) {
      const rows = accountId
        ? requireDatabase().prepare('SELECT * FROM devices WHERE account_id=? ORDER BY created_at').all(accountId)
        : requireDatabase().prepare('SELECT * FROM devices ORDER BY created_at').all();
      return rows.map((row) => ({
        id: row.id, accountId: row.account_id, name: row.name, kind: row.kind,
        permissions: parseRequiredJson(row.permissions_json, 'device permissions'), disabled: row.disabled === 1,
        certificateFingerprint: row.certificate_fingerprint || undefined,
        createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        ...(row.last_seen_at === null ? {} : { lastSeenAt: Number(row.last_seen_at) }),
        ...(row.revoked_at === null ? {} : { revokedAt: Number(row.revoked_at), revokedReason: row.revoked_reason }),
      }));
    },
    readDeviceCredential(credentialId) {
      const row = requireDatabase().prepare(`SELECT c.*,d.account_id,d.name,d.kind,d.permissions_json,d.disabled,d.revoked_at
        FROM device_credentials c JOIN devices d ON d.id=c.device_id WHERE c.id=?`).get(credentialId);
      if (!row) return null;
      return { id: row.id, deviceId: row.device_id, accountId: row.account_id, name: row.name, kind: row.kind,
        permissions: parseRequiredJson(row.permissions_json, 'device credential permissions'), secretHash: row.secret_hash, algorithm: row.algorithm,
        disabled: row.disabled === 1, revokedAt: row.revoked_at === null ? undefined : Number(row.revoked_at),
        createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) };
    },
    readDeviceCredentialForDevice(deviceId) {
      const row = requireDatabase().prepare(`SELECT c.id FROM device_credentials c JOIN devices d ON d.id=c.device_id
        WHERE c.device_id=? AND d.disabled=0 AND d.revoked_at IS NULL`).get(deviceId);
      return row ? this.readDeviceCredential(row.id) : null;
    },
    resolveBoundDevice(accountId, deviceId) {
      const row = requireDatabase().prepare(`SELECT id FROM devices WHERE id=? AND account_id=? AND disabled=0
        AND revoked_at IS NULL`).get(deviceId, accountId);
      return row?.id || null;
    },
    touchDevice(deviceId, seenAt = Date.now()) {
      return requireDatabase().prepare(`UPDATE devices SET last_seen_at=?,updated_at=? WHERE id=? AND disabled=0 AND revoked_at IS NULL`)
        .run(seenAt, seenAt, deviceId).changes === 1;
    },
    revokeDevice(deviceId, reason = 'device_revoked', revokedAt = Date.now()) {
      return inTransaction(requireDatabase(), () => {
        const active = requireDatabase();
        const row = active.prepare('SELECT id,account_id,disabled FROM devices WHERE id=?').get(deviceId);
        if (!row) return null;
        active.prepare('UPDATE devices SET disabled=1,revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,?),updated_at=? WHERE id=?')
          .run(revokedAt, String(reason).slice(0, 64), revokedAt, deviceId);
        active.prepare('DELETE FROM device_credentials WHERE device_id=?').run(deviceId);
        active.prepare(`UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,?)
          WHERE device_id=?`).run(revokedAt, String(reason).slice(0, 64), deviceId);
        active.prepare('DELETE FROM profile_selections WHERE device_id=?').run(deviceId);
        active.prepare(`UPDATE pairing_requests SET state='expired',credential_ciphertext=NULL,credential_iv=NULL,credential_tag=NULL
          WHERE device_id=? AND state IN ('pending','approved')`).run(deviceId);
        active.prepare(`UPDATE invitation_sessions SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,?)
          WHERE device_id=?`).run(revokedAt, String(reason).slice(0, 64), deviceId);
        active.prepare(`UPDATE offline_download_leases SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,?)
          WHERE device_id=?`).run(revokedAt, String(reason).slice(0, 64), deviceId);
        return { id: row.id, accountId: row.account_id, alreadyRevoked: row.disabled === 1 };
      });
    },
    readMediaSource(mediaId, sourceId = undefined) {
      const row = sourceId
        ? requireDatabase().prepare(`SELECT s.*,r.locator root_locator,r.state root_state FROM media_sources s
          LEFT JOIN library_roots r ON r.id=s.root_id WHERE s.media_id=? AND s.id=?`).get(mediaId, sourceId)
        : requireDatabase().prepare(`SELECT s.*,r.locator root_locator,r.state root_state FROM media_sources s
          LEFT JOIN library_roots r ON r.id=s.root_id WHERE s.media_id=?
          ORDER BY s.state='online' DESC,s.last_seen_at DESC,s.indexed_at DESC LIMIT 1`).get(mediaId);
      if (!row) return null;
      return {
        id: row.id, mediaId: row.media_id, rootId: row.root_id, rootPath: row.root_locator,
        relativePath: row.relative_path, path: row.locator, state: row.state,
        rootState: row.root_state, extension: row.file_extension,
        ...(row.size_bytes === null ? {} : { sizeBytes: Number(row.size_bytes) }),
        ...(row.modified_at_ms === null ? {} : { modifiedAtMs: Number(row.modified_at_ms) }),
        ...(row.probe_json ? { probe: parseRequiredJson(row.probe_json, 'media probe') } : {}),
      };
    },
    listMediaSources(mediaId) {
      return requireDatabase().prepare(`SELECT s.id,s.media_id,s.root_id,s.state,s.file_extension,s.size_bytes,s.modified_at_ms,
        s.indexed_at,s.last_seen_at FROM media_sources s WHERE s.media_id=?
        ORDER BY s.state='online' DESC,s.last_seen_at DESC,s.indexed_at DESC`).all(mediaId).map((row) => ({
        id: row.id, mediaId: row.media_id, rootId: row.root_id, state: row.state,
        extension: row.file_extension,
        ...(row.size_bytes === null ? {} : { sizeBytes: Number(row.size_bytes) }),
        ...(row.modified_at_ms === null ? {} : { modifiedAtMs: Number(row.modified_at_ms) }),
      }));
    },
    recordMediaProbe(mediaId, sourceId, probe) {
      const result = requireDatabase().prepare('UPDATE media_sources SET probe_json=? WHERE media_id=? AND id=?')
        .run(json(probe), mediaId, sourceId);
      return result.changes === 1;
    },
    replaceAdminState: (state) => inTransaction(requireDatabase(), () => replaceAdminState(requireDatabase(), state)),
    readClientState: () => readClientState(requireDatabase()),
    replaceClientState: (state) => inTransaction(requireDatabase(), () => replaceClientState(requireDatabase(), state)),
    replaceAllState: (state) => inTransaction(requireDatabase(), () => replaceAllState(requireDatabase(), state)),
    mutateClientState(mutation) {
      return inTransaction(requireDatabase(), () => {
        const state = readClientState(requireDatabase());
        const result = mutation(state);
        replaceClientState(requireDatabase(), state);
        return result;
      });
    },
    async stop() {
      if (!database) return;
      const active = database;
      database = null; marker = null; availability = { backup: null, report: null };
      active.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      active.close();
    },
  };
}

export async function createCanonicalImportStage({ dataDir, migrationId, sourceFingerprint, sourceCounts, reconciliation, state, backupPath, reportPath }) {
  if (!SAFE_MIGRATION_ID.test(String(migrationId || ''))) throw codedError('migration_id_invalid', 'Migration id must use 1 to 96 safe filename characters.');
  const resolvedDir = path.resolve(dataDir);
  await fs.mkdir(resolvedDir, { recursive: true });
  const canonicalPath = path.join(resolvedDir, CANONICAL_STATE_FILENAME);
  const [backup, report] = await Promise.all([digestPath(backupPath), digestPath(reportPath)]);
  const stagedPath = path.join(resolvedDir, `.${CANONICAL_STATE_FILENAME}.${migrationId}.stage`);
  if (await fs.access(canonicalPath).then(() => true, () => false)) {
    const current = new DatabaseSync(canonicalPath, { readOnly: true });
    try {
      const marker = verifyOpenDatabase(current);
      const counts = targetCounts(current);
      const same = marker.id === migrationId && marker.sourceFingerprint === sourceFingerprint
        && json(marker.sourceCounts) === json(sourceCounts || {})
        && json(marker.reconciliation) === json(reconciliation || {})
        && marker.backupSha256 === backup.sha256 && marker.backupSizeBytes === backup.sizeBytes
        && marker.reportSha256 === report.sha256 && marker.reportSizeBytes === report.sizeBytes
        && json(marker.targetCounts) === json(counts);
      if (!same) throw codedError('canonical_cutover_conflict', 'A different canonical cutover is already committed.');
      validateReconciliation(marker.sourceCounts, marker.reconciliation, counts);
      return { migrationId, stagedPath, canonicalPath, recovered: true, alreadyCommitted: true };
    } finally { current.close(); }
  }
  const existed = await fs.access(stagedPath).then(() => true, () => false);
  if (existed) {
    const staged = new DatabaseSync(stagedPath, { readOnly: true });
    try {
      const marker = verifyOpenDatabase(staged);
      const same = marker.id === migrationId && marker.sourceFingerprint === sourceFingerprint
        && json(marker.sourceCounts) === json(sourceCounts || {})
        && json(marker.reconciliation) === json(reconciliation || {})
        && marker.backupSha256 === backup.sha256 && marker.backupSizeBytes === backup.sizeBytes
        && marker.reportSha256 === report.sha256 && marker.reportSizeBytes === report.sizeBytes;
      if (!same) throw codedError('canonical_stage_conflict', 'The existing migration stage does not match this import plan.');
      const counts = targetCounts(staged);
      validateReconciliation(marker.sourceCounts, marker.reconciliation, counts);
      if (json(marker.targetCounts) !== json(counts)) throw codedError('canonical_stage_conflict', 'The existing stage target counts do not match its committed marker.');
      return { migrationId, stagedPath, canonicalPath, recovered: true };
    } finally { staged.close(); }
  }
  const database = new DatabaseSync(stagedPath);
  try {
    initializeSchema(database);
    const createdAt = Date.now();
    database.prepare(`INSERT INTO migration_markers(
      id,format,schema_version,source_fingerprint,state,backup_path,backup_sha256,backup_size_bytes,
      report_path,report_sha256,report_size_bytes,source_counts_json,reconciliation_json,target_counts_json,created_at,committed_at
    ) VALUES(?,?,?,?,'prepared',?,?,?,?,?,?,?,?,'{}',?,NULL)`).run(
      migrationId, CANONICAL_MIGRATION_FORMAT, CANONICAL_SCHEMA_VERSION, sourceFingerprint,
      backup.path, backup.sha256, backup.sizeBytes, report.path, report.sha256, report.sizeBytes,
      json(sourceCounts || {}), json(reconciliation || {}), createdAt,
    );
    inTransaction(database, () => replaceAllState(database, state));
    const counts = targetCounts(database);
    validateReconciliation(sourceCounts, reconciliation, counts);
    if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || database.prepare('PRAGMA foreign_key_check').all().length) {
      throw codedError('canonical_import_invalid', 'Canonical import failed database verification.');
    }
    database.prepare("UPDATE migration_markers SET state='committed',target_counts_json=?,committed_at=? WHERE id=? AND state='prepared'")
      .run(json(counts), Date.now(), migrationId);
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    database.close();
    await fs.rm(stagedPath, { force: true }).catch(() => undefined);
    throw error;
  }
  database.close();
  const handle = await fs.open(stagedPath, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return { migrationId, stagedPath, canonicalPath, recovered: false };
}

export async function finalizeCanonicalImport({ dataDir, migrationId, stagedPath }) {
  if (!SAFE_MIGRATION_ID.test(String(migrationId || ''))) throw codedError('migration_id_invalid', 'Migration id must use 1 to 96 safe filename characters.');
  const resolvedDir = path.resolve(dataDir);
  const canonicalPath = path.join(resolvedDir, CANONICAL_STATE_FILENAME);
  const resolvedStage = path.resolve(stagedPath);
  if (path.dirname(resolvedStage) !== resolvedDir || path.basename(resolvedStage) !== `.${CANONICAL_STATE_FILENAME}.${migrationId}.stage`) {
    throw codedError('canonical_stage_invalid', 'The staged canonical database path is invalid.');
  }
  if (await fs.access(canonicalPath).then(() => true, () => false)) {
    const current = new DatabaseSync(canonicalPath, { readOnly: true });
    try {
      const marker = verifyOpenDatabase(current);
      if (marker.id !== migrationId) throw codedError('canonical_cutover_conflict', 'A different canonical cutover is already committed.');
      return { committed: true, recovered: true, marker: redactedMarker(marker, await evidenceAvailability(marker)) };
    } finally { current.close(); }
  }
  const staged = new DatabaseSync(resolvedStage, { readOnly: true });
  try {
    const marker = verifyOpenDatabase(staged);
    if (marker.id !== migrationId) throw codedError('canonical_stage_invalid', 'The staged database has the wrong migration marker.');
  } finally { staged.close(); }
  await fs.rename(resolvedStage, canonicalPath);
  await syncDirectory(resolvedDir);
  const reopened = new DatabaseSync(canonicalPath, { readOnly: true });
  try {
    const marker = verifyOpenDatabase(reopened);
    return { committed: true, recovered: false, marker: redactedMarker(marker, await evidenceAvailability(marker)) };
  } finally { reopened.close(); }
}
