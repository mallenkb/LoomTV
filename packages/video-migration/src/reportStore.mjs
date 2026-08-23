/**
 * Operator report persistence.
 *
 * the canonical server's commit API records the report's SHA-256 and byte length in the canonical
 * migration marker, and a recovered stage is only accepted when those digests still
 * match. `createMigrationReport` stamps `createdAt`, so writing a fresh report on every
 * attempt would change the digest and turn an idempotent rerun into a stage conflict.
 * A report for a migration ID that already exists is therefore verified and reused, never
 * rewritten.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { CANONICAL_MIGRATION_REPORT_FIELDS } from 'loom-media-server-headless/migration';
import { migrationError } from './errors.mjs';
import { assertRedacted, assertReportFields } from './redaction.mjs';
import { fileDigest, pathExists } from './sourceStaging.mjs';

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_FAILURE_REPORT_BYTES = 64 * 1024;

export function migrationReportFileName(migrationId, dryRun) {
  return `loomtv-migration-${migrationId}${dryRun ? '-dry-run' : ''}.json`;
}

export function migrationFailureReportFileName(failureId) {
  return `loomtv-migration-failure-${failureId}.json`;
}

const sameJson = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * Validates the report against the frozen field list and the redaction rules, then writes
 * it, or reuses a byte-identical predecessor.
 */
export async function persistMigrationReport({ reportDir, migrationId, report, dryRun }) {
  assertReportFields(report, CANONICAL_MIGRATION_REPORT_FIELDS);
  assertRedacted(report);
  if (report.migrationId !== migrationId) {
    throw migrationError('report_field_mismatch', 'The report migration ID does not match the plan.', {
      expectedMigrationId: migrationId,
    });
  }

  const resolvedDir = path.resolve(reportDir);
  await fs.mkdir(resolvedDir, { recursive: true, mode: DIRECTORY_MODE });
  const reportPath = path.join(resolvedDir, migrationReportFileName(migrationId, dryRun));

  if (await pathExists(reportPath)) {
    const existing = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    const compatible = existing.format === report.format
      && existing.migrationId === report.migrationId
      && existing.sourceFingerprint === report.sourceFingerprint
      && existing.dryRun === report.dryRun
      && sameJson(existing.sourceCounts, report.sourceCounts)
      && sameJson(existing.reconciliation, report.reconciliation);
    if (!compatible) {
      throw migrationError('staging_conflict', 'A report already exists for this migration ID and describes different state.', {
        detail: 'Move the existing report aside if the previous attempt should be abandoned, then rerun.',
      });
    }
    return { reportPath, reused: true, ...await fileDigest(reportPath) };
  }

  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const staged = `${reportPath}.partial`;
  const handle = await fs.open(staged, 'w', FILE_MODE);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(staged, reportPath);
  const directory = await fs.open(resolvedDir, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return { reportPath, reused: false, ...await fileDigest(reportPath) };
}

export async function persistMigrationFailureReport({ reportDir, failureId, report }) {
  assertRedacted(report);
  if (report?.format !== 'loomtv-canonical-migration-failure-v1' || report.failureId !== failureId) {
    throw migrationError('report_field_mismatch', 'The failure report does not match its identifier.');
  }
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_FAILURE_REPORT_BYTES) {
    throw migrationError('failure_report_write_failed', 'The migration failure report exceeded its size limit.');
  }
  const resolvedDir = path.resolve(reportDir);
  await fs.mkdir(resolvedDir, { recursive: true, mode: DIRECTORY_MODE });
  const reportPath = path.join(resolvedDir, migrationFailureReportFileName(failureId));
  if (await pathExists(reportPath)) {
    const existing = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    if (!sameJson(existing, report)) {
      throw migrationError('staging_conflict', 'An existing migration failure report describes different evidence.');
    }
    return { reportPath, reused: true, ...await fileDigest(reportPath) };
  }
  const staged = `${reportPath}.partial`;
  const handle = await fs.open(staged, 'wx', FILE_MODE);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(staged, reportPath);
  const directory = await fs.open(resolvedDir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return { reportPath, reused: false, ...await fileDigest(reportPath) };
}
