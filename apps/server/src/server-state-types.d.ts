import type * as V from '@loom-media-server/video-contracts';
import type * as S from '@loom-media-server/video-contracts/server';
import type { DesktopHistoryEntry, MigrationReconciliation } from './legacy-state-import.js';

export type Profile = V.ViewingProfile & { isGuest?: boolean; type?: string; ownerId?: string };
export type ProfileCredential = S.ViewingProfileCredential & { salt?: string; hash?: string };
export type TrackPreferences = Pick<V.PlaybackTrackPreferences, 'audio' | 'subtitle'>;
export type StoredTrackPreferences = V.PlaybackTrackPreferences & { preferences?: TrackPreferences };
export interface ClientState {
  profiles: Profile[];
  profileCredentials: ProfileCredential[];
  assignments: V.ProfileAssignment[];
  selections: V.ProfileSelection[];
  progress: V.WatchProgress[];
  history: DesktopHistoryEntry[];
  profilePreferences: Array<{ profileId: string; preferences: V.ProfilePreferences; updatedAt: number }>;
  profileRestrictions: V.ProfileRestrictions[];
  profileListEntries: V.ProfileListEntry[];
  trackPreferences: StoredTrackPreferences[];
}
export interface LegacyProgress { position: number; duration: number; watched: boolean; updatedAt: number }
export interface LegacyClientSnapshot extends Omit<ClientState, 'progress' | 'selections'> {
  progress: Record<string, Record<string, LegacyProgress>>;
  selections: Record<string, string>;
}
export interface PlaybackProfileContext {
  profile: V.ViewingProfile;
  profileId: string;
  assignmentAccess: V.ProfileAssignment['access'];
  restrictions: V.ProfileRestrictions | null;
  deviceId: string;
  selectionRevision: number;
}
export type ProfileInput = { name?: unknown; kind?: unknown; type?: unknown; avatarKey?: unknown; colorKey?: unknown };
export interface StoredAccount {
  id: string; name: string; salt: string; hash: string;
  role?: string; permissions?: string[]; rootIds?: string[] | null; deviceIds?: string[] | null;
  maxSessions?: number | null; disabled?: boolean; createdAt?: number; updatedAt?: number;
}
export interface StoredSession {
  id?: string; tokenHash: string; userId?: string; deviceId?: string | null; createdAt: number;
  lastSeenAt?: number; idleExpiresAt?: number; absoluteExpiresAt?: number; expiresAt: number;
  revokedAt?: number; revokedReason?: string | null;
}
export interface StoredRoot { id: string; path: string; kind: string; createdAt: number; lastScanAt?: number }
export interface StoredCatalogItem extends Omit<Partial<V.CatalogItem>, 'kind'> {
  id: string; rootId: string; path: string; relativePath: string; type: string; kind: string;
  title: string; extension?: string | null; sizeBytes?: number; modifiedAtMs?: number; indexedAt: number;
  sourceId?: string; series?: { title: string; season?: number | null; episode?: number | null };
  localMetadata?: V.MediaProbe | import('./server-admin-types.js').Probe | Record<string, unknown>;
  contentRatings?: Record<string, { minimumAge?: number }>; maximumAge?: number; ageRating?: number;
  legacyStreamUrl?: string;
}
export interface AdminState {
  owner: StoredAccount | null; users: StoredAccount[]; sessions: StoredSession[];
  loginAttempts: Array<{ key: string; failures: number; firstAttemptAt: number; lastAttemptAt: number; lockedUntil: number }>;
  roots: StoredRoot[]; catalog: StoredCatalogItem[]; profiles: unknown[]; watchState: Record<string, unknown>;
  scan: import('./server-admin-types.js').Scan; backup: Partial<import('./server-admin-types.js').BackupStatus> & { state: string }; logs: Array<{timestamp?: unknown; id?: unknown; level?: unknown; source?: unknown; message?: unknown; details?: unknown}>;
}
export type StoredDevice = Omit<Partial<V.Device>, 'accountId'> & { id: string; accountId?: string | null; scopes?: string[] };
export type StoredDeviceCredential = { id?: string; deviceId: string; secretHash: string; algorithm: string; createdAt?: number; expiresAt?: number; updatedAt: number };
export interface CanonicalState {
  adminState?: Partial<AdminState>; clientState?: Partial<ClientState>;
  catalogItems?: V.CatalogItem[];
  mediaSources?: Array<S.MediaSourceRecord & { fileExtension?: string; extension?: Record<string, unknown> }>;
  mediaIdentityAliases?: S.MediaIdentityAlias[];
  mediaIdentityEvidence?: Array<S.MediaIdentityEvidence & { sourceId: string }>;
  devices?: StoredDevice[]; deviceCredentials?: StoredDeviceCredential[];
}
export interface MigrationMarker {
  id: string; format: string; schemaVersion: number; sourceFingerprint: string;
  backupPath: string | null; backupSha256: string | null; backupSizeBytes: number | null;
  reportPath: string | null; reportSha256: string | null; reportSizeBytes: number | null;
  sourceCounts: Record<string, number>; reconciliation: Record<string, MigrationReconciliation>;
  targetCounts: Record<string, number>; createdAt: number; committedAt: number;
}
export interface EvidenceAvailability { backup: boolean | null; report: boolean | null }
export type StateSnapshot = S.CanonicalStateSnapshot;
export type StateStore = ReturnType<typeof import('./canonical-state-store.js').createCanonicalStateStore>;
export type ClientService = ReturnType<typeof import('./client-state.js').createHeadlessClientState>;
export type InvitationRecord = V.Invitation & { secretHash?: string; revokedReason?: string | null };
export type InvitationSessionRecord = V.InvitationSession & { issuerAccountId: string; secretHash?: string; revokedReason?: string | null };
export type DownloadLeaseRecord = Omit<V.OfflineDownloadLease, 'revokedReason'> & { revokedReason?: string | null } & { fileVersion: string; secretHash?: string; quotaOwner?: string };
export type PairingRequestInput = { id: string; requestSecretHash: string; credentialId: string; credentialSecretHash: string;
  credentialCiphertext: string | null; credentialIv: string | null; credentialTag: string | null; deviceId: string; name: string; kind: string;
  permissions?: string[]; certificateFingerprint?: string; createdAt: number; expiresAt: number };
