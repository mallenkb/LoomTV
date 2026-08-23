/**
 * The migration bridge.
 *
 * Orchestrates the canonical server's frozen migration API in the order the API requires:
 *
 *   createLegacyCanonicalImportPlan -> createVerifiedLegacyBackup -> createMigrationReport
 *   -> write the redacted report -> commitLegacyCanonicalImport
 *
 * The commit API stages the canonical database, verifies it, records the backup and
 * report SHA-256 and sizes, fsyncs, atomically renames, fsyncs the directory, and
 * reopens. It recovers an interrupted commit on its own, but it refuses when a canonical
 * database already exists, so deciding whether a rerun is the same migration is this
 * module's job. That decision is made on the committed marker, its evidence digests, and
 * its reconciliation, and on nothing weaker.
 *
 * `plan.state` holds credentials and raw locators. It is passed to the commit API and is
 * never serialized, logged, or returned to a caller.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  commitLegacyCanonicalImport,
  createLegacyCanonicalImportPlan,
  createMigrationReport,
  createVerifiedLegacyBackup,
  legacyStateFilenames,
  mapLegacyAllowedFolders,
} from 'loom-media-server-headless/migration';
import { createMediaItemId } from '@loom-media-server/media-core';
import { migrationError } from './errors.mjs';
import { createFilesystemEvidenceProvider } from './evidence.mjs';
import { readDesktopInventory } from './desktopInventory.mjs';
import { resolveMediaIdentity } from './identityResolver.mjs';
import { projectDesktopState } from './desktopProjection.mjs';
import { createOwnerAccount } from './ownerCredential.mjs';
import { persistMigrationFailureReport, persistMigrationReport } from './reportStore.mjs';
import { opaqueFingerprint } from './redaction.mjs';
import {
  readCommittedMarker,
  readbackCanonicalCounts,
  redactMarker,
  verifyMarkerEvidence,
} from './canonicalMarker.mjs';
import { rollbackInstructions } from './rollback.mjs';
import { fileDigest, pathExists, writeMigrationBundle } from './sourceStaging.mjs';

const sameJson = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

async function snapshotMigrationSources({ dataDir, desktopDatabase, desktopSettingsPath }) {
  const clientSqlite = path.join(dataDir, legacyStateFilenames.clientSqlite);
  const candidates = [
    [path.join(dataDir, legacyStateFilenames.admin), 'admin-json'],
    [clientSqlite, 'client-sqlite'],
    [`${clientSqlite}-wal`, 'client-sqlite-wal'],
    [`${clientSqlite}-shm`, 'client-sqlite-shm'],
    [path.join(dataDir, legacyStateFilenames.clientJson), 'client-json'],
    ...(desktopDatabase ? [
      [desktopDatabase, 'desktop-sqlite'],
      [`${desktopDatabase}-wal`, 'desktop-sqlite-wal'],
      [`${desktopDatabase}-shm`, 'desktop-sqlite-shm'],
    ] : []),
    ...(desktopSettingsPath ? [[desktopSettingsPath, 'desktop-settings']] : []),
  ];
  const snapshot = [];
  for (const [target, kind] of candidates) {
    const resolved = path.resolve(target);
    const exists = await pathExists(resolved);
    snapshot.push({ target: resolved, kind, exists, ...(exists ? await fileDigest(resolved) : {}) });
  }
  return snapshot;
}

async function assertSourceSnapshotUnchanged(expected) {
  for (const source of expected) {
    const exists = await pathExists(source.target);
    if (exists !== source.exists) {
      throw migrationError('legacy_state_changed', 'The migration source set changed after the import plan was built.', {
        sourceKind: source.kind,
      });
    }
    if (!exists) continue;
    const actual = await fileDigest(source.target);
    if (source.sha256 !== actual.sha256 || source.sizeBytes !== actual.sizeBytes) {
      throw migrationError('legacy_state_changed', 'A migration source changed after the import plan was built.', {
        sourceKind: source.kind,
      });
    }
  }
}

function resolveWorkDirectories({ dataDir, workDir, backupDir, reportDir, bundleDir }) {
  const root = path.resolve(workDir || path.join(path.resolve(dataDir), 'loomtv-migration'));
  return {
    workDir: root,
    backupDir: path.resolve(backupDir || path.join(root, 'backups')),
    reportDir: path.resolve(reportDir || path.join(root, 'reports')),
    bundleDir: path.resolve(bundleDir || path.join(root, 'bundles')),
  };
}

async function hasLegacyHeadlessSources(dataDir) {
  for (const fileName of Object.values(legacyStateFilenames)) {
    if (await pathExists(path.join(path.resolve(dataDir), fileName))) return true;
  }
  return false;
}

async function readExistingHeadlessOwner(dataDir) {
  const ownerPath = path.join(path.resolve(dataDir), legacyStateFilenames.admin);
  if (!await pathExists(ownerPath)) return null;
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  } catch {
    throw migrationError('legacy_state_malformed', 'The legacy headless admin state could not be parsed.', {
      table: 'headless_admin',
      column: 'document',
      recordReference: opaqueFingerprint('owner-singleton'),
    });
  }
  if (raw?.owner === null || raw?.owner === undefined) return null;
  const owner = raw.owner;
  if (!owner || typeof owner.id !== 'string' || !owner.id
    || typeof owner.salt !== 'string' || !owner.salt
    || typeof owner.hash !== 'string' || !owner.hash) {
    throw migrationError('legacy_state_malformed', 'The legacy headless owner record is incomplete.', {
      table: 'headless_admin',
      column: 'owner',
      recordReference: opaqueFingerprint('owner-singleton'),
    });
  }
  return {
    id: owner.id,
    name: typeof owner.name === 'string' && owner.name ? owner.name : 'Owner',
    salt: owner.salt,
    hash: owner.hash,
  };
}

async function validateLegacyJsonSources(dataDir) {
  const sources = [
    [legacyStateFilenames.admin, 'headless_admin'],
    [legacyStateFilenames.clientJson, 'headless_client'],
  ];
  for (const [fileName, table] of sources) {
    const target = path.join(path.resolve(dataDir), fileName);
    if (!await pathExists(target)) continue;
    try {
      JSON.parse(await fs.readFile(target, 'utf8'));
    } catch {
      throw migrationError('legacy_state_malformed', 'A legacy headless JSON document could not be parsed.', {
        table,
        column: 'document',
        recordReference: opaqueFingerprint(fileName),
      });
    }
  }
}

/**
 * A clock taken from the source rather than from the wall.
 *
 * the canonical server derives the migration ID from a hash of the source bytes. If the projection stamped
 * `Date.now()` into the staged files, every attempt would produce a different migration
 * ID and a rerun could never be recognised as the same migration.
 */
