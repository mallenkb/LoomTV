import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DiscoveryInventory, cleanupAbandonedInventories } from './inventory.ts';
import { discoverTypescript } from './typescriptDiscovery.ts';
import { discoverRust, ScannerEngineError } from './rustScannerClient.ts';
import type { DiscoveryOptions } from './discoveryTypes.ts';

export type DiscoveryEngine = 'typescript' | 'rust' | 'auto';
export function scannerBinaryPath(resources: string, platform = process.platform, arch = process.arch) {
  return path.resolve(resources, 'scanner', `${platform}-${arch}`, platform === 'win32' ? 'loom-scanner.exe' : 'loom-scanner');
}

/** One traversal supplies either a cache match or an inventory ready to consume. */
export async function inspectLibraryRoot(root: string, expectedSignature: string, options: DiscoveryOptions & { engine?: DiscoveryEngine; binary?: string } = {}) {
  if (options.engine === 'typescript') return undefined;
  cleanupAbandonedInventories();
  const started = performance.now();
  let inventory: DiscoveryInventory | undefined;
  try {
    const counts = await discoverRust(options.binary || scannerBinaryPath(path.resolve('apps/desktop/resources')),
      path.resolve(root), async (entries) => {
        inventory ??= new DiscoveryInventory(root);
        inventory.signal = options.signal;
        inventory.add(entries);
      }, { ...options, expectedSignature });
    const unchanged = counts.signature === expectedSignature;
    if (unchanged && inventory) throw new ScannerEngineError('Unexpected inventory for unchanged root.');
    if (!unchanged) {
      inventory ??= new DiscoveryInventory(root);
      inventory.signal = options.signal;
      inventory.complete = true;
      inventory.acceptWorkerSignature(counts.signature, counts.fileCount);
    }
    return { inventory, unchanged, metrics: { ...counts, engine: 'rust' as const, discoveryMs: performance.now() - started, fallback: false } };
  } catch (error) {
    inventory?.close();
    if (options.engine === 'rust' || !(error instanceof ScannerEngineError) || options.signal?.aborted) throw error;
    return undefined;
  }
}

/** No parent inventory is allocated for a native quick-scan signature check. */
export async function fingerprintLibraryRoot(root: string, options: DiscoveryOptions & { engine?: DiscoveryEngine; binary?: string } = {}) {
  if (options.engine === 'typescript') return undefined;
  cleanupAbandonedInventories();
  const started = performance.now();
  try {
    const counts = await discoverRust(options.binary || scannerBinaryPath(path.resolve('apps/desktop/resources')),
      path.resolve(root), async () => { throw new ScannerEngineError('Unexpected signature-check batch.'); },
      { ...options, fingerprintOnly: true });
    return { ...counts, engine: 'rust' as const, fingerprintOnly: true, discoveryMs: performance.now() - started };
  } catch (error) {
    if (options.engine === 'rust' || !(error instanceof ScannerEngineError) || options.signal?.aborted) throw error;
    // An older or unavailable worker falls through to ordinary discovery.
    return undefined;
  }
}
export async function discoverLibraryRoot(root: string, options: DiscoveryOptions & { engine?: DiscoveryEngine; binary?: string } = {}) {
  cleanupAbandonedInventories();
  const engine = options.engine ?? 'typescript';
  const started = performance.now();
  const attempt = async (selected: 'typescript' | 'rust') => {
    const inventory = new DiscoveryInventory(root);
    inventory.signal = options.signal;
    try {
      const sink = async (entries: Parameters<DiscoveryInventory['add']>[0]) => { inventory.add(entries); };
      const counts = selected === 'typescript'
        ? await discoverTypescript(path.resolve(root), sink, options)
        : await discoverRust(options.binary || scannerBinaryPath(path.resolve('apps/desktop/resources')), path.resolve(root), sink, options);
      inventory.complete = true;
      if ('signature' in counts) {
        if (typeof counts.signature !== 'string' || !('fileCount' in counts) || typeof counts.fileCount !== 'number') {
          throw new ScannerEngineError('Scanner signature is missing.');
        }
        try { inventory.acceptWorkerSignature(counts.signature, counts.fileCount); }
        catch (error) { throw new ScannerEngineError(error instanceof Error ? error.message : String(error)); }
      }
      return { inventory, metrics: { ...counts, engine: selected, discoveryMs: performance.now() - started, fallback: false } };
    } catch (error) { inventory.close(); throw error; }
  };
  try { return await attempt(engine === 'typescript' ? 'typescript' : 'rust'); }
  catch (error) {
    if (engine !== 'auto' || !(error instanceof ScannerEngineError) || options.signal?.aborted) throw error;
    console.warn('[scanner] Rust discovery failed; retrying the root with TypeScript:', error.message);
    const result = await attempt('typescript');
    result.metrics.fallback = true;
    return result;
  }
}
