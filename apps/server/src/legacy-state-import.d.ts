export const CANONICAL_MIGRATION_REPORT_FORMAT: 'loomtv-canonical-migration-report-v1';
export const CANONICAL_MIGRATION_REPORT_FIELDS: readonly string[];

export interface MigrationRejection {
  reason: string;
  count: number;
}

export interface MigrationReconciliation {
  source: number;
  imported: number;
  merged?: number;
  legacyOnly: number;
  generated?: number;
  rejected: MigrationRejection[];
}

export interface LegacyCanonicalImportPlan {
  migrationId: string;
  format: 'loomtv-canonical-migration-v1';
  sourceFingerprint: string;
  sourceKinds: string[];
  sourceCounts: Record<string, number>;
  targetCounts: Record<string, number>;
  reconciliation: Record<string, MigrationReconciliation>;
  /** Contains raw locators and server-only credentials. Never serialize or log this field. */
  state: Record<string, unknown>;
  decisions: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
}

export interface VerifiedLegacyBackup {
  backupPath: string;
  artifactCount: number;
  verified: true;
}

export interface CanonicalCommitResult {
  committed: true;
  recovered: boolean;
  marker: Record<string, unknown>;
}

export interface DesktopHistoryEntry {
  id: string;
  profileId: string;
  mediaId: string;
  event: 'started' | 'progressed' | 'completed' | 'unwatched';
  positionSeconds: number;
  occurredAt: number;
}

export interface DesktopProfilePreferences {
  profileId: string;
  preferences: ProfilePreferences;
  updatedAt: number;
}

export type DesktopProfileRestriction = ProfileRestrictions | (
  Omit<ProfileRestrictions, 'allowedRootIds'> & { allowedFolders: string[] }
);

export interface DesktopEvidenceRecord extends MediaIdentityEvidence {
  sourceId: string;
}

export interface DesktopDeviceRecord {
  id: string;
  accountId?: string;
  name: string;
  kind: string;
  disabled?: boolean;
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
}

export interface DesktopAccountRecord {
  account: Account;
  credential: AccountCredential;
}

export interface DesktopSessionRecord extends AccountSession {
  /** Server-only token hash. Never serialize this into a report. */
  tokenHash: string;
  lastSeenAt?: number;
}

export interface DesktopCanonicalProjection {
  /** Legacy account/session projection. Credentials remain server-private. */
  adminState?: Record<string, unknown>;
  accounts?: DesktopAccountRecord[];
  sessions?: DesktopSessionRecord[];
  libraryRoots?: Array<LibraryRoot & { locator: string }>;
  catalogItems?: CatalogItem[];
  mediaSources?: MediaSourceRecord[];
  mediaIdentityAliases?: MediaIdentityAlias[];
  mediaIdentityEvidence?: DesktopEvidenceRecord[];
  profiles?: ViewingProfile[];
  profileCredentials?: ViewingProfileCredential[];
  profileAssignments?: ProfileAssignment[];
  assignments?: ProfileAssignment[];
  profileSelections?: ProfileSelection[];
  selections?: ProfileSelection[];
  progress?: WatchProgress[];
  history?: DesktopHistoryEntry[];
  profilePreferences?: DesktopProfilePreferences[];
  profileRestrictions?: DesktopProfileRestriction[];
  profileListEntries?: ProfileListEntry[];
  trackPreferences?: PlaybackTrackPreferences[];
  devices?: DesktopDeviceRecord[];
  deviceCredentials?: Array<{ deviceId: string; secretHash: string; algorithm: string; updatedAt: number }>;
}

export function mapLegacyAllowedFolders(input: {
  allowedFolders: unknown;
  libraryRoots: Array<{ id: string; path?: string; locator?: string }>;
}): string[] | null | undefined;

export function createLegacyCanonicalImportPlan(input: {
  dataDir: string;
  desktopState?: DesktopCanonicalProjection | null;
}): Promise<LegacyCanonicalImportPlan>;

export function createVerifiedLegacyBackup(input: {
  dataDir: string;
  migrationId: string;
  destinationDir: string;
  additionalArtifacts?: Array<{ path: string; kind: string }>;
}): Promise<VerifiedLegacyBackup>;

export function commitLegacyCanonicalImport(input: {
  dataDir: string;
  plan: LegacyCanonicalImportPlan;
  backupPath: string;
  reportPath: string;
}): Promise<CanonicalCommitResult>;

export function createMigrationReport(
  plan: LegacyCanonicalImportPlan,
  options?: { dryRun?: boolean; targetCounts?: Record<string, number>; backup?: VerifiedLegacyBackup | null },
): Record<string, unknown>;

export const legacyStateFilenames: Readonly<{
  admin: 'headless-admin.json';
  clientSqlite: 'headless-client.sqlite';
  clientJson: 'headless-client.json';
}>;
import type {
  Account,
  AccountSession,
  CatalogItem,
  LibraryRoot,
  PlaybackTrackPreferences,
  ProfileAssignment,
  ProfileListEntry,
  ProfilePreferences,
  ProfileRestrictions,
  ProfileSelection,
  ViewingProfile,
  WatchProgress,
} from '@loom-media-server/video-contracts';
import type {
  AccountCredential,
  MediaIdentityAlias,
  MediaIdentityEvidence,
  MediaSourceRecord,
  ViewingProfileCredential,
} from '@loom-media-server/video-contracts/server';
