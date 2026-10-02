/** Retain the selected track until both restoring output and decoding a frame succeed. */
export function restoreOffscreenTrack(
  trackId: number | null,
  select: (trackId: number) => boolean,
  decodeFrame: () => boolean,
): number | null {
  if (trackId === null) return null;
  if (!select(trackId) || !decodeFrame()) return trackId;
  return null;
}
