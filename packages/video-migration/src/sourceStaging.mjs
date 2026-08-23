/**
 * Digest helpers and the migration bundle.
 *
 * The bridge does not stage intermediate legacy files. The whole desktop projection
 * travels to the canonical server's plan builder as one `DesktopCanonicalProjection`, and the
 * authoritative pre-migration state is the untouched desktop database, which is copied
 * with its WAL and SHM sidecars into the single verified backup the canonical marker
 * records.
 *
 * What remains here is the migration bundle: artefacts with real bytes that the canonical
 * schema has no column for. Everything written is byte-stable for a given projection,
 * because the migration ID is a hash of the source and an unstable ID would make a rerun
 * a different migration instead of an idempotent one.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** JSON with recursively sorted keys, so two equal projections serialize identically. */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

const byKey = (selector) => (left, right) => {
  const a = selector(left);
  const b = selector(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

export async function fileDigest(target) {
  const hash = createHash('sha256');
  const handle = await fs.open(target, 'r');
  let sizeBytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

export const pathExists = (target) => fs.access(target).then(() => true, () => false);

async function writeFileAtomic(target, contents) {
  const staged = `${target}.partial`;
  const handle = await fs.open(staged, 'w', FILE_MODE);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(staged, target);
  const directory = await fs.open(path.dirname(target), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Migration bundle: artefacts the canonical schema has no column for.
 *
 * - Custom artwork bytes, addressed by content hash and referenced from the catalog
 *   item's extension payload. The canonical store holds artwork references, not bytes.
 * - A copy of the identity evidence, as an operator-inspectable record. The evidence
 *   itself is imported into `media_identity_evidence` through the projection carrier;
 *   this copy exists so a later migration can rebuild the ladder from a bundle alone.
 */
export async function writeMigrationBundle({ bundleDir, migrationId, artworkArtifacts = [], evidence = [] }) {
  const resolved = path.resolve(bundleDir, `migration-${migrationId}`);
  const artworkDir = path.join(resolved, 'artwork');
  await fs.mkdir(artworkDir, { recursive: true, mode: DIRECTORY_MODE });

  const artworkIndex = [];
  const writtenDigests = new Set();
  for (const artifact of artworkArtifacts) {
    const fileName = `${artifact.sha256}.bin`;
    if (!writtenDigests.has(artifact.sha256)) {
      const target = path.join(artworkDir, fileName);
      if (!await pathExists(target)) await writeFileAtomic(target, artifact.bytes);
      writtenDigests.add(artifact.sha256);
    }
    artworkIndex.push({
      fileName,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      mimeType: artifact.mimeType,
      legacyMediaId: artifact.legacyMediaId,
      target: artifact.target,
      updatedAt: artifact.updatedAt,
      attachedToCatalogItem: artifact.resolved,
    });
  }

  const indexPath = path.join(resolved, 'bundle.json');
  const index = {
    format: 'loomtv-migration-bundle-v1',
    migrationId,
    artwork: artworkIndex.sort(byKey((entry) => `${entry.legacyMediaId} ${entry.target}`)),
    identityEvidence: [...evidence].sort(byKey((entry) => `${entry.legacyMediaId} ${entry.kind} ${entry.value}`)),
  };
  await writeFileAtomic(indexPath, `${stableStringify(index)}\n`);
  return { bundleDir: resolved, indexPath, artworkCount: artworkIndex.length, evidenceCount: evidence.length };
}
