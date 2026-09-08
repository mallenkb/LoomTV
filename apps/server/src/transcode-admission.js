import { randomUUID } from 'node:crypto';

export const DEFAULT_GLOBAL_TRANSCODE_LIMIT = 2;
export const DEFAULT_PRINCIPAL_TRANSCODE_LIMIT = 1;
export const DEFAULT_TRANSCODE_QUEUE_LIMIT = 16;
export const DEFAULT_PRINCIPAL_QUEUE_LIMIT = 4;

/** @param {number | undefined} value @param {number} fallback */
function bounded(value, fallback, maximum = 256) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

/** @param {number} status @param {string} code @param {string} message @param {number} [retryAfter] */
function admissionError(status, code, message, retryAfter) {
  return Object.assign(new Error(message), {
    status,
    code,
    ...(retryAfter ? { retryAfter } : {}),
  });
}

/**
 * FIFO-ish transcode admission with both global and principal-specific caps.
 * A permit is deliberately idempotent: every failure and shutdown path can
 * call `release()` without leaking a slot or advancing the queue twice.
 * @param {{ globalLimit?: number, principalLimit?: number, queueLimit?: number, principalQueueLimit?: number }} options
 */
export function createTranscodeAdmission(options = {}) {
  const globalLimit = bounded(options.globalLimit, DEFAULT_GLOBAL_TRANSCODE_LIMIT, 64);
  const principalLimit = bounded(options.principalLimit, DEFAULT_PRINCIPAL_TRANSCODE_LIMIT, 32);
  const queueLimit = bounded(options.queueLimit, DEFAULT_TRANSCODE_QUEUE_LIMIT, 256);
  const principalQueueLimit = bounded(options.principalQueueLimit, DEFAULT_PRINCIPAL_QUEUE_LIMIT, 64);
  /** @typedef {{ id: string, principalId: string, acquiredAt: number, released: boolean, release: () => boolean }} Permit */
  /** @typedef {{ id: string, principalId: string, resolve: (permit: Permit) => void, reject: (error: Error) => void, signal?: AbortSignal, onAbort: () => void }} QueueEntry */
  /** @type {Map<string, Permit>} */
  const active = new Map();
  /** @type {QueueEntry[]} */
  const queued = [];
  let closed = false;
  let failed = 0;
  let canceled = 0;

  /** @param {unknown} value */
  function principalKey(value) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : 'anonymous';
  }

  /** @param {string} principalId */
  function activeFor(principalId) {
    let count = 0;
    for (const permit of active.values()) if (permit.principalId === principalId) count += 1;
    return count;
  }

  /** @param {string} principalId */
  function queuedFor(principalId) {
    return queued.reduce((count, entry) => count + (entry.principalId === principalId ? 1 : 0), 0);
  }

  /** @param {string} principalId */
  function canAdmit(principalId) {
    return active.size < globalLimit && activeFor(principalId) < principalLimit;
  }

  /** @param {string} principalId @param {string} [requestId] @returns {Permit} */
  function makePermit(principalId, requestId) {
    const permit = {
      id: requestId || randomUUID(),
      principalId,
      acquiredAt: Date.now(),
      released: false,
      release() {
        if (permit.released) return false;
        permit.released = true;
        active.delete(permit.id);
        pump();
        return true;
      },
    };
    active.set(permit.id, permit);
    return permit;
  }

  /** @param {QueueEntry} entry */
  function removeQueued(entry) {
    const index = queued.indexOf(entry);
    if (index < 0) return false;
    queued.splice(index, 1);
    return true;
  }

  /** @param {QueueEntry} entry @param {Error} error */
  function rejectQueued(entry, error, { countCancellation = false } = {}) {
    if (!removeQueued(entry)) return false;
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
    if (countCancellation) canceled += 1;
    entry.reject(error);
    return true;
  }

  function pump() {
    if (closed) return;
    let progressed = true;
    while (progressed && queued.length) {
      progressed = false;
      for (const entry of [...queued]) {
        if (!canAdmit(entry.principalId)) continue;
        if (!removeQueued(entry)) continue;
        entry.signal?.removeEventListener?.('abort', entry.onAbort);
        entry.resolve(makePermit(entry.principalId, entry.id));
        progressed = true;
        if (active.size >= globalLimit) break;
      }
    }
  }

  /** @param {string | { id?: string } | null | undefined} principal @param {{ signal?: AbortSignal }} optionsForRequest @returns {Promise<Permit>} */
  function acquire(principal, optionsForRequest = {}) {
    const principalId = principalKey(typeof principal === 'object' ? principal?.id : principal);
    if (closed) return Promise.reject(admissionError(503, 'transcode_admission_closed', 'Transcoding is shutting down.'));
    if (canAdmit(principalId)) return Promise.resolve(makePermit(principalId));
    if (queuedFor(principalId) >= principalQueueLimit) {
      return Promise.reject(admissionError(429, 'transcode_principal_limit', 'This account has reached its transcode limit; retry shortly.', 2));
    }
    if (queued.length >= queueLimit) {
      return Promise.reject(admissionError(503, 'transcode_global_limit', 'The server has reached its transcode capacity; retry shortly.', 2));
    }
    const signal = optionsForRequest.signal;
    if (signal?.aborted) {
      canceled += 1;
      return Promise.reject(admissionError(499, 'transcode_request_cancelled', 'The transcode request was cancelled.'));
    }
    return new Promise((resolve, reject) => {
      /** @type {QueueEntry} */
      const entry = {
        id: randomUUID(),
        principalId,
        resolve,
        reject,
        signal,
        onAbort: () => { rejectQueued(entry, admissionError(499, 'transcode_request_cancelled', 'The transcode request was cancelled.'), { countCancellation: true }); },
      };
      signal?.addEventListener?.('abort', entry.onAbort, { once: true });
      queued.push(entry);
      pump();
    });
  }

  function close() {
    if (closed) return false;
    closed = true;
    const error = admissionError(503, 'transcode_admission_closed', 'Transcoding is shutting down.');
    for (const entry of [...queued]) rejectQueued(entry, error, { countCancellation: true });
    return true;
  }

  function recordFailure() { failed += 1; }
  function recordCancelled() { canceled += 1; }

  function stats() {
    /** @type {Record<string, number>} */
    const principals = {};
    for (const permit of active.values()) principals[permit.principalId] = (principals[permit.principalId] || 0) + 1;
    return {
      active: active.size,
      queued: queued.length,
      globalLimit,
      principalLimit,
      queueLimit,
      principalQueueLimit,
      principals,
      failed,
      canceled,
      closed,
    };
  }

  return {
    acquire,
    close,
    stats,
    recordFailure,
    recordCancelled,
    isClosed: () => closed,
    active: () => active.size,
    queued: () => queued.length,
  };
}
