import { powerSaveBlocker } from 'electron';
import { loadSettings } from './settings';

type NativePlaybackPowerState = {
  status: 'starting' | 'loading' | 'ready' | 'ended' | 'error' | 'closed';
  paused?: boolean;
};

type PlaybackPowerSession = {
  timeoutMinutes: number;
  pauseBeforeSleep: () => void;
  timer: NodeJS.Timeout | null;
};

const playbackSessions = new Map<string, PlaybackPowerSession>();
let displaySleepBlockerId: number | null = null;

function configuredTimeoutMinutes(): number {
  try {
    const value = Number(loadSettings().playbackDisplaySleepTimeoutMinutes);
    return Number.isFinite(value) ? Math.max(0, Math.min(480, Math.round(value))) : 0;
  } catch {
    return 0;
  }
}

function reconcileDisplaySleepBlocker(): void {
  const shouldBlock = playbackSessions.size > 0;
  try {
    if (shouldBlock) {
      if (displaySleepBlockerId === null || !powerSaveBlocker.isStarted(displaySleepBlockerId)) {
        displaySleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      }
      return;
    }

    if (displaySleepBlockerId !== null) {
      if (powerSaveBlocker.isStarted(displaySleepBlockerId)) powerSaveBlocker.stop(displaySleepBlockerId);
      displaySleepBlockerId = null;
    }
  } catch (error) {
    console.warn('[playback] Could not update the display sleep blocker:', error instanceof Error ? error.message : error);
  }
}

function resetSessionTimer(session: PlaybackPowerSession, timeoutMinutes: number): void {
  if (session.timer) clearTimeout(session.timer);
  session.timeoutMinutes = timeoutMinutes;
  session.timer = null;
  if (timeoutMinutes <= 0) return;
  session.timer = setTimeout(() => {
    session.timer = null;
    // Keep the blocker until the engine reports paused or the session closes.
    // Sending a pause command alone does not confirm playback has stopped.
    try {
      session.pauseBeforeSleep();
    } catch (error) {
      console.warn('[playback] Could not pause playback for the sleep timer:', error);
    }
  }, timeoutMinutes * 60_000);
  session.timer.unref();
}

/** Keep the display awake only while a native engine is actively loading or playing. */
export function syncNativePlaybackDisplaySleep(
  sessionId: string,
  state: NativePlaybackPowerState,
  pauseBeforeSleep: () => void,
): void {
  const shouldBlock = (state.status === 'loading' || state.status === 'ready') && state.paused !== true;
  const existing = playbackSessions.get(sessionId);
  if (!shouldBlock) {
    if (existing?.timer) clearTimeout(existing.timer);
    playbackSessions.delete(sessionId);
    reconcileDisplaySleepBlocker();
    return;
  }

  if (existing) {
    existing.pauseBeforeSleep = pauseBeforeSleep;
    return;
  }

  const timeoutMinutes = configuredTimeoutMinutes();
  const session: PlaybackPowerSession = { timeoutMinutes, pauseBeforeSleep, timer: null };
  resetSessionTimer(session, timeoutMinutes);
  playbackSessions.set(sessionId, session);
  reconcileDisplaySleepBlocker();
}

/** Apply a newly saved timeout to playback already in progress. */
export function refreshNativePlaybackDisplaySleepTimeout(): void {
  const timeoutMinutes = configuredTimeoutMinutes();
  for (const session of playbackSessions.values()) {
    if (session.timeoutMinutes !== timeoutMinutes) resetSessionTimer(session, timeoutMinutes);
  }
  reconcileDisplaySleepBlocker();
}

/** Defensive cleanup for sessions that terminate before emitting their final state. */
export function releaseNativePlaybackDisplaySleep(sessionId: string): void {
  const session = playbackSessions.get(sessionId);
  if (session?.timer) clearTimeout(session.timer);
  playbackSessions.delete(sessionId);
  reconcileDisplaySleepBlocker();
}
