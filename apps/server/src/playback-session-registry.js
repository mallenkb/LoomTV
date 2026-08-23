import { randomBytes, randomUUID } from 'node:crypto';

export const PLAYBACK_SESSION_ACTIONS = Object.freeze(['direct', 'hls', 'download']);
export const DEFAULT_PLAYBACK_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_PLAYBACK_ABSOLUTE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_PLAYBACK_SESSIONS = 4_096;
export const DEFAULT_PLAYBACK_SWEEP_INTERVAL_MS = 5 * 1000;
// Native HLS playlists can advertise up to 45 two-second segments. Keep the
// previous capability usable for the full playlist/retry horizon while a
// client receives the rotated token.
export const DEFAULT_PLAYBACK_TOKEN_OVERLAP_MS = 90 * 1000;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function nonNegativeInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(maximum, Math.trunc(value)));
}

function sessionError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function actionValue(value) {
  const action = String(value || '').trim().toLowerCase();
  return PLAYBACK_SESSION_ACTIONS.includes(action) ? action : null;
}

function principalValue(input) {
  const value = input?.principalId ?? input?.userId;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : null;
}

function itemValue(input) {
  return typeof input?.itemId === 'string' && input.itemId.trim()
    ? input.itemId.trim().slice(0, 128)
    : null;
}

function snapshot(entry, includeToken = false) {
  if (!entry) return null;
  return {
    id: entry.id,
    ...(includeToken ? { token: entry.token } : {}),
    principalId: entry.principalId,
    principalType: entry.principalType,
    itemId: entry.itemId,
    action: entry.action,
    profile: entry.profile,
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    idleExpiresAt: entry.idleExpiresAt,
    absoluteExpiresAt: entry.absoluteExpiresAt,
    expiresAt: Math.min(entry.idleExpiresAt, entry.absoluteExpiresAt),
    renewedAt: entry.renewedAt,
    revokedAt: entry.revokedAt,
    revokeReason: entry.revokeReason,
  };
}

/**
 * In-memory playback capabilities shared by direct and HLS playback.
 *
 * The clock is injected instead of captured at module load time. Callers can
 * use `sweep()` deterministically in tests, while the production interval is
 * only a prompt for the same clock-driven expiry logic.
 */
