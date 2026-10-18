/** The delay applied to an online subtitle, and how to change it. */
export type OnlineSubtitleTiming = { delay: number; setDelay: (seconds: number) => void };

/** "0.50s later", "0.25s earlier" or "In sync", so the direction never depends on reading a sign. */
export function formatSyncOffset(seconds: number): string {
  if (!Number.isFinite(seconds) || Math.abs(seconds) < 0.005) return 'In sync';
  return `${Math.abs(seconds).toFixed(2)}s ${seconds < 0 ? 'earlier' : 'later'}`;
}
