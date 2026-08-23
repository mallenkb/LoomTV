/**
 * Read-only view of the canonical migration marker.
 *
 * `commitLegacyCanonicalImport` recovers an interrupted commit, but it refuses outright
 * when the canonical database already exists: `createCanonicalImportStage` throws
 * `canonical_cutover_exists` before it looks at the marker. Deciding whether a rerun is
 * the same migration or a different one is therefore the caller's job, and this module is
 * how the bridge does it without touching the canonical server's code.
 *
 * The filename and the marker columns are duplicated from
 * `apps/server/src/canonical-state-store.js`. the canonical server's `/migration` entry point does not
 * export either; that coupling is recorded in the handoff ledger as a contract request.
 */

import fsSync from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrationError } from './errors.mjs';
import { fileDigest, pathExists } from './sourceStaging.mjs';

export const CANONICAL_STATE_FILENAME = 'loomtv-canonical.sqlite';

export function canonicalStatePath(dataDir) {
  return path.join(path.resolve(dataDir), CANONICAL_STATE_FILENAME);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * @returns {object|null} the committed marker, or null when no canonical database exists.
 *   `backupPath` and `reportPath` are returned because rollback needs them. They are raw
 *   locators: never place them in a report or a log.
 */
export function readCommittedMarker({ dataDir }) {
  const databasePath = canonicalStatePath(dataDir);
  if (!fsSync.existsSync(databasePath)) return null;
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA query_only=ON');
  } catch (error) {
    throw migrationError('canonical_marker_unreadable', 'The canonical database exists but could not be opened read-only.', {
      cause: error?.code || 'unknown',
    });
  }
  try {
    const row = database.prepare("SELECT * FROM migration_markers WHERE state='committed'").get();
    if (!row) {
      throw migrationError('canonical_marker_unreadable', 'The canonical database has no committed migration marker.');
    }
    return {
      migrationId: row.id,
      format: row.format,
      schemaVersion: Number(row.schema_version),
      sourceFingerprint: row.source_fingerprint,
      backupPath: row.backup_path,
      backupSha256: row.backup_sha256,
      backupSizeBytes: row.backup_size_bytes === null ? null : Number(row.backup_size_bytes),
      reportPath: row.report_path,
      reportSha256: row.report_sha256,
      reportSizeBytes: row.report_size_bytes === null ? null : Number(row.report_size_bytes),
      sourceCounts: parseJson(row.source_counts_json, {}),
      reconciliation: parseJson(row.reconciliation_json, {}),
      targetCounts: parseJson(row.target_counts_json, {}),
      createdAt: Number(row.created_at),
      committedAt: row.committed_at === null ? null : Number(row.committed_at),
    };
  } finally {
    database.close();
  }
}

/**
 * Reconciliation category to canonical table. Categories whose destination is a singleton
 * payload row, or which are counted inside another table, are deliberately absent: a
 * readback that invented a count for them would compare two different things and report a
 * mismatch on every successful migration.
 */
const READBACK_TABLES = Object.freeze({
  accounts: 'accounts',
  accountCredentials: 'account_credentials',
  sessions: 'account_sessions',
  loginAttempts: 'login_attempts',
  roots: 'library_roots',
  catalogItems: 'catalog_items',
  mediaSources: 'media_sources',
  mediaIdentityAliases: 'media_identity_aliases',
  mediaIdentityEvidence: 'media_identity_evidence',
  profiles: 'profiles',
  profileCredentials: 'profile_credentials',
  profileAssignments: 'profile_assignments',
  profileSelections: 'profile_selections',
  progress: 'watch_progress',
  history: 'watch_history',
  profilePreferences: 'profile_preferences',
  profileRestrictions: 'profile_restrictions',
  profileListEntries: 'profile_list_entries',
  trackPreferences: 'track_preferences',
  devices: 'devices',
  deviceCredentials: 'device_credentials',
  operationalLogs: 'operational_logs',
});

/**
 * Counts what the committed database actually holds, through a separate read-only handle.
 *
 * `finalizeCanonicalImport` verifies its own write. This re-reads the renamed file so the
 * bridge does not report a successful migration on the strength of the writer's own word,
 * and it compares the result against the plan's expected target counts rather than
 * against anything the writer returned.
 */
export function readbackCanonicalCounts({ dataDir, expectedTargetCounts = {} }) {
  const databasePath = canonicalStatePath(dataDir);
  if (!fsSync.existsSync(databasePath)) {
    throw migrationError('canonical_marker_unreadable', 'The canonical database is absent during readback.');
  }
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA query_only=ON');
  } catch (error) {
    throw migrationError('canonical_marker_unreadable', 'The canonical database could not be reopened for readback.', {
      cause: error?.code || 'unknown',
    });
  }
  try {
    const observed = {};
    const mismatches = [];
    for (const [category, table] of Object.entries(READBACK_TABLES)) {
      const expected = expectedTargetCounts[category];
      if (!Number.isFinite(Number(expected))) continue;
      const row = database.prepare(`SELECT COUNT(*) AS total FROM ${JSON.stringify(table)}`).get();
      const total = Number(row?.total ?? -1);
      observed[category] = total;
      if (total !== Number(expected)) mismatches.push({ category, expected: Number(expected), observed: total });
    }
    if (mismatches.length) {
      throw migrationError('canonical_readback_mismatch', 'The committed canonical database does not hold the record counts the migration planned.', {
        mismatches: mismatches.slice(0, 32),
        mismatchCount: mismatches.length,
      });
    }
    return { verified: true, counts: observed };
  } finally {
    database.close();
  }
}

/** Confirms the backup and report the marker points at are still present and unchanged. */
export async function verifyMarkerEvidence(marker) {
  async function check(target, expectedSha, expectedSize) {
    if (!target) return null;
    if (!await pathExists(target)) return false;
    const actual = await fileDigest(target).catch(() => null);
    return Boolean(actual && actual.sha256 === expectedSha && actual.sizeBytes === expectedSize);
  }
  return {
    backup: await check(marker.backupPath, marker.backupSha256, marker.backupSizeBytes),
    report: await check(marker.reportPath, marker.reportSha256, marker.reportSizeBytes),
  };
}

/** Marker view that is safe to print or embed. Paths become presence flags. */
export function redactMarker(marker, evidenceAvailable) {
  if (!marker) return null;
  const { backupPath, reportPath, ...safe } = marker;
  return {
    ...safe,
    backupRecorded: Boolean(backupPath),
    reportRecorded: Boolean(reportPath),
    evidenceAvailable,
  };
}
