import { z } from 'zod';
import path from 'node:path';
import { discoveryEntrySchema, MAX_BATCH_ENTRIES, MAX_FRAME_BYTES, SCANNER_PROTOCOL } from './discoveryTypes.ts';
import protocolContract from '../../../native/scanner/protocol-contract.json' with { type: 'json' };

const requestId = z.string().min(1).max(protocolContract.maxRequestIdBytes)
  .refine((value) => !value.includes('\0') && Buffer.byteLength(value) <= protocolContract.maxRequestIdBytes);
const envelope = { version: z.literal(SCANNER_PROTOCOL), id: requestId };
export const scannerEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('ready'), capabilities: z.array(z.string()).max(16) }).strict(),
  z.object({ ...envelope, kind: z.literal('batch'), sequence: z.number().int().nonnegative().safe(), entries: z.array(discoveryEntrySchema).min(1).max(MAX_BATCH_ENTRIES) }).strict(),
  z.object({ ...envelope, kind: z.literal('progress'), directories: z.number().int().nonnegative().safe(), stats: z.number().int().nonnegative().safe() }).strict(),
  z.object({ ...envelope, kind: z.literal('complete'), directories: z.number().int().nonnegative().safe(), stats: z.number().int().nonnegative().safe(), peakRssBytes: z.number().nonnegative().safe().nullable(), signature: z.string().regex(/^inventory-v1:\d+:[a-f0-9]{64}$/).max(100), fileCount: z.number().int().nonnegative().safe() }).strict(),
  z.object({ ...envelope, kind: z.literal('cancelled') }).strict(),
  z.object({ ...envelope, kind: z.literal('error'), filesystem: z.boolean(), message: z.string().max(4096) }).strict(),
]);

export async function* decodeScannerFrames(source: AsyncIterable<Buffer>) {
  let pending = Buffer.alloc(0);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of source) {
    pending = Buffer.concat([pending, chunk]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > MAX_FRAME_BYTES) throw new Error('Scanner frame exceeds limit.');
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      yield scannerEventSchema.parse(JSON.parse(decoder.decode(line)));
    }
    if (pending.length > MAX_FRAME_BYTES) throw new Error('Scanner frame exceeds limit.');
  }
  if (pending.length) throw new Error('Scanner ended inside a frame.');
}

export const scannerCommandSchema = z.object({
  ...envelope,
  kind: z.enum(protocolContract.commandKinds as [string, ...string[]]),
  root: discoveryEntrySchema.shape.path.refine((value) => path.isAbsolute(value)).optional(),
  extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/).max(protocolContract.maxExtensionBytes)).max(protocolContract.maxExtensions).optional(),
  max_year: z.number().int().min(1).max(protocolContract.maxYear).optional(),
  expected_signature: z.string().regex(/^inventory-v1:\d+:[a-f0-9]{64}$/).max(100).optional(),
  sequence: z.number().int().nonnegative().max(protocolContract.maxSequence).optional(),
}).strict().superRefine((command, context) => {
  const fields = protocolContract.commandFields[command.kind as keyof typeof protocolContract.commandFields] as readonly string[];
  if (!fields) { context.addIssue({ code: 'custom', message: 'Unknown scanner command.' }); return; }
  const values = command as Record<string, unknown>;
  for (const key of fields) if (values[key] === undefined) context.addIssue({ code: 'custom', message: `Missing scanner command field: ${key}.` });
  for (const key of Object.keys(command)) if (!['version', 'id', 'kind', ...fields].includes(key)) context.addIssue({ code: 'custom', message: `Unexpected scanner command field: ${key}.` });
});