function sourceClock(inventory) {
  let latest = 1;
  const consider = (value) => {
    const number = Number(value);
    if (Number.isFinite(number) && number > latest) latest = number;
  };
  for (const folder of inventory.folders) consider(folder.addedAt);
  for (const item of inventory.mediaItems) consider(item.updatedAt);
  for (const profile of inventory.profiles) { consider(profile.createdAt); consider(profile.updatedAt); }
  for (const entry of inventory.progress) consider(entry.updatedAt);
  for (const entry of inventory.preferences) consider(entry.updatedAt);
  for (const entry of inventory.trackPreferences) consider(entry.updatedAt);
  for (const entry of inventory.selections) consider(entry.selectedAt);
  for (const entry of inventory.customArtwork) consider(entry.updatedAt);
  return latest;
}

/** Stable opaque owner account ID, so a rerun projects the same bytes. */
function deriveOwnerAccountId(inventory) {
  const ownerProfile = inventory.profiles.find((profile) => profile.profileType === 'owner');
  const seed = ownerProfile
    ? `owner-profile:${ownerProfile.id}`
    : `profiles:${inventory.profiles.map((profile) => profile.id).sort().join(',')}`;
  const digest = createHash('sha256').update(`loomtv-canonical-owner:${seed}`).digest('hex');
  return [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join('-');
}

/**
 * Resolves every desktop library grant to canonical root IDs before the plan is built.
 *
 * the canonical server's own carrier normalization would run `mapLegacyAllowedFolders` against the roots it
 * has already read from the data directory. In projected mode that set is empty, because
 * the roots arrive inside the projection rather than from a headless file, so every grant
 * would fail as unmatched. Mapping here, against the roots this migration actually
 * projects, is the only place the two are in scope together.
 *
 * The mapping helper stays the canonical server's, so the fail-closed rule has one implementation: an empty
 * grant list becomes `null`, meaning every root, and a subfolder grant throws rather than
 * widening. Every failure is collected first, so an operator sees the whole list at once.
 */
function resolveRestrictions({ profileRestrictions, roots }) {
  const failures = [];
  const resolved = [];
  for (const record of profileRestrictions) {
    const { allowedFolders, ...canonical } = record;
    try {
      resolved.push({
        ...canonical,
        allowedRootIds: mapLegacyAllowedFolders({ allowedFolders, libraryRoots: roots }) ?? null,
      });
    } catch (error) {
      failures.push({
        profileId: record.profileId,
        code: error?.code || 'legacy_folder_restriction_unmatched',
        locatorFingerprint: error?.locatorFingerprint || null,
      });
    }
  }
  if (failures.length) {
    throw migrationError(
      'legacy_restriction_unrepresentable',
      'Desktop library grants cannot be represented by canonical root IDs. Migration stopped without changing any state.',
      {
        failures,
        detail: 'A subfolder grant has no canonical form, and widening it to the whole root would give a restricted profile more access than it has today.',
      },
    );
  }
  return resolved;
}

function expectedTargetCounts(reconciliation) {
  return Object.fromEntries(Object.entries(reconciliation || {}).map(([category, row]) => [
    category,
    Number(row?.imported || 0) + Number(row?.generated || 0),
  ]));
}

/**
 * Reuses an existing verified backup instead of recreating it.
 *
 * `createVerifiedLegacyBackup` stamps `createdAt` into its manifest, so recreating the
 * backup would change the manifest digest that the canonical marker records, and a rerun
 * after an interrupted commit would be rejected as a stage conflict rather than resumed.
 */
async function ensureVerifiedLegacyBackup({ dataDir, migrationId, destinationDir, additionalArtifacts = [] }) {
  const manifestPath = path.join(path.resolve(destinationDir), `canonical-cutover-${migrationId}`, 'manifest.json');
  if (await pathExists(manifestPath)) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (manifest.migrationId !== migrationId) {
      throw migrationError('staging_conflict', 'An existing legacy backup belongs to a different migration.');
    }
    for (const artifact of manifest.artifacts || []) {
      const actual = await fileDigest(path.join(path.dirname(manifestPath), artifact.fileName)).catch(() => null);
      if (!actual || actual.sha256 !== artifact.sha256 || actual.sizeBytes !== artifact.sizeBytes) {
        throw migrationError('backup_verification_failed', 'An existing legacy backup failed verification.', {
          fileName: artifact.fileName,
          detail: 'Move the backup directory aside and rerun so a fresh verified backup is taken.',
        });
      }
    }
    return { backupPath: manifestPath, artifactCount: (manifest.artifacts || []).length, verified: true, reused: true };
  }
  const backup = await createVerifiedLegacyBackup({ dataDir, migrationId, destinationDir, additionalArtifacts });
  return { ...backup, reused: false };
}

