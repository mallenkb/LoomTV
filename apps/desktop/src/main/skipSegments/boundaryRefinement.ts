export type BoundaryKind = 'chapter' | 'silence' | 'keyframe';
export type BoundaryPoint = { kind: BoundaryKind; timeMs: number };
export type RefinedBoundary = { timeMs: number; kind: BoundaryKind | 'media-edge' | 'original'; originalMs: number };

const KIND_PRIORITY: Record<BoundaryKind, number> = { chapter: 0, silence: 1, keyframe: 2 };

export function selectRefinedBoundary(input: {
  proposedMs: number;
  mediaDurationMs: number;
  points: BoundaryPoint[];
  inwardDirection: -1 | 1;
  inwardWindowMs?: number;
  outwardWindowMs?: number;
  mediaEdgeWindowMs?: number;
}): RefinedBoundary {
  const proposedMs = Math.max(0, Math.min(input.mediaDurationMs, Math.round(input.proposedMs)));
  const mediaEdgeWindowMs = input.mediaEdgeWindowMs ?? 2000;
  if (proposedMs <= mediaEdgeWindowMs) return { timeMs: 0, kind: 'media-edge', originalMs: proposedMs };
  if (input.mediaDurationMs - proposedMs <= mediaEdgeWindowMs) {
    return { timeMs: input.mediaDurationMs, kind: 'media-edge', originalMs: proposedMs };
  }
  const inwardWindowMs = input.inwardWindowMs ?? 5000;
  const outwardWindowMs = input.outwardWindowMs ?? 2000;
  const eligible = input.points.filter((point) => {
    const delta = point.timeMs - proposedMs;
    const inward = Math.sign(delta) === input.inwardDirection;
    return Math.abs(delta) <= (inward ? inwardWindowMs : outwardWindowMs);
  }).sort((left, right) => Math.abs(left.timeMs - proposedMs) - Math.abs(right.timeMs - proposedMs)
    || KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]);
  const winner = eligible[0];
  return winner
    ? { timeMs: Math.round(winner.timeMs), kind: winner.kind, originalMs: proposedMs }
    : { timeMs: proposedMs, kind: 'original', originalMs: proposedMs };
}
