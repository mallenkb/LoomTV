/**
 * Media identity evidence.
 *
 * the canonical server's canonical vocabulary ranks evidence content-sha256 > filesystem-id >
 * quick-hash > legacy-path-hash (`IDENTITY_EVIDENCE_STRENGTH`). The bridge only ever
 * reconnects a moved file on one of the first three, and a quick-hash reconnection is
 * always reported so an operator can review it.
 */

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { IDENTITY_EVIDENCE_STRENGTH, identityEvidenceStrength } from '@loom-media-server/video-contracts';

/** Head and tail window used by the quick hash. */
export const QUICK_HASH_WINDOW_BYTES = 64 * 1024;

/** Evidence kinds the bridge is allowed to reconnect on, strongest first. */
export const RELINK_EVIDENCE_ORDER = Object.freeze(['content-sha256', 'filesystem-id', 'quick-hash']);

export function strongestEvidenceKind(kinds) {
  let best = null;
  for (const kind of kinds) {
    if (!IDENTITY_EVIDENCE_STRENGTH[kind]) continue;
    if (!best || identityEvidenceStrength(kind) > identityEvidenceStrength(best)) best = kind;
  }
  return best;
}

async function readWindow(handle, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/**
 * Deterministic cheap identity for a large media file: the byte length, the first
 * window, and the last window. Two different encodes of the same title do not collide
 * in practice, but two copies of one file do match, which is why a quick-hash match is
 * only ever accepted when it is unique and is always surfaced in the report.
 */
export async function quickHash(locator) {
  const handle = await fs.open(locator, 'r');
  try {
    const stats = await handle.stat();
    const size = Number(stats.size);
    const hash = createHash('sha256');
    hash.update(`quick-hash:v1:${size}`);
    hash.update(await readWindow(handle, 0, Math.min(QUICK_HASH_WINDOW_BYTES, size)));
    if (size > QUICK_HASH_WINDOW_BYTES) {
      hash.update(await readWindow(handle, Math.max(0, size - QUICK_HASH_WINDOW_BYTES), QUICK_HASH_WINDOW_BYTES));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function contentSha256(locator) {
  const handle = await fs.open(locator, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Device and inode survive a rename inside one filesystem, so this is the evidence that
 * reconnects a file the user moved between folders on the same volume. Windows and some
 * network mounts report inode 0; there the evidence is unavailable rather than wrong.
 */
export function filesystemId(stats) {
  const ino = Number(stats.ino);
  const dev = Number(stats.dev);
  if (!Number.isFinite(ino) || ino === 0) return null;
  return `${dev}:${ino}`;
}

/**
 * The filesystem-backed evidence provider. It is injected rather than imported directly
 * so a caller can cap the cost of a migration over a slow NAS mount, and so the
 * resolver stays a pure function of the evidence it is given.
 */
export function createFilesystemEvidenceProvider({
  allowContentHash = true,
  allowQuickHash = true,
  maxContentHashBytes = null,
} = {}) {
  const statCache = new Map();
  const valueCache = new Map();

  async function statOf(locator) {
    if (!statCache.has(locator)) {
      statCache.set(locator, fs.stat(locator).then((stats) => stats, () => null));
    }
    return statCache.get(locator);
  }

  return {
    supports(kind) {
      if (kind === 'content-sha256') return allowContentHash;
      if (kind === 'quick-hash') return allowQuickHash;
      return kind === 'filesystem-id';
    },
    async exists(locator) {
      const stats = await statOf(locator);
      return Boolean(stats && stats.isFile());
    },
    async describe(locator) {
      const stats = await statOf(locator);
      if (!stats || !stats.isFile()) return null;
      return { sizeBytes: Number(stats.size), modifiedAtMs: Number(stats.mtimeMs) };
    },
    async evidence(locator, kind) {
      if (!this.supports(kind)) return null;
      const cacheKey = `${kind} ${locator}`;
      if (valueCache.has(cacheKey)) return valueCache.get(cacheKey);
      const stats = await statOf(locator);
      if (!stats || !stats.isFile()) return null;
      if (kind === 'content-sha256' && maxContentHashBytes !== null && Number(stats.size) > maxContentHashBytes) {
        valueCache.set(cacheKey, null);
        return null;
      }
      const compute = kind === 'filesystem-id'
        ? Promise.resolve(filesystemId(stats))
        : kind === 'content-sha256'
          ? contentSha256(locator)
          : quickHash(locator);
      const value = await compute.catch(() => null);
      valueCache.set(cacheKey, value);
      return value;
    },
  };
}