/**
 * The artifacts that make up the true pre-migration state.
 *
 * In projected mode the data directory holds no legacy headless files, so the
 * authoritative source is the desktop database. the canonical server's backup routine copies a SQLite
 * artifact together with its `-wal` and `-shm` sidecars and digest-verifies each one, and
 * it records the whole set in the single manifest the canonical marker points at. Passing
 * the desktop database here, rather than backing it up separately, is what binds the
 * authoritative source to the marker that rollback later checks.
 */
function desktopBackupArtifacts(options) {
  if (!options.desktopDatabase) return [];
  return [
    { path: path.resolve(options.desktopDatabase), kind: 'desktop-sqlite' },
    ...(options.desktopSettingsPath ? [{ path: path.resolve(options.desktopSettingsPath), kind: 'desktop-settings' }] : []),
  ];
}

/**
 * Builds the import plan and everything the report needs, without writing to the data
 * directory. This is the whole of a dry run and the first half of a real run.
 */
async function prepareCanonicalMigration(options) {
  const dataDir = path.resolve(options.dataDir);
  const directories = resolveWorkDirectories({ dataDir, ...options });
  const desktopDatabase = options.desktopDatabase ? path.resolve(options.desktopDatabase) : null;
  const desktopSettingsPath = options.desktopSettingsPath ? path.resolve(options.desktopSettingsPath) : null;
  const legacyPresent = await hasLegacyHeadlessSources(dataDir);
  if (legacyPresent) await validateLegacyJsonSources(dataDir);

  if (!desktopDatabase && !legacyPresent) {
    throw migrationError('desktop_database_missing', 'No legacy state was found. Supply a desktop database, or point at a data directory that holds headless legacy state.');
  }

  const sourceMode = desktopDatabase ? legacyPresent ? 'combined' : 'projected' : 'direct';
  const sourceSnapshot = await snapshotMigrationSources({ dataDir, desktopDatabase, desktopSettingsPath });
  let projection = null;
  let identity = null;
  let inventory = null;
  let planDir = dataDir;
  let ownerAccount = null;

  if (desktopDatabase) {
    inventory = readDesktopInventory({ databasePath: desktopDatabase, settingsPath: desktopSettingsPath });
    const now = sourceClock(inventory);

    const seriesIds = new Set(inventory.episodeFiles.map((file) => file.seriesId));
    const records = new Map();
    for (const item of inventory.mediaItems) {
      if (seriesIds.has(item.id) || !item.filePath) continue;
      records.set(item.id, { legacyMediaId: item.id, locator: path.resolve(item.filePath) });
    }
    for (const file of inventory.episodeFiles) {
      const locator = path.resolve(file.filePath);
      const legacyMediaId = createMediaItemId(locator);
      if (records.has(legacyMediaId)) continue;
      records.set(legacyMediaId, { legacyMediaId, locator });
    }

    const provider = options.evidenceProvider || createFilesystemEvidenceProvider({
      allowContentHash: options.allowContentHash !== false,
      allowQuickHash: options.allowQuickHash !== false,
      maxContentHashBytes: options.maxContentHashBytes ?? null,
    });
    identity = await resolveMediaIdentity({
      records: [...records.values()],
      candidateLocators: (options.relinkCandidates || []).map((locator) => path.resolve(locator)),
      priorEvidence: options.priorEvidence || [],
      provider,
      observedAt: now,
    });

    const ownerProfile = inventory.profiles.find((profile) => profile.profileType === 'owner');
    const existingHeadlessOwner = legacyPresent ? await readExistingHeadlessOwner(dataDir) : null;
    ownerAccount = existingHeadlessOwner || await createOwnerAccount({
      name: options.owner?.name || ownerProfile?.name || 'Owner',
      password: options.owner?.password,
      accountId: options.owner?.accountId || deriveOwnerAccountId(inventory),
      createdAt: now,
    });

    projection = projectDesktopState({
      inventory,
      identity,
      ownerAccount,
      sessionPolicy: options.sessionPolicy || 'preserve',
      now,
    });
    projection.desktopState.profileRestrictions = resolveRestrictions({
      profileRestrictions: projection.desktopState.profileRestrictions,
      roots: projection.desktopState.adminState.roots,
    });
    if (existingHeadlessOwner) {
      // The direct headless source remains the sole account record. Desktop profiles and
      // devices bind to that owner, so a combined import does not synthesize a duplicate
      // credential or fail reconciliation by counting the same owner twice.
      projection.desktopState.adminState.owner = null;
      projection.decisions.push({
        code: 'combined_owner_preserved',
        value: 'existing-headless-owner',
      });
    }
  }

  // The plan is built against the real data directory and one complete
  // `DesktopCanonicalProjection`. Nothing is written to an intermediate legacy file: in
  // projected mode this directory holds no headless sources, so every record reaches the
  // frozen importer exactly once and through the carrier the canonical server validates.
  const plan = await createLegacyCanonicalImportPlan({
    dataDir: planDir,
    desktopState: projection ? projection.desktopState : null,
  });
  await assertSourceSnapshotUnchanged(sourceSnapshot);

  // the canonical server leaves these arrays empty for the bridge to fill. Nothing else on the plan is
  // touched: the commit API reads migrationId, sourceFingerprint, sourceCounts,
  // reconciliation, and state, and all five stay exactly as the canonical server produced them.
  if (projection) {
    plan.decisions.push(...projection.decisions);
    plan.decisions.push(...identity.decisions);
    plan.warnings.push(...projection.warnings, ...identity.warnings);
    plan.conflicts.push(...projection.conflicts, ...identity.conflicts);
  }
  plan.decisions.push({ code: 'source_mode', value: sourceMode });
  plan.decisions.push({
    code: 'legacy_sources_retained',
    value: 'read-only-until-operator-removes-them',
    detail: 'The commit only adds the canonical database. The pre-migration state stays in place and remains the rollback target.',
  });
  return {
    dataDir,
    planDir,
    sourceMode,
    directories,
    plan,
    projection,
    identity,
    inventory,
    ownerAccount,
    sourceSnapshot,
    expectedTargetCounts: expectedTargetCounts(plan.reconciliation),
  };
}

