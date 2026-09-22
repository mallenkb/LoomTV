// Chromium and the main process keep caches warm for as long as the app runs,
// including the hours LoomTV sits in the tray serving other devices. Hand that
// memory back once nobody is looking, and never while something plays.

export const IDLE_TRIM_AFTER_SECONDS = 5 * 60;
export const HIDDEN_TRIM_DELAY_MS = 30_000;
export const IDLE_POLL_INTERVAL_MS = 60_000;

export type IdleTrimReason = 'hidden' | 'idle';

export type IdleMemoryTrimDependencies = {
  /** Seconds since the last keyboard or pointer input anywhere on the system. */
  idleSeconds: () => number;
  /** True while a player is open or any media session is playing. */
  isPlaybackActive: () => boolean;
  /** True while the main window is shown and not minimized. */
  isWindowVisible: () => boolean;
  trim: (reason: IdleTrimReason) => void;
  setTimer?: (callback: () => void, delayMs: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
};

export function createIdleMemoryTrimmer(deps: IdleMemoryTrimDependencies) {
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let hiddenTimer: unknown = null;
  // One trim per stretch of inactivity. New input starts a new stretch.
  let trimmedThisIdlePeriod = false;

  const runTrim = (reason: IdleTrimReason): void => {
    if (deps.isPlaybackActive()) return;
    trimmedThisIdlePeriod = true;
    deps.trim(reason);
  };

  return {
    /** Called on a slow interval. Cheap: two getters and a comparison. */
    poll(): void {
      if (deps.idleSeconds() < IDLE_TRIM_AFTER_SECONDS) {
        trimmedThisIdlePeriod = false;
        return;
      }
      if (!trimmedThisIdlePeriod) runTrim('idle');
    },
    windowHidden(): void {
      if (hiddenTimer !== null) return;
      const timer = setTimer(() => {
        hiddenTimer = null;
        if (!deps.isWindowVisible()) runTrim('hidden');
      }, HIDDEN_TRIM_DELAY_MS);
      timer.unref?.();
      hiddenTimer = timer;
    },
    windowShown(): void {
      if (hiddenTimer === null) return;
      clearTimer(hiddenTimer);
      hiddenTimer = null;
    },
  };
}
