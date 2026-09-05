import { performance } from 'node:perf_hooks';

type Diagnostic = { elapsedMs: number; event: string; value?: string | number | boolean };
const recent: Diagnostic[] = [];
const started = performance.now();

// Only pass fixed event names and scalar state, never media URLs, paths,
// credentials, or exception messages. Keep normal playback free of disk I/O.
export function recordPlaybackDiagnostic(event: string, value?: Diagnostic['value']): void {
  recent.push({ elapsedMs: Math.round(performance.now() - started), event, value });
  if (recent.length > 128) recent.shift();
  if (process.env.LOOMTV_DEBUG_PLAYBACK === '1') console.info('[playback timing]', recent[recent.length - 1]);
}

export function playbackDiagnostics(): Diagnostic[] {
  return recent.map((entry) => ({ ...entry }));
}
