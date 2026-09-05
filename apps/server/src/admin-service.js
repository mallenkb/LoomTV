import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createHeadlessLibraryScanner } from './library-scanner.js';
import { normalizeIpAddress } from './trusted-proxy.js';
import {
  CANONICAL_BACKUP_ENVELOPE_FORMAT,
  CANONICAL_BACKUP_ENVELOPE_VERSION,
} from '@loom-media-server/video-contracts/server';
import {
  containedRelativePath,
  isPathWithin,
  statContainedFile,
} from './media-path-guard.js';
import {
  AUTH_PERMISSIONS,
  USER_ROLES,
  canAccessRoot,
  canResetCredentials,
  hasPermission,
  isLocalNetworkAddress,
  isOwnerPrincipal,
  MAX_DEVICE_IDS,
  MAX_DEVICE_ID_LENGTH,
  normalizeRootIds,
  normalizeDeviceIds,
  permissionsForRole,
  principalView,
  userView,
} from './auth-policy.js';

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 64;
const ADMIN_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_LOGS = 250;
const MAX_ROOTS = 128;
const MAX_USERS = 128;
const MAX_SESSIONS = 64;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_SHARED_ADDRESS_FAILURES = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const LOGIN_DELAY_MS = 250;
const STATE_FILENAME = 'headless-admin.json';
const STATE_VERSION = 1;
const LEGACY_BACKUP_FORMAT = 'loomtv-headless-backup';
const LEGACY_BACKUP_VERSION = 1;
const BACKUP_FORMAT = CANONICAL_BACKUP_ENVELOPE_FORMAT;
const BACKUP_VERSION = CANONICAL_BACKUP_ENVELOPE_VERSION;
const MAX_BACKUP_HISTORY = 24;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STORAGE_PROBE_TIMEOUT_MS = 1_000;
const STORAGE_PROBE_PREFIX = '.loomtv-storage-probe-';

/**
 * @typedef {'writable' | 'missing' | 'not-directory' | 'permission-denied' | 'read-only' | 'write-failed' | 'cleanup-failed' | 'probe-timeout' | 'unavailable'} StorageHealthState
 * @typedef {{
 *   path: string,
 *   available: boolean,
 *   writable: boolean,
 *   state: StorageHealthState,
 *   totalBytes?: number,
 *   freeBytes?: number,
 * }} StorageHealthStatus
 */

function storageStateForError(error, fallback) {
  if (error?.storageState) return error.storageState;
  switch (error?.code) {
    case 'ENOENT': return 'missing';
    case 'ENOTDIR': return 'not-directory';
    case 'EACCES':
    case 'EPERM': return 'permission-denied';
    case 'EROFS': return 'read-only';
    case 'ETIMEDOUT': return 'probe-timeout';
    default: return fallback;
  }
}

function storageProbeTimeoutError() {
  return Object.assign(new Error('Persistent storage health probe timed out.'), {
    code: 'ETIMEDOUT',
    storageState: 'probe-timeout',
  });
}

function createStorageDeadline(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return async function withinStorageDeadline(operation) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw storageProbeTimeoutError();
    let timeout;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(storageProbeTimeoutError()), remainingMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function removeStorageProbe(fileSystem, probePath) {
  try {
    await fileSystem.rm(probePath, { force: true });
  } catch (rmError) {
    try {
      await fileSystem.unlink(probePath);
    } catch (unlinkError) {
      if (unlinkError?.code === 'ENOENT') return;
      throw Object.assign(new Error('Persistent storage probe file could not be removed.'), {
        storageState: 'cleanup-failed',
        cause: unlinkError,
        rmCause: rmError,
      });
    }
  }
}

async function atomicStorageWriteProbe(_targetPath, { fileSystem, probePath }) {
  let handle;
  let operationError;
  try {
    handle = await fileSystem.open(probePath, 'wx', 0o600);
    await handle.writeFile('loomtv-storage-health\n', 'utf8');
    await handle.sync();
  } catch (error) {
    operationError = error;
  }

  if (!handle) throw operationError;

  try {
    await handle.close();
  } catch (error) {
    operationError ||= error;
  }

  // Cleanup is attempted after every successful exclusive create, including
  // write, fsync, and close failures. A failed rm gets an unlink fallback.
  await removeStorageProbe(fileSystem, probePath);
  if (operationError) throw operationError;
}

function storageCapacity(stats) {
  const blockSize = Number(stats?.bsize);
  const blocks = Number(stats?.blocks);
  const availableBlocks = Number(stats?.bavail);
  const totalBytes = blocks * blockSize;
  const freeBytes = availableBlocks * blockSize;
  return {
    ...(Number.isFinite(totalBytes) && totalBytes >= 0 ? { totalBytes } : {}),
    ...(Number.isFinite(freeBytes) && freeBytes >= 0 ? { freeBytes } : {}),
  };
}

function storageCheckMessage(storage) {
  if (storage.writable) {
    return `${storage.freeBytes == null ? 'Available' : `${Math.round(storage.freeBytes / 1024 / 1024)} MB free`}.`;
  }
  switch (storage.state) {
    case 'missing': return 'Data directory is missing.';
    case 'not-directory': return 'Configured data path is not a directory.';
    case 'permission-denied': return 'Data directory is available, but write permission was denied.';
    case 'read-only': return 'Data directory is available on a read-only filesystem.';
    case 'cleanup-failed': return 'Data directory write probe could not clean up its temporary file.';
    case 'probe-timeout': return 'Data directory write probe timed out.';
    case 'write-failed': return 'Data directory did not accept a verified write.';
    default: return 'Data directory is unavailable.';
  }
}

function invalidInput(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_request' });
}

function permissionsInput(value, role, fallback) {
  if (value === undefined) return fallback === undefined ? permissionsForRole(role) : fallback;
  if (!Array.isArray(value)) throw invalidInput('permissions must be an array.');
  if (value.length > AUTH_PERMISSIONS.length) throw invalidInput('permissions contains too many entries.');
  const invalid = value.find((permission) => typeof permission !== 'string' || !AUTH_PERMISSIONS.includes(permission));
  if (invalid !== undefined) throw invalidInput('permissions contains an unknown permission.');
  return permissionsForRole(role, value);
}

function rootIdsInput(value, preserveUndefined = false) {
  if (value === undefined && preserveUndefined) return undefined;
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    throw invalidInput('rootIds must be an array or null.');
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ROOTS || value.some((rootId) => typeof rootId !== 'string' || !rootId.trim() || rootId.trim().length > 128)) {
      throw invalidInput('rootIds contains an invalid entry.');
    }
  }
  return normalizeRootIds(value);
}

function deviceIdsInput(value, preserveUndefined = false) {
  if (value === undefined && preserveUndefined) return undefined;
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    throw invalidInput('deviceIds must be an array or null.');
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DEVICE_IDS || value.some((deviceId) => (
      typeof deviceId !== 'string' || !deviceId.trim() || deviceId.trim().length > MAX_DEVICE_ID_LENGTH
    ))) {
      throw invalidInput('deviceIds contains an invalid entry.');
    }
  }
  const normalized = normalizeDeviceIds(value);
  return Array.isArray(normalized) && normalized.length === 0 ? null : normalized;
}

function maxSessionsInput(value, preserveUndefined = false) {
  if (value === undefined && preserveUndefined) return undefined;
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw invalidInput('maxSessions must be an integer between 1 and 32, or null.');
  }
  return value;
}

function backupError(message) {
  return Object.assign(new Error(message), { status: 422, code: 'invalid_backup' });
}

function stableChecksum(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function backupDataFromState(state, clientState) {
  return {
    stateVersion: STATE_VERSION,
    owner: state.owner,
    users: state.users,
    roots: state.roots,
    catalog: state.catalog,
    scan: state.scan,
    logs: state.logs,
    profiles: state.profiles,
    watchState: state.watchState,
    // The hosted client's profiles/progress live in a separate adapter so
    // desktop and headless stores cannot overwrite one another. Keep that
    // adapter in the same backup envelope so a restore is complete.
    clientState: clientState && typeof clientState === 'object' ? clientState : undefined,
  };
}

function legacyBackupEnvelopeFromState(state, sourceVersion, clientState) {
  const data = backupDataFromState(state, clientState);
  return {
    format: LEGACY_BACKUP_FORMAT,
    version: LEGACY_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    source: { version: sourceVersion || '0.0.0', stateVersion: STATE_VERSION },
    checksum: stableChecksum(data),
    data,
  };
}

function canonicalBackupEnvelope(snapshot, sourceVersion) {
  const data = snapshot;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    source: { version: sourceVersion || '0.0.0', stateVersion: STATE_VERSION,
      canonicalSchemaVersion: snapshot.schemaVersion },
    checksum: stableChecksum(data),
    data,
  };
}

function normalizeBackupHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.kind === 'string')
    .map((entry) => ({
      kind: entry.kind === 'restore' ? 'restore' : 'backup',
      createdAt: Number(entry.createdAt) || Date.now(),
      destination: typeof entry.destination === 'string' ? entry.destination.slice(0, 4_096) : undefined,
      checksum: typeof entry.checksum === 'string' ? entry.checksum.slice(0, 128) : undefined,
      formatVersion: Number(entry.formatVersion) || BACKUP_VERSION,
      sizeBytes: Number.isFinite(entry.sizeBytes) ? Number(entry.sizeBytes) : undefined,
      source: typeof entry.source === 'string' ? entry.source.slice(0, 4_096) : undefined,
      status: typeof entry.status === 'string' ? entry.status.slice(0, 32) : undefined,
    }))
    .slice(0, MAX_BACKUP_HISTORY);
}

function normalizeBackupStatus(value) {
  const status = value && typeof value === 'object' ? value : {};
  return {
    state: ['never', 'running', 'completed', 'failed', 'restored'].includes(status.state) ? status.state : 'never',
    lastBackupAt: Number.isFinite(status.lastBackupAt) ? Number(status.lastBackupAt) : undefined,
    lastRestoreAt: Number.isFinite(status.lastRestoreAt) ? Number(status.lastRestoreAt) : undefined,
    destination: typeof status.destination === 'string' ? status.destination.slice(0, 4_096) : undefined,
    sizeBytes: Number.isFinite(status.sizeBytes) ? Number(status.sizeBytes) : undefined,
    checksum: typeof status.checksum === 'string' ? status.checksum.slice(0, 128) : undefined,
    formatVersion: Number(status.formatVersion) || undefined,
    restoredFrom: typeof status.restoredFrom === 'string' ? status.restoredFrom.slice(0, 4_096) : undefined,
    rollbackDestination: typeof status.rollbackDestination === 'string' ? status.rollbackDestination.slice(0, 4_096) : undefined,
    error: typeof status.error === 'string' ? status.error.slice(0, 500) : undefined,
    history: normalizeBackupHistory(status.history),
  };
}

