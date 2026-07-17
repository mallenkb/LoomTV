import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnalysisInterruptedError,
  batchedFingerprintIndices,
  neighborIndices,
  runIsolatedWorkerPool,
  yieldToAnalysisEvents,
} from '../src/main/skipSegments/analysisBatch.ts';

test('batched fingerprint planning is identical to the union of legacy per-target windows', () => {
  const targets = [0, 4, 9, 15];
  const episodeCount = 18;
  const legacyUnion = [...new Set(targets.flatMap((target) => neighborIndices(target, episodeCount)))].sort((a, b) => a - b);
  assert.deepEqual(batchedFingerprintIndices(targets, episodeCount), legacyUnion);
  for (const target of targets) {
    assert.deepEqual(
      neighborIndices(target, episodeCount),
      Array.from({ length: episodeCount }, (_, index) => index).slice(Math.max(0, target - 4), target + 5),
    );
  }
});

test('the two-worker pool isolates a corrupt item and completes unrelated work', async () => {
  const completed: number[] = [];
  let active = 0;
  let peak = 0;
  const failures = await runIsolatedWorkerPool(
    [1, 2, 3, 4, 5],
    2,
    async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      if (item === 3) throw new Error('corrupt episode');
      completed.push(item);
    },
    () => true,
  );
  assert.equal(peak, 2);
  assert.deepEqual(completed.sort((a, b) => a - b), [1, 2, 4, 5]);
  assert.equal(failures.get(3)?.message, 'corrupt episode');
});

test('the worker pool propagates interruption instead of recording a permanent item failure', async () => {
  let allowed = true;
  await assert.rejects(
    runIsolatedWorkerPool(
      [1, 2, 3],
      2,
      async () => {
        allowed = false;
        throw new AnalysisInterruptedError();
      },
      () => allowed,
    ),
    AnalysisInterruptedError,
  );
});

test('analysis yields allow an interruption event to run before the next target', async () => {
  let active = true;
  setImmediate(() => { active = false; });
  await assert.rejects(() => yieldToAnalysisEvents(() => active), AnalysisInterruptedError);
});