async function prepareCanonicalMigrationWithFailureReport(options, dryRun) {
  try {
    return await prepareCanonicalMigration(options);
  } catch (error) {
    if (!['desktop_state_malformed', 'legacy_state_malformed'].includes(error?.code)) throw error;
    const dataDir = path.resolve(options.dataDir);
    const directories = resolveWorkDirectories({ dataDir, ...options });
    const sourceTarget = error.table === 'headless_client'
      ? path.join(dataDir, legacyStateFilenames.clientJson)
      : error.table === 'headless_admin'
        ? path.join(dataDir, legacyStateFilenames.admin)
        : error.table === 'desktop_settings' && options.desktopSettingsPath
          ? path.resolve(options.desktopSettingsPath)
        : options.desktopDatabase
          ? path.resolve(options.desktopDatabase)
          : path.join(dataDir, legacyStateFilenames.admin);
    const sourceEvidence = await fileDigest(sourceTarget).catch(() => ({ sha256: 'unavailable', sizeBytes: 0 }));
    const recordReference = error.recordReference
      || opaqueFingerprint(`${error.table || 'unknown'}:${error.column || 'unknown'}`);
    const failureId = createHash('sha256').update(JSON.stringify({
      code: error.code,
      table: error.table || 'unknown',
      column: error.column || 'unknown',
      recordReference,
      sourceFingerprint: sourceEvidence.sha256,
    })).digest('hex').slice(0, 32);
    const report = {
      format: 'loomtv-canonical-migration-failure-v1',
      failureId,
      dryRun: dryRun === true,
      sourceFingerprint: sourceEvidence.sha256,
      sourceSizeBytes: sourceEvidence.sizeBytes,
      error: {
        code: error.code,
        table: error.table || 'unknown',
        column: error.column || 'unknown',
        recordReference,
        ...(Number.isSafeInteger(error.byteLength) ? { byteLength: error.byteLength } : {}),
      },
      canonicalStateChanged: false,
      redactions: { rawPaths: true, credentials: true, malformedValues: true },
    };
    try {
      const persisted = await persistMigrationFailureReport({
        reportDir: directories.reportDir,
        failureId,
        report,
      });
      Object.assign(error, {
        failureReportId: failureId,
        failureReportFileName: path.basename(persisted.reportPath),
        failureReportWritten: true,
      });
    } catch (reportError) {
      throw migrationError('failure_report_write_failed', 'The migration stopped, but its redacted failure report could not be written.', {
        migrationFailureCode: error.code,
        failureReportId: failureId,
        reportFailureCode: reportError?.code || 'failure_report_write_failed',
      });
    }
    throw error;
  }
}