function validateBackupEnvelope(value, { requireCanonical = false } = {}) {
  if (requireCanonical && value?.format !== BACKUP_FORMAT) {
    throw backupError('Legacy partial-state backups cannot replace the canonical store. Import them through the migration workflow.');
  }
  // Backups created before the checksummed envelope were raw admin-state JSON
  // files. Accept them as a one-time migration so an upgrade cannot strand a
  // NAS owner with an otherwise valid recovery point.
  if (value && typeof value === 'object' && !value.format && value.owner && Array.isArray(value.roots)) {
    const data = backupDataFromState(value, undefined);
    return {
      format: LEGACY_BACKUP_FORMAT,
      version: LEGACY_BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      source: { version: 'legacy', stateVersion: STATE_VERSION },
      checksum: stableChecksum(data),
      data,
      legacy: true,
    };
  }
  if (!value || typeof value !== 'object'
    || ![BACKUP_FORMAT, LEGACY_BACKUP_FORMAT].includes(value.format)) {
    throw backupError('The selected file is not a LoomTV backup.');
  }
  const expectedVersion = value.format === BACKUP_FORMAT ? BACKUP_VERSION : LEGACY_BACKUP_VERSION;
  if (value.version !== expectedVersion || !value.data || typeof value.data !== 'object') {
    throw backupError('This LoomTV backup format is not supported by this server.');
  }
  if (typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(value.checksum)) {
    throw backupError('The backup checksum is missing or malformed.');
  }
  const checksum = stableChecksum(value.data);
  const expected = Buffer.from(value.checksum, 'hex');
  const actual = Buffer.from(checksum, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw backupError('The backup checksum does not match its contents.');
  }
  if (value.format === LEGACY_BACKUP_FORMAT && (!value.data.owner || typeof value.data.owner !== 'object')) {
    throw backupError('The backup does not contain an owner account.');
  }
  return value;
}

function hashToken(value) {
  return createHash('sha256').update(value).digest('hex');
}

