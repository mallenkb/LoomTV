import fs from 'node:fs/promises';
import path from 'node:path';
import { isImageFileName, isMacSidecarFile, isSubtitleFileName, isVideoFileName } from '../fileClassification.ts';
import { assertNotAborted, MAX_BATCH_ENTRIES, type DiscoveryEntry, type DiscoveryOptions, type DiscoverySink } from './discoveryTypes.ts';

const STAT_CONCURRENCY = 32;

/** No symlinked directories are followed. File symlinks retain their logical path. */
export async function discoverTypescript(root: string, sink: DiscoverySink, options: DiscoveryOptions = {}) {
  let directories = 0;
  let stats = 1;
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Library root is not a directory.');
  const visit = async (directory: string): Promise<void> => {
    assertNotAborted(options.signal);
    directories++;
    // opendir bounds traversal memory even for a directory with millions of files.
    const handle = await fs.opendir(directory, { encoding: 'buffer' as BufferEncoding });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending: { fullPath: string; supported: boolean }[] = [];
    const flush = async () => {
      if (pending.length === 0) return;
      const files = pending; pending = [];
      const batch: DiscoveryEntry[] = new Array(files.length);
      let next = 0;
      const workers = Array.from({ length: Math.min(STAT_CONCURRENCY, files.length) }, async () => {
        while (next < files.length) {
          assertNotAborted(options.signal);
          const index = next++;
          const { fullPath, supported } = files[index];
          let size = '0'; let mtime = '0';
          if (supported) {
            const metadata = await fs.stat(fullPath, { bigint: true });
            stats++;
            size = String(metadata.size);
            mtime = String(metadata.mtimeNs / 1_000_000n);
          }
          // Cache hits need only file facts. The inventory supplies filename
          // hints on demand when classification or subtitle matching needs them.
          batch[index] = { path: fullPath, kind: supported ? 'file' : 'other', size, mtime };
        }
      });
      const settled = await Promise.allSettled(workers);
      const failure = settled.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      await sink(batch);
      assertNotAborted(options.signal);
    };
    for await (const entry of handle) {
      assertNotAborted(options.signal);
      const name = decoder.decode(entry.name as unknown as Uint8Array);
      if (isMacSidecarFile(name)) continue;
      const fullPath = path.join(directory, name);
      const supported = isVideoFileName(name) || isImageFileName(name) || isSubtitleFileName(name);
      if (entry.isDirectory()) {
        await flush();
        await sink([{ path: fullPath, kind: 'directory', size: '0', mtime: '0' }]);
        assertNotAborted(options.signal);
        await visit(fullPath);
      } else {
        pending.push({ fullPath, supported });
        if (pending.length >= MAX_BATCH_ENTRIES) await flush();
      }
    }
    await flush();
  };
  await visit(root);
  return { directories, stats };
}
