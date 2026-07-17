import { createHash } from 'node:crypto';

export type SegmentAnalysisJobKind = 'manual' | 'incremental' | 'hash-recompute' | 'cleanup';
export type SegmentAnalysisJobState = 'pending' | 'running' | 'waiting_for_peers' | 'complete' | 'error' | 'cancelled';

export type SegmentAnalysisScope = {
  mediaId: string;
  season: number;
  episode: number;
};

export type SegmentAnalysisJob = SegmentAnalysisScope & {
  jobKey: string;
  kind: SegmentAnalysisJobKind;
  fileRevision: string;
  configHash: string;
  state: SegmentAnalysisJobState;
  detail: string;
  createdAt: number;
  updatedAt: number;
};

const PRIORITY: Record<SegmentAnalysisJobKind, number> = {
  manual: 0,
  incremental: 1,
  'hash-recompute': 2,
  cleanup: 3,
};

const TRANSITIONS: Record<SegmentAnalysisJobState, ReadonlySet<SegmentAnalysisJobState>> = {
  pending: new Set(['running', 'cancelled']),
  running: new Set(['pending', 'waiting_for_peers', 'complete', 'error', 'cancelled']),
  waiting_for_peers: new Set(['pending', 'cancelled']),
  complete: new Set(),
  error: new Set(['pending', 'cancelled']),
  cancelled: new Set(['pending']),
};

export function segmentAnalysisJobKey(
  kind: SegmentAnalysisJobKind,
  scope: SegmentAnalysisScope,
  fileRevision: string,
  configHash: string,
): string {
  return createHash('sha256')
    .update([kind, scope.mediaId, scope.season, scope.episode, fileRevision, configHash].join('|'))
    .digest('hex')
    .slice(0, 24);
}

export function compareSegmentAnalysisJobs(left: SegmentAnalysisJob, right: SegmentAnalysisJob): number {
  return PRIORITY[left.kind] - PRIORITY[right.kind]
    || left.createdAt - right.createdAt
    || left.jobKey.localeCompare(right.jobKey);
}

export function canTransitionSegmentAnalysisJob(
  from: SegmentAnalysisJobState,
  to: SegmentAnalysisJobState,
): boolean {
  return from === to || TRANSITIONS[from].has(to);
}
