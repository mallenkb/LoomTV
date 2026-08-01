import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createHeadlessLibraryScanner } from './library-scanner.js';
import {
  AUTH_PERMISSIONS,
  USER_ROLES,
  canAccessRoot,
  hasPermission,
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
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const LOGIN_DELAY_MS = 250;
const STATE_FILENAME = 'headless-admin.json';
const STATE_VERSION = 1;
const BACKUP_FORMAT = 'loomtv-headless-backup';
const BACKUP_VERSION = 1;
const MAX_BACKUP_HISTORY = 24;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

function backupEnvelopeFromState(state, sourceVersion, clientState) {
  const data = backupDataFromState(state, clientState);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    source: { version: sourceVersion || '0.0.0', stateVersion: STATE_VERSION },
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

function validateBackupEnvelope(value) {
  // Backups created before the checksummed envelope were raw admin-state JSON
  // files. Accept them as a one-time migration so an upgrade cannot strand a
  // NAS owner with an otherwise valid recovery point.
  if (value && typeof value === 'object' && !value.format && value.owner && Array.isArray(value.roots)) {
    const data = backupDataFromState(value, undefined);
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      source: { version: 'legacy', stateVersion: STATE_VERSION },
      checksum: stableChecksum(data),
      data,
      legacy: true,
    };
  }
  if (!value || typeof value !== 'object' || value.format !== BACKUP_FORMAT) {
    throw backupError('The selected file is not a LoomTV backup.');
  }
  if (value.version !== BACKUP_VERSION || !value.data || typeof value.data !== 'object') {
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
  if (!value.data.owner || typeof value.data.owner !== 'object') {
    throw backupError('The backup does not contain an owner account.');
  }
  return value;
}

function hashToken(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function requestAddress(value) {
  const normalized = String(value || 'unknown').trim();
  return normalized.slice(0, 128) || 'unknown';
}

function authAttemptKey(kind, value) {
  return hashToken(`${kind}:${normalizedIdentity(value)}`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function isPathWithin(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
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
        tokenHash: entry.tokenHash,
        userId: typeof entry.userId === 'string' ? entry.userId.slice(0, 100) : state.owner?.id,
        deviceId: typeof entry.deviceId === 'string' && entry.deviceId.trim()
          ? entry.deviceId.trim().slice(0, MAX_DEVICE_ID_LENGTH)
          : null,
        createdAt: Number(entry.createdAt) || Date.now(),
        expiresAt: Number(entry.expiresAt),
      }))
      .slice(-MAX_SESSIONS);
  }
  if (Array.isArray(raw.loginAttempts)) {
    state.loginAttempts = raw.loginAttempts
      .filter((entry) => entry && typeof entry.key === 'string' && Number.isFinite(entry.lastAttemptAt))
      .map((entry) => ({
        key: entry.key.slice(0, 128),
        failures: Math.max(0, Math.min(MAX_LOGIN_ATTEMPTS, Number(entry.failures) || 0)),
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
        type: entry.type === 'tv' || entry.kind === 'episode' ? 'tv' : 'movie',
        title: typeof entry.title === 'string' ? entry.title.slice(0, 500) : path.basename(entry.path),
        kind: entry.kind === 'episode' ? 'episode' : 'movie',
        ...(Number.isSafeInteger(entry.year) && entry.year > 1900 && entry.year < 2200 ? { year: entry.year } : {}),
        ...(entry.animeLikely === true ? { animeLikely: true } : {}),
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
        available: entry.available !== false,
        indexedAt: Number(entry.indexedAt) || Date.now(),
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
  const dataDir = path.resolve(options.dataDir);
  const statePath = path.join(dataDir, STATE_FILENAME);
  const mediaDir = options.mediaDir ? path.resolve(options.mediaDir) : null;
  const getRuntimeHealth = options.getRuntimeHealth || (async () => ({}));
  const getSessions = options.getSessions || (async () => []);
  const getClientState = options.getClientState || (async () => null);
  const replaceClientState = options.replaceClientState || (async () => undefined);
  let statePromise;
  let writeQueue = Promise.resolve();
  let ownerCreationPromise = null;
  let backupPromise = null;

  async function saveState(state) {
    writeQueue = writeQueue.catch(() => undefined).then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const temporaryPath = `${statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, statePath);
    });
    return writeQueue;
  }

  async function writeBackupFile(destination, envelope) {
    const serialized = JSON.stringify(envelope, null, 2);
    if (Buffer.byteLength(serialized) > MAX_BACKUP_BYTES) throw backupError('The backup is larger than the supported limit.');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, destination);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const stats = await fs.stat(destination);
    return { sizeBytes: stats.size, checksum: envelope.checksum };
  }

  async function storageStatus(targetPath) {
    try {
      const [stats, writable] = await Promise.all([
        fs.statfs(targetPath),
        fs.access(targetPath).then(() => true).catch(() => false),
      ]);
      return {
        path: targetPath,
        writable,
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
      };
    } catch (error) {
      return { path: targetPath, writable: false, state: error?.code || 'unavailable' };
    }
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
      statePromise = fs.readFile(statePath, 'utf8')
        .then((contents) => normalizeState(JSON.parse(contents)))
        .catch(async (error) => {
          if (error?.code === 'ENOENT') {
            const state = defaultState();
            if (mediaDir) state.roots.push({ id: rootIdFor(mediaDir), path: mediaDir, kind: 'others', createdAt: Date.now() });
            await saveState(state);
            return state;
          }
          throw Object.assign(new Error('Persistent admin state could not be loaded safely.'), {
            status: 503,
            code: 'state_unavailable',
            cause: error,
          });
        })
        .then(async (state) => {
          if (mediaDir && state.roots.length === 0) {
            state.roots.push({ id: rootIdFor(mediaDir), path: mediaDir, kind: 'others', createdAt: Date.now() });
            await saveState(state);
          }
          return state;
        });
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
    await saveState(state);
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

  const scanner = createHeadlessLibraryScanner({ loadState, saveState, appendLog });

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

  function loginKeys(identity, address) {
    return [
      authAttemptKey('identity', identity || 'owner'),
      authAttemptKey('address', requestAddress(address)),
    ];
  }

  function pruneLoginAttempts(state, now = Date.now()) {
    state.loginAttempts = state.loginAttempts.filter((entry) => (
      entry.lastAttemptAt > now - LOGIN_WINDOW_MS || entry.lockedUntil > now
    ));
  }

  function loginLock(state, keys, now = Date.now()) {
    pruneLoginAttempts(state, now);
    const locked = state.loginAttempts.find((entry) => keys.includes(entry.key) && entry.lockedUntil > now);
    return locked ? Math.ceil((locked.lockedUntil - now) / 1000) : 0;
  }

  function rememberLoginFailure(state, keys, now = Date.now()) {
    pruneLoginAttempts(state, now);
    for (const key of keys) {
      const current = state.loginAttempts.find((entry) => entry.key === key);
      if (!current || current.lastAttemptAt <= now - LOGIN_WINDOW_MS) {
        state.loginAttempts.push({ key, failures: 1, firstAttemptAt: now, lastAttemptAt: now, lockedUntil: 0 });
        continue;
      }
      current.failures = Math.min(MAX_LOGIN_ATTEMPTS, current.failures + 1);
      current.lastAttemptAt = now;
      if (current.failures >= MAX_LOGIN_ATTEMPTS) current.lockedUntil = now + LOGIN_LOCKOUT_MS;
    }
    state.loginAttempts = state.loginAttempts.slice(-256);
  }

  function clearLoginAttempts(state, keys) {
    state.loginAttempts = state.loginAttempts.filter((entry) => !keys.includes(entry.key));
  }

  function activeUserSessions(state, userId) {
    const now = Date.now();
    return state.sessions.filter((entry) => entry.userId === userId && entry.expiresAt > now);
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
      tokenHash: hashToken(token),
      userId: principal.id,
      deviceId: typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim().slice(0, MAX_DEVICE_ID_LENGTH) : null,
      createdAt: Date.now(),
      expiresAt: Date.now() + ADMIN_TOKEN_TTL_MS,
    };
    state.sessions.push(session);
    await saveState(state);
    return { adminToken: token, expiresAt: session.expiresAt, user: principalView(principal) };
  }

  async function authenticateRequest(req) {
    const token = tokenFromRequest(req);
    if (!token) return null;
    const state = await loadState();
    const now = Date.now();
    const active = state.sessions.filter((entry) => entry.expiresAt > now && principalForUserId(state, entry.userId));
    const session = active.find((entry) => entry.tokenHash === hashToken(token));
    if (active.length !== state.sessions.length) {
      state.sessions = active;
      await saveState(state);
    }
    return session ? principalForUserId(state, session.userId) : null;
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
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((entry) => entry.tokenHash !== hashToken(token));
      if (state.sessions.length === before) return false;
      await saveState(state);
      return true;
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
      if (ownerCreationPromise) return ownerCreationPromise;
      ownerCreationPromise = (async () => {
        const state = await loadState();
        if (state.owner) throw Object.assign(new Error('The LoomTV owner has already been created.'), { status: 409 });
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) {
          throw invalidInput('The owner name must be between 1 and 80 characters.');
        }
        if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 256) {
          throw invalidInput('The owner password must be between 8 and 256 characters.');
        }
        const credentials = await hashPassword(input.password);
        state.owner = { id: randomUUID(), name: input.name.trim(), ...credentials };
        await saveState(state);
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
      const deviceId = typeof input.deviceId === 'string' && input.deviceId.trim()
        ? input.deviceId.trim().slice(0, MAX_DEVICE_ID_LENGTH)
        : null;
      const keys = loginKeys(identity || 'owner', address);
      const now = Date.now();
      const retryAfter = loginLock(state, keys, now);
      if (retryAfter) {
        await saveState(state);
        throw Object.assign(new Error('Too many sign-in attempts. Try again later.'), {
          status: 429,
          code: 'login_locked',
          retryAfter,
        });
      }

      const match = userByName(state, identity || 'owner');
      const credential = match?.record;
      await wait(LOGIN_DELAY_MS);
      const passwordValid = credential
        ? await verifyPassword(input.password, credential.salt, credential.hash)
        : await scrypt(input.password, 'loomtv-invalid-login-salt', PASSWORD_BYTES).then(() => false);
      if (!match || !passwordValid || (match.type === 'user' && match.record.disabled)) {
        rememberLoginFailure(state, keys, now);
        await saveState(state);
        await appendLog('warn', 'Rejected sign-in attempt.', { identity: identity || 'owner' });
        const lockedRetryAfter = loginLock(state, keys, now);
        throw Object.assign(new Error(lockedRetryAfter
          ? 'Too many sign-in attempts. Try again later.'
          : 'The account name or password is incorrect.'), {
          status: lockedRetryAfter ? 429 : 401,
          code: lockedRetryAfter ? 'login_locked' : 'invalid_credentials',
          ...(lockedRetryAfter ? { retryAfter: lockedRetryAfter } : {}),
        });
      }
      clearLoginAttempts(state, keys);
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
      if (changingAnother && !hasPermission(principal, 'users.manage')) throw permissionDenied('Only an account administrator can reset another password.');
      const targetIsOwner = state.owner?.id === targetId;
      if (changingAnother && targetIsOwner && !isOwnerPrincipal(principal)) {
        throw permissionDenied('Only the owner can reset the owner password.');
      }
      if (changingAnother && !targetIsOwner && !isOwnerPrincipal(principal)) ensureUserScope(principal, target);
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
      await appendLog('info', `Password changed for ${target.name}.`, { userId: targetId });
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

    async listLibraryItems(principal) {
      if (principal) ensurePrincipalPermission(principal, 'library.read');
      const items = await scanner.listItems();
      if (!principal || principal.rootIds === null || isOwnerPrincipal(principal)) return items;
      return items.filter((item) => canAccessRoot(principal, item.rootId));
    },

    async getLibraryItem(itemId, principal) {
      if (principal) ensurePrincipalPermission(principal, 'library.read');
      const item = await scanner.getItem(itemId);
      if (!item || (principal && !canAccessRoot(principal, item.rootId))) return null;
      return item;
    },

    async resolveMediaPath(itemId, principal) {
      if (principal && !isOwnerPrincipal(principal)
        && !hasPermission(principal, 'library.read')
        && !hasPermission(principal, 'stream')
        && !hasPermission(principal, 'transcode')
        && !hasPermission(principal, 'downloads')
        && !hasPermission(principal, 'media.delete')) throw permissionDenied();
      const item = await scanner.getItem(itemId);
      if (!item) throw Object.assign(new Error('Media item was not found.'), { status: 404 });
      if (principal && !canAccessRoot(principal, item.rootId)) throw permissionDenied('This account cannot access that library.');
      const root = (await loadState()).roots.find((entry) => entry.id === item.rootId);
      if (!root) throw Object.assign(new Error('Media root was removed.'), { status: 404 });
      const resolvedRoot = path.resolve(root.path);
      const resolvedPath = path.resolve(item.path);
      if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw Object.assign(new Error('Media path is outside its configured root.'), { status: 403 });
      }
      return { ...item, path: resolvedPath, rootPath: resolvedRoot };
    },

    async deleteLibraryItem(itemId, principal) {
      ensurePrincipalPermission(principal, 'media.delete');
      const state = await loadState();
      const item = state.catalog.find((entry) => entry.id === itemId);
      if (!item) throw Object.assign(new Error('Media item was not found.'), { status: 404 });
      if (!canAccessRoot(principal, item.rootId)) throw permissionDenied('This account cannot delete media from that library.');
      const root = state.roots.find((entry) => entry.id === item.rootId);
      if (!root) throw Object.assign(new Error('Media root was removed.'), { status: 404 });

      const rootRealPath = await fs.realpath(root.path).catch(() => path.resolve(root.path));
      const fileRealPath = await fs.realpath(item.path).catch((error) => {
        throw Object.assign(new Error('The media file is unavailable.'), { status: error?.code === 'EACCES' ? 403 : 409 });
      });
      if (!isPathWithin(rootRealPath, fileRealPath)) {
        throw Object.assign(new Error('Media path is outside its configured root.'), { status: 403 });
      }
      const stats = await fs.stat(fileRealPath).catch((error) => {
        throw Object.assign(new Error('The media file is unavailable.'), { status: error?.code === 'EACCES' ? 403 : 409 });
      });
      if (!stats.isFile()) throw Object.assign(new Error('The media path is not a file.'), { status: 409 });
      await fs.unlink(fileRealPath).catch((error) => {
        throw Object.assign(new Error('The media file could not be deleted.'), { status: error?.code === 'EACCES' ? 403 : 500 });
      });
      state.catalog = state.catalog.filter((entry) => entry.id !== itemId);
      await saveState(state);
      await appendLog('info', `Media file deleted: ${item.relativePath || item.path}`, { itemId, userId: principal.id });
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
      const state = mediaState !== 'online'
        ? 'offline'
        : transcoderState === 'unavailable' ? 'degraded' : 'healthy';
      const backendLabel = transcoderHealth.recommendedBackend && transcoderHealth.recommendedBackend !== 'software'
        ? ` Recommended backend: ${transcoderHealth.recommendedBackend}.`
        : '';
      const currentState = await loadState();
      const catalogCount = Array.isArray(currentState.catalog) ? currentState.catalog.length : 0;
      const storage = summaryOnly ? null : await storageStatus(dataDir);
      const latestBackup = normalizeBackupHistory(currentState.backup?.history).find((entry) => entry.kind === 'backup' && entry.status === 'completed');
      const checks = [
        { name: 'Headless runtime', state: 'pass', message: 'The server is running without Electron.' },
        { name: 'Headless catalog', state: 'pass', message: `${catalogCount} media records and scan checkpoints are available without Electron.` },
        { name: 'Media root', state: mediaState === 'online' ? 'pass' : 'warn', message: runtime.media?.path && !summaryOnly ? `${runtime.media.path} is ${mediaState}.` : `Media root is ${mediaState}.` },
        { name: 'FFmpeg transcoder', state: transcoderState === 'available' ? 'pass' : transcoderState === 'limited' ? 'warn' : 'fail', message: transcoderHealth.available ? `FFmpeg is available.${backendLabel}` : 'FFmpeg is not available on this host.' },
      ];
      if (!summaryOnly) {
        checks.push({ name: 'Persistent storage', state: storage?.writable && (storage.freeBytes === undefined || storage.freeBytes > 64 * 1024 * 1024) ? 'pass' : 'warn', message: storage?.writable ? `${storage.freeBytes == null ? 'Available' : `${Math.round(storage.freeBytes / 1024 / 1024)} MB free`}.` : 'Data directory is not writable.' });
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
        await saveState(state);
        try {
          const envelope = backupEnvelopeFromState(state, options.version, await getClientState());
          const outputPath = path.join(destination, `loomtv-backup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`);
          const artifact = await writeBackupFile(outputPath, envelope);
          const createdAt = Date.now();
          const history = [{ kind: 'backup', status: 'completed', createdAt, destination: outputPath, checksum: artifact.checksum, formatVersion: BACKUP_VERSION, sizeBytes: artifact.sizeBytes }, ...normalizeBackupHistory(state.backup.history)].slice(0, MAX_BACKUP_HISTORY);
          state.backup = { ...normalizeBackupStatus(state.backup), state: 'completed', lastBackupAt: createdAt, destination: outputPath, sizeBytes: artifact.sizeBytes, checksum: artifact.checksum, formatVersion: BACKUP_VERSION, history };
          await saveState(state);
          await appendLog('info', 'Headless admin state backup completed.', { destination: outputPath, checksum: artifact.checksum, sizeBytes: artifact.sizeBytes });
        } catch (error) {
          state.backup = { ...normalizeBackupStatus(state.backup), state: 'failed', error: error instanceof Error ? error.message : String(error) };
          await saveState(state);
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
      ensurePrincipalPermission(principal, 'backup.create');
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
      envelope = validateBackupEnvelope(envelope);
      const current = await loadState();
      const rollbackDir = path.join(dataDir, 'backups', 'pre-restore');
      const rollbackPath = path.join(rollbackDir, `loomtv-pre-restore-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`);
      const previousClientState = await getClientState();
      const rollbackEnvelope = backupEnvelopeFromState(current, options.version, previousClientState);
      const rollbackArtifact = await writeBackupFile(rollbackPath, rollbackEnvelope);
      const replacement = normalizeState({ ...envelope.data, sessions: [], loginAttempts: [] });
      if (!replacement.owner) throw backupError('The backup does not contain a usable owner account.');
      const restoredAt = Date.now();
      const history = [{ kind: 'restore', status: 'completed', createdAt: restoredAt, source: sourcePath, destination: rollbackPath, checksum: envelope.checksum, formatVersion: envelope.version, sizeBytes: stats.size }, ...normalizeBackupHistory(current.backup.history)].slice(0, MAX_BACKUP_HISTORY);
      replacement.backup = { ...normalizeBackupStatus(current.backup), state: 'restored', lastRestoreAt: restoredAt, restoredFrom: sourcePath, rollbackDestination: rollbackPath, destination: sourcePath, sizeBytes: stats.size, checksum: envelope.checksum, formatVersion: envelope.version, history };
      await saveState(replacement);
      try {
        if (envelope.data.clientState !== undefined) await replaceClientState(envelope.data.clientState);
      } catch (error) {
        // Keep the restore all-or-nothing across the admin and hosted-client
        // stores. The rollback artifact remains available if this recovery
        // write itself fails.
        await saveState(current);
        throw Object.assign(new Error('The hosted client profile state could not be restored.'), {
          status: 500,
          code: 'client_state_restore_failed',
          cause: error,
        });
      }
      Object.keys(current).forEach((key) => { delete current[key]; });
      Object.assign(current, replacement);
      await appendLog('warn', 'Headless admin state restored from backup.', { source: sourcePath, checksum: envelope.checksum, rollbackDestination: rollbackPath, rollbackSizeBytes: rollbackArtifact.sizeBytes });
      return { restored: true, source: sourcePath, checksum: envelope.checksum, rollbackDestination: rollbackPath, backup: current.backup };
    },
  };
}

export const headlessAdminStateFilename = STATE_FILENAME;