/** Dry run: plan, report, and write nothing into the canonical data directory. */
export async function planCanonicalMigration(options) {
  const prepared = await prepareCanonicalMigrationWithFailureReport(options, true);
  const report = createMigrationReport(prepared.plan, {
    dryRun: true,
    targetCounts: prepared.expectedTargetCounts,
    backup: null,
  });
  const persisted = await persistMigrationReport({
    reportDir: prepared.directories.reportDir,
    migrationId: prepared.plan.migrationId,
    report,
    dryRun: true,
  });
  return {
    dryRun: true,
    committed: false,
    migrationId: prepared.plan.migrationId,
    sourceMode: prepared.sourceMode,
    sourceFingerprint: prepared.plan.sourceFingerprint,
    directories: prepared.directories,
    report,
    reportPath: persisted.reportPath,
    summary: prepared.projection?.summary || null,
    rollback: rollbackInstructions({ migrationId: prepared.plan.migrationId }),
  };
}

/**
 * Real run: verified backup, report, commit, and independent readback.
 *
 * A rerun of a migration that already committed is a no-op, and only when the committed
 * marker, its evidence digests, and its reconciliation all match this plan. Anything else
 * is a conflict and stops.
 */
export async function runCanonicalMigration(options) {
  const prepared = await prepareCanonicalMigrationWithFailureReport(options, false);
  const { plan, directories, dataDir, planDir } = prepared;

  const existing = readCommittedMarker({ dataDir });
  if (existing) {
    const evidence = await verifyMarkerEvidence(existing);
    const matches = existing.migrationId === plan.migrationId
      && existing.sourceFingerprint === plan.sourceFingerprint
      && sameJson(existing.sourceCounts, plan.sourceCounts)
      && sameJson(existing.reconciliation, plan.reconciliation);
    if (!matches) {
      throw migrationError('canonical_cutover_conflict', 'This data directory already holds a different committed canonical migration.', {
        committedMigrationId: existing.migrationId,
        requestedMigrationId: plan.migrationId,
        detail: 'Roll the committed migration back before importing different state.',
      });
    }
    return {
      dryRun: false,
      committed: true,
      recovered: true,
      migrationId: plan.migrationId,
      sourceMode: prepared.sourceMode,
      sourceFingerprint: plan.sourceFingerprint,
      directories,
      marker: redactMarker(existing, evidence),
      evidenceAvailable: evidence,
      report: null,
      reportPath: null,
      rollback: rollbackInstructions({ migrationId: plan.migrationId }),
    };
  }

  await assertSourceSnapshotUnchanged(prepared.sourceSnapshot);
  const backup = await ensureVerifiedLegacyBackup({
    dataDir: planDir,
    migrationId: plan.migrationId,
    destinationDir: directories.backupDir,
    additionalArtifacts: desktopBackupArtifacts(options),
  });
  await assertSourceSnapshotUnchanged(prepared.sourceSnapshot);
  if (prepared.sourceMode === 'projected' || prepared.sourceMode === 'combined') {
    plan.decisions.push({
      code: 'desktop_source_backup',
      value: 'verified-in-canonical-marker-manifest',
      count: backup.artifactCount,
      detail: 'The desktop database and its WAL and SHM sidecars are copied and digest-verified into the same manifest the canonical marker records.',
    });
  }

  const bundle = prepared.projection
    ? await writeMigrationBundle({
      bundleDir: directories.bundleDir,
      migrationId: plan.migrationId,
      artworkArtifacts: prepared.projection.artworkArtifacts,
      evidence: prepared.identity.evidence,
    })
    : null;
  if (bundle) {
    plan.decisions.push({
      code: 'migration_bundle_written',
      value: 'artwork-and-identity-evidence',
      count: bundle.artworkCount + bundle.evidenceCount,
    });
  }

  const report = createMigrationReport(plan, {
    dryRun: false,
    targetCounts: prepared.expectedTargetCounts,
    backup: { verified: backup.verified, artifactCount: backup.artifactCount },
  });
  const persisted = await persistMigrationReport({
    reportDir: directories.reportDir,
    migrationId: plan.migrationId,
    report,
    dryRun: false,
  });

  const result = await commitLegacyCanonicalImport({
    dataDir,
    plan,
    backupPath: backup.backupPath,
    reportPath: persisted.reportPath,
  });

  // Independent readback. `finalizeCanonicalImport` already reopens and verifies the
  // renamed database; this re-reads it in a separate handle so the bridge does not report
  // success on the strength of the writer's own word.
  const marker = readCommittedMarker({ dataDir });
  if (!marker || marker.migrationId !== plan.migrationId) {
    throw migrationError('canonical_marker_unreadable', 'The committed canonical state did not read back with the expected migration marker.', {
      expectedMigrationId: plan.migrationId,
    });
  }
  const evidence = await verifyMarkerEvidence(marker);
  const readback = readbackCanonicalCounts({ dataDir, expectedTargetCounts: prepared.expectedTargetCounts });

  return {
    dryRun: false,
    committed: true,
    recovered: result.recovered === true,
    readback,
    migrationId: plan.migrationId,
    sourceMode: prepared.sourceMode,
    sourceFingerprint: plan.sourceFingerprint,
    directories,
    report,
    reportPath: persisted.reportPath,
    reportReused: persisted.reused,
    backup: { artifactCount: backup.artifactCount, reused: backup.reused },

    bundle: bundle ? { artworkCount: bundle.artworkCount, evidenceCount: bundle.evidenceCount } : null,
    marker: redactMarker(marker, evidence),
    evidenceAvailable: evidence,
    summary: prepared.projection?.summary || null,
    rollback: rollbackInstructions({ migrationId: plan.migrationId }),
  };
}

/** Reports what a data directory currently holds, without changing anything. */
export async function inspectCanonicalMigration({ dataDir }) {
  const marker = readCommittedMarker({ dataDir });
  if (!marker) {
    return {
      committed: false,
      legacySourcesPresent: await hasLegacyHeadlessSources(dataDir),
    };
  }
  const evidence = await verifyMarkerEvidence(marker);
  return {
    committed: true,
    legacySourcesPresent: await hasLegacyHeadlessSources(dataDir),
    marker: redactMarker(marker, evidence),
    evidenceAvailable: evidence,
  };
}
