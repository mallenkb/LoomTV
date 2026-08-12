// Mobile direct playback and LoomTV's seekable HLS sessions expose a full VOD
// timeline. The HLS anchor only controls initial loading; expo-video continues
// to report and seek absolute media seconds.
export function mobileAbsoluteMediaSeconds(playerSeconds: number): number {
  return Number.isFinite(playerSeconds) ? Math.max(0, playerSeconds) : 0;
}

export function mobilePlayerSecondsForAbsolute(mediaSeconds: number): number {
  return Number.isFinite(mediaSeconds) ? Math.max(0, mediaSeconds) : 0;
}

export const MOBILE_ACCESSIBLE_SEEK_STEP_SECONDS = 10;

export function mobileAccessibleTimeLabel(seconds: number): string {
  const totalSeconds = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (remainingSeconds > 0 || parts.length === 0) {
    parts.push(`${remainingSeconds} ${remainingSeconds === 1 ? 'second' : 'seconds'}`);
  }
  return parts.join(', ');
}

export function mobileAccessibleSeekRange(playerSeconds: number, durationSeconds: number): {
  min: number;
  max: number;
  now: number;
  remaining: number;
} {
  const max = Number.isFinite(durationSeconds) ? Math.max(0, Math.round(durationSeconds)) : 0;
  const unclampedNow = Number.isFinite(playerSeconds) ? Math.max(0, Math.round(playerSeconds)) : 0;
  const now = Math.min(max, unclampedNow);
  return { min: 0, max, now, remaining: max - now };
}

export function mobileAccessibleSeekTarget(
  playerSeconds: number,
  durationSeconds: number,
  action: 'increment' | 'decrement',
): number {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const position = Number.isFinite(playerSeconds) ? Math.max(0, playerSeconds) : 0;
  const delta = action === 'increment'
    ? MOBILE_ACCESSIBLE_SEEK_STEP_SECONDS
    : -MOBILE_ACCESSIBLE_SEEK_STEP_SECONDS;
  return Math.min(duration, Math.max(0, position + delta));
}
