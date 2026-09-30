// Video-on-demand HLS for the headless server.
//
// FFmpeg reads input as fast as it can, and remuxing a film finishes in
// seconds. The output is therefore an event playlist that keeps every
// segment, and the server paces the encoder instead: it pauses FFmpeg once it
// is far ahead of the last segment the client requested and resumes it when
// the client catches up. EVENT playlists keep referencing earlier segments,
// so files remain until session teardown. Existing byte quotas still apply.

export const HLS_SEGMENT_SECONDS = 2;
/** Pause this many segments ahead. Remux keyframes can extend the two-second segment target. */
export const HLS_MAX_LEAD_SEGMENTS = 60;
/** Resume it once the lead falls to this many segments. */
export const HLS_RESUME_LEAD_SEGMENTS = 30;
// Listing one directory is cheap; a short tick keeps a fast remux from
// running far past the lead limit before it is paused.
export const HLS_PACING_INTERVAL_MS = 250;

/** @param {string} name */
export function hlsSegmentIndex(name) {
  const match = /^segment-(\d{5,})\.ts$/.exec(name);
  const index = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(index) ? index : null;
}

/**
 * Whether to pause or resume the encoder.
 * @param {{ producedIndex: number, requestedIndex: number | null, suspended: boolean }} state
 * producedIndex is the highest segment written (-1 before the first);
 * requestedIndex is the segment the client asked for most recently.
 * @returns {'suspend' | 'resume' | null}
 */
export function hlsPacingDecision({ producedIndex, requestedIndex, suspended }) {
  const lead = producedIndex - (requestedIndex ?? -1);
  if (!suspended && lead >= HLS_MAX_LEAD_SEGMENTS) return 'suspend';
  if (suspended && lead <= HLS_RESUME_LEAD_SEGMENTS) return 'resume';
  return null;
}
