// Password and PIN checks run scrypt, which costs tens of milliseconds of CPU
// and about 16 MiB of memory each. Bound how many run at once so a burst of
// sign-in or PIN attempts cannot exhaust the server; extra attempts wait in a
// short queue and are refused once that is full.

export const DEFAULT_MAX_CONCURRENT_KDF = 4;
export const DEFAULT_MAX_QUEUED_KDF = 32;

/** @param {{ maxConcurrent?: number, maxQueued?: number }} [options] */
export function createKdfLimiter({ maxConcurrent = DEFAULT_MAX_CONCURRENT_KDF, maxQueued = DEFAULT_MAX_QUEUED_KDF } = {}) {
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  return {
    /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
    async run(work) {
      if (active < maxConcurrent) {
        active += 1;
      } else {
        if (waiting.length >= maxQueued) {
          throw Object.assign(new Error('The server is busy checking other sign-ins. Try again shortly.'), {
            status: 429, code: 'verification_busy', retryAfter: 1,
          });
        }
        // A finishing check hands its slot straight to the next waiter.
        await new Promise((resolve) => { waiting.push(() => resolve(undefined)); });
      }
      try {
        return await work();
      } finally {
        const next = waiting.shift();
        if (next) next(); else active -= 1;
      }
    },
    stats: () => ({ active, queued: waiting.length }),
  };
}

/** One limiter shared by account sign-in and profile PIN checks. */
export const sharedKdfLimiter = createKdfLimiter();
