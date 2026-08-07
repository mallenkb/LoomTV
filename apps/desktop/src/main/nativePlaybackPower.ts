import { powerSaveBlocker } from 'electron';

type NativePlaybackPowerState = {
  status: 'starting' | 'loading' | 'ready' | 'ended' | 'error' | 'closed';
  paused?: boolean;
};

const activePlaybackSessions = new Set<string>();
let displaySleepBlockerId: number | null = null;

function reconcileDisplaySleepBlocker(): void {
  if (activePlaybackSessions.size > 0) {
    if (displaySleepBlockerId === null || !powerSaveBlocker.isStarted(displaySleepBlockerId)) {
      displaySleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    }
    return;
  }

  if (displaySleepBlockerId !== null) {
    if (powerSaveBlocker.isStarted(displaySleepBlockerId)) powerSaveBlocker.stop(displaySleepBlockerId);
    displaySleepBlockerId = null;
  }
}

/** Keep the display awake only while a native engine is actively loading or playing. */
export function syncNativePlaybackDisplaySleep(
  sessionId: string,
  state: NativePlaybackPowerState,
): void {
  const shouldBlock = (state.status === 'loading' || state.status === 'ready') && state.paused !== true;
  if (shouldBlock) activePlaybackSessions.add(sessionId);
  else activePlaybackSessions.delete(sessionId);
  reconcileDisplaySleepBlocker();
}

/** Defensive cleanup for sessions that terminate before emitting their final state. */
export function releaseNativePlaybackDisplaySleep(sessionId: string): void {
  activePlaybackSessions.delete(sessionId);
  reconcileDisplaySleepBlocker();
}
