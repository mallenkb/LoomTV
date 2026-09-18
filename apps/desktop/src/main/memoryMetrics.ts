import { app } from 'electron';

// A diagnostic target for the MAIN process, not a hard cap or a whole-app total.
const MAIN_TARGET_BYTES = 600_000_000;
let started = false;
let sampling = false;

async function sampleMemory(checkpoint: string): Promise<void> {
  if (process.env.LOOM_MEMORY_METRICS !== '1' || sampling || !app.isReady()) return;
  sampling = true;
  try {
    const main = process.memoryUsage();
    const footprint = await process.getProcessMemoryInfo().catch(() => null);
    const mainPrivateBytes = footprint && Number.isFinite(footprint.private)
      ? footprint.private * 1024 : null;
    console.info('[memory]', JSON.stringify({
      timestamp: new Date().toISOString(),
      checkpoint,
      main,
      mainPrivateBytes,
      mainTargetBytes: MAIN_TARGET_BYTES,
      mainAboveTarget: mainPrivateBytes === null ? null : mainPrivateBytes > MAIN_TARGET_BYTES,
      processes: app.getAppMetrics().map(({ pid, type, memory }) => ({
        pid,
        type,
        workingSetBytes: memory.workingSetSize * 1024,
        peakWorkingSetBytes: memory.peakWorkingSetSize * 1024,
      })),
    }));
  } catch (error) {
    console.warn('[memory] Could not sample process memory:', error instanceof Error ? error.message : String(error));
  } finally {
    sampling = false;
  }
}

/** No media paths, URLs, titles, or library objects enter diagnostics. */
export function recordMemoryCheckpoint(checkpoint: string): void {
  void sampleMemory(checkpoint);
}

/** Disabled by default. Never forces GC, unloads LibVLC, or interrupts playback. */
export function startMemoryMetrics(): void {
  if (started || process.env.LOOM_MEMORY_METRICS !== '1') return;
  started = true;
  recordMemoryCheckpoint('startup');
  const timer = setInterval(() => recordMemoryCheckpoint('interval'), 10_000);
  timer.unref();
  app.once('will-quit', () => { clearInterval(timer); started = false; });
}