export type PairingRequestRecord = Omit<PairingRequestInput, 'permissions' | 'credentialCiphertext' | 'credentialIv' | 'credentialTag'> & {
  credentialCiphertext: string | null; credentialIv: string | null; credentialTag: string | null;
  requestedPermissions: V.AccountPermission[]; approvedPermissions: V.AccountPermission[] | null;
  accountId?: string; state: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired'; decidedAt?: number; consumedAt?: number;
};
export type PairingApprovalInput = { requestId: string; accountId: string; permissions?: string[]; approvedAt?: number; credentialExpiresAt: number };

/** SQLite column types follow the canonical schema and its runtime migrations. */
export interface SqlRows {
  meta: { key: string; value: string };
  accounts: { id: string; name: string; account_type: 'owner' | 'user'; role: 'owner' | 'admin' | 'user' | 'viewer'; permissions_json: string; root_ids_json: string | null; device_ids_json: string | null; max_sessions: number | null; disabled: 0 | 1; created_at: number; updated_at: number };
  owner_account: { singleton: number; account_id: string };
  account_credentials: { account_id: string; password_salt: string; password_hash: string; password_algorithm: string; updated_at: number };
  devices: { id: string; account_id: string | null; name: string; kind: string; disabled: 0 | 1; permissions_json: string; certificate_fingerprint: string | null; created_at: number; updated_at: number; last_seen_at: number | null; revoked_at: number | null; revoked_reason: string | null };
  device_credentials: { id: string | null; device_id: string; secret_hash: string; algorithm: 'sha256' | 'scrypt'; created_at: number | null; expires_at: number | null; updated_at: number };
  pairing_requests: { id: string; request_secret_hash: string; credential_id: string; credential_secret_hash: string; credential_ciphertext: string | null; credential_iv: string | null; credential_tag: string | null; device_id: string; requested_name: string; requested_kind: string; requested_permissions_json: string; approved_permissions_json: string | null; certificate_fingerprint: string | null; account_id: string | null; state: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired'; created_at: number; expires_at: number; decided_at: number | null; consumed_at: number | null };
  account_sessions: { id: string; token_hash: string; account_id: string; device_id: string | null; created_at: number; last_seen_at: number; idle_expires_at: number; absolute_expires_at: number; revoked_at: number | null; revoked_reason: string | null };
  login_attempts: { key: string; failures: number; first_attempt_at: number; last_attempt_at: number; locked_until: number };
  library_roots: { id: string; locator: string; kind: 'movies' | 'tvShows' | 'anime' | 'others'; state: 'available' | 'offline' | 'removed'; created_at: number; last_scan_at: number | null };
  catalog_items: { id: string; media_type: string; media_kind: string; title: string; year: number | null; anime_likely: 0 | 1; series_title: string | null; series_season: number | null; series_episode: number | null; extension_json: string; created_at: number; updated_at: number };
  media_sources: { id: string; media_id: string; root_id: string | null; relative_path: string; locator: string; state: 'online' | 'offline' | 'unreadable' | 'missing'; file_extension: string | null; size_bytes: number | null; modified_at_ms: number | null; indexed_at: number; last_seen_at: number | null; probe_json: string | null; extension_json: string };
  media_identity_aliases: { namespace: 'desktop-path-hash' | 'headless-path-hash' | 'legacy-media-id' | 'provider'; alias: string; media_id: string; created_at: number };
  media_identity_evidence: { source_id: string; kind: 'content-sha256' | 'filesystem-id' | 'quick-hash' | 'legacy-path-hash'; value: string; observed_at: number };
  scan_state: { singleton: number; payload_json: string };
  profiles: { id: string; name: string; kind: 'adult' | 'child' | 'guest'; avatar_key: string; color_key: string; has_pin: 0 | 1; guest_device_id: string | null; sort_order: number; created_at: number; updated_at: number; last_used_at: number | null };
  profile_credentials: { profile_id: string; pin_salt: string; pin_hash: string; pin_algorithm: 'scrypt'; updated_at: number };
  profile_assignments: { profile_id: string; account_id: string; access: 'use' | 'manage'; created_at: number };
  profile_selections: { account_id: string; device_id: string; profile_id: string | null; revision: number; automatic_sign_in: 0 | 1; selected_at: number | null };
  watch_progress: { profile_id: string; media_id: string; position_seconds: number; duration_seconds: number; watched: 0 | 1; updated_at: number };
  watch_history: { id: string; profile_id: string; media_id: string; event: 'started' | 'progressed' | 'completed' | 'unwatched'; position_seconds: number; occurred_at: number };
  profile_preferences: { profile_id: string; payload_json: string; updated_at: number };
  profile_restrictions: { profile_id: string; allowed_root_ids_json: string | null; payload_json: string; revision: number };
  profile_list_entries: { profile_id: string; media_id: string; kind: 'watchlist' | 'favorite' | 'watched'; created_at: number };
  track_preferences: { profile_id: string; scope: string; payload_json: string; updated_at: number };
  backup_state: { singleton: number; payload_json: string };
  operational_logs: { sequence: number; timestamp: number; payload_json: string };
  migration_markers: { id: string; format: string; schema_version: number; source_fingerprint: string; state: 'prepared' | 'committed' | 'rolled-back'; backup_path: string | null; backup_sha256: string | null; backup_size_bytes: number | null; report_path: string | null; report_sha256: string | null; report_size_bytes: number | null; source_counts_json: string; reconciliation_json: string; target_counts_json: string; created_at: number; committed_at: number | null };
  remote_policy: { singleton: number; enabled: 0 | 1; download_quota_bytes: number; download_lease_ttl_ms: number; invitation_ttl_ms: number; updated_at: number; updated_by: string | null };
  audit_events: { id: string; occurred_at: number; request_class: 'local' | 'remote'; actor_type: 'anonymous' | 'account' | 'device' | 'invitation'; actor_id: string | null; action: string; outcome: 'allowed' | 'denied' | 'created' | 'revoked' | 'expired' | 'failed'; address_hash: string | null; details_json: string };
  invitations: { id: string; issuer_account_id: string; secret_hash: string; scope_json: string; state: 'pending' | 'accepted' | 'revoked' | 'expired'; created_at: number; expires_at: number; accepted_at: number | null; revoked_at: number | null; revoked_reason: string | null };
  invitation_sessions: { id: string; invitation_id: string; secret_hash: string; device_id: string; created_at: number; last_seen_at: number; idle_expires_at: number; absolute_expires_at: number; revoked_at: number | null; revoked_reason: string | null };
  offline_download_leases: { id: string; secret_hash: string; account_id: string | null; invitation_session_id: string | null; quota_owner: string; device_id: string; profile_id: string; selection_revision: number; root_id: string; media_id: string; source_id: string; file_version: string; size_bytes: number; allow_ranges: 0 | 1; created_at: number; expires_at: number; revoked_at: number | null; revoked_reason: string | null };
}
export type ReadCatalogItem = Omit<StoredCatalogItem, 'rootId' | 'path' | 'relativePath' | 'sourceId' | 'extension'> & {
  rootId: string | null; path: string | null; relativePath: string | null; sourceId: string | null; extension: string | null;
};
export type ReadAdminState = Omit<AdminState, 'catalog'> & { catalog: ReadCatalogItem[] };
export type ProfileMedia = { rootId?: string | null; contentRatings?: Record<string, { minimumAge?: number }>;
  maximumAge?: number; ageRating?: number; localMetadata?: unknown };
export interface MigrationIssue { code: string; category: string; count: number; [key: string]: unknown }
export type DesktopProjection = Omit<import('./legacy-state-import.js').DesktopCanonicalProjection, 'adminState' | 'profileRestrictions' | 'libraryRoots'> & {
  adminState?: Partial<AdminState>;
  profileRestrictions?: Array<V.ProfileRestrictions & { allowedFolders?: string[] }>;
  libraryRoots?: Array<V.LibraryRoot & { locator: string; path?: string }>;
};
export type MigrationCarriers = Required<Pick<ClientState, 'profiles' | 'profileCredentials' | 'assignments' | 'selections' | 'progress' | 'history' | 'profilePreferences' | 'profileListEntries' | 'trackPreferences'>> & {
  profileRestrictions: Array<Omit<V.ProfileRestrictions, 'allowedRootIds'> & { allowedRootIds: string[] | null | undefined }>;
  mediaIdentityAliases: S.MediaIdentityAlias[]; mediaIdentityEvidence: Array<S.MediaIdentityEvidence & { sourceId: string }>;
  catalogItems: V.CatalogItem[]; mediaSources: S.MediaSourceRecord[];
  libraryRoots: NonNullable<DesktopProjection['libraryRoots']>; adminState: Partial<AdminState> | null;
  accounts: NonNullable<DesktopProjection['accounts']>; sessions: NonNullable<DesktopProjection['sessions']>;
  devices: StoredDevice[]; deviceCredentials: StoredDeviceCredential[];
};
export type ImportState = CanonicalState & { adminState: AdminState; clientState: ClientState;
  mediaIdentityAliases: S.MediaIdentityAlias[]; mediaIdentityEvidence: Array<S.MediaIdentityEvidence & { sourceId: string }>;
  devices: StoredDevice[]; deviceCredentials: StoredDeviceCredential[]; generatedAliasCount: number };
export type ImportPlan = Omit<import('./legacy-state-import.js').LegacyCanonicalImportPlan, 'state'> & {state: ImportState};
export type PersistenceOptions = import('./server-admin-types.js').AdminOptions & {
  getCertificateFingerprint?: () => string | undefined;
  clock?: () => number;
  proxyPolicy: Parameters<typeof import('./remote-policy.js').createRemotePolicyService>[0]['proxyPolicy'];
};
export interface LegacyV2Options {
  authorizeLegacyPairing?: import('./server.js').CanonicalRuntimeOptions['authorizeLegacyPairing'];
  getCertificateFingerprint?: () => string | undefined;
  clientAddress?: (req: import('node:http').IncomingMessage) => string;
}
export interface LegacyV2Context {
  adminService: import('./api-types.js').AdminService;
  clientState: ClientService;
  mediaService: import('./api-types.js').MediaService;
  pairingService: import('./api-types.js').PairingService;
  remotePolicy: ReturnType<typeof import('./remote-policy.js').createRemotePolicyService>;
  persistence: ReturnType<typeof import('./canonical-persistence.js').createCanonicalPersistence>;
  deploymentMode: import('./server.js').CanonicalDeploymentMode;
}
export type PairingConsumption =
  | { state: 'pending' | 'expired'; expiresAt: number }
  | { state: 'denied' }
  | { state: 'approved'; deviceId: string; credentialId: string; accountId: string; permissions: string[];
      certificateFingerprint?: string; encryptedSecret: {ciphertext: string | null; iv: string | null; tag: string | null} };

export interface StoredDeviceAuthentication {
  id: string; deviceId: string; accountId: string | null; name: string; kind: string; permissions: string[];
  secretHash: string; algorithm: string; disabled: boolean; revokedAt?: number; createdAt: number; expiresAt: number;
}
