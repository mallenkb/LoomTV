import { powerMonitor } from 'electron';

/**
 * True while the session's screen is locked. The window server stops taking
 * frames from a locked screen, yet the window still reports itself visible,
 * so native video surfaces pile up exactly as they do for a hidden window.
 */
export function isScreenLocked(): boolean {
  try {
    return powerMonitor.getSystemIdleState(60) === 'locked';
  } catch {
    return false;
  }
}