export function createPlaybackSessionRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const idleTimeoutMs = positiveInteger(options.idleTimeoutMs, DEFAULT_PLAYBACK_IDLE_TIMEOUT_MS);
  const absoluteTimeoutMs = positiveInteger(options.absoluteTimeoutMs, DEFAULT_PLAYBACK_ABSOLUTE_TIMEOUT_MS);
  const maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_PLAYBACK_SESSIONS, 65_536);
  const sweepIntervalMs = Number.isFinite(options.sweepIntervalMs)
    ? Math.max(0, Math.trunc(options.sweepIntervalMs))
    : DEFAULT_PLAYBACK_SWEEP_INTERVAL_MS;
  const tokenOverlapMs = nonNegativeInteger(options.tokenOverlapMs, DEFAULT_PLAYBACK_TOKEN_OVERLAP_MS, 120 * 1000);
  const maxTokenAliases = positiveInteger(options.maxTokenAliases, 4, 32);
  const onRevoke = typeof options.onRevoke === 'function' ? options.onRevoke : null;
  const sessions = new Map();
  const tokenToId = new Map();
  let sweepTimer = null;
  let closed = false;

  function expiryFor(createdAt, lastActivityAt, entryOptions = {}) {
    const entryIdle = positiveInteger(entryOptions.idleTimeoutMs, idleTimeoutMs);
    const entryAbsolute = positiveInteger(entryOptions.absoluteTimeoutMs, absoluteTimeoutMs);
    const activeIdle = positiveInteger(entryOptions.activeIdleTimeoutMs, entryIdle);
    const absoluteExpiresAt = Number.isFinite(entryOptions.absoluteExpiresAt)
      ? Math.max(createdAt, Math.trunc(entryOptions.absoluteExpiresAt))
      : createdAt + entryAbsolute;
    const idleExpiresAt = Math.min(lastActivityAt + entryIdle, absoluteExpiresAt);
    return { idleExpiresAt, absoluteExpiresAt, idleTimeoutMs: entryIdle, activeIdleTimeoutMs: activeIdle, absoluteTimeoutMs: entryAbsolute };
  }

  function pruneTokenAliases(currentTime = now()) {
    for (const entry of sessions.values()) {
      for (const [token, expiresAt] of entry.tokenAliases) {
        if (expiresAt <= currentTime) {
          entry.tokenAliases.delete(token);
          if (tokenToId.get(token) === entry.id) tokenToId.delete(token);
        }
      }
    }
  }

  function resolve(identifier, currentTime = now()) {
    if (!identifier) return null;
    const id = sessions.has(identifier) ? identifier : tokenToId.get(identifier);
    const entry = id ? sessions.get(id) || null : null;
    if (!entry) return null;
    const aliasExpiresAt = entry.tokenAliases.get(identifier);
    if (aliasExpiresAt !== undefined && aliasExpiresAt <= currentTime) {
      entry.tokenAliases.delete(identifier);
      if (tokenToId.get(identifier) === entry.id) tokenToId.delete(identifier);
      return null;
    }
    return entry;
  }

  function matches(entry, expected = {}) {
    if (!entry) return false;
    const expectedPrincipal = expected.principalId ?? expected.userId;
    if (expectedPrincipal !== undefined && entry.principalId !== expectedPrincipal) return false;
    if (expected.itemId !== undefined && entry.itemId !== expected.itemId) return false;
    if (expected.profileId !== undefined && entry.profile?.profileId !== expected.profileId) return false;
    if (expected.deviceId !== undefined && entry.profile?.deviceId !== expected.deviceId) return false;
    if (expected.selectionRevision !== undefined && entry.profile?.selectionRevision !== expected.selectionRevision) return false;
    if (expected.sourceId !== undefined && entry.profile?.sourceId !== expected.sourceId) return false;
    if (expected.action !== undefined) {
      const actions = Array.isArray(expected.action) ? expected.action : [expected.action];
      if (!actions.includes(entry.action)) return false;
    }
    return true;
  }

  function expire(entry, currentTime) {
    return currentTime >= Math.min(entry.idleExpiresAt, entry.absoluteExpiresAt);
  }

  function notifyRevoked(entry, reason) {
    if (!onRevoke) return;
    try {
      const result = onRevoke(snapshot(entry), reason);
      if (result && typeof result.then === 'function') result.catch(() => undefined);
    } catch {
      // Cleanup callbacks must never make revocation incomplete.
    }
  }

  function revokeEntry(entry, reason = 'revoked', currentTime = now()) {
    if (!entry || !sessions.has(entry.id)) return false;
    sessions.delete(entry.id);
    tokenToId.delete(entry.token);
    for (const token of entry.tokenAliases.keys()) {
      if (tokenToId.get(token) === entry.id) tokenToId.delete(token);
    }
    entry.tokenAliases.clear();
    entry.revokedAt = currentTime;
    entry.revokeReason = String(reason).slice(0, 64);
    notifyRevoked(entry, entry.revokeReason);
    return true;
  }

  function oldestEntry(excludeId = null) {
    let oldest = null;
    for (const entry of sessions.values()) {
      if (entry.id === excludeId) continue;
      if (!oldest || entry.lastActivityAt < oldest.lastActivityAt
        || (entry.lastActivityAt === oldest.lastActivityAt && entry.createdAt < oldest.createdAt)) {
        oldest = entry;
      }
    }
    return oldest;
  }

  function sweep(currentTime = now()) {
    let removed = 0;
    pruneTokenAliases(currentTime);
    for (const entry of [...sessions.values()]) {
      if (expire(entry, currentTime)) removed += revokeEntry(entry, 'expired', currentTime) ? 1 : 0;
    }
    while (sessions.size > maxSessions) {
      const oldest = oldestEntry();
      if (!oldest || !revokeEntry(oldest, 'capacity', currentTime)) break;
      removed += 1;
    }
    return removed;
  }

  function ensureOpen() {
    if (closed) throw sessionError(503, 'playback_registry_closed', 'Playback sessions are draining.');
  }

  function create(input = {}) {
    ensureOpen();
    const principalId = principalValue(input);
    const itemId = itemValue(input);
    const action = actionValue(input.action);
    if (!principalId || !itemId || !action) {
      throw sessionError(400, 'playback_session_invalid', 'A playback session requires a principal, media item, and action.');
    }
    const createdAt = Number.isFinite(input.createdAt) ? Math.trunc(input.createdAt) : now();
    const lastActivityAt = Number.isFinite(input.lastActivityAt) ? Math.trunc(input.lastActivityAt) : createdAt;
    const expiry = expiryFor(createdAt, lastActivityAt, input);
    sweep(createdAt);
    let token = typeof input.token === 'string' && input.token ? input.token : randomBytes(24).toString('base64url');
    while (tokenToId.has(token)) token = randomBytes(24).toString('base64url');
    let id = typeof input.id === 'string' && input.id ? input.id : randomUUID();
    while (sessions.has(id)) id = randomUUID();
    const entry = {
      id,
      token,
      principalId,
      principalType: typeof input.principalType === 'string' ? input.principalType.slice(0, 32) : undefined,
      itemId,
      action,
      profile: input.profile && typeof input.profile === 'object' ? { ...input.profile } : null,
      createdAt,
      lastActivityAt,
      idleExpiresAt: expiry.idleExpiresAt,
      absoluteExpiresAt: expiry.absoluteExpiresAt,
      idleTimeoutMs: expiry.idleTimeoutMs,
      activeIdleTimeoutMs: expiry.activeIdleTimeoutMs,
      absoluteTimeoutMs: expiry.absoluteTimeoutMs,
      tokenOverlapMs: nonNegativeInteger(input.tokenOverlapMs, tokenOverlapMs, 120 * 1000),
      tokenAliases: new Map(),
      renewedAt: undefined,
      revokedAt: undefined,
      revokeReason: undefined,
    };
    sessions.set(entry.id, entry);
    tokenToId.set(entry.token, entry.id);
    sweep(createdAt);
    return snapshot(entry, true);
  }

  function authorize(identifier, expected = {}, currentTime = now()) {
    const entry = resolve(identifier, currentTime);
    if (!entry || !matches(entry, expected)) return null;
    if (expire(entry, currentTime)) {
      revokeEntry(entry, 'expired', currentTime);
      return null;
    }
    return { ...snapshot(entry), token: entry.token };
  }

  function touch(identifier, currentTime = now(), touchOptions = {}) {
    const entry = resolve(identifier, currentTime);
    if (!entry || expire(entry, currentTime)) {
      if (entry) revokeEntry(entry, 'expired', currentTime);
      return null;
    }
    if (touchOptions.activate && entry.activeIdleTimeoutMs) entry.idleTimeoutMs = entry.activeIdleTimeoutMs;
    if (Number.isFinite(touchOptions.idleTimeoutMs)) {
      entry.idleTimeoutMs = positiveInteger(touchOptions.idleTimeoutMs, entry.idleTimeoutMs);
    }
    entry.lastActivityAt = currentTime;
    entry.idleExpiresAt = Math.min(currentTime + entry.idleTimeoutMs, entry.absoluteExpiresAt);
    return snapshot(entry);
  }

  function renew(identifier, expected = {}, currentTime = now()) {
    ensureOpen();
    const entry = resolve(identifier, currentTime);
    // A rotated capability may remain valid for media requests during its
    // bounded overlap, but it must never rotate the lease again. Renewal
    // accepts the current token or an authenticated session id only.
    const isSessionId = typeof identifier === 'string' && sessions.has(identifier);
    if (!isSessionId && (!entry || entry.token !== identifier)) return null;
    if (!entry || !matches(entry, expected) || expire(entry, currentTime)) {
      if (entry && expire(entry, currentTime)) revokeEntry(entry, 'expired', currentTime);
      return null;
    }
    const previousToken = entry.token;
    let nextToken = randomBytes(24).toString('base64url');
    while (tokenToId.has(nextToken)) nextToken = randomBytes(24).toString('base64url');
    const overlap = nonNegativeInteger(entry.tokenOverlapMs, tokenOverlapMs, 120 * 1000);
    if (overlap > 0) {
      entry.tokenAliases.set(previousToken, currentTime + overlap);
      while (entry.tokenAliases.size > maxTokenAliases) {
        const oldestToken = entry.tokenAliases.keys().next().value;
        entry.tokenAliases.delete(oldestToken);
        if (tokenToId.get(oldestToken) === entry.id) tokenToId.delete(oldestToken);
      }
    } else tokenToId.delete(previousToken);
    entry.token = nextToken;
    tokenToId.set(nextToken, entry.id);
    entry.idleTimeoutMs = entry.activeIdleTimeoutMs || entry.idleTimeoutMs;
    entry.lastActivityAt = currentTime;
    // `absoluteExpiresAt` is a hard cap measured from creation. Renewal may
    // extend idle time, never the total lifetime of a playback capability.
    entry.idleExpiresAt = Math.min(currentTime + entry.idleTimeoutMs, entry.absoluteExpiresAt);
    entry.renewedAt = currentTime;
    return snapshot(entry, true);
  }

  function revoke(identifier, reason = 'revoked', currentTime = now()) {
    return revokeEntry(resolve(identifier, currentTime), reason, currentTime);
  }

  function remove(identifier) {
    const entry = resolve(identifier);
    if (!entry) return false;
    sessions.delete(entry.id);
    tokenToId.delete(entry.token);
    for (const token of entry.tokenAliases.keys()) {
      if (tokenToId.get(token) === entry.id) tokenToId.delete(token);
    }
    entry.tokenAliases.clear();
    return true;
  }

  function revokeByPrincipal(principalId, reason = 'principal_revoked', currentTime = now()) {
    let count = 0;
    for (const entry of [...sessions.values()]) {
      if (entry.principalId === principalId) count += revokeEntry(entry, reason, currentTime) ? 1 : 0;
    }
    return count;
  }

  function revokeByDevice(deviceId, reason = 'device_revoked', currentTime = now()) {
    let count = 0;
    for (const entry of [...sessions.values()]) {
      if (entry.profile?.deviceId === deviceId) count += revokeEntry(entry, reason, currentTime) ? 1 : 0;
    }
    return count;
  }

  function revokeByAuthenticationSession(authenticationSessionId, reason = 'auth_session_revoked', currentTime = now()) {
    let count = 0;
    for (const entry of [...sessions.values()]) {
      if (entry.profile?.authenticationSessionId === authenticationSessionId) {
        count += revokeEntry(entry, reason, currentTime) ? 1 : 0;
      }
    }
    return count;
  }

  function revokeByItem(itemId, reason = 'item_revoked', currentTime = now()) {
    let count = 0;
    for (const entry of [...sessions.values()]) {
      if (entry.itemId === itemId) count += revokeEntry(entry, reason, currentTime) ? 1 : 0;
    }
    return count;
  }

  function revokeAll(reason = 'revoked', currentTime = now()) {
    let count = 0;
    for (const entry of [...sessions.values()]) count += revokeEntry(entry, reason, currentTime) ? 1 : 0;
    return count;
  }

  function get(identifier) {
    return snapshot(resolve(identifier));
  }

  function isSessionIdentifier(identifier) {
    return typeof identifier === 'string' && sessions.has(identifier);
  }

  function list(currentTime = now()) {
    sweep(currentTime);
    return [...sessions.values()]
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
      .map((entry) => snapshot(entry));
  }

  function stats(currentTime = now()) {
    sweep(currentTime);
    const byAction = Object.fromEntries(PLAYBACK_SESSION_ACTIONS.map((action) => [action, 0]));
    for (const entry of sessions.values()) byAction[entry.action] = (byAction[entry.action] || 0) + 1;
    return { active: sessions.size, max: maxSessions, byAction };
  }

  function close(reason = 'shutdown') {
    if (closed) return 0;
    closed = true;
    if (sweepTimer) clearIntervalFn(sweepTimer);
    sweepTimer = null;
    return revokeAll(reason);
  }

  if (sweepIntervalMs > 0) {
    sweepTimer = setIntervalFn(() => sweep(), sweepIntervalMs);
    sweepTimer?.unref?.();
  }

  return {
    create,
    authorize,
    touch,
    renew,
    retry: create,
    revoke,
    revokeByPrincipal,
    revokeByDevice,
    revokeByAuthenticationSession,
    revokeByItem,
    revokeAll,
    remove,
    get,
    list,
    sweep,
    stats,
    isSessionIdentifier,
    size: () => sessions.size,
    isClosed: () => closed,
    close,
    stop: close,
  };
}
