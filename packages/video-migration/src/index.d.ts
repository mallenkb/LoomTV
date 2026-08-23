/**
 * Public declarations for `@loom-media-server/video-migration`.
 *
 * Only redacted results appear here. The inventory, the desktop projection, the identity
 * resolver, the owner credential, and the canonical server's import plan all carry credential material or
 * raw locators, so they have no public type and no public export.
 */

export const MIGRATION_ERROR_CODES: readonly string[];

export declare class MigrationBridgeError extends Error {
  readonly code: string;
  readonly [key: string]: unknown;
}

export function migrationError(code: string, message: string, details?: Record<string, unknown>): MigrationBridgeError;
export function isMigrationBridgeError(value: unknown): value is MigrationBridgeError;

export function assertRedacted<T extends Record<string, unknown>>(report: T): T;
export function assertReportFields<T extends Record<string, unknown>>(report: T, expectedFields: readonly string[]): T;
export function locatorFingerprint(locator: string): string;
export function opaqueFingerprint(value: string): string;

export const QUICK_HASH_WINDOW_BYTES: number;
export const RELINK_EVIDENCE_ORDER: readonly ['content-sha256', 'filesystem-id', 'quick-hash'];
export function strongestEvidenceKind(kinds: Iterable<string>): string | null;

export const DESKTOP_DATABASE_FILENAME: 'loomtv.sqlite';
export const CANONICAL_STATE_FILENAME: 'loomtv-canonical.sqlite';
export function canonicalStatePath(dataDir: string): string;
export function migrationReportFileName(migrationId: string, dryRun: boolean): string;

export interface EvidenceProvider {
  supports(kind: string): boolean;
  exists(locator: string): Promise<boolean>;
  describe(locator: string): Promise<{ sizeBytes: number; modifiedAtMs: number } | null>;
  evidence(locator: string, kind: string): Promise<string | null>;
}

export interface MigrationOptions {
  /** Canonical data directory. The committed database and the marker live here. */
  dataDir: string;
  /** Desktop `loomtv.sqlite`. Present for a desktop-sourced migration, absent for a headless one. */
  desktopDatabase?: string;
  desktopSettingsPath?: string;
  workDir?: string;
  backupDir?: string;
  reportDir?: string;
  bundleDir?: string;
  /** The owner password is used to derive a credential and is never reported or logged. */
  owner?: { name?: string; password?: string; accountId?: string };
  sessionPolicy?: 'preserve' | 'revoke';
  /** Files on disk that no intact record claims, offered as reconnection candidates. */
  relinkCandidates?: string[];
  priorEvidence?: Array<{ legacyMediaId: string; kind: string; value: string }>;
  allowContentHash?: boolean;
  allowQuickHash?: boolean;
  maxContentHashBytes?: number | null;
  evidenceProvider?: EvidenceProvider;
}

/** Marker view with every raw locator replaced by a presence flag. */
export interface RedactedMarker {
  migrationId: string;
  format: string;
  schemaVersion: number;
  sourceFingerprint: string;
  backupRecorded: boolean;
  reportRecorded: boolean;
  evidenceAvailable: { backup: boolean | null; report: boolean | null };
  sourceCounts: Record<string, number>;
  reconciliation: Record<string, unknown>;
  targetCounts: Record<string, number>;
  createdAt: number;
  committedAt: number | null;
}

export interface MigrationPlanResult {
  dryRun: true;
  committed: false;
  migrationId: string;
  sourceMode: 'projected' | 'direct' | 'combined';
  sourceFingerprint: string;
  directories: { workDir: string; backupDir: string; reportDir: string; bundleDir: string };
  report: Record<string, unknown>;
  reportPath: string;
  summary: Record<string, unknown> | null;
  rollback: string[];
}

export interface MigrationRunResult {
  dryRun: false;
  committed: true;
  recovered: boolean;
  migrationId: string;
  sourceMode: 'projected' | 'direct' | 'combined';
  sourceFingerprint: string;
  directories: { workDir: string; backupDir: string; reportDir: string; bundleDir: string };
  /** Counts read back from the committed database through a separate read-only handle. */
  readback?: { verified: true; counts: Record<string, number> };
  report: Record<string, unknown> | null;
  reportPath: string | null;
  backup?: { artifactCount: number; reused: boolean };
  bundle?: { artworkCount: number; evidenceCount: number } | null;
  marker: RedactedMarker | null;
  evidenceAvailable: { backup: boolean | null; report: boolean | null };
  summary?: Record<string, unknown> | null;
  rollback: string[];
}

/** Dry run. Plans and reports without writing anything into the data directory. */
export function planCanonicalMigration(options: MigrationOptions): Promise<MigrationPlanResult>;

/** Verified backup, report, commit, and independent readback. A completed rerun is a no-op. */
export function runCanonicalMigration(options: MigrationOptions): Promise<MigrationRunResult>;

/** Reports what a data directory holds today, without changing anything. */
export function inspectCanonicalMigration(input: { dataDir: string }): Promise<{
  committed: boolean;
  legacySourcesPresent: boolean;
  marker?: RedactedMarker | null;
  evidenceAvailable?: { backup: boolean | null; report: boolean | null };
}>;

export function rollbackInstructions(input: { migrationId: string }): string[];

export function rollbackCanonicalMigration(input: {
  dataDir: string;
  migrationId?: string;
  confirmServerStopped?: boolean;
  restoreSources?: boolean;
  /** Required when the backup holds desktop artifacts, so each returns to its own location. */
  desktopDatabase?: string | null;
  desktopSettingsPath?: string | null;
  force?: boolean;
}): Promise<{
  rolledBack: boolean;
  reason?: string;
  migrationId?: string;
  movedAside?: string[];
  restoredSources?: Array<{ kind: string; origin: string }>;
  skippedSources?: Array<{ kind: string; reason: string }>;
  backupVerified?: boolean;
  marker?: RedactedMarker | null;
  instructions: string[];
}>;
