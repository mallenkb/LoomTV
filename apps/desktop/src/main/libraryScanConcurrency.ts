import type { ProbeMediaFileResult } from './mediaProbeFile.ts';

export const LIBRARY_ITEM_CONCURRENCY = 2;
export const LIBRARY_PROBE_CONCURRENCY = 4;

type AsyncMediaFileProbe = (filePath: string) => Promise<ProbeMediaFileResult>;
type ScheduledTask = () => void;

function createConcurrencyLimiter(concurrency: number) {
  const pending: ScheduledTask[] = [];
  let active = 0;

  const startPending = () => {
    while (active < concurrency && pending.length > 0) {
      const start = pending.shift();
      if (!start) return;
      active += 1;
      start();
    }
  };

  return <Result>(task: () => Promise<Result>): Promise<Result> => new Promise((resolve, reject) => {
    pending.push(() => {
      void Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          startPending();
        });
    });
    startPending();
  });
}

const scheduleLibraryItemTask = createConcurrencyLimiter(LIBRARY_ITEM_CONCURRENCY);
const sharedProbeLimiters = new WeakMap<AsyncMediaFileProbe, AsyncMediaFileProbe>();

/** Caps metadata-rich item builds across recursive scanner instances. */
export function runBoundedLibraryItemTask<Result>(task: () => Promise<Result>): Promise<Result> {
  return scheduleLibraryItemTask(task);
}

/** Reuses one FIFO limiter for every consumer of the same cached probe function. */
export function getBoundedLibraryProbe(probe: AsyncMediaFileProbe): AsyncMediaFileProbe {
  const existing = sharedProbeLimiters.get(probe);
  if (existing) return existing;

  const schedule = createConcurrencyLimiter(LIBRARY_PROBE_CONCURRENCY);
  const boundedProbe: AsyncMediaFileProbe = (filePath) => schedule(() => probe(filePath));
  sharedProbeLimiters.set(probe, boundedProbe);
  return boundedProbe;
}

/** Maps with a fixed worker pool while retaining input-index result ordering. */
export async function mapWithConcurrency<Input, Result>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (values.length === 0) return [];

  const workerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency)));
  const results = new Array<Result>(values.length);
  const failures: Array<{ index: number; error: unknown }> = [];
  let nextIndex = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;

      try {
        results[index] = await mapper(values[index] as Input, index);
      } catch (error) {
        failures.push({ index, error });
        stopped = true;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const [failure] = failures.sort((left, right) => left.index - right.index);
  if (failure) throw failure.error;
  return results;
}

/**
 * Runs small concurrent batches but publishes each result in input order. If a
 * task fails, earlier successful results are published before the error escapes.
 */
export async function processWithConcurrencyInOrder<Input, Result>(
  values: readonly Input[],
  concurrency: number,
  task: (value: Input, index: number) => Promise<Result>,
  publish: (result: Result, index: number) => void | Promise<void>,
): Promise<void> {
  const batchSize = Math.max(1, Math.floor(concurrency));
  for (let start = 0; start < values.length; start += batchSize) {
    const batch = values.slice(start, start + batchSize);
    const settled = await Promise.allSettled(batch.map((value, offset) => task(value, start + offset)));
    for (let offset = 0; offset < settled.length; offset += 1) {
      const result = settled[offset];
      if (!result) continue;
      if (result.status === 'rejected') throw result.reason;
      await publish(result.value, start + offset);
    }
  }
}
