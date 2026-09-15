import { z } from 'zod';
import protocolContract from '../../../native/scanner/protocol-contract.json' with { type: 'json' };

export const SCANNER_PROTOCOL = protocolContract.version;
export const MAX_FRAME_BYTES = protocolContract.maxFrameBytes;
export const MAX_BATCH_ENTRIES = protocolContract.maxBatchEntries;
export const discoveryEntrySchema = z.object({
  path: z.string().min(1).max(protocolContract.maxPathBytes).refine((value) => !value.includes('\0') && Buffer.byteLength(value) <= protocolContract.maxPathBytes),
  kind: z.enum(['directory', 'file', 'other']),
  size: z.string().regex(/^\d+$/).max(20),
  mtime: z.string().regex(/^-?\d+$/).max(20),
  hints: z.object({ title: z.string().max(32768), year: z.number().int().min(0).max(9999), season: z.number().int().min(0).max(99).optional(), episode: z.number().int().min(0).max(999).optional(), subtitleKeys: z.array(z.string().max(32768)).max(256).optional() }).strict().optional(),
}).strict();
export type DiscoveryEntry = z.infer<typeof discoveryEntrySchema>;
export type DiscoverySink = (entries: DiscoveryEntry[]) => Promise<void>;
export type DiscoveryOptions = {
  signal?: AbortSignal;
  startupTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};
export function assertNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
