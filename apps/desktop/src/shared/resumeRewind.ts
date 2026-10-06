export const DEFAULT_RESUME_REWIND_SECONDS = 3;

export function normalizeResumeRewind(value: unknown, fallback = DEFAULT_RESUME_REWIND_SECONDS): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(30, Math.round(value)))
    : fallback;
}

export function resumeRewindTarget(position: number, seconds: number, earliest = 0): number {
  return Math.max(earliest, position - normalizeResumeRewind(seconds, 0));
}
