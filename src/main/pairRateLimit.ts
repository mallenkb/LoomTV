// Per-remote-IP sliding window. After PAIR_LOCKOUT_FAILS bad attempts inside
// PAIR_LOCKOUT_WINDOW_MS, lock for PAIR_LOCKOUT_DURATION_MS.

const PAIR_LOCKOUT_FAILS = 5;
const PAIR_LOCKOUT_WINDOW_MS = 60 * 1000;
const PAIR_LOCKOUT_DURATION_MS = 60 * 60 * 1000;

type PairAttemptState = { fails: number[]; lockedUntil?: number };
const pairAttempts = new Map<string, PairAttemptState>();

export function checkPairRateLimit(address: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const state = pairAttempts.get(address) || { fails: [] };
  if (state.lockedUntil && state.lockedUntil > now) {
    return { allowed: false, retryAfterMs: state.lockedUntil - now };
  }
  state.fails = state.fails.filter((timestamp) => now - timestamp < PAIR_LOCKOUT_WINDOW_MS);
  pairAttempts.set(address, state);
  return { allowed: true };
}

export function recordPairFailure(address: string): void {
  const now = Date.now();
  const state = pairAttempts.get(address) || { fails: [] };
  state.fails = state.fails.filter((timestamp) => now - timestamp < PAIR_LOCKOUT_WINDOW_MS);
  state.fails.push(now);
  if (state.fails.length >= PAIR_LOCKOUT_FAILS) {
    state.lockedUntil = now + PAIR_LOCKOUT_DURATION_MS;
    state.fails = [];
  }
  pairAttempts.set(address, state);
}

export function recordPairSuccess(address: string): void {
  pairAttempts.delete(address);
}
