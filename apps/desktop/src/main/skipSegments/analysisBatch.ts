export class AnalysisInterruptedError extends Error {
  constructor(message = 'Analysis was interrupted and queued again.') {
    super(message);
    this.name = 'AnalysisInterruptedError';
  }
}

export function isAnalysisInterruptedError(error: unknown): boolean {
  return error instanceof AnalysisInterruptedError
    || (error instanceof Error && error.message.toLowerCase().includes('interrupted'));
}

export function neighborIndices(targetIndex: number, episodeCount: number, radius = 4): number[] {
  const start = Math.max(0, targetIndex - radius);
  const end = Math.min(episodeCount, targetIndex + radius + 1);
  return Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
}

export function batchedFingerprintIndices(targetIndices: number[], episodeCount: number, radius = 4): number[] {
  const indices = new Set<number>();
  for (const targetIndex of targetIndices) {
    for (const index of neighborIndices(targetIndex, episodeCount, radius)) indices.add(index);
  }
  return [...indices].sort((left, right) => left - right);
}

// CPU-heavy cached matching can otherwise chain through promise microtasks and
// prevent Electron from receiving playback/cancel IPC until a whole season is
// finished. Yield a macrotask between targets, then re-check interruption.
export async function yieldToAnalysisEvents(shouldContinue: () => boolean): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!shouldContinue()) throw new AnalysisInterruptedError();
}

export async function runIsolatedWorkerPool<T>(
  items: T[],
  workerCount: number,
  execute: (item: T) => Promise<void>,
  shouldContinue: () => boolean,
): Promise<Map<T, Error>> {
  const queue = [...items];
  const failures = new Map<T, Error>();
  const workers = Array.from({ length: Math.min(Math.max(1, workerCount), queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      if (!shouldContinue()) throw new AnalysisInterruptedError();
      try {
        await execute(item);
      } catch (error) {
        if (isAnalysisInterruptedError(error) || !shouldContinue()) {
          throw error instanceof AnalysisInterruptedError
            ? error
            : new AnalysisInterruptedError();
        }
        failures.set(item, error instanceof Error ? error : new Error('Analysis helper failed.'));
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const interruption = settled.find((result): result is PromiseRejectedResult =>
    result.status === 'rejected' && isAnalysisInterruptedError(result.reason));
  if (interruption) throw interruption.reason;
  const unexpected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (unexpected) throw unexpected.reason;
  return failures;
}
