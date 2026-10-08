export type StoredProgress = {
  positionSeconds?: number;
  position?: number;
  durationSeconds?: number;
  duration?: number;
  watched?: boolean;
} | null | undefined;

/**
 * Where Play should start. A watched or 90%-played title restarts from zero,
 * matching the mobile client's completion rule.
 */
export function resumeStartSeconds(record: StoredProgress): number {
  const position = Math.max(0, Number(record?.positionSeconds ?? record?.position ?? 0) || 0);
  const duration = Math.max(0, Number(record?.durationSeconds ?? record?.duration ?? 0) || 0);
  if (record?.watched === true) return 0;
  if (duration > 0 && position / duration >= 0.9) return 0;
  return position;
}
