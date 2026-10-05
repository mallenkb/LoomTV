import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { playbackDiagnostics, recordPlaybackDiagnostic } from './playbackDiagnostics.ts';

/**
 * Notices when the Electron main thread stops running JavaScript for a while
 * (a synchronous child process, a blocking native call, a long loop) and keeps
 * the last few stalls on disk so a slow session can be explained afterwards.
 * A 100 ms timer whose callback arrives late is the whole mechanism, so the
 * idle cost is one timer wake-up per tick.
 */

export const STALL_THRESHOLD_MS = 250;
const TICK_MS = 100;
const MAX_STALLS = 20;
const WRITE_DELAY_MS = 5_000;
export const STALL_FILE_NAME = 'main-thread-stalls.json';

export type MainThreadStall = { at: string; durationMs: number; phase: string; uptimeMs: number };

export function createStallDetector(options: {
  now: () => number;
  onStall: (durationMs: number) => void;
  thresholdMs?: number;
  tickMs?: number;
}): { tick: () => void } {
  const thresholdMs = options.thresholdMs ?? STALL_THRESHOLD_MS;
  const tickMs = options.tickMs ?? TICK_MS;
  let last = options.now();
  return {
    tick() {
      const now = options.now();
      const lateBy = now - last - tickMs;
      last = now;
      if (lateBy >= thresholdMs) options.onStall(Math.round(lateBy));
    },
  };
}

/** Keeps the newest stalls, oldest first, at most `MAX_STALLS`. */
export function appendStall(existing: unknown, stall: MainThreadStall): MainThreadStall[] {
  const valid = Array.isArray(existing)
    ? existing.filter((entry): entry is MainThreadStall => Boolean(entry)
      && typeof entry.at === 'string' && Number.isFinite(entry.durationMs)
      && typeof entry.phase === 'string' && Number.isFinite(entry.uptimeMs))
    : [];
  return [...valid, stall].slice(-MAX_STALLS);
}

/** The last diagnostic event names what the app was doing (startup or playback). */
function currentPhase(): string {
  const recent = playbackDiagnostics();
  return recent[recent.length - 1]?.event || 'idle';
}

export function startMainThreadWatchdog(userDataPath: string): () => void {
  const file = path.join(userDataPath, STALL_FILE_NAME);
  const pending: MainThreadStall[] = [];
  let writeTimer: NodeJS.Timeout | null = null;
  const flush = async () => {
    writeTimer = null;
    const stalls = pending.splice(0);
    if (stalls.length === 0) return;
    let next: unknown = [];
    try { next = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { /* first stall or damaged file */ }
    for (const stall of stalls) next = appendStall(next, stall);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await fs.promises.rename(temporary, file);
    } catch {
      await fs.promises.unlink(temporary).catch(() => undefined);
    }
  };
  const detector = createStallDetector({
    now: () => performance.now(),
    onStall: (durationMs) => {
      const phase = currentPhase();
      recordPlaybackDiagnostic('main.stall', durationMs);
      pending.push({ at: new Date().toISOString(), durationMs, phase, uptimeMs: Math.round(performance.now()) });
      // Writing is deferred and batched so a burst of stalls costs one write.
      writeTimer ??= setTimeout(() => { void flush(); }, WRITE_DELAY_MS);
      writeTimer.unref();
    },
  });
  const timer = setInterval(detector.tick, TICK_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    if (writeTimer) clearTimeout(writeTimer);
    void flush();
  };
}
