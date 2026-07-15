import type { ChildProcess } from 'node:child_process';

/**
 * Global FFmpeg governor. Every long-lived ffmpeg the app spawns is registered
 * here so playback can never fan out into dozens of encoders:
 *
 * - Playback processes (HLS encoder windows, progressive /stream remuxes) are
 *   deduped per source and hard-capped; past the cap the least-recently-active
 *   one is killed. HLS sessions self-heal by respawning their window on the
 *   next segment request, so eviction degrades gracefully.
 * - Tool processes (thumbnails, embedded-subtitle extraction) are short-lived
 *   but bursty, so they run through a small concurrency queue instead of
 *   spawning in parallel per request.
 */

// In-app playback + one LAN viewer; a third concurrent encoder evicts the
// least recently used one.
const MAX_PLAYBACK_PROCESSES = 2;
const MAX_TOOL_PROCESSES = 2;
const MAX_TOOL_QUEUE = 48;
const TOOL_QUEUE_TIMEOUT_MS = 20000;

interface PlaybackMeta {
  key: string;
  label: string;
  lastTouchAt: number;
}

const playbackProcesses = new Map<ChildProcess, PlaybackMeta>();
const playbackActivityLeases = new Map<string, { label: string; touchedAt: number }>();
const analysisProcesses = new Set<ChildProcess>();
let lastPlaybackActivityAt = 0;

function killProcess(proc: ChildProcess): void {
  try {
    if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
  } catch {
    // The process may already be gone.
  }
}

function interruptAnalysis(): void {
  for (const proc of [...analysisProcesses]) killProcess(proc);
  analysisProcesses.clear();
}

function notePlaybackActivity(): void {
  lastPlaybackActivityAt = Date.now();
  interruptAnalysis();
}

export function setPlaybackActivityLease(key: string, active: boolean, label = key): void {
  const safeKey = String(key || '').trim();
  if (!safeKey) return;
  if (active) {
    playbackActivityLeases.set(safeKey, { label, touchedAt: Date.now() });
    notePlaybackActivity();
  } else {
    playbackActivityLeases.delete(safeKey);
    lastPlaybackActivityAt = Date.now();
  }
}

export function acquirePlaybackActivityLease(key: string, label = key): () => void {
  setPlaybackActivityLease(key, true, label);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setPlaybackActivityLease(key, false, label);
  };
}

export function registerAnalysisProcess(proc: ChildProcess): void {
  if (isPlaybackActivityActive()) {
    killProcess(proc);
    return;
  }
  analysisProcesses.add(proc);
  const forget = () => analysisProcesses.delete(proc);
  proc.once('exit', forget);
  proc.once('error', forget);
}

export function isPlaybackActivityActive(): boolean {
  return playbackActivityLeases.size > 0 || playbackProcesses.size > 0;
}

export function millisecondsSincePlaybackActivity(): number {
  return lastPlaybackActivityAt ? Date.now() - lastPlaybackActivityAt : Number.POSITIVE_INFINITY;
}

function evictLeastRecentPlayback(): void {
  let lruProc: ChildProcess | null = null;
  let lruMeta: PlaybackMeta | null = null;
  for (const [proc, meta] of playbackProcesses) {
    if (!lruMeta || meta.lastTouchAt < lruMeta.lastTouchAt) {
      lruProc = proc;
      lruMeta = meta;
    }
  }
  if (!lruProc || !lruMeta) return;
  console.warn(`[ffmpeg] playback cap (${MAX_PLAYBACK_PROCESSES}) reached; stopping ${lruMeta.label}`);
  killProcess(lruProc);
  playbackProcesses.delete(lruProc);
}

/**
 * Track a playback ffmpeg. A new process for the same `key` replaces the old
 * one (a seek restart must never leave the previous encoder running), and the
 * global cap is enforced across in-app playback and LAN sharing combined.
 */
export function registerPlaybackProcess(proc: ChildProcess, key: string, label: string): void {
  notePlaybackActivity();
  for (const [existing, meta] of [...playbackProcesses]) {
    if (existing !== proc && meta.key === key) {
      killProcess(existing);
      playbackProcesses.delete(existing);
    }
  }
  while (playbackProcesses.size >= MAX_PLAYBACK_PROCESSES) {
    const before = playbackProcesses.size;
    evictLeastRecentPlayback();
    if (playbackProcesses.size === before) break;
  }
  playbackProcesses.set(proc, { key, label, lastTouchAt: Date.now() });
  const forget = () => playbackProcesses.delete(proc);
  proc.once('exit', forget);
  proc.once('error', forget);
}

/** Mark a playback process as active so cap eviction prefers idle encoders. */
export function touchPlaybackProcess(proc: ChildProcess | null | undefined): void {
  if (!proc) return;
  const meta = playbackProcesses.get(proc);
  if (meta) {
    meta.lastTouchAt = Date.now();
    lastPlaybackActivityAt = meta.lastTouchAt;
  }
}

interface ToolWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let activeToolCount = 0;
const toolWaiters: ToolWaiter[] = [];

function makeToolRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeToolCount = Math.max(0, activeToolCount - 1);
    const next = toolWaiters.shift();
    if (next) {
      clearTimeout(next.timer);
      activeToolCount += 1;
      next.resolve(makeToolRelease());
    }
  };
}

/**
 * Acquire a slot for a short-lived ffmpeg job (thumbnail, subtitle extract).
 * Resolves with an idempotent release callback; call it when the process
 * exits. Requests beyond the queue bound or older than the timeout reject so
 * a thumbnail burst cannot pile up processes or hang requests forever.
 */
export function acquireFfmpegToolSlot(label: string): Promise<() => void> {
  if (activeToolCount < MAX_TOOL_PROCESSES) {
    activeToolCount += 1;
    return Promise.resolve(makeToolRelease());
  }
  if (toolWaiters.length >= MAX_TOOL_QUEUE) {
    return Promise.reject(new Error(`FFmpeg is busy; dropped queued ${label} request.`));
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: ToolWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = toolWaiters.indexOf(waiter);
        if (index >= 0) toolWaiters.splice(index, 1);
        reject(new Error(`Timed out waiting for an FFmpeg slot (${label}).`));
      }, TOOL_QUEUE_TIMEOUT_MS),
    };
    waiter.timer.unref?.();
    toolWaiters.push(waiter);
  });
}

export function killAllManagedFfmpeg(): void {
  for (const proc of [...playbackProcesses.keys()]) killProcess(proc);
  playbackProcesses.clear();
  interruptAnalysis();
  playbackActivityLeases.clear();
}

export function managedFfmpegCounts(): { playback: number; playbackLeases: number; analysis: number; tools: number; queuedTools: number } {
  return {
    playback: playbackProcesses.size,
    playbackLeases: playbackActivityLeases.size,
    analysis: analysisProcesses.size,
    tools: activeToolCount,
    queuedTools: toolWaiters.length,
  };
}
