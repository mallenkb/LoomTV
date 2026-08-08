import fsPromises from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_TOTAL_CACHE_BYTES = 20 * 1024 ** 3;
export const DEFAULT_MAX_SESSION_CACHE_BYTES = 4 * 1024 ** 3;
export const DEFAULT_MIN_FREE_CACHE_BYTES = 256 * 1024 ** 2;
export const DEFAULT_CACHE_QUOTA_SWEEP_INTERVAL_MS = 15 * 1000;

function boundedBytes(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function nonNegativeBytes(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(maximum, Math.trunc(value)));
}

function quotaError(status, code, message, details = {}) {
  return Object.assign(new Error(message), { status, code, ...details });
}

function inside(rootPath, candidate) {
  const relative = path.relative(rootPath, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function statfsFreeBytes(stats) {
  const blockSize = Number(stats?.bsize || stats?.frsize);
  const availableBlocks = Number(stats?.bavail ?? stats?.bfree);
  if (!Number.isFinite(blockSize) || !Number.isFinite(availableBlocks) || blockSize < 0 || availableBlocks < 0) return null;
  return blockSize * availableBlocks;
}

/**
 * A reservation-aware byte quota for transcode output. Reservations are made
 * before an output directory becomes visible; scans remain the source of
 * truth for already-created files and therefore also reconcile orphaned data.
 */
export function createTranscodeCacheQuota(options = {}) {
  const rootPath = path.resolve(options.rootPath || '.');
  const fileSystem = options.fileSystem || fsPromises;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxTotalBytes = boundedBytes(options.maxTotalBytes, DEFAULT_MAX_TOTAL_CACHE_BYTES);
  const maxSessionBytes = boundedBytes(options.maxSessionBytes, DEFAULT_MAX_SESSION_CACHE_BYTES);
  const minFreeBytes = nonNegativeBytes(options.minFreeBytes, DEFAULT_MIN_FREE_CACHE_BYTES);
  const sweepIntervalMs = Number.isFinite(options.sweepIntervalMs)
    ? Math.max(0, Math.trunc(options.sweepIntervalMs))
    : DEFAULT_CACHE_QUOTA_SWEEP_INTERVAL_MS;
  const reservations = new Map();
  let scanPromise = null;
  let lastStatus = {
    state: 'unknown',
    totalBytes: 0,
    freeBytes: null,
    reservedBytes: 0,
    maxTotalBytes,
    maxSessionBytes,
    minFreeBytes,
    sessionBytes: new Map(),
    violations: [],
  };

  function reservedBytes() {
    return [...reservations.values()].reduce((sum, reservation) => sum + reservation.bytes, 0);
  }

  async function scanFiles() {
    const sessionBytes = new Map();
    let totalBytes = 0;
    let fileCount = 0;
    let directoryCount = 0;
    const pending = [{ directory: rootPath, sessionId: null }];
    while (pending.length) {
      const { directory, sessionId } = pending.pop();
      let entries;
      try {
        entries = await fileSystem.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw quotaError(503, 'transcode_cache_unavailable', 'The transcode cache could not be inspected.', { cause: error });
      }
      directoryCount += 1;
      for (const entry of entries) {
        if (entry.isSymbolicLink?.()) continue;
        const candidate = path.resolve(directory, entry.name);
        if (!inside(rootPath, candidate)) continue;
        if (entry.isDirectory?.()) {
          pending.push({ directory: candidate, sessionId: sessionId || entry.name });
          continue;
        }
        if (!entry.isFile?.()) continue;
        const stats = await fileSystem.stat(candidate).catch((error) => {
          if (error?.code === 'ENOENT') return null;
          throw quotaError(503, 'transcode_cache_unavailable', 'The transcode cache could not be inspected.', { cause: error });
        });
        if (!stats) continue;
        const bytes = Number.isFinite(stats.size) && stats.size >= 0 ? Number(stats.size) : 0;
        totalBytes += bytes;
        fileCount += 1;
        if (sessionId) sessionBytes.set(sessionId, (sessionBytes.get(sessionId) || 0) + bytes);
      }
    }
    let freeBytes = null;
    if (typeof fileSystem.statfs === 'function') {
      freeBytes = await fileSystem.statfs(rootPath).then(statfsFreeBytes).catch(() => null);
    }
    return { totalBytes, freeBytes, sessionBytes, fileCount, directoryCount };
  }

  function violationsFor(status) {
    const violations = [];
    if (status.totalBytes + status.reservedBytes >= maxTotalBytes) violations.push('total_bytes');
    if (status.freeBytes === null && minFreeBytes > 0) violations.push('free_space_unknown');
    if (status.freeBytes !== null && status.freeBytes < minFreeBytes) violations.push('free_space');
    for (const bytes of status.sessionBytes.values()) {
      if (bytes > maxSessionBytes) {
        violations.push('session_bytes');
        break;
      }
    }
    return violations;
  }

  function currentStatus() {
    const current = { ...lastStatus, reservedBytes: reservedBytes() };
    current.violations = violationsFor(current);
    return current;
  }

  async function status() {
    if (!scanPromise) {
      scanPromise = scanFiles()
        .then((scan) => {
          const next = {
            ...lastStatus,
            ...scan,
            reservedBytes: reservedBytes(),
          };
          next.violations = violationsFor(next);
          next.state = next.violations.length ? 'over-quota' : 'within-quota';
          lastStatus = next;
          return next;
        })
        .catch((error) => {
          lastStatus = {
            ...lastStatus,
            state: 'unavailable',
            violations: ['unavailable'],
            error: error?.code || 'transcode_cache_unavailable',
          };
          throw error;
        })
        .finally(() => { scanPromise = null; });
    }
    return scanPromise;
  }

  async function checkAdmission() {
    const current = { ...(await status()), reservedBytes: reservedBytes() };
    if (current.state === 'unavailable') throw quotaError(503, 'transcode_cache_unavailable', 'The transcode cache is unavailable.');
    if (current.freeBytes === null && minFreeBytes > 0) {
      throw quotaError(503, 'transcode_cache_free_space_unknown', 'The server could not verify free cache space.');
    }
    if (current.totalBytes + current.reservedBytes >= maxTotalBytes) {
      throw quotaError(507, 'transcode_cache_quota', 'The transcode cache has reached its total byte quota.');
    }
    if (current.freeBytes !== null && current.freeBytes < minFreeBytes) {
      throw quotaError(507, 'transcode_cache_free_space', 'The server does not have enough free cache space.');
    }
    return current;
  }

  async function reserve(id, principalId, bytes = maxSessionBytes) {
    if (reservations.has(id)) return reservations.get(id);
    const reservationBytes = boundedBytes(bytes, maxSessionBytes);
    const current = { ...(await status()), reservedBytes: reservedBytes() };
    if (current.state === 'unavailable') throw quotaError(503, 'transcode_cache_unavailable', 'The transcode cache is unavailable.');
    if (current.freeBytes === null && minFreeBytes > 0) {
      throw quotaError(503, 'transcode_cache_free_space_unknown', 'The server could not verify free cache space.');
    }
    if (current.totalBytes + current.reservedBytes + reservationBytes > maxTotalBytes) {
      throw quotaError(507, 'transcode_cache_quota', 'The transcode cache cannot reserve space for this transcode.');
    }
    if (current.freeBytes !== null && current.freeBytes < minFreeBytes + reservationBytes) {
      throw quotaError(507, 'transcode_cache_free_space', 'The server does not have enough free cache space.');
    }
    const reservation = { id, principalId, bytes: reservationBytes, createdAt: now() };
    reservations.set(id, reservation);
    lastStatus = { ...lastStatus, reservedBytes: reservedBytes() };
    return reservation;
  }

  function release(id) {
    const reservation = reservations.get(id);
    if (!reservation) return false;
    reservations.delete(id);
    lastStatus = { ...lastStatus, reservedBytes: Math.max(0, lastStatus.reservedBytes - reservation.bytes) };
    return true;
  }

  function snapshot() {
    const current = currentStatus();
    return {
      state: current.state,
      totalBytes: current.totalBytes,
      freeBytes: current.freeBytes,
      reservedBytes: current.reservedBytes,
      maxTotalBytes,
      maxSessionBytes,
      minFreeBytes,
      fileCount: current.fileCount || 0,
      directoryCount: current.directoryCount || 0,
      sessionBytes: Object.fromEntries(current.sessionBytes || []),
      violations: [...current.violations],
    };
  }

  async function sessionBytes(sessionId) {
    const current = await status();
    return {
      bytes: current.sessionBytes.get(sessionId) || 0,
      totalBytes: current.totalBytes,
      freeBytes: current.freeBytes,
      violations: violationsFor(current),
    };
  }

  return {
    rootPath,
    maxTotalBytes,
    maxSessionBytes,
    minFreeBytes,
    sweepIntervalMs,
    status,
    checkAdmission,
    reserve,
    release,
    sessionBytes,
    snapshot,
  };
}
