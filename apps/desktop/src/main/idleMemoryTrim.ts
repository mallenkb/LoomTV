// Chromium and the main process keep caches warm for as long as the app runs,
// including the hours LoomTV sits in the tray serving other devices. Hand that
// memory back once nobody is looking. Playback trims only unused UI resources;
// the decoder and its resume/seek buffers are never part of this cleanup.

export const IDLE_TRIM_AFTER_SECONDS = 5 * 60;
export const HIDDEN_TRIM_DELAY_MS = 30_000;
export const IDLE_POLL_INTERVAL_MS = 60_000;
export const PLAYBACK_TRIM_DELAY_MS = 15_000;

export type IdleTrimReason = 'hidden' | 'idle' | 'playback';

export type IdleMemoryTrimDependencies = {
  /** Seconds since the last keyboard or pointer input anywhere on the system. */
  idleSeconds: () => number;
  /** True while a player is open or any media session is playing. */
  isPlaybackActive: () => boolean;
  /** Local player lease, including paused playback. Excludes LAN streams. */
  isPlayerOpen: () => boolean;
  /** True while the main window is shown and not minimized. */
  isWindowActive: () => boolean;
  trim: (reason: IdleTrimReason) => void;
  setTimer?: (callback: () => void, delayMs: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
};

export function createIdleMemoryTrimmer(deps: IdleMemoryTrimDependencies) {
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let hiddenTimer: unknown = null;
  let playbackTimer: unknown = null;
  let playerWasOpen = false;
  let disposed = false;
  // One trim per stretch of inactivity. New input starts a new stretch.
  let trimmedThisIdlePeriod = false;

  const runTrim = (reason: IdleTrimReason): void => {
    if (disposed) return;
    if (reason === 'playback') {
      if (!deps.isPlayerOpen()) return;
    } else {
      if (deps.isPlaybackActive()) return;
      trimmedThisIdlePeriod = true;
    }
    deps.trim(reason);
  };

  const trimmer = {
    /** One delayed cleanup after hidden library artwork has been detached. */
    playbackChanged(): void {
      if (disposed) return;
      const open = deps.isPlayerOpen();
      if (open === playerWasOpen) return;
      playerWasOpen = open;
      if (playbackTimer !== null) clearTimer(playbackTimer);
      playbackTimer = null;
      if (open) {
        const timer = setTimer(() => {
          playbackTimer = null;
          runTrim('playback');
        }, PLAYBACK_TRIM_DELAY_MS);
        timer.unref?.();
        playbackTimer = timer;
      } else {
        trimmedThisIdlePeriod = false;
        if (!deps.isWindowActive()) trimmer.windowInactive();
      }
    },
    /** Called on a slow interval. Cheap: two getters and a comparison. */
    poll(): void {
      if (disposed) return;
      trimmer.playbackChanged();
      if (deps.idleSeconds() < IDLE_TRIM_AFTER_SECONDS) {
        trimmedThisIdlePeriod = false;
        return;
      }
      if (!trimmedThisIdlePeriod) runTrim('idle');
    },
    windowInactive(): void {
      if (disposed || hiddenTimer !== null) return;
      const timer = setTimer(() => {
        hiddenTimer = null;
        if (!deps.isWindowActive()) runTrim('hidden');
      }, HIDDEN_TRIM_DELAY_MS);
      timer.unref?.();
      hiddenTimer = timer;
    },
    windowActive(): void {
      if (hiddenTimer === null) return;
      clearTimer(hiddenTimer);
      hiddenTimer = null;
    },
    dispose(): void {
      disposed = true;
      if (hiddenTimer !== null) clearTimer(hiddenTimer);
      if (playbackTimer !== null) clearTimer(playbackTimer);
      hiddenTimer = null;
      playbackTimer = null;
    },
  };
  return trimmer;
}
