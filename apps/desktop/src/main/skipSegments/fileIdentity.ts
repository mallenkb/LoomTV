import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Cache-identity definitions shared by the resolution service, the detector,
// and the analysis coordinator. This module must stay free of database and
// Electron imports so pure coordinator tests can load it under plain Node.

export const FINGERPRINT_ALGORITHM_VERSION = 'loom-chromaprint-v1-11025-mono';

function hashId(...values: Array<string | number | null | undefined>): string {
  return createHash('sha256').update(values.map((value) => String(value ?? '')).join('|')).digest('hex').slice(0, 24);
}

export function mediaFileRevision(
  filePath: string,
  durationMs: number,
  audioTrack: number,
  known?: { fileSize?: number; modifiedAtMs?: number },
): string {
  const stats = typeof known?.fileSize === 'number' && typeof known.modifiedAtMs === 'number' ? null : fs.statSync(filePath);
  return hashId(
    path.resolve(filePath),
    known?.fileSize ?? stats?.size,
    Math.round(known?.modifiedAtMs ?? stats?.mtimeMs ?? 0),
    Math.round(durationMs),
    audioTrack,
  );
}
