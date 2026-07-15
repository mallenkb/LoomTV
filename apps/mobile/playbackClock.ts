// Mobile direct playback and LoomTV's seekable HLS sessions expose a full VOD
// timeline. The HLS anchor only controls initial loading; expo-video continues
// to report and seek absolute media seconds.
export function mobileAbsoluteMediaSeconds(playerSeconds: number): number {
  return Number.isFinite(playerSeconds) ? Math.max(0, playerSeconds) : 0;
}

export function mobilePlayerSecondsForAbsolute(mediaSeconds: number): number {
  return Number.isFinite(mediaSeconds) ? Math.max(0, mediaSeconds) : 0;
}
