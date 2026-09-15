import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
export type ScanMetrics = { probes: number; probeExecutions: number; probeCacheHits: number; probeMs: number; providers: number; requestAttempts: number; rechecks: number; providerMs: number; reconciliationMs: number };
export const scanMetrics = new AsyncLocalStorage<ScanMetrics>();
export async function measureScanWork<T>(kind: 'probe' | 'provider', work: () => Promise<T>): Promise<T> {
  const metrics = scanMetrics.getStore();
  if (!metrics) return work();
  const start = performance.now();
  if (kind === 'probe') metrics.probes++; else metrics.providers++;
  try { return await work(); }
  finally { if (kind === 'probe') metrics.probeMs += performance.now() - start; else metrics.providerMs += performance.now() - start; }
}
export function startScanMetrics() {
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const started = performance.now();
  let peakRss = process.memoryUsage().rss;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
  sample.unref();
  return () => { clearInterval(sample); delay.disable(); return { totalMs: performance.now() - started, eventLoopP95Ms: Number.isFinite(delay.percentile(95)) ? delay.percentile(95) / 1e6 : 0, peakParentRssBytes: Math.max(peakRss, process.memoryUsage().rss) }; };
}
