/**
 * Rollback.
 *
 * A committed canonical cutover never destroys its source: `commitLegacyCanonicalImport`
 * only adds `loomtv-canonical.sqlite`. Rollback moves that database aside after proving
 * the verified backup is still intact, and restores each backed-up artifact to the
 * destination it actually came from.
 *
 * Rollback does **not** start a legacy fallback server. Legacy JSON and SQLite files are
 * read-only migration inputs and are never a fallback store after cutover, so the state a
 * rolled-back installation returns to is the previous product: the desktop app running on
 * its own database, or a server that has not yet been migrated. Restoring a legacy file
 * puts the migration source back; it does not make that file authoritative for the
 * canonical server.
 *
 * The canonical database is moved, never deleted, so a rollback taken by mistake is
 * itself reversible.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { migrationError } from './errors.mjs';
import { fileDigest, pathExists } from './sourceStaging.mjs';
import { canonicalStatePath, readCommittedMarker, redactMarker, verifyMarkerEvidence } from './canonicalMarker.mjs';

const SIDECAR_SUFFIXES = ['', '-wal', '-shm'];

/** Operator-readable steps. Printed by the command and repeated in the migration guide. */
export function rollbackInstructions({ migrationId }) {
  return [
    'Stop every LoomTV server that uses this data directory, including a desktop app that hosts one.',
    `Confirm the verified backup for migration ${migrationId} still matches its recorded SHA-256.`,
    'Move loomtv-canonical.sqlite and its -wal and -shm sidecars out of the data directory.',
    'Restore each backed-up artifact to the location it was copied from. A desktop database goes back beside the desktop app, not into the server data directory.',
    'Start the previous product, not a canonical server: the desktop app on its own database, or a server that has not been migrated. Legacy files are migration inputs and are never a canonical fallback store.',
    'Confirm the restored installation reads its own state before deleting the canonical database you moved aside.',
  ];
}

async function moveAside(target, suffix) {
  if (!await pathExists(target)) return null;
  const destination = `${target}.rolled-back-${suffix}`;
  await fs.rename(target, destination);
  return path.basename(destination);
}

/**
 * Where each backed-up artifact came from.
 *
 * The backup flattens every source into one directory and renames the desktop artifacts
 * to `desktop-source-N.sqlite`. Copying a file back under its backup name would leave a
 * desktop database sitting in the server data directory under a name nothing reads, so
 * the destination is resolved from the artifact kind instead. A desktop artifact whose
 * destination the caller did not supply is refused rather than guessed.
 */
function restoreDestination(artifact, { dataDir, desktopDatabase, desktopSettingsPath }) {
  const kind = String(artifact.kind || '');
  const legacy = {
    'admin-json': 'headless-admin.json',
    'client-sqlite': 'headless-client.sqlite',
    'client-json': 'headless-client.json',
  }[kind];
  if (legacy) return { destination: path.join(path.resolve(dataDir), legacy), origin: 'data-directory' };
  if (kind.startsWith('desktop-sqlite')) {
    if (!desktopDatabase) return { destination: null, origin: 'desktop-database' };
    const suffix = kind.slice('desktop-sqlite'.length);
    return { destination: `${path.resolve(desktopDatabase)}${suffix}`, origin: 'desktop-database' };
  }
  if (kind.startsWith('desktop-settings')) {
    if (!desktopSettingsPath) return { destination: null, origin: 'desktop-settings' };
    return { destination: path.resolve(desktopSettingsPath), origin: 'desktop-settings' };
  }
  return { destination: null, origin: 'unknown' };
}

async function planRestoreFromManifest({ manifestPath, dataDir, desktopDatabase, desktopSettingsPath }) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const backupDir = path.dirname(manifestPath);
  const unresolved = [];
  const actions = [];
  for (const artifact of manifest.artifacts || []) {
    const { destination, origin } = restoreDestination(artifact, { dataDir, desktopDatabase, desktopSettingsPath });
    if (!destination) {
      unresolved.push({ kind: artifact.kind, origin });
      continue;
    }
    const source = path.join(backupDir, artifact.fileName);
    const digest = await fileDigest(source).catch(() => null);
    if (!digest || digest.sha256 !== artifact.sha256 || digest.sizeBytes !== artifact.sizeBytes) {
      throw migrationError('rollback_evidence_missing', 'A backup artifact failed verification during restore.', {
        kind: artifact.kind,
      });
    }
    const destinationDigest = await pathExists(destination) ? await fileDigest(destination).catch(() => null) : null;
    const intact = destinationDigest?.sha256 === artifact.sha256 && destinationDigest?.sizeBytes === artifact.sizeBytes;
    actions.push({ artifact, source, destination, origin, intact });
  }
  if (unresolved.length) {
    throw migrationError('rollback_evidence_missing', 'A backup artifact has no known restore destination.', {
      unresolved,
      detail: 'Supply the desktop database and settings paths this migration was taken from, so each artifact returns to its real source location.',
    });
  }
  return actions;
}

