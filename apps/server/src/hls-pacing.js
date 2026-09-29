// Video-on-demand HLS for the headless server.
//
// FFmpeg reads input as fast as it can, and remuxing a film finishes in
// seconds. The output is therefore an event playlist that keeps every
// segment, and the server paces the encoder instead: it pauses FFmpeg once it
// is far ahead of the last segment the client requested and resumes it when
// the client catches up. Old segments are removed only when a session's cache
// grows large, and only well behind the client, so pauses and backward seeks
// keep working.

export const HLS_SEGMENT_SECONDS = 2;
/** Pause the encoder this many segments (120 s) ahead of the client. */
export const HLS_MAX_LEAD_SEGMENTS = 60;
/** Resume it once the lead falls to this many segments (60 s). */
export const HLS_RESUME_LEAD_SEGMENTS = 30;
/** Segments (5 min) kept behind the client when a large session is trimmed. */
export const HLS_KEEP_BEHIND_SEGMENTS = 150;
// Listing one directory is cheap; a short tick keeps a fast remux from
// running far past the lead limit before it is paused.
export const HLS_PACING_INTERVAL_MS = 250;

/** @param {string} name */
export function hlsSegmentIndex(name) {
  const match = /^segment-(\d{5})\.ts$/.exec(name);
  return match ? Number(match[1]) : null;
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

/**
 * Segment indexes that may be deleted: only when the session uses more than
 * softLimitBytes, and only those well behind the client's position.
 * @param {{ indexes: number[], requestedIndex: number | null, sessionBytes: number, softLimitBytes: number }} state
 */
export function prunableHlsSegments({ indexes, requestedIndex, sessionBytes, softLimitBytes }) {
  if (requestedIndex === null || sessionBytes <= softLimitBytes) return [];
  const keepFrom = requestedIndex - HLS_KEEP_BEHIND_SEGMENTS;
  return indexes.filter((index) => index < keepFrom).sort((left, right) => left - right);
}