function timingSafeStringEqual(left, right) {
  const expected = Buffer.from(String(left || ''), 'utf8');
  const actual = Buffer.from(String(right || ''), 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function requestAddress(value) {
  return normalizeIpAddress(value) || 'unknown';
}

function authAttemptKey(kind, value) {
  return hashToken(`${kind}:${normalizedIdentity(value)}`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function loginThrottleDelayMs(addressFailures) {
  const failures = Number.isFinite(Number(addressFailures)) ? Math.max(0, Math.floor(Number(addressFailures))) : 0;
  const bucket = Math.min(3, Math.floor(failures / MAX_LOGIN_ATTEMPTS));
  return LOGIN_DELAY_MS * (2 ** bucket);
}

function publicOwnerPrincipal(owner) {
  return owner ? {
    id: owner.id,
    name: owner.name,
    type: 'owner',
    role: 'owner',
    permissions: ['*'],
    rootIds: null,
    deviceIds: null,
    maxSessions: null,
  } : null;
}

function publicUserPrincipal(user) {
  return user ? {
    id: user.id,
    name: user.name,
    type: 'user',
    role: user.role,
    permissions: user.permissions,
    rootIds: user.rootIds,
    deviceIds: user.deviceIds,
    maxSessions: user.maxSessions,
  } : null;
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const value = await scrypt(password, salt, PASSWORD_BYTES);
  return { salt, hash: Buffer.from(value).toString('base64') };
}

async function verifyPassword(password, salt, expectedHash) {
  const value = await scrypt(password, salt, PASSWORD_BYTES);
  const actual = Buffer.from(value);
  const expected = Buffer.from(expectedHash, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function rootIdFor(rootPath) {
  return createHash('sha256').update(path.resolve(rootPath)).digest('hex').slice(0, 24);
}

function isNetworkLikePath(rootPath) {
  const normalized = rootPath.replaceAll('\\', '/');
  return normalized.startsWith('/Volumes/')
    || normalized.startsWith('/Network/')
    || normalized.startsWith('/mnt/')
    || normalized.startsWith('/media/')
    || /^\/\/[^/]+\/[^/]+/.test(normalized);
}

function defaultState() {
  return {
    owner: null,
    users: [],
    sessions: [],
    loginAttempts: [],
    roots: [],
    catalog: [],
    profiles: [],
    watchState: {},
    scan: { state: 'idle' },
    backup: normalizeBackupStatus({ state: 'never' }),
    logs: [],
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();
  const state = defaultState();
  if (raw.owner && typeof raw.owner === 'object'
    && typeof raw.owner.id === 'string'
    && typeof raw.owner.name === 'string'
    && typeof raw.owner.salt === 'string'
    && typeof raw.owner.hash === 'string') {
    state.owner = {
      id: raw.owner.id.slice(0, 100),
      name: raw.owner.name.slice(0, 80),
      salt: raw.owner.salt,
      hash: raw.owner.hash,
    };
  }
  if (Array.isArray(raw.users)) {
    state.users = raw.users
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string'
        && typeof entry.salt === 'string' && typeof entry.hash === 'string')
      .map((entry) => ({
        id: entry.id.slice(0, 100),
        name: entry.name.trim().slice(0, 80),
        salt: entry.salt,
        hash: entry.hash,
        role: USER_ROLES.includes(entry.role) ? entry.role : 'viewer',
        permissions: permissionsForRole(entry.role, entry.permissions),
        rootIds: normalizeRootIds(entry.rootIds),
        deviceIds: normalizeDeviceIds(entry.deviceIds),
        maxSessions: Number.isSafeInteger(entry.maxSessions) && entry.maxSessions >= 1 && entry.maxSessions <= 32
          ? entry.maxSessions
          : null,
        disabled: entry.disabled === true,
        createdAt: Number(entry.createdAt) || Date.now(),
        updatedAt: Number(entry.updatedAt) || Number(entry.createdAt) || Date.now(),
      }))
      .slice(0, MAX_USERS);
  }
  if (Array.isArray(raw.sessions)) {
    state.sessions = raw.sessions
      .filter((entry) => entry && typeof entry.tokenHash === 'string' && Number.isFinite(entry.expiresAt))
      .map((entry) => ({
        id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 128) : randomUUID(),
        tokenHash: entry.tokenHash,
        userId: typeof entry.userId === 'string' ? entry.userId.slice(0, 100) : state.owner?.id,
        deviceId: typeof entry.deviceId === 'string' && entry.deviceId.trim()
          ? entry.deviceId.trim().slice(0, MAX_DEVICE_ID_LENGTH)
          : null,
        createdAt: Number(entry.createdAt) || Date.now(),
        lastSeenAt: Number(entry.lastSeenAt) || Number(entry.createdAt) || Date.now(),
        idleExpiresAt: Number(entry.idleExpiresAt) || Number(entry.expiresAt),
        absoluteExpiresAt: Number(entry.absoluteExpiresAt) || Number(entry.expiresAt),
        expiresAt: Number(entry.expiresAt),
        ...(Number.isFinite(entry.revokedAt) ? {
          revokedAt: Number(entry.revokedAt),
          revokedReason: String(entry.revokedReason || 'revoked').slice(0, 64),
        } : {}),
      }))
      .slice(-MAX_SESSIONS);
  }
  if (Array.isArray(raw.loginAttempts)) {
    state.loginAttempts = raw.loginAttempts
      .filter((entry) => entry && typeof entry.key === 'string' && Number.isFinite(entry.lastAttemptAt))
      .map((entry) => ({
        key: entry.key.slice(0, 128),
        failures: Math.max(0, Math.min(MAX_SHARED_ADDRESS_FAILURES, Number(entry.failures) || 0)),
        firstAttemptAt: Number(entry.firstAttemptAt) || Number(entry.lastAttemptAt),
        lastAttemptAt: Number(entry.lastAttemptAt),
        lockedUntil: Number(entry.lockedUntil) || 0,
      }))
      .slice(-256);
  }
  if (Array.isArray(raw.roots)) {
    state.roots = raw.roots
      .filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim())
      .map((entry) => {
        const rootPath = path.resolve(entry.path);
        return {
          id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 100) : rootIdFor(rootPath),
          path: rootPath,
          kind: ['movies', 'tvShows', 'anime', 'others'].includes(entry.kind) ? entry.kind : 'others',
          createdAt: Number(entry.createdAt) || Date.now(),
          lastScanAt: Number.isFinite(entry.lastScanAt) ? Number(entry.lastScanAt) : undefined,
        };
      })
      .slice(0, MAX_ROOTS);
  }
  if (Array.isArray(raw.catalog)) {
    state.catalog = raw.catalog
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.rootId === 'string' && typeof entry.path === 'string')
      .map((entry) => ({
        id: entry.id.slice(0, 128),
        rootId: entry.rootId.slice(0, 128),
        path: path.resolve(entry.path),
        relativePath: typeof entry.relativePath === 'string' ? entry.relativePath.slice(0, 4_096) : path.basename(entry.path),
        type: entry.type === 'tv' || ['series','episode'].includes(entry.kind) ? 'tv' : 'movie',
        title: typeof entry.title === 'string' ? entry.title.slice(0, 500) : path.basename(entry.path),
        kind: ['movie','series','episode','video'].includes(entry.kind) ? entry.kind : 'movie',
        ...(Number.isSafeInteger(entry.year) && entry.year > 1900 && entry.year < 2200 ? { year: entry.year } : {}),
        ...(entry.animeLikely === true ? { animeLikely: true } : {}),
        ...(typeof entry.seriesId === 'string' && entry.seriesId.length <= 128 ? { seriesId: entry.seriesId } : {}),
        ...(Number.isSafeInteger(entry.seasonNumber) && entry.seasonNumber >= 0 ? { seasonNumber: entry.seasonNumber } : {}),
        ...(Number.isSafeInteger(entry.episodeNumber) && entry.episodeNumber >= 0 ? { episodeNumber: entry.episodeNumber } : {}),
        ...(entry.series && typeof entry.series === 'object' && typeof entry.series.title === 'string'
          ? {
            series: {
              title: entry.series.title.slice(0, 500),
              season: Number.isSafeInteger(entry.series.season) && entry.series.season >= 0 ? entry.series.season : 1,
              episode: Number.isSafeInteger(entry.series.episode) && entry.series.episode >= 0 ? entry.series.episode : null,
            },
          }
          : {}),
        extension: typeof entry.extension === 'string' ? entry.extension.slice(0, 16) : path.extname(entry.path).slice(1).toLowerCase(),
        sizeBytes: Number.isFinite(entry.sizeBytes) ? Number(entry.sizeBytes) : undefined,
        modifiedAtMs: Number.isFinite(entry.modifiedAtMs) ? Number(entry.modifiedAtMs) : undefined,
        ...(entry.localMetadata && typeof entry.localMetadata === 'object' && !Array.isArray(entry.localMetadata)
          ? { localMetadata: entry.localMetadata }
          : {}),
        ...(entry.contentRatings && typeof entry.contentRatings === 'object' && !Array.isArray(entry.contentRatings)
          ? {
            contentRatings: Object.fromEntries(Object.entries(entry.contentRatings).slice(0, 64).flatMap(([country, rating]) => (
              /^[A-Za-z]{2,3}$/.test(country) && rating && Number.isFinite(rating.minimumAge)
                ? [[country.toUpperCase(), { ...rating, minimumAge: Math.max(0, Math.min(21, Number(rating.minimumAge))) }]]
                : []
            ))),
          }
          : {}),
        ...(typeof entry.summary === 'string' ? { summary: entry.summary.slice(0, 20_000) } : {}),
        ...(Number.isFinite(entry.rating) ? { rating: Number(entry.rating) } : {}),
        ...(Array.isArray(entry.genres) ? { genres: entry.genres
          .filter((genre) => typeof genre === 'string' && genre.length <= 128).slice(0, 128) } : {}),
        ...(entry.providerIds && typeof entry.providerIds === 'object' && !Array.isArray(entry.providerIds)
          ? { providerIds: Object.fromEntries(Object.entries(entry.providerIds).slice(0, 64).flatMap(([provider, value]) => (
            typeof value === 'string' && provider.length <= 64 && value.length <= 256 ? [[provider, value]] : []
          ))) } : {}),
        ...(Array.isArray(entry.subtitleSidecars) ? { subtitleSidecars: entry.subtitleSidecars.slice(0, 64).flatMap((sidecar) => {
          if (!sidecar || typeof sidecar !== 'object' || typeof sidecar.id !== 'string' || !sidecar.id.startsWith('sidecar:')
            || typeof sidecar.path !== 'string' || !['srt','vtt','ass','ssa'].includes(sidecar.format)) return [];
          return [{
            id: sidecar.id.slice(0, 128), path: path.resolve(sidecar.path),
            relativeName: typeof sidecar.relativeName === 'string' ? sidecar.relativeName.slice(0, 500) : path.basename(sidecar.path),
            format: sidecar.format, codec: typeof sidecar.codec === 'string' ? sidecar.codec.slice(0, 32) : sidecar.format,
            ...(typeof sidecar.language === 'string' ? { language: sidecar.language.slice(0, 32) } : {}),
            ...(typeof sidecar.title === 'string' ? { title: sidecar.title.slice(0, 200) } : {}),
            forced: sidecar.forced === true, default: sidecar.default === true, origin: 'local',
            ...(Number.isFinite(sidecar.sizeBytes) ? { sizeBytes: Number(sidecar.sizeBytes) } : {}),
            ...(Number.isFinite(sidecar.modifiedAtMs) ? { modifiedAtMs: Number(sidecar.modifiedAtMs) } : {}),
          }];
        }) } : {}),
        legacyIds: Array.isArray(entry.legacyIds) ? entry.legacyIds
          .filter((legacyId) => typeof legacyId === 'string' && legacyId.length <= 512).slice(0, 512) : [],
        available: entry.available !== false,
        indexedAt: Number(entry.indexedAt) || Date.now(),
        createdAt: Number(entry.createdAt) || Number(entry.indexedAt) || Date.now(),
        updatedAt: Number(entry.updatedAt) || Number(entry.indexedAt) || Date.now(),
      }));
  }
  if (Array.isArray(raw.profiles)) state.profiles = raw.profiles.slice(0, 4_096);
  if (raw.watchState && typeof raw.watchState === 'object' && !Array.isArray(raw.watchState)) {
    try {
      const serialized = JSON.stringify(raw.watchState);
      if (serialized.length <= 8 * 1024 * 1024) state.watchState = JSON.parse(serialized);
    } catch {
      state.watchState = {};
    }
  }
  if (raw.scan && typeof raw.scan === 'object') state.scan = { ...state.scan, ...raw.scan };
  if (state.scan.state === 'scanning') {
    state.scan = {
      ...state.scan,
      state: 'interrupted',
      interruptedAt: Date.now(),
      warning: 'The previous scan was interrupted before shutdown; the existing catalog was preserved.',
    };
  }
  state.backup = normalizeBackupStatus(raw.backup);
  if (Array.isArray(raw.logs)) {
    const cutoff = Date.now() - LOG_RETENTION_MS;
    state.logs = raw.logs
      .filter((entry) => entry && Number(entry.timestamp) > cutoff)
      .slice(0, MAX_LOGS);
  }
  return state;
}

export function createHeadlessAdminService(options) {
  if (!options.bootstrapSecurity) throw new Error('createHeadlessAdminService requires bootstrapSecurity.');
  const requireBootstrapSecret = options.requireBootstrapSecret !== false;
  const dataDir = path.resolve(options.dataDir);
  const statePath = path.join(dataDir, STATE_FILENAME);
  const mediaDir = options.mediaDir ? path.resolve(options.mediaDir) : null;
  const getRuntimeHealth = options.getRuntimeHealth || (async () => ({}));
  const getSessions = options.getSessions || (async () => []);
  const getClientState = options.getClientState || (async () => null);
  const replaceClientState = options.replaceClientState || (async () => undefined);
  const replaceAllState = typeof options.replaceAllState === 'function' ? options.replaceAllState : null;
  const stateStore = options.stateStore || null;
  const onCanonicalRestore = typeof options.onCanonicalRestore === 'function'
    ? options.onCanonicalRestore
    : null;
  const onPlaybackSessionsRevoked = typeof options.onPlaybackSessionsRevoked === 'function'
    ? options.onPlaybackSessionsRevoked
    : null;
  const onPlaybackSessionsRevokedForItem = typeof options.onPlaybackSessionsRevokedForItem === 'function'
    ? options.onPlaybackSessionsRevokedForItem
    : null;
  const onAuthenticationSessionRevoked = typeof options.onAuthenticationSessionRevoked === 'function'
    ? options.onAuthenticationSessionRevoked
    : null;
  const onAllPlaybackSessionsRevoked = typeof options.onAllPlaybackSessionsRevoked === 'function'
    ? options.onAllPlaybackSessionsRevoked
    : null;
  const loginDelay = options.loginDelay || wait;
  const storageFileSystem = options.storageFileSystem
    ? { ...fs, ...options.storageFileSystem }
    : fs;
  const storageWriteProbe = options.storageWriteProbe || atomicStorageWriteProbe;
  const storageProbeTimeoutMs = Number.isFinite(options.storageProbeTimeoutMs)
    ? Math.max(10, Math.min(10_000, Math.trunc(options.storageProbeTimeoutMs)))
    : STORAGE_PROBE_TIMEOUT_MS;
  const storageOperations = new Map();
  let statePromise;
  let writeQueue = Promise.resolve();
  let ownerCreationPromise = null;
  let backupPromise = null;

  async function notifyPlaybackSessionsRevoked(principalId, reason) {
    if (!onPlaybackSessionsRevoked || !principalId) return;
    try { await onPlaybackSessionsRevoked(principalId, reason); } catch { /* playback cleanup is best effort */ }
  }

  async function notifyPlaybackSessionsRevokedForItem(itemId, reason) {
    if (!onPlaybackSessionsRevokedForItem || !itemId) return;
    try { await onPlaybackSessionsRevokedForItem(itemId, reason); } catch { /* playback cleanup is best effort */ }
  }

  async function notifyAuthenticationSessionRevoked(sessionId, reason) {
    if (!onAuthenticationSessionRevoked || !sessionId) return;
    try { await onAuthenticationSessionRevoked(sessionId, reason); } catch { /* playback cleanup is best effort */ }
  }

  async function notifyAllPlaybackSessionsRevoked(reason, strict = false) {
    if (!onAllPlaybackSessionsRevoked) return;
    try { await onAllPlaybackSessionsRevoked(reason); } catch (error) {
      if (strict) throw error;
      // Non-restore administrative cleanup remains best effort.
    }
  }

  async function saveState(state) {
    writeQueue = writeQueue.catch(() => undefined).then(async () => {
      if (stateStore) {
        stateStore.replaceAdminState(state);
        return;
      }
      await fs.mkdir(dataDir, { recursive: true });
      const temporaryPath = `${statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, statePath);
    });
    return writeQueue;
  }

  async function saveBackupStatus(status) {
    if (stateStore?.updateBackupState) {
      stateStore.updateBackupState(status);
      return;
    }
    const state = await loadState();
    state.backup = status;
    await saveState(state);
  }

  async function writeBackupFile(destination, envelope) {
    const serialized = JSON.stringify(envelope, null, 2);
    if (Buffer.byteLength(serialized) > MAX_BACKUP_BYTES) throw backupError('The backup is larger than the supported limit.');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, destination);
      const directory = await fs.open(path.dirname(destination), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const stats = await fs.stat(destination);
    return { sizeBytes: stats.size, checksum: envelope.checksum };
  }

  function sharedStorageOperation(operationName, targetPath, operation) {
    const key = `${operationName}:${targetPath}`;
    const existing = storageOperations.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(operation);
    storageOperations.set(key, pending);
    const clear = () => {
      if (storageOperations.get(key) === pending) storageOperations.delete(key);
    };
    pending.then(clear, clear);
    return pending;
  }

  /** @returns {Promise<StorageHealthStatus>} */
  async function storageStatus(targetPath) {
    const withinDeadline = createStorageDeadline(storageProbeTimeoutMs);
    let stats;
    try {
      stats = await withinDeadline(() => sharedStorageOperation('stat', targetPath, () => storageFileSystem.stat(targetPath)));
    } catch (error) {
      return {
        path: targetPath,
        available: false,
        writable: false,
        state: storageStateForError(error, 'unavailable'),
      };
    }
    if (!stats.isDirectory()) {
      return { path: targetPath, available: false, writable: false, state: 'not-directory' };
    }

    const capacityPromise = withinDeadline(() => sharedStorageOperation('statfs', targetPath, () => storageFileSystem.statfs(targetPath)))
      .then(storageCapacity)
      .catch(() => ({}));
    try {
      await withinDeadline(() => sharedStorageOperation('access', targetPath, () => storageFileSystem.access(targetPath, fsConstants.W_OK)));
    } catch (error) {
      const state = storageStateForError(error, 'write-failed');
      return {
        path: targetPath,
        available: !['missing', 'not-directory'].includes(state),
        writable: false,
        state,
        ...await capacityPromise,
      };
    }

    const probePath = path.join(targetPath, `${STORAGE_PROBE_PREFIX}${process.pid}-${randomUUID()}.tmp`);
    try {
      await withinDeadline(() => sharedStorageOperation('write-probe', targetPath, () => storageWriteProbe(targetPath, {
        fileSystem: storageFileSystem,
        probePath,
      })));
    } catch (error) {
      const state = storageStateForError(error, 'write-failed');
      return {
        path: targetPath,
        available: !['missing', 'not-directory'].includes(state),
        writable: false,
        state,
        ...await capacityPromise,
      };
    }
    return {
      path: targetPath,
      available: true,
      writable: true,
      state: 'writable',
      ...await capacityPromise,
    };
  }

  function pruneLogs(state, now = Date.now()) {
    const before = state.logs.length;
    state.logs = state.logs
      .filter((entry) => Number(entry.timestamp) > now - LOG_RETENTION_MS)
      .slice(0, MAX_LOGS);
    return state.logs.length !== before;
  }

  async function loadState() {
    if (!statePromise) {
      statePromise = (stateStore
        ? Promise.resolve(normalizeState(stateStore.readAdminState()))
        : fs.readFile(statePath, 'utf8').then((contents) => normalizeState(JSON.parse(contents))))
        .catch(async (error) => {
          if (error?.code === 'ENOENT') {
            const state = defaultState();
            await saveState(state);
            return state;
          }
          throw Object.assign(new Error('Persistent admin state could not be loaded safely.'), {
            status: 503,
            code: 'state_unavailable',
            cause: error,
          });
        })
        .then((state) => state);
    }
    return statePromise;
  }

  async function appendLog(level, message, details) {
    const state = await loadState();
    state.logs.unshift({
      id: randomUUID(),
      timestamp: Date.now(),
      level,
      source: 'headless-server',
      message: String(message).slice(0, 500),
      ...(details ? { details } : {}),
    });
    pruneLogs(state);
    if (stateStore?.appendOperationalLog) stateStore.appendOperationalLog(state.logs[0]);
    else await saveState(state);
  }

  async function rootView(root) {
    try {
      const stats = await fs.stat(root.path);
      const readable = await fs.access(root.path).then(() => true).catch(() => false);
      return {
        ...root,
        state: stats.isDirectory() && readable ? 'online' : 'offline',
        isNetworkLike: isNetworkLikePath(root.path),
        message: stats.isDirectory() && readable ? 'Mounted folder is available.' : 'Path is not a readable directory.',
      };
    } catch (error) {
      return {
        ...root,
        state: error?.code === 'EACCES' ? 'degraded' : 'offline',
        isNetworkLike: isNetworkLikePath(root.path),
        message: error?.code === 'EACCES' ? 'Permission denied.' : 'Folder is unavailable; reconnect the share before scanning.',
      };
    }
  }

  const scanner = createHeadlessLibraryScanner({
    loadState,
    saveState,
    appendLog,
    probeMedia: typeof options.probeMedia === 'function' ? options.probeMedia : null,
  });

  function tokenFromRequest(req) {
    const header = req?.headers?.authorization || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    const token = req?.headers?.['x-loom-admin-token'];
    return typeof token === 'string' ? token.trim() : '';
  }

  function principalForUserId(state, userId) {
    if (!userId) return null;
    if (state.owner?.id === userId) return publicOwnerPrincipal(state.owner);
    const user = state.users.find((entry) => entry.id === userId && !entry.disabled);
    return publicUserPrincipal(user);
  }

  function principalCanManageUser(principal, user) {
    if (!principal || isOwnerPrincipal(principal) || principal.rootIds === null) return true;
    if (user.rootIds === null) return false;
    return user.rootIds.every((rootId) => principal.rootIds.includes(rootId));
  }

  function ensureUserScope(principal, user) {
    if (!principalCanManageUser(principal, user)) {
      throw permissionDenied('You cannot manage an account outside your library roots.');
    }
  }

  function permissionDenied(message = 'This account is not allowed to perform that action.') {
    return Object.assign(new Error(message), { status: 403, code: 'permission_denied' });
  }

  function ensurePrincipalPermission(principal, permission) {
    if (!hasPermission(principal, permission)) throw permissionDenied();
    return principal;
  }

  function userByName(state, name) {
    const identity = normalizedIdentity(name);
    if (!identity) return null;
    if (state.owner && (normalizedIdentity(state.owner.name) === identity || identity === 'owner')) {
      return { record: state.owner, principal: publicOwnerPrincipal(state.owner), type: 'owner' };
    }
    const user = state.users.find((entry) => normalizedIdentity(entry.name) === identity);
    return user ? { record: user, principal: publicUserPrincipal(user), type: 'user' } : null;
  }

  function loginKeys(identity, address, match) {
    const submittedIdentity = identity || 'owner';
    const canonicalIdentity = match?.record?.id
      ? authAttemptKey('identity', `account:${match.record.id}`)
      : authAttemptKey('identity', `name:${submittedIdentity}`);
    const legacyNames = match?.type === 'owner'
      ? ['owner', submittedIdentity, String(match.record.name || '').trim()]
      : [submittedIdentity];
    return {
      // The owner can sign in as either `owner` or their chosen display name.
      // Bucket a resolved account by its immutable ID so aliases cannot double
      // the number of password guesses before the per-identity lock engages.
      identity: canonicalIdentity,
      // Fold transient attempts written by pre-upgrade versions under a
      // submitted-name key into the stable account key on the next login.
      identityCandidates: [...new Set([
        canonicalIdentity,
        ...legacyNames.filter(Boolean).map((name) => authAttemptKey('identity', name)),
      ])],
      address: authAttemptKey('address', requestAddress(address)),
    };
  }

  function pruneLoginAttempts(state, now = Date.now()) {
    state.loginAttempts = state.loginAttempts.filter((entry) => (
      entry.lastAttemptAt > now - LOGIN_WINDOW_MS || entry.lockedUntil > now
    ));
  }

  function loginLock(state, identityKeys, now = Date.now()) {
    pruneLoginAttempts(state, now);
    const candidates = Array.isArray(identityKeys) ? identityKeys : [identityKeys];
    const locked = state.loginAttempts.find((entry) => candidates.includes(entry.key) && entry.lockedUntil > now);
    return locked ? Math.ceil((locked.lockedUntil - now) / 1000) : 0;
  }

  function loginFailureCount(state, key, now = Date.now()) {
    pruneLoginAttempts(state, now);
    const entry = state.loginAttempts.find((candidate) => candidate.key === key);
    return entry && entry.lastAttemptAt > now - LOGIN_WINDOW_MS ? entry.failures : 0;
  }

  function reconcileIdentityAttempts(state, keys, now = Date.now()) {
    pruneLoginAttempts(state, now);
    const candidates = new Set(keys.identityCandidates);
    const entries = state.loginAttempts.filter((entry) => candidates.has(entry.key));
    if (!entries.length || (entries.length === 1 && entries[0].key === keys.identity)) return;
    const failures = Math.min(
      MAX_LOGIN_ATTEMPTS,
      entries.reduce((total, entry) => total + entry.failures, 0),
    );
    const lockedUntil = Math.max(0, ...entries.map((entry) => entry.lockedUntil));
    state.loginAttempts = state.loginAttempts.filter((entry) => !candidates.has(entry.key));
    state.loginAttempts.push({
      key: keys.identity,
      failures,
      firstAttemptAt: Math.min(...entries.map((entry) => entry.firstAttemptAt)),
      lastAttemptAt: Math.max(...entries.map((entry) => entry.lastAttemptAt)),
      lockedUntil: failures >= MAX_LOGIN_ATTEMPTS && lockedUntil <= now
        ? now + LOGIN_LOCKOUT_MS
        : lockedUntil,
    });
  }

  function rememberLoginFailure(state, keys, now = Date.now()) {
    pruneLoginAttempts(state, now);
    for (const [kind, key] of Object.entries(keys)) {
      const current = state.loginAttempts.find((entry) => entry.key === key);
      if (!current || current.lastAttemptAt <= now - LOGIN_WINDOW_MS) {
        state.loginAttempts.push({ key, failures: 1, firstAttemptAt: now, lastAttemptAt: now, lockedUntil: 0 });
        continue;
      }
      const limit = kind === 'identity' ? MAX_LOGIN_ATTEMPTS : MAX_SHARED_ADDRESS_FAILURES;
      current.failures = Math.min(limit, current.failures + 1);
      current.lastAttemptAt = now;
      if (kind === 'identity' && current.failures >= MAX_LOGIN_ATTEMPTS) current.lockedUntil = now + LOGIN_LOCKOUT_MS;
    }
    state.loginAttempts = state.loginAttempts.slice(-256);
  }

  function clearLoginAttempts(state, keys) {
    state.loginAttempts = state.loginAttempts.filter((entry) => !keys.includes(entry.key));
  }

  function activeUserSessions(state, userId) {
    const now = Date.now();
    return state.sessions.filter((entry) => entry.userId === userId && !entry.revokedAt && entry.expiresAt > now);
  }

  function enforceSessionPolicy(state, principal, deviceId) {
    if (!principal || isOwnerPrincipal(principal)) return;
    if (principal.deviceIds !== null && !principal.deviceIds.includes(deviceId)) {
      throw Object.assign(new Error('This account is not enabled on the requested device.'), {
        status: 403,
        code: 'device_not_allowed',
      });
    }
    if (principal.maxSessions !== null && activeUserSessions(state, principal.id).length >= principal.maxSessions) {
      throw Object.assign(new Error('This account has reached its concurrent session limit.'), {
        status: 409,
        code: 'session_limit_reached',
      });
    }
  }

  async function issueToken(state, principal, deviceId = null) {
    enforceSessionPolicy(state, principal, deviceId);
    const token = randomBytes(32).toString('base64url');
    state.sessions = state.sessions
      .filter((entry) => entry.expiresAt > Date.now())
      .slice(-(MAX_SESSIONS - 1));
    const session = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      userId: principal.id,
      deviceId: typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim().slice(0, MAX_DEVICE_ID_LENGTH) : null,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      idleExpiresAt: Date.now() + ADMIN_TOKEN_TTL_MS,
      absoluteExpiresAt: Date.now() + ADMIN_TOKEN_TTL_MS,
      expiresAt: Date.now() + ADMIN_TOKEN_TTL_MS,
    };
    state.sessions.push(session);
    await saveState(state);
    return { adminToken: token, expiresAt: session.expiresAt, user: principalView(principal) };
  }

  async function authenticateRequest(req) {
    const deviceCredential = await options.pairingService?.authenticate(req?.headers?.authorization);
    if (deviceCredential) {
      const state = await loadState();
      const account = principalForUserId(state, deviceCredential.accountId);
      if (!account) return null;
      const principal = {
        ...account,
        authentication: 'device-credential',
        deviceId: deviceCredential.deviceId,
        deviceCredentialId: deviceCredential.id,
        devicePermissions: [...deviceCredential.permissions],
      };
      const address = options.clientAddress?.(req) || req?.socket?.remoteAddress;
      if (!isLocalNetworkAddress(address) && !hasPermission(principal, 'remote.access')) {
        throw Object.assign(new Error('Remote access is not enabled for this device.'), {
          status: 403, code: 'remote_access_disabled',
        });
      }
      return principal;
    }
    const token = tokenFromRequest(req);
    if (!token) return null;
    const state = await loadState();
    const now = Date.now();
    const active = state.sessions.filter((entry) => !entry.revokedAt && entry.expiresAt > now && principalForUserId(state, entry.userId));
    const session = active.find((entry) => timingSafeStringEqual(entry.tokenHash, hashToken(token)));
    if (active.length !== state.sessions.length) {
      state.sessions = active;
      await saveState(state);
    }
    if (!session) return null;
    const principal = principalForUserId(state, session.userId);
    if (session.deviceId) {
      const device = await options.pairingService?.resolveSessionDevice(principal.id, session.deviceId);
      if (!device) {
        session.revokedAt = now;
        session.revokedReason = 'device_revoked';
        await saveState(state);
        return null;
      }
      const sessionPrincipal = {
        ...principal, authentication: 'device-session', sessionId: session.id,
        deviceId: device.deviceId, deviceCredentialId: device.id,
        devicePermissions: [...device.permissions],
      };
      const address = options.clientAddress?.(req) || req?.socket?.remoteAddress;
      if (!isLocalNetworkAddress(address) && !hasPermission(sessionPrincipal, 'remote.access')) {
        throw Object.assign(new Error('Remote access is not enabled for this device.'), {
          status: 403, code: 'remote_access_disabled',
        });
      }
      return sessionPrincipal;
    }
    const sessionPrincipal = { ...principal, authentication: 'account-session', sessionId: session.id, deviceId: null };
    const address = options.clientAddress?.(req) || req?.socket?.remoteAddress;
    if (!isLocalNetworkAddress(address) && !hasPermission(sessionPrincipal, 'remote.access')) {
      throw Object.assign(new Error('Remote access is not enabled for this account.'), {
        status: 403, code: 'remote_access_disabled',
      });
    }
    return sessionPrincipal;
  }

  return {
    async isOwnerConfigured() {
      return Boolean((await loadState()).owner);
    },

    async authenticateRequest(req) {
      return authenticateRequest(req);
    },

    async getPrincipalById(userId) {
      return principalForUserId(await loadState(), userId);
    },

    async getOwnerPrincipal() {
      return publicOwnerPrincipal((await loadState()).owner);
    },

    async isSessionActive(sessionId, accountId, deviceId = null) {
      if (!sessionId || !accountId) return false;
      const now = Date.now();
      return (await loadState()).sessions.some((entry) => (
        entry.id === sessionId && entry.userId === accountId && !entry.revokedAt && entry.expiresAt > now
        && (deviceId === null || entry.deviceId === deviceId)
      ));
    },

    async issueDeviceSession(credential) {
      const state = await loadState();
      const principal = principalForUserId(state, credential?.accountId);
      if (!principal || !credential?.deviceId) throw Object.assign(new Error('The device credential is invalid.'), {
        status: 401, code: 'device_revoked',
      });
      return issueToken(state, principal, credential.deviceId);
    },

    async authorizeRequest(req, permission) {
      const principal = await authenticateRequest(req);
      return Boolean(principal && (!permission || hasPermission(principal, permission)));
    },

    async authorizePrincipal(principal, permission) {
      return Boolean(principal && (!permission || hasPermission(principal, permission)));
    },

    async revokeRequest(req) {
      const token = tokenFromRequest(req);
      if (!token) return false;
      const state = await loadState();
      const tokenHash = hashToken(token);
      const revokedSessionIds = state.sessions
        .filter((entry) => timingSafeStringEqual(entry.tokenHash, tokenHash))
        .map((entry) => entry.id)
        .filter(Boolean);
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((entry) => !timingSafeStringEqual(entry.tokenHash, tokenHash));
      if (state.sessions.length === before) return false;
      await saveState(state);
      await Promise.all(revokedSessionIds.map((sessionId) => notifyAuthenticationSessionRevoked(sessionId, 'auth_session_revoked')));
      return true;
    },

    async revokeDeviceSessions(deviceId, reason = 'device_revoked') {
      const state = await loadState();
      const revokedAt = Date.now();
      let changed = false;
      for (const session of state.sessions) {
        if (session.deviceId !== deviceId || session.revokedAt) continue;
        session.revokedAt = revokedAt;
        session.revokedReason = String(reason).slice(0, 64);
        changed = true;
      }
      if (changed) await saveState(state);
      return changed;
    },

    async getBootstrap(principal) {
      const state = await loadState();
      const canReadAdmin = Boolean(principal && hasPermission(principal, 'admin.read'));
      const canReadLibrary = Boolean(principal && hasPermission(principal, 'library.read'));
      const health = await this.getHealth(principal, { summary: !canReadAdmin });
      const roots = await Promise.all(state.roots.map(rootView));
      const visibleRootIds = principal && !isOwnerPrincipal(principal) && principal.rootIds !== null
        ? new Set(principal.rootIds)
        : null;
      const visibleCatalog = visibleRootIds
        ? state.catalog.filter((item) => visibleRootIds.has(item.rootId))
        : state.catalog;
      const visibleScan = !principal || isOwnerPrincipal(principal) || principal.rootIds === null
        ? state.scan
        : state.scan?.rootId && principal.rootIds.includes(state.scan.rootId)
          ? state.scan
          : { state: state.scan?.state === 'scanning' ? 'scanning' : 'idle' };
      return {
        apiVersion: 1,
        app: {
          name: 'LoomTV',
          version: health.version || options.version || '0.0.0',
          uptimeSeconds: health.uptimeSeconds || 0,
          baseUrl: options.baseUrl,
        },
        ownerConfigured: Boolean(state.owner),
        user: principalView(principal),
        users: principal && hasPermission(principal, 'users.read')
          ? state.users.filter((user) => principalCanManageUser(principal, user)).map(userView)
          : [],
        health,
        library: {
          roots: canReadLibrary
            ? principal && !isOwnerPrincipal(principal) && principal.rootIds !== null
              ? roots.filter((root) => principal.rootIds.includes(root.id))
              : roots
            : [],
          scan: canReadLibrary ? visibleScan : { state: 'idle' },
          itemCount: canReadLibrary && Array.isArray(visibleCatalog) ? visibleCatalog.length : 0,
        },
        sessions: [],
        backup: principal && hasPermission(principal, 'backup.read') ? state.backup : { state: 'restricted' },
      };
    },

    async createOwner(input) {
      // Concurrent callers must never receive the first caller's newly issued
      // owner token. Wait, then re-evaluate owner state and this caller's
      // one-time bootstrap capability independently.
      while (ownerCreationPromise) await ownerCreationPromise.catch(() => undefined);
      ownerCreationPromise = (async () => {
        const state = await loadState();
        if (state.owner) throw Object.assign(new Error('The LoomTV owner has already been created.'), { status: 409 });
        // Trusted desktop setup and the shared web setup follow the same owner
        // flow. Deployments that opt into a bootstrap secret still verify it
        // here, before any account state is written.
        if (input.trustedChannel !== true && requireBootstrapSecret) {
          options.bootstrapSecurity.authorize(input.bootstrapSecret, input.address);
        }
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) {
          throw invalidInput('The owner name must be between 1 and 80 characters.');
        }
        if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 256) {
          throw invalidInput('The owner password must be between 8 and 256 characters.');
        }
        const credentials = await hashPassword(input.password);
        state.owner = { id: randomUUID(), name: input.name.trim(), ...credentials };
        await saveState(state);
        await options.bootstrapSecurity.invalidate();
        await appendLog('info', 'Owner account created.');
        return issueToken(state, publicOwnerPrincipal(state.owner));
      })();
      try {
        return await ownerCreationPromise;
      } finally {
        ownerCreationPromise = null;
      }
    },

    async createSession(input) {
      const state = await loadState();
      const identity = typeof input.username === 'string' ? input.username.trim() : '';
      if (typeof input.password !== 'string' || input.password.length > 256) {
        throw invalidInput('The account password is invalid.');
      }
      const address = requestAddress(input.address);
      const requestedDeviceId = typeof input.deviceId === 'string' && input.deviceId.trim()
        ? input.deviceId.trim().slice(0, MAX_DEVICE_ID_LENGTH)
        : null;
      const match = userByName(state, identity || 'owner');
      const deviceId = requestedDeviceId && match?.principal
        ? await options.pairingService?.resolveBoundDevice(match.principal.id, requestedDeviceId)
        : null;
      const keys = loginKeys(identity || 'owner', address, match);
      const now = Date.now();
      reconcileIdentityAttempts(state, keys, now);
      const retryAfter = loginLock(state, keys.identityCandidates, now);
      if (retryAfter) {
        await saveState(state);
        throw Object.assign(new Error('Too many sign-in attempts. Try again later.'), {
          status: 429,
          code: 'login_locked',
          retryAfter,
        });
      }

      const credential = match?.record;
      await loginDelay(loginThrottleDelayMs(loginFailureCount(state, keys.address, now)));
      const passwordValid = credential
        ? await verifyPassword(input.password, credential.salt, credential.hash)
        : await scrypt(input.password, 'loomtv-invalid-login-salt', PASSWORD_BYTES).then(() => false);
      if (!match || !passwordValid || (match.type === 'user' && match.record.disabled)) {
        rememberLoginFailure(state, { identity: keys.identity, address: keys.address }, now);
        await saveState(state);
        await appendLog('warn', 'Rejected sign-in attempt.', { identity: identity || 'owner' });
        const lockedRetryAfter = loginLock(state, keys.identityCandidates, now);
        throw Object.assign(new Error(lockedRetryAfter
          ? 'Too many sign-in attempts. Try again later.'
          : 'The account name or password is incorrect.'), {
          status: lockedRetryAfter ? 429 : 401,
          code: lockedRetryAfter ? 'login_locked' : 'invalid_credentials',
          ...(lockedRetryAfter ? { retryAfter: lockedRetryAfter } : {}),
        });
      }
      if (!isLocalNetworkAddress(address) && !hasPermission(match.principal, 'remote.access')) {
        throw Object.assign(new Error('Remote access is not enabled for this account.'), {
          status: 403, code: 'remote_access_disabled',
        });
      }
      // A valid login clears its identity failures, but not failures shared by
      // every client behind the same address. The latter decay as a throttle;
      // they never create a global hard lock for a NAT or reverse proxy.
      clearLoginAttempts(state, keys.identityCandidates);
      await saveState(state);
      return issueToken(state, match.principal, deviceId);
    },

    async getCurrentUser(principal) {
      return principalView(principal);
    },

    async listUsers(principal) {
      ensurePrincipalPermission(principal, 'users.read');
      return (await loadState()).users.filter((user) => principalCanManageUser(principal, user)).map(userView);
    },

    async createUser(input, principal) {
      ensurePrincipalPermission(principal, 'users.manage');
      const state = await loadState();
      const name = String(input.name || '').trim();
      if (!name || name.length > 80) throw Object.assign(new Error('User name must be between 1 and 80 characters.'), { status: 400 });
      if (normalizedIdentity(name) === 'owner' || (state.owner && normalizedIdentity(state.owner.name) === normalizedIdentity(name))) {
        throw Object.assign(new Error('That name is reserved for the owner account.'), { status: 409 });
      }
      if (state.users.some((user) => normalizedIdentity(user.name) === normalizedIdentity(name))) {
        throw Object.assign(new Error('A user with that name already exists.'), { status: 409 });
      }
      if (state.users.length >= MAX_USERS) throw Object.assign(new Error('The server has reached its user limit.'), { status: 400 });
      const role = USER_ROLES.includes(input.role) ? input.role : 'viewer';
      if (!isOwnerPrincipal(principal) && role === 'admin') throw permissionDenied('Only the owner can create an administrator.');
      const permissions = permissionsInput(input.permissions, role);
      if (!isOwnerPrincipal(principal) && permissions.some((permission) => !hasPermission(principal, permission))) {
        throw permissionDenied('You cannot grant permissions you do not have yourself.');
      }
      const rootIds = rootIdsInput(input.rootIds);
      const knownRootIds = new Set(state.roots.map((root) => root.id));
      if (rootIds && rootIds.some((rootId) => !knownRootIds.has(rootId))) {
        throw Object.assign(new Error('One or more library roots are invalid.'), { status: 400 });
      }
      if (!isOwnerPrincipal(principal) && principal.rootIds !== null) {
        if (rootIds === null) throw permissionDenied('You cannot grant access to every library root.');
        if (rootIds.some((rootId) => !principal.rootIds.includes(rootId))) throw permissionDenied('You cannot grant access outside your own library roots.');
      }
      if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 256) {
        throw Object.assign(new Error('User passwords must be between 8 and 256 characters.'), { status: 400 });
      }
      const credentials = await hashPassword(input.password);
      const user = {
        id: randomUUID(),
        name,
        ...credentials,
        role,
        permissions,
        rootIds,
        deviceIds: deviceIdsInput(input.deviceIds),
        maxSessions: maxSessionsInput(input.maxSessions),
        disabled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.users.push(user);
      await saveState(state);
      await appendLog('info', `User account created: ${name}`, { userId: user.id, role });
      return userView(user);
    },

    async updateUser(userId, input, principal) {
      ensurePrincipalPermission(principal, 'users.manage');
      const state = await loadState();
      const user = state.users.find((entry) => entry.id === userId);
      if (!user) throw Object.assign(new Error('User account was not found.'), { status: 404 });
      ensureUserScope(principal, user);
      if (input.name !== undefined) {
        const name = String(input.name || '').trim();
        if (!name || name.length > 80) throw Object.assign(new Error('User name must be between 1 and 80 characters.'), { status: 400 });
        if (normalizedIdentity(name) === 'owner'
          || (state.owner && normalizedIdentity(state.owner.name) === normalizedIdentity(name))
          || state.users.some((entry) => entry.id !== user.id && normalizedIdentity(entry.name) === normalizedIdentity(name))) {
          throw Object.assign(new Error('A user with that name already exists.'), { status: 409 });
        }
        user.name = name;
      }
      const role = input.role === undefined ? user.role : input.role;
      if (!USER_ROLES.includes(role)) throw Object.assign(new Error('User role is invalid.'), { status: 400 });
      if (!isOwnerPrincipal(principal) && role === 'admin') throw permissionDenied('Only the owner can grant administrator access.');
      const roleChanged = role !== user.role;
      const permissions = input.permissions === undefined
        ? (roleChanged ? permissionsForRole(role) : user.permissions)
        : permissionsInput(input.permissions, role);
      if (!isOwnerPrincipal(principal) && permissions.some((permission) => !hasPermission(principal, permission))) {
        throw permissionDenied('You cannot grant permissions you do not have yourself.');
      }
      const rootIds = input.rootIds === undefined ? user.rootIds : rootIdsInput(input.rootIds);
      const deviceIds = input.deviceIds === undefined ? user.deviceIds : deviceIdsInput(input.deviceIds);
      const maxSessions = input.maxSessions === undefined ? user.maxSessions : maxSessionsInput(input.maxSessions);
      const knownRootIds = new Set(state.roots.map((root) => root.id));
      if (rootIds && rootIds.some((rootId) => !knownRootIds.has(rootId))) {
        throw Object.assign(new Error('One or more library roots are invalid.'), { status: 400 });
      }
      if (!isOwnerPrincipal(principal) && principal.rootIds !== null) {
        if (rootIds === null || rootIds.some((rootId) => !principal.rootIds.includes(rootId))) throw permissionDenied('You cannot grant access outside your own library roots.');
      }
      user.role = role;
      user.permissions = permissions;
      user.rootIds = rootIds;
      user.deviceIds = deviceIds;
      user.maxSessions = maxSessions;
      if (input.disabled !== undefined) user.disabled = input.disabled === true;
      user.updatedAt = Date.now();
      if (user.disabled) state.sessions = state.sessions.filter((session) => session.userId !== user.id);
      await saveState(state);
      await appendLog('info', `User account updated: ${user.name}`, { userId: user.id });
      if (user.disabled) await notifyPlaybackSessionsRevoked(user.id, 'principal_disabled');
      else if (roleChanged || input.permissions !== undefined || input.rootIds !== undefined) {
        await notifyPlaybackSessionsRevoked(user.id, 'permissions_changed');
      }
      return userView(user);
    },

    async removeUser(userId, principal) {
      ensurePrincipalPermission(principal, 'users.manage');
      const state = await loadState();
      const user = state.users.find((entry) => entry.id === userId);
      if (!user) throw Object.assign(new Error('User account was not found.'), { status: 404 });
      ensureUserScope(principal, user);
      state.users = state.users.filter((entry) => entry.id !== userId);
      state.sessions = state.sessions.filter((session) => session.userId !== userId);
      await saveState(state);
      await appendLog('info', `User account removed: ${user.name}`, { userId });
      await notifyPlaybackSessionsRevoked(userId, 'principal_removed');
    },

    async changePassword(input, principal) {
      if (!principal) throw Object.assign(new Error('A signed-in account is required.'), { status: 401 });
      const state = await loadState();
      const targetId = input.userId || principal.id;
      const target = state.owner?.id === targetId
        ? state.owner
        : state.users.find((entry) => entry.id === targetId);
      if (!target) throw Object.assign(new Error('Account was not found.'), { status: 404 });
      const changingAnother = targetId !== principal.id;
      const targetIsOwner = state.owner?.id === targetId;
      const targetPrincipal = targetIsOwner ? publicOwnerPrincipal(target) : publicUserPrincipal(target);
      const policyAllowed = canResetCredentials(principal, targetPrincipal);
      await appendLog(policyAllowed ? 'info' : 'warn', 'Credential-reset policy evaluated.', {
        actorId: principal.id,
        targetId,
        policyResult: policyAllowed ? 'allowed' : 'denied',
      });
      if (!policyAllowed) throw permissionDenied('This account cannot reset credentials for the selected account.');
      if (!changingAnother && typeof input.currentPassword !== 'string') throw Object.assign(new Error('The current password is required.'), { status: 400 });
      if (!changingAnother && !(await verifyPassword(input.currentPassword, target.salt, target.hash))) {
        throw Object.assign(new Error('The current password is incorrect.'), { status: 401 });
      }
      if (typeof input.newPassword !== 'string' || input.newPassword.length < 8 || input.newPassword.length > 256) {
        throw Object.assign(new Error('Passwords must be between 8 and 256 characters.'), { status: 400 });
      }
      if (await verifyPassword(input.newPassword, target.salt, target.hash)) {
        throw Object.assign(new Error('Choose a password different from the current password.'), { status: 400 });
      }
      Object.assign(target, await hashPassword(input.newPassword), { updatedAt: Date.now() });
      state.sessions = state.sessions.filter((session) => session.userId !== targetId);
      await saveState(state);
      await notifyPlaybackSessionsRevoked(targetId, 'credentials_changed');
      await appendLog('info', `Password changed for ${target.name}.`, {
        actorId: principal.id,
        targetId,
        policyResult: 'allowed',
      });
      if (targetId === principal.id) return issueToken(state, target === state.owner ? publicOwnerPrincipal(state.owner) : publicUserPrincipal(target));
      return { changed: true };
    },

    async listLibraryRoots(principal) {
      if (principal) ensurePrincipalPermission(principal, 'library.read');
      const roots = await Promise.all((await loadState()).roots.map(rootView));
      if (!principal || isOwnerPrincipal(principal) || principal.rootIds === null) return roots;
      return roots.filter((root) => principal.rootIds.includes(root.id));
    },

    async listLibraryDirectories(input = {}, principal) {
      ensurePrincipalPermission(principal, 'library.manage');
      if (!mediaDir) {
        throw Object.assign(new Error('No media mount is configured for this server.'), { status: 409 });
      }

      const configuredRoot = await fs.realpath(mediaDir).catch((error) => {
        throw Object.assign(new Error('The configured media mount is not available.'), { status: error?.code === 'EACCES' ? 403 : 409 });
      });
      const requestedPath = typeof input.path === 'string' && input.path.trim()
        ? path.resolve(input.path.trim())
        : configuredRoot;
      if (!isPathWithin(configuredRoot, requestedPath)) {
        throw Object.assign(new Error('Browse is limited to the configured media mount.'), { status: 403 });
      }

      const currentPath = await fs.realpath(requestedPath).catch((error) => {
        throw Object.assign(new Error('That folder is not available on the server.'), { status: error?.code === 'EACCES' ? 403 : 404 });
      });
      if (!isPathWithin(configuredRoot, currentPath)) {
        throw Object.assign(new Error('Browse is limited to the configured media mount.'), { status: 403 });
      }
      if (!isOwnerPrincipal(principal) && principal.rootIds !== null) {
        const state = await loadState();
        const allowed = state.roots
          .filter((root) => principal.rootIds.includes(root.id))
          .some((root) => isPathWithin(root.path, currentPath));
        if (!allowed) throw permissionDenied('Folder browsing is outside this account’s library roots.');
      }
      const stats = await fs.stat(currentPath).catch((error) => {
        throw Object.assign(new Error('That folder is not available on the server.'), { status: error?.code === 'EACCES' ? 403 : 404 });
      });
      if (!stats.isDirectory()) throw Object.assign(new Error('The selected path is not a folder.'), { status: 400 });

      const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch((error) => {
        throw Object.assign(new Error('The server could not read that folder.'), { status: error?.code === 'EACCES' ? 403 : 500 });
      });
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: path.join(currentPath, entry.name) }))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
      const parentPath = currentPath === configuredRoot ? null : path.dirname(currentPath);
      return {
        rootPath: configuredRoot,
        path: currentPath,
        parentPath: parentPath && isPathWithin(configuredRoot, parentPath) ? parentPath : null,
        directories,
      };
    },

    async searchLibraryDirectories(input = {}, principal) {
      ensurePrincipalPermission(principal, 'library.manage');
      if (!mediaDir) {
        throw Object.assign(new Error('No media mount is configured for this server.'), { status: 409 });
      }
      const query = typeof input.query === 'string' ? input.query.trim().toLocaleLowerCase() : '';
      if (!query || query.length > 120) {
        throw Object.assign(new Error('Enter a folder name to search.'), { status: 400 });
      }

      const configuredRoot = await fs.realpath(mediaDir).catch((error) => {
        throw Object.assign(new Error('The configured media mount is not available.'), { status: error?.code === 'EACCES' ? 403 : 409 });
      });
      const maxResults = 100;
      const maxVisited = 5_000;
      const maxDepth = 12;
      const unavailableDirectoryErrors = new Set([
        'EACCES',
        'EIO',
        'ELOOP',
        'ENAMETOOLONG',
        'ENOENT',
        'ENOTCONN',
        'ENOTDIR',
        'ENXIO',
        'EPERM',
        'ESTALE',
        'ETIMEDOUT',
      ]);
      const state = !isOwnerPrincipal(principal) && principal.rootIds !== null ? await loadState() : null;
      const searchRoots = state
        ? state.roots
          .filter((root) => principal.rootIds.includes(root.id))
          .map((root) => path.resolve(root.path))
          .filter((root) => isPathWithin(configuredRoot, root))
        : [configuredRoot];
      const queue = [];
      for (const root of searchRoots) {
        const existing = await fs.realpath(root).catch(() => null);
        if (existing && isPathWithin(configuredRoot, existing)) queue.push({ path: existing, depth: 0 });
      }

      const directories = [];
      let visited = 0;
      while (queue.length && directories.length < maxResults && visited < maxVisited) {
        const current = queue.shift();
        visited += 1;
        const entries = await fs.readdir(current.path, { withFileTypes: true }).catch((error) => {
          // External drives, NAS shares, and cloud-storage placeholders can
          // disappear or time out while the rest of the browse root remains
          // healthy. Skip only that branch so one unavailable folder cannot
          // discard matches found elsewhere.
          if (unavailableDirectoryErrors.has(error?.code)) return [];
          throw Object.assign(new Error('The server could not search that folder.'), { status: 500 });
        });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const childPath = path.join(current.path, entry.name);
          if (!isPathWithin(configuredRoot, childPath)) continue;
          if (entry.name.toLocaleLowerCase().includes(query)) {
            directories.push({ name: entry.name, path: childPath });
            if (directories.length >= maxResults) break;
          }
          if (current.depth < maxDepth) queue.push({ path: childPath, depth: current.depth + 1 });
        }
      }

      directories.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
      return {
        rootPath: configuredRoot,
        query,
        directories,
        truncated: queue.length > 0 || visited >= maxVisited || directories.length >= maxResults,
      };
    },

    async addLibraryRoot(input, principal) {
      ensurePrincipalPermission(principal, 'library.manage');
      if (!isOwnerPrincipal(principal) && principal.rootIds !== null) {
        throw permissionDenied('Only an unrestricted administrator can add library roots.');
      }
      const state = await loadState();
      if (!input || typeof input.path !== 'string' || !input.path.trim() || input.path.trim().length > 4_096) {
        throw invalidInput('A library root path is required.');
      }
      const rootPath = path.resolve(input.path);
      if (state.roots.some((root) => root.path === rootPath)) return rootView(state.roots.find((root) => root.path === rootPath));
      if (state.roots.length >= MAX_ROOTS) throw Object.assign(new Error('The server has reached its library-root limit.'), { status: 400 });
      const kind = ['movies', 'tvShows', 'anime', 'others'].includes(input.kind) ? input.kind : 'others';
      const root = { id: rootIdFor(rootPath), path: rootPath, kind, createdAt: Date.now() };
      state.roots.push(root);
      await saveState(state);
      await appendLog('info', `Library root added: ${rootPath}`);
      return rootView(root);
    },

    async removeLibraryRoot(rootId, principal) {
      ensurePrincipalPermission(principal, 'library.manage');
      if (!isOwnerPrincipal(principal) && principal.rootIds !== null) {
        throw permissionDenied('Only an unrestricted administrator can remove library roots.');
      }
      const state = await loadState();
      const before = state.roots.length;
      state.roots = state.roots.filter((root) => root.id !== rootId);
      if (state.roots.length === before) throw Object.assign(new Error('Library root was not found.'), { status: 404 });
      await saveState(state);
      await appendLog('info', `Library root removed: ${rootId}`);
    },

    async getScanStatus(principal) {
      ensurePrincipalPermission(principal, 'library.read');
      const scan = (await loadState()).scan;
      if (!isOwnerPrincipal(principal) && principal.rootIds !== null
        && (!scan.rootId || !principal.rootIds.includes(scan.rootId))) {
        return { state: scan.state === 'scanning' ? 'scanning' : 'idle' };
      }
      return scan;
    },

    async startLibraryScan(input, principal) {
      ensurePrincipalPermission(principal, 'library.manage');
      if (!isOwnerPrincipal(principal) && principal.rootIds !== null) {
        if (!input.rootId) throw invalidInput('rootId is required when scanning a scoped library account.');
        if (!canAccessRoot(principal, input.rootId)) throw permissionDenied('This account cannot scan that library root.');
      }
      return scanner.start(input);
    },

    async stop() {
      return scanner.stop();
    },

    catalogRevision() { return stateStore?.catalogRevision?.() ?? null; },

    async listLibraryItems(principal) {
      if (principal) ensurePrincipalPermission(principal, 'library.read');
      const items = await scanner.listItems();
      const episodesBySeries = new Map();
      for (const entry of items) {
        if (entry.kind !== 'episode' || !entry.seriesId) continue;
        const episodes = episodesBySeries.get(entry.seriesId) || [];
        episodes.push(entry);
        episodesBySeries.set(entry.seriesId, episodes);
      }
      const episodeSourcesForSeries = (seriesId) => (episodesBySeries.get(seriesId) || [])
        .flatMap((entry) => stateStore?.listMediaSources?.(entry.id)
          || [{ id: entry.sourceId || `${entry.id}:primary`, rootId: entry.rootId, state: entry.available === false ? 'offline' : 'online' }]);
      return items.flatMap((item) => {
        const linkedEpisodes = item.kind === 'series'
          ? episodesBySeries.get(item.id) || []
          : [];
        if (principal?.invitationMediaIds && !principal.invitationMediaIds.includes(item.id)
          && !linkedEpisodes.some((entry) => principal.invitationMediaIds.includes(entry.id))) return [];
        const ownSources = stateStore?.listMediaSources?.(item.id);
        const canonicalSources = item.kind === 'series'
          ? episodeSourcesForSeries(item.id)
          : ownSources?.length ? ownSources
            : [{ id: item.sourceId || `${item.id}:primary`, rootId: item.rootId, state: item.available === false ? 'offline' : 'online' }];
        const visibleSources = !principal || principal.rootIds === null || isOwnerPrincipal(principal)
          ? canonicalSources
          : canonicalSources.filter((source) => canAccessRoot(principal, source.rootId));
        if (!visibleSources.length && (item.kind !== 'series' || principal && principal.rootIds !== null && !isOwnerPrincipal(principal))) return [];
        return [{ ...item, sourceIds: visibleSources.map((source) => source.id), available: visibleSources.some((source) => source.state === 'online') }];
      });
    },

    async getLibraryItem(itemId, principal) {
      if (principal) ensurePrincipalPermission(principal, 'library.read');
      if (principal?.invitationMediaIds && !principal.invitationMediaIds.includes(itemId)) return null;
      const item = await scanner.getItem(itemId);
      if (!item) return null;
      const items = item.kind === 'series' ? await scanner.listItems() : [];
      const linkedEpisodes = items.filter((entry) => entry.kind === 'episode' && entry.seriesId === item.id);
      if (principal?.invitationMediaIds && !principal.invitationMediaIds.includes(itemId)
        && !linkedEpisodes.some((entry) => principal.invitationMediaIds.includes(entry.id))) return null;
      const ownSources = stateStore?.listMediaSources?.(item.id);
      const canonicalSources = item.kind === 'series'
        ? linkedEpisodes.flatMap((entry) => stateStore?.listMediaSources?.(entry.id)
          || [{ id: entry.sourceId || `${entry.id}:primary`, rootId: entry.rootId, state: entry.available === false ? 'offline' : 'online' }])
        : ownSources?.length ? ownSources
          : [{ id: item.sourceId || `${item.id}:primary`, rootId: item.rootId, state: item.available === false ? 'offline' : 'online' }];
      const visibleSources = !principal || principal.rootIds === null || isOwnerPrincipal(principal)
        ? canonicalSources
        : canonicalSources.filter((source) => canAccessRoot(principal, source.rootId));
      if (!visibleSources.length && (item.kind !== 'series' || principal && principal.rootIds !== null && !isOwnerPrincipal(principal))) return null;
      return { ...item, sourceIds: visibleSources.map((source) => source.id), available: visibleSources.some((source) => source.state === 'online') };
    },

    async recordMediaProbe(itemId, sourceId, probe) {
      if (!probe || typeof probe !== 'object' || !Array.isArray(probe.tracks)) return null;
      if (stateStore?.recordMediaProbe) return stateStore.recordMediaProbe(itemId, sourceId, probe) ? probe : null;
      const state = await loadState();
      const item = state.catalog.find((entry) => entry.id === itemId);
      if (!item) return null;
      item.localMetadata = {
        sourceId: typeof probe.sourceId === 'string' ? probe.sourceId.slice(0, 256) : item.sourceId,
        container: typeof probe.container === 'string' ? probe.container.slice(0, 64) : 'unknown',
        ...(Number.isFinite(probe.durationSeconds) ? { durationSeconds: Number(probe.durationSeconds) } : {}),
        ...(Number.isFinite(probe.bitrateKbps) ? { bitrateKbps: Number(probe.bitrateKbps) } : {}),
        ...(Number.isFinite(probe.width) ? { width: Number(probe.width) } : {}),
        ...(Number.isFinite(probe.height) ? { height: Number(probe.height) } : {}),
        ...(typeof probe.videoCodec === 'string' ? { videoCodec: probe.videoCodec.slice(0, 64) } : {}),
        ...(typeof probe.audioCodec === 'string' ? { audioCodec: probe.audioCodec.slice(0, 64) } : {}),
        hdr: probe.hdr === true,
        tracks: probe.tracks.slice(0, 256),
        chapters: Array.isArray(probe.chapters) ? probe.chapters.slice(0, 10_000) : [],
        probedAt: Number(probe.probedAt) || Date.now(),
      };
      await saveState(state);
      return item.localMetadata;
    },

    async resolveMediaPath(itemId, principal, sourceId = undefined) {
      if (principal && !isOwnerPrincipal(principal)
        && !hasPermission(principal, 'library.read')
        && !hasPermission(principal, 'stream')
        && !hasPermission(principal, 'transcode')
        && !hasPermission(principal, 'downloads')
        && !hasPermission(principal, 'media.delete')) throw permissionDenied();
      if (principal?.invitationMediaIds && !principal.invitationMediaIds.includes(itemId)) throw permissionDenied('Media is outside the invitation scope.');
      const item = await scanner.getItem(itemId);
      if (!item) throw Object.assign(new Error('Media item was not found.'), { status: 404 });
      const visibleCanonicalSources = (stateStore?.listMediaSources?.(itemId) || []).filter((source) => (
        !principal || canAccessRoot(principal, source.rootId)
      ));
      const selectedSourceId = sourceId || visibleCanonicalSources[0]?.id;
      const canonicalSource = stateStore?.readMediaSource?.(itemId, selectedSourceId);
      if (sourceId && !canonicalSource) throw Object.assign(new Error('Media source was not found.'), { status: 404, code: 'source_unavailable' });
      const selected = canonicalSource || item;
      if (selected.state && selected.state !== 'online') throw Object.assign(new Error('Media source is unavailable.'), { status: 409, code: 'source_unavailable' });
      if (principal && selected.rootId && !canAccessRoot(principal, selected.rootId)) throw permissionDenied('This account cannot access that library.');
      const root = canonicalSource?.rootPath
        ? { id: canonicalSource.rootId, path: canonicalSource.rootPath }
        : (await loadState()).roots.find((entry) => entry.id === selected.rootId);
      if (!root) throw Object.assign(new Error('Media root was removed.'), { status: 404 });
      // Containment is decided on canonical real paths, not on the recorded
      // strings: a catalog entry can point at a symlink, a dangling link, or a
      // path whose type changed since it was indexed. `fileId` lets the caller
      // that finally opens the file prove it is still the same file.
      const verified = await statContainedFile(root.path, selected.path);
      return {
        ...item,
        rootId: selected.rootId || item.rootId,
        sourceId: selected.id || item.sourceId || `${itemId}:primary`,
        sourceState: selected.state || (item.available === false ? 'offline' : 'online'),
        ...(selected.probe ? { localMetadata: selected.probe } : {}),
        ...(Number.isFinite(selected.modifiedAtMs) ? { recordedModifiedAtMs: Number(selected.modifiedAtMs) } : {}),
        ...(Number.isFinite(selected.sizeBytes) ? { recordedSizeBytes: Number(selected.sizeBytes) } : {}),
        path: verified.realPath,
        rootPath: verified.rootRealPath,
        fileId: verified.fileId,
        sizeBytes: verified.stats.size,
        modifiedAtMs: verified.stats.mtimeMs,
      };
    },

    async deleteLibraryItem(itemId, principal) {
      ensurePrincipalPermission(principal, 'media.delete');
      const state = await loadState();
      const item = state.catalog.find((entry) => entry.id === itemId);
      if (!item) throw Object.assign(new Error('Media item was not found.'), { status: 404 });
      if (!canAccessRoot(principal, item.rootId)) throw permissionDenied('This account cannot delete media from that library.');
      const root = state.roots.find((entry) => entry.id === item.rootId);
      if (!root) throw Object.assign(new Error('Media root was removed.'), { status: 404 });

      const verified = await statContainedFile(root.path, item.path);
      // unlink never follows a final-component symlink, so a link substituted
      // after verification removes the link itself and cannot reach outside.
      await fs.unlink(verified.realPath).catch((error) => {
        throw Object.assign(new Error('The media file could not be deleted.'), { status: error?.code === 'EACCES' ? 403 : 500 });
      });
      state.catalog = state.catalog.filter((entry) => entry.id !== itemId);
      await saveState(state);
      // Logs are readable by any account holding logs.read, including a
      // root-scoped administrator, so record the path below the root rather
      // than the absolute path the catalog stored.
      await appendLog('info', `Media file deleted: ${containedRelativePath(verified.rootRealPath, verified.realPath)}`, { itemId, userId: principal.id });
      await notifyPlaybackSessionsRevokedForItem(itemId, 'item_removed');
      return { id: itemId, deleted: true };
    },

    async getHealth(principal, healthOptions = {}) {
      const summaryOnly = healthOptions.summary === true;
      if (principal && !summaryOnly) ensurePrincipalPermission(principal, 'admin.read');
      const runtime = await getRuntimeHealth();
      const mediaState = runtime.media?.state || 'unconfigured';
      const transcoderHealth = runtime.transcoder || {};
      const transcoderState = transcoderHealth.available
        ? (transcoderHealth.hardwareAcceleration ? 'available' : 'limited')
        : 'unavailable';
      const runtimeState = mediaState !== 'online'
        ? 'offline'
        : transcoderState === 'unavailable' ? 'degraded' : 'healthy';
      const backendLabel = transcoderHealth.recommendedBackend && transcoderHealth.recommendedBackend !== 'software'
        ? ` Recommended backend: ${transcoderHealth.recommendedBackend}.`
        : '';
      const currentState = await loadState();
      const catalogCount = Array.isArray(currentState.catalog) ? currentState.catalog.length : 0;
      const storage = summaryOnly ? null : await storageStatus(dataDir);
      const state = !summaryOnly && storage && !storage.writable && runtimeState === 'healthy'
        ? 'degraded'
        : runtimeState;
      const latestBackup = normalizeBackupHistory(currentState.backup?.history).find((entry) => entry.kind === 'backup' && entry.status === 'completed');
      const checks = [
        { name: 'Headless runtime', state: 'pass', message: 'The server is running without Electron.' },
        { name: 'Headless catalog', state: 'pass', message: `${catalogCount} media records and scan checkpoints are available without Electron.` },
        { name: 'Media root', state: mediaState === 'online' ? 'pass' : 'warn', message: runtime.media?.path && !summaryOnly ? `${runtime.media.path} is ${mediaState}.` : `Media root is ${mediaState}.` },
        { name: 'FFmpeg transcoder', state: transcoderState === 'available' ? 'pass' : transcoderState === 'limited' ? 'warn' : 'fail', message: transcoderHealth.available ? `FFmpeg is available.${backendLabel}` : 'FFmpeg is not available on this host.' },
      ];
      if (!summaryOnly) {
        checks.push({ name: 'Persistent storage', state: storage.writable && (storage.freeBytes === undefined || storage.freeBytes > 64 * 1024 * 1024) ? 'pass' : 'warn', message: storageCheckMessage(storage) });
        checks.push({ name: 'Latest backup', state: latestBackup ? 'pass' : 'warn', message: latestBackup ? `Last verified snapshot ${new Date(latestBackup.createdAt).toISOString()}.` : 'No verified backup has been recorded.' });
      }
      const safeTranscoder = {
        state: transcoderHealth.state,
        available: transcoderHealth.available,
        recommendedBackend: transcoderHealth.recommendedBackend,
        hardwareAcceleration: transcoderHealth.hardwareAcceleration,
        codecs: transcoderHealth.codecs,
        softwareCodecs: transcoderHealth.softwareCodecs,
        softwareFallback: transcoderHealth.softwareFallback,
        toneMapping: transcoderHealth.toneMapping,
        mediaStreaming: transcoderHealth.mediaStreaming,
        ...(transcoderHealth.admission && typeof transcoderHealth.admission === 'object'
          ? {
            admission: Object.fromEntries(
              ['active', 'queued', 'globalLimit', 'principalLimit', 'queueLimit', 'principalQueueLimit', 'failed', 'canceled']
                .filter((field) => Number.isFinite(transcoderHealth.admission[field]))
                .map((field) => [field, transcoderHealth.admission[field]]),
            ),
          }
          : {}),
      };
      return {
        state,
        version: runtime.version || options.version || '0.0.0',
        uptimeSeconds: runtime.uptimeSeconds || 0,
        database: 'catalog',
        transcoder: transcoderState,
        transcoderDetails: summaryOnly ? safeTranscoder : transcoderHealth,
        ...(summaryOnly ? {} : { storage }),
        checks,
      };
    },

    async listSessions(principal) {
      ensurePrincipalPermission(principal, 'sessions.read');
      return getSessions();
    },

    async listLogs(input = {}, principal) {
      ensurePrincipalPermission(principal, 'logs.read');
      const options = typeof input === 'number' ? { limit: input } : (input || {});
      const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(500, options.limit)) : 100;
      const offset = Number.isSafeInteger(options.offset) ? Math.max(0, options.offset) : 0;
      const state = await loadState();
      const pruned = pruneLogs(state);
      if (pruned) await saveState(state);
      const level = ['debug', 'info', 'warn', 'error'].includes(options.level) ? options.level : null;
      const source = typeof options.source === 'string' ? options.source.trim().slice(0, 128).toLocaleLowerCase() : '';
      const search = typeof options.search === 'string' ? options.search.trim().toLocaleLowerCase().slice(0, 200) : '';
      const before = Number.isFinite(options.before) ? Number(options.before) : null;
      const after = Number.isFinite(options.after) ? Number(options.after) : null;
      const filtered = state.logs.filter((entry) => (
        (!level || entry.level === level)
        && (!source || String(entry.source || '').toLocaleLowerCase() === source)
        && (!search || `${entry.message || ''} ${entry.source || ''}`.toLocaleLowerCase().includes(search))
        && (before === null || Number(entry.timestamp) < before)
        && (after === null || Number(entry.timestamp) > after)
      ));
      const logs = filtered.slice(offset, offset + limit);
      const nextOffset = offset + logs.length < filtered.length ? offset + logs.length : null;
      return { logs, page: { limit, offset, total: filtered.length, nextOffset, hasMore: nextOffset !== null } };
    },

    async getBackupStatus(principal) {
      ensurePrincipalPermission(principal, 'backup.read');
      return (await loadState()).backup;
    },

    getBackupRoot() {
      return path.join(dataDir, 'backups');
    },

    isBackupPathAllowed(candidate) {
      if (typeof candidate !== 'string' || !candidate.trim()) return false;
      return isPathWithin(path.join(dataDir, 'backups'), path.resolve(candidate));
    },

    async getDiagnostics(principal) {
      ensurePrincipalPermission(principal, 'admin.read');
      const health = await this.getHealth(principal);
      const state = await loadState();
      const logs = hasPermission(principal, 'logs.read')
        ? await this.listLogs({ limit: 50 }, principal)
        : { logs: [], page: { limit: 50, offset: 0, total: 0, nextOffset: null, hasMore: false } };
      return {
        generatedAt: Date.now(),
        health,
        backup: hasPermission(principal, 'backup.read') ? state.backup : { state: 'restricted' },
        sessions: hasPermission(principal, 'sessions.read') ? await this.listSessions(principal) : [],
        logs,
      };
    },

    async startBackup(input = {}, principal) {
      ensurePrincipalPermission(principal, 'backup.create');
      if (backupPromise) return backupPromise;
      backupPromise = (async () => {
        const state = await loadState();
        const destination = path.resolve(input.destination || path.join(dataDir, 'backups'));
        state.backup = { ...normalizeBackupStatus(state.backup), state: 'running', destination };
        await saveBackupStatus(state.backup);
        try {
          const envelope = stateStore?.exportCanonicalSnapshot
            ? canonicalBackupEnvelope(stateStore.exportCanonicalSnapshot(), options.version)
            : legacyBackupEnvelopeFromState(state, options.version, await getClientState());
          const outputPath = path.join(destination, `loomtv-backup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`);
          const artifact = await writeBackupFile(outputPath, envelope);
          const createdAt = Date.now();
          const history = [{ kind: 'backup', status: 'completed', createdAt, destination: outputPath, checksum: artifact.checksum, formatVersion: BACKUP_VERSION, sizeBytes: artifact.sizeBytes }, ...normalizeBackupHistory(state.backup.history)].slice(0, MAX_BACKUP_HISTORY);
          state.backup = { ...normalizeBackupStatus(state.backup), state: 'completed', lastBackupAt: createdAt, destination: outputPath, sizeBytes: artifact.sizeBytes, checksum: artifact.checksum, formatVersion: BACKUP_VERSION, history };
          await saveBackupStatus(state.backup);
          await appendLog('info', 'Headless admin state backup completed.', { destination: outputPath, checksum: artifact.checksum, sizeBytes: artifact.sizeBytes });
        } catch (error) {
          state.backup = { ...normalizeBackupStatus(state.backup), state: 'failed', error: error instanceof Error ? error.message : String(error) };
          await saveBackupStatus(state.backup);
          await appendLog('error', 'Headless admin state backup failed.');
        }
        return state.backup;
      })();
      try {
        return await backupPromise;
      } finally {
        backupPromise = null;
      }
    },

    async restoreBackup(input = {}, principal) {
      const current = await loadState();
      if (!isOwnerPrincipal(principal) || !principal?.id || principal.id !== current.owner?.id) {
        throw Object.assign(new Error('Only the configured owner can restore canonical state.'), {
          status: 403, code: 'permission_denied',
        });
      }
      const source = typeof input.path === 'string' ? input.path.trim() : '';
      if (!source || source.length > 4_096) throw invalidInput('A backup path is required.');
      const sourcePath = path.resolve(source);
      if (sourcePath === statePath) throw backupError('The live admin state cannot be restored as a backup.');
      const stats = await fs.stat(sourcePath).catch((error) => {
        throw Object.assign(new Error('The selected backup file is unavailable.'), { status: error?.code === 'EACCES' ? 403 : 404, code: error?.code === 'EACCES' ? 'permission_denied' : 'backup_not_found' });
      });
      if (!stats.isFile()) throw backupError('The selected backup path is not a file.');
      if (stats.size > MAX_BACKUP_BYTES) throw backupError('The selected backup is larger than the supported limit.');
      let envelope;
      try {
        envelope = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
      } catch {
        throw backupError('The selected backup is not valid JSON.');
      }
      envelope = validateBackupEnvelope(envelope, { requireCanonical: Boolean(stateStore?.restoreCanonicalSnapshot) });
      const rollbackDir = path.join(dataDir, 'backups', 'pre-restore');
      const rollbackPath = path.join(rollbackDir, `loomtv-pre-restore-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`);
      const previousClientState = stateStore?.exportCanonicalSnapshot ? null : await getClientState();
      const rollbackEnvelope = stateStore?.exportCanonicalSnapshot
        ? canonicalBackupEnvelope(stateStore.exportCanonicalSnapshot(), options.version)
        : legacyBackupEnvelopeFromState(current, options.version, previousClientState);
      const rollbackArtifact = await writeBackupFile(rollbackPath, rollbackEnvelope);
      const restoredAt = Date.now();
      const history = [{ kind: 'restore', status: 'completed', createdAt: restoredAt, source: sourcePath, destination: rollbackPath, checksum: envelope.checksum, formatVersion: envelope.version, sizeBytes: stats.size }, ...normalizeBackupHistory(current.backup.history)].slice(0, MAX_BACKUP_HISTORY);
      let replacement;
      let canonicalRestored = false;
      try {
        if (stateStore?.restoreCanonicalSnapshot) {
          await stateStore.restoreCanonicalSnapshot(envelope.data, restoredAt);
          canonicalRestored = true;
          replacement = normalizeState(stateStore.readAdminState());
        } else {
          replacement = normalizeState({ ...envelope.data, sessions: [], loginAttempts: [] });
        }
        if (!replacement.owner) throw backupError('The backup does not contain a usable owner account.');
        replacement.backup = { ...normalizeBackupStatus(current.backup), state: 'restored', lastRestoreAt: restoredAt, restoredFrom: sourcePath, rollbackDestination: rollbackPath, destination: sourcePath, sizeBytes: stats.size, checksum: envelope.checksum, formatVersion: envelope.version, history };
        if (canonicalRestored) {
          await saveBackupStatus(replacement.backup);
          await onCanonicalRestore?.();
          await notifyAllPlaybackSessionsRevoked('backup_restored', true);
        } else if (envelope.data.clientState !== undefined && replaceAllState) {
          await replaceAllState({ adminState: replacement, clientState: envelope.data.clientState });
        } else {
          await saveState(replacement);
          if (envelope.data.clientState !== undefined) await replaceClientState(envelope.data.clientState);
        }
      } catch (error) {
        let rollbackError;
        if (canonicalRestored) {
          try { await stateStore.restoreCanonicalSnapshot(rollbackEnvelope.data, Date.now()); } catch (failure) { rollbackError = failure; }
        } else if (!replaceAllState) await saveState(current);
        const invalidSnapshot = ['canonical_backup_incompatible','canonical_backup_invalid','canonical_owner_mismatch','canonical_state_invalid']
          .includes(error?.code);
        throw Object.assign(new Error('The canonical state could not be restored.'), {
          status: invalidSnapshot && !rollbackError ? 422 : 500,
          code: invalidSnapshot && !rollbackError ? 'invalid_backup' : 'canonical_state_restore_failed',
          cause: rollbackError ? new AggregateError([error, rollbackError], 'Canonical restore and rollback both failed.') : error,
        });
      }
      Object.keys(current).forEach((key) => { delete current[key]; });
      Object.assign(current, replacement);
      if (!canonicalRestored) await notifyAllPlaybackSessionsRevoked('backup_restored');
      await appendLog('warn', 'Headless admin state restored from backup.', { source: sourcePath, checksum: envelope.checksum, rollbackDestination: rollbackPath, rollbackSizeBytes: rollbackArtifact.sizeBytes });
      return { restored: true, source: sourcePath, checksum: envelope.checksum, rollbackDestination: rollbackPath, backup: current.backup };
    },
  };
}

export const headlessAdminStateFilename = STATE_FILENAME;
export { normalizeState as normalizeHeadlessAdminState };
