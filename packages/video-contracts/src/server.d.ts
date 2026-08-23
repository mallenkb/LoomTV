import type {
  AccountId,
  IdentityEvidenceKind,
  LibraryRootId,
  MediaId,
  MediaProbe,
  MediaSourceId,
  MediaSourceState,
  ProfileId,
  ProfileKind,
} from './index.mjs';

export const CANONICAL_BACKUP_ENVELOPE_FORMAT: 'loomtv-canonical-backup';
export const CANONICAL_BACKUP_ENVELOPE_VERSION: 2;
export const CANONICAL_STATE_SNAPSHOT_FORMAT: 'loomtv-canonical-state-v1';
export const CANONICAL_STATE_SNAPSHOT_VERSION: 1;
export const CANONICAL_BACKUP_DURABLE_TABLES: readonly string[];
export const CANONICAL_BACKUP_TRANSIENT_TABLES: readonly string[];

export interface CanonicalBackupRetentionPolicy {
  durableTables: string[];
  excludedTransientTables: string[];
  invitationsRestoredAsRevoked: true;
}

export interface CanonicalStateSnapshot {
  format: typeof CANONICAL_STATE_SNAPSHOT_FORMAT;
  version: typeof CANONICAL_STATE_SNAPSHOT_VERSION;
  schemaVersion: number;
  createdAt: number;
  policy: CanonicalBackupRetentionPolicy;
  tables: Record<string, Array<Record<string, string | number | null>>>;
}

export interface CanonicalBackupEnvelope {
  format: typeof CANONICAL_BACKUP_ENVELOPE_FORMAT;
  version: typeof CANONICAL_BACKUP_ENVELOPE_VERSION;
  createdAt: string;
  source: { version: string; stateVersion: number; canonicalSchemaVersion: number };
  checksum: string;
  data: CanonicalStateSnapshot;
}

export type LegacyProfileKind = 'owner' | 'standard' | 'kid' | 'guest';
export const LEGACY_PROFILE_KIND_MAP: Readonly<Record<LegacyProfileKind, ProfileKind>>;
export function migrateLegacyProfileKind(value: unknown): ProfileKind;
export function compareIdentityEvidence(leftKind: IdentityEvidenceKind | string, rightKind: IdentityEvidenceKind | string): number;

/** Exactly one account has the owner role. Credentials never enter client DTOs. */
export interface AccountCredential {
  accountId: AccountId;
  passwordHash: string;
  passwordSalt: string;
  passwordAlgorithm: 'scrypt';
  updatedAt: number;
}

export interface ViewingProfileCredential {
  profileId: ProfileId;
  pinHash: string;
  pinSalt: string;
  pinAlgorithm: 'scrypt';
  updatedAt: number;
}

/** Strength comes from kind through identityEvidenceStrength and is never stored from input. */
export interface MediaIdentityEvidence {
  kind: IdentityEvidenceKind;
  value: string;
  observedAt: number;
}

export interface MediaIdentityAlias {
  mediaId: MediaId;
  alias: string;
  namespace: 'desktop-path-hash' | 'headless-path-hash' | 'legacy-media-id' | 'provider';
  createdAt: number;
}

/** Raw locators are server-only and must not appear in client payloads or logs. */
export interface MediaSourceRecord {
  id: MediaSourceId;
  mediaId: MediaId;
  rootId: LibraryRootId;
  relativePath: string;
  locator: string;
  state: MediaSourceState;
  sizeBytes?: number;
  modifiedAtMs?: number;
  indexedAt: number;
  lastSeenAt?: number;
  evidence: MediaIdentityEvidence[];
  probe?: MediaProbe;
}

export interface LegacyProfilePreferencesInput {
  appThemeMode?: 'dark' | 'light';
  appThemeColor?: 'orange' | 'yellow' | 'red' | 'blue' | 'twitch';
  appHomeStyle?: 'default' | 'modern';
  appModernHeroMode?: 'continue-watching' | 'featured';
  showProviderRatingBadges?: boolean;
  sidebarNavOrder?: string[];
  autoplayNextEnabled?: boolean;
  playbackSkipBackSeconds?: number;
  playbackSkipForwardSeconds?: number;
}
