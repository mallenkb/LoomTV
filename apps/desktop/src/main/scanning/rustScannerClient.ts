import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { VIDEO_EXTENSIONS } from '@loom-media-server/media-core';
import { SCANNER_PROTOCOL, type DiscoverySink, type DiscoveryOptions } from './discoveryTypes.ts';
import { decodeScannerFrames, scannerCommandSchema } from './scannerProtocol.ts';

export class ScannerEngineError extends Error {}
export class ScannerFilesystemError extends Error {}
class ScannerCancelledError extends Error {}
const active = new Map<ChildProcess, { stop: () => void; closed: Promise<void> }>();
export function hasScannerProcesses(): boolean { return active.size > 0; }
export async function stopScannerProcesses(): Promise<void> {
  const workers = [...active.values()];
  for (const worker of workers) worker.stop();
  await Promise.all(workers.map((worker) => worker.closed));
}
export async function discoverRust(binary: string, root: string, sink: DiscoverySink, options: DiscoveryOptions & { timeoutMs?: number; fingerprintOnly?: boolean; expectedSignature?: string } = {}) {
  if (!path.isAbsolute(binary)) throw new ScannerEngineError('Scanner executable must be an absolute path.');
  if (options.fingerprintOnly && options.expectedSignature !== undefined) throw new ScannerEngineError('Conflicting scanner modes.');
  options.signal?.throwIfAborted();
  const id = randomUUID();
  const child = spawn(binary, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  } });
  let failure: Error | undefined;
  let ready = false;
  let result: { directories: number; stats: number; peakRssBytes?: number | null; signature: string; fileCount: number } | undefined;
  let sequence = 0;
  let isClosed = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt: (error: Error) => void = () => undefined;
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
  void interrupted.catch(() => undefined);
  const closed = new Promise<void>((resolve) => child.once('close', () => { isClosed = true; active.delete(child); resolve(); }));
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
  const terminate = () => {
    if (isClosed) return;
    child.kill();
    forceKill ??= setTimeout(() => { if (!isClosed) child.kill('SIGKILL'); }, shutdownTimeoutMs);
  };
  const fail = (error: Error) => {
    failure ||= error;
    interrupt(failure);
    clearTimeout(timer);
    terminate();
  };
  const send = async (command: object) => {
    const frame = JSON.stringify(scannerCommandSchema.parse({ version: SCANNER_PROTOCOL, id, ...command })) + '\n';
    await Promise.race([new Promise<void>((resolve, reject) => {
      child.stdin.write(frame, (error) => error ? reject(error) : resolve());
    }), interrupted]);
  };
  const stop = (kind: 'cancel' | 'shutdown') => {
    if (failure || isClosed) return;
    // Queue the command before rejecting any pending consumer or write.
    void send({ kind }).catch(() => undefined);
    failure = new ScannerCancelledError(kind === 'cancel' ? 'Scan cancelled.' : 'Scanner shut down.');
    interrupt(failure);
    clearTimeout(timer);
    forceKill ??= setTimeout(() => { if (!isClosed) child.kill('SIGKILL'); }, shutdownTimeoutMs);
  };
  active.set(child, { stop: () => stop('shutdown'), closed });
  child.on('error', (error) => fail(new ScannerEngineError(error.message)));
  child.stdin.on('error', (error) => fail(new ScannerEngineError(error.message)));
  // Drain diagnostics without retaining paths or an unbounded log.
  child.stderr.resume();
  timer = setTimeout(() => fail(new ScannerEngineError('Scanner startup timed out.')), options.startupTimeoutMs ?? options.timeoutMs ?? 15_000);
  const abort = () => stop('cancel');
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    await send({ kind: 'hello' });
    for await (const event of decodeScannerFrames(child.stdout)) {
      if (failure) throw failure;
      if (event.id !== id || result) throw new ScannerEngineError('Stale scanner event.');
      clearTimeout(timer);
      timer = setTimeout(() => fail(new ScannerEngineError('Scanner stopped responding.')), options.inactivityTimeoutMs ?? options.timeoutMs ?? 60_000);
      if (event.kind === 'ready') {
        if (ready || !['discovery', 'cancel', 'ack', 'signature'].every((capability) => event.capabilities.includes(capability))) throw new ScannerEngineError('Invalid scanner handshake.');
        if (options.fingerprintOnly && !event.capabilities.includes('fingerprint')) throw new ScannerEngineError('Scanner does not support signature checks.');
        if (options.expectedSignature !== undefined && !event.capabilities.includes('inspect')) throw new ScannerEngineError('Scanner does not support reusable discovery.');
        ready = true;
        await send({ kind: options.expectedSignature !== undefined ? 'inspect' : options.fingerprintOnly ? 'fingerprint' : 'discover',
          ...(options.expectedSignature !== undefined ? { expected_signature: options.expectedSignature } : {}),
          root, max_year: new Date().getFullYear() + 1, extensions: [...VIDEO_EXTENSIONS, '.vtt', '.srt', '.ass', '.ssa', '.jpg', '.jpeg', '.png', '.webp', '.avif'] });
      } else {
        if (!ready) throw new ScannerEngineError('Scanner did not handshake.');
        if (event.kind === 'batch') {
          if (options.fingerprintOnly) throw new ScannerEngineError('Unexpected inventory in signature check.');
          if (event.sequence !== sequence++) throw new ScannerEngineError('Out-of-order scanner batch.');
          await Promise.race([sink(event.entries), interrupted]);
          options.signal?.throwIfAborted();
          if (failure) throw failure;
          await send({ kind: 'ack', sequence: event.sequence });
        } else if (event.kind === 'error') {
          throw event.filesystem ? new ScannerFilesystemError(event.message) : new ScannerEngineError(event.message);
        } else if (event.kind === 'cancelled') {
          throw new ScannerCancelledError('Scan cancelled.');
        } else if (event.kind === 'complete') {
          if (event.stats !== event.fileCount + 1 || !event.signature.startsWith(`inventory-v1:${event.fileCount}:`)) throw new ScannerEngineError('Invalid scanner file count.');
          result = { directories: event.directories, stats: event.stats, peakRssBytes: event.peakRssBytes, signature: event.signature, fileCount: event.fileCount };
        }
      }
    }
    await closed;
    options.signal?.throwIfAborted();
    if (failure) throw failure;
    if (!result || child.exitCode !== 0) throw new ScannerEngineError('Scanner exited before completing discovery.');
    return result;
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    if (error instanceof ScannerFilesystemError || error instanceof ScannerCancelledError) throw error;
    throw error instanceof ScannerEngineError ? error : new ScannerEngineError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (!isClosed) { child.stdin.end(); terminate(); await closed; }
    clearTimeout(forceKill);
    active.delete(child);
  }
}
