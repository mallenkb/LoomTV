// Canonical HLS starts at a source offset and exposes a relative player clock.
export function mobileAbsoluteMediaSeconds(playerSeconds: number, sourceOffset = 0): number {
  return (Number.isFinite(playerSeconds) ? Math.max(0, playerSeconds) : 0) + sourceOffset;
}

export function mobilePlayerSecondsForAbsolute(mediaSeconds: number, sourceOffset = 0): number {
  return Number.isFinite(mediaSeconds) ? Math.max(0, mediaSeconds - sourceOffset) : 0;
}

export function mobileMediaDurationSeconds(playerDuration: number, sourceOffset = 0, originalDuration = 0): number {
  if (originalDuration > 0 && Number.isFinite(originalDuration)) return originalDuration;
  return playerDuration > 0 && Number.isFinite(playerDuration) ? playerDuration + sourceOffset : 0;
}
