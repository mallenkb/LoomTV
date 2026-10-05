import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

const startupMarks = ['processStart', 'appReady', 'mediaServerReady', 'windowCreated', 'windowRevealed', 'domContentLoaded', 'firstLibraryRender'] as const;
type StartupMark = typeof startupMarks[number];
const elapsedSchema = z.number().finite().nonnegative();
const launchSchema = z.object({
  id: z.string().max(64),
  startedAt: z.number().finite().positive(),
  marks: z.partialRecord(z.enum(startupMarks), elapsedSchema),
  windowToLibraryMs: z.number().finite().optional(),
}).strict();
const historySchema = z.array(launchSchema).max(10);
type StartupLaunch = z.infer<typeof launchSchema>;

export function appendStartupLaunch(history: unknown, launch: StartupLaunch): StartupLaunch[] {
  const parsed = historySchema.safeParse(history);
  return [...(parsed.success ? parsed.data : []).filter((entry) => entry.id !== launch.id), launch].slice(-10);
}

export function createStartupTimingRecorder(userData: string, options: {
  startedAt?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
} = {}) {
  const now = options.now || (() => performance.now());
  const launch: StartupLaunch = { id: randomUUID(), startedAt: options.startedAt ?? performance.timeOrigin, marks: { processStart: 0 } };
  const filePath = path.join(userData, 'startup-timings.json');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  let dirty = true;
  let history: StartupLaunch[] | undefined;

  const flush = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    pending = pending.then(async () => {
      if (!dirty) return;
      dirty = false;
      const snapshot = structuredClone(launch);
      try {
        if (!history) {
          try {
            const handle = await fs.open(filePath, 'r');
            try {
              const buffer = Buffer.alloc(64 * 1024 + 1);
              const { bytesRead } = await handle.read(buffer);
              history = bytesRead > 64 * 1024 ? [] : historySchema.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
            } finally { await handle.close(); }
          } catch { history = []; }
        }
        const next = appendStartupLaunch(history, snapshot);
        await fs.mkdir(userData, { recursive: true });
        const temporaryPath = `${filePath}.${launch.id}.tmp`;
        try {
          await fs.writeFile(temporaryPath, JSON.stringify(next), { mode: 0o600 });
          await fs.rename(temporaryPath, filePath);
          history = next;
        } finally { await fs.rm(temporaryPath, { force: true }); }
      } catch (error) {
        dirty = true;
        options.onError?.(error);
      }
    });
    return pending;
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { void flush(); }, 250);
    timer.unref();
  };
  const record = (mark: StartupMark, elapsedMs = now()): boolean => {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > now() + 50) throw new Error('Invalid startup timestamp.');
    if (launch.marks[mark] !== undefined) return false;
    launch.marks[mark] = elapsedMs;
    const { windowRevealed, firstLibraryRender } = launch.marks;
    if (windowRevealed !== undefined && firstLibraryRender !== undefined) {
      launch.windowToLibraryMs = firstLibraryRender - windowRevealed;
    }
    dirty = true;
    schedule();
    return true;
  };
  schedule();
  return { record, flush, recordLibraryRender: (timestamp: number) => record('firstLibraryRender', timestamp - launch.startedAt) };
}

let recorder: ReturnType<typeof createStartupTimingRecorder> | undefined;
export function initializeStartupTimings(userData: string): void {
  recorder = createStartupTimingRecorder(userData, {
    onError: () => console.warn('Could not save startup timings.'),
  });
}
export function recordStartupMark(mark: StartupMark): void { recorder?.record(mark); }
export function recordFirstLibraryRender(timestamp: number): boolean { return recorder?.recordLibraryRender(timestamp) ?? false; }
export function flushStartupTimings(): Promise<void> { return recorder?.flush() ?? Promise.resolve(); }
