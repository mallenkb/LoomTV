import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionSegmentAnalysisJob, compareSegmentAnalysisJobs, segmentAnalysisJobKey, type SegmentAnalysisJob } from '../src/main/skipSegments/analysisJobs.ts';

const job = (kind: SegmentAnalysisJob['kind'], createdAt: number): SegmentAnalysisJob => ({
  jobKey: kind, kind, mediaId: 'demon-slayer', season: 1, episode: 1,
  fileRevision: 'revision', configHash: 'config', state: 'pending', detail: '', createdAt, updatedAt: createdAt,
});

test('job keys are idempotent for the same scope and revision', () => {
  const scope = { mediaId: 'demon-slayer', season: 1, episode: 1 };
  assert.equal(segmentAnalysisJobKey('incremental', scope, 'rev-1', 'cfg-1'), segmentAnalysisJobKey('incremental', scope, 'rev-1', 'cfg-1'));
  assert.notEqual(segmentAnalysisJobKey('incremental', scope, 'rev-1', 'cfg-1'), segmentAnalysisJobKey('incremental', scope, 'rev-2', 'cfg-1'));
});

test('manual and incremental work outrank recompute and cleanup work', () => {
  const sorted = [job('cleanup', 1), job('hash-recompute', 1), job('incremental', 1), job('manual', 2)].sort(compareSegmentAnalysisJobs);
  assert.deepEqual(sorted.map((value) => value.kind), ['manual', 'incremental', 'hash-recompute', 'cleanup']);
});

test('completed jobs cannot be restarted through an illegal transition', () => {
  assert.equal(canTransitionSegmentAnalysisJob('running', 'pending'), true);
  assert.equal(canTransitionSegmentAnalysisJob('complete', 'pending'), false);
});
