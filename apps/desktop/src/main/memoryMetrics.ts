import { app } from 'electron';

/** Opt-in diagnostics. No media paths, URLs or library data are recorded. */
export function startMemoryMetrics(): void {
  if (process.env.LOOM_MEMORY_METRICS !== '1') return;
  const sample = () => {
    try {
      console.info('[memory]', JSON.stringify({
        timestamp: new Date().toISOString(),
        main: process.memoryUsage(),
        processes: app.getAppMetrics().map(({ pid, type, memory }) => ({
          pid, type, workingSetBytes: memory.workingSetSize * 1024,
          peakWorkingSetBytes: memory.peakWorkingSetSize * 1024,
        })),
      }));
    } catch (error) {
      console.warn('[memory] Could not sample process memory:', error instanceof Error ? error.message : String(error));
    }
  };
  sample();
  const timer = setInterval(sample, 10_000);
  timer.unref();
  app.once('will-quit', () => clearInterval(timer));
}