async function restoreFromPlan(actions, suffix) {
  const restored = [];
  const skipped = [];
  const staged = [];
  for (const action of actions) {
    if (action.intact) {
      skipped.push({ kind: action.artifact.kind, reason: 'destination_verified' });
      continue;
    }
    await fs.mkdir(path.dirname(action.destination), { recursive: true });
    const temporary = `${action.destination}.rollback-partial-${suffix}`;
    await fs.copyFile(action.source, temporary);
    const handle = await fs.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    const digest = await fileDigest(temporary);
    if (digest.sha256 !== action.artifact.sha256 || digest.sizeBytes !== action.artifact.sizeBytes) {
      throw migrationError('rollback_evidence_missing', 'A staged restore artifact failed verification.', {
        kind: action.artifact.kind,
      });
    }
    staged.push({ ...action, temporary });
  }
  for (const action of staged) {
    if (await pathExists(action.destination)) {
      await fs.rename(action.destination, `${action.destination}.pre-rollback-${suffix}`);
    }
    await fs.rename(action.temporary, action.destination);
    restored.push({ kind: action.artifact.kind, origin: action.origin });
  }
  return { restored, skipped };
}

/**
 * @param {object} input
 * @param {string} input.dataDir canonical data directory
 * @param {string} [input.migrationId] refuse to roll back a different migration
 * @param {boolean} input.confirmServerStopped explicit operator acknowledgement
 * @param {boolean} [input.restoreSources] restore legacy sources that are missing
 * @param {boolean} [input.force] proceed even when the verified backup no longer matches
 */
export async function rollbackCanonicalMigration({
  dataDir,
  migrationId,
  confirmServerStopped = false,
  restoreSources = false,
  desktopDatabase = null,
  desktopSettingsPath = null,
  force = false,
}) {
  if (!confirmServerStopped) {
    throw migrationError('rollback_not_confirmed', 'Rollback requires an explicit confirmation that every server is stopped.');
  }
  const marker = readCommittedMarker({ dataDir });
  if (!marker) {
    return { rolledBack: false, reason: 'no_canonical_state', instructions: rollbackInstructions({ migrationId: migrationId || 'unknown' }) };
  }
  if (migrationId && marker.migrationId !== migrationId) {
    throw migrationError('canonical_cutover_conflict', 'The committed canonical state belongs to a different migration.', {
      committedMigrationId: marker.migrationId,
      requestedMigrationId: migrationId,
    });
  }

  const evidence = await verifyMarkerEvidence(marker);
  if (evidence.backup !== true && !force) {
    throw migrationError('rollback_evidence_missing', 'The verified backup recorded by this migration is missing or no longer matches.', {
      evidenceAvailable: evidence,
      detail: 'Restore the backup directory, or rerun with force once you have another verified copy of the pre-migration state.',
    });
  }

  const suffix = `${marker.migrationId}-${Date.now()}`;
  let restored = { restored: [], skipped: [] };
  if (restoreSources && marker.backupPath && evidence.backup === true) {
    const restorePlan = await planRestoreFromManifest({
      manifestPath: marker.backupPath,
      dataDir,
      desktopDatabase,
      desktopSettingsPath,
    });
    restored = await restoreFromPlan(restorePlan, suffix);
  }

  // The canonical store stays in place until every requested source restore has passed
  // destination resolution, digest verification, staging, and atomic replacement.
  const canonicalPath = canonicalStatePath(dataDir);
  const movedAside = [];
  for (const sidecar of SIDECAR_SUFFIXES) {
    const moved = await moveAside(`${canonicalPath}${sidecar}`, suffix);
    if (moved) movedAside.push(moved);
  }

  const directory = await fs.open(path.resolve(dataDir), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }

  return {
    rolledBack: true,
    migrationId: marker.migrationId,
    movedAside,
    restoredSources: restored.restored,
    skippedSources: restored.skipped,
    backupVerified: evidence.backup === true,
    marker: redactMarker(marker, evidence),
    instructions: rollbackInstructions({ migrationId: marker.migrationId }),
  };
}
