export type OpaqueId = string;
export type MediaId = OpaqueId;
export type MediaSourceId = OpaqueId;
export type LibraryRootId = OpaqueId;
export type AccountId = OpaqueId;
export type ProfileId = OpaqueId;
export type DeviceId = OpaqueId;
export type AccountSessionId = OpaqueId;
export type PlaybackSessionId = OpaqueId;
export type InvitationId = OpaqueId;
export type InvitationSessionId = OpaqueId;
export type OfflineDownloadLeaseId = OpaqueId;

export const VIDEO_CONTRACT_VERSION: 1;
export const CANONICAL_API_VERSION: '1';
export const CANONICAL_API_PREFIX: '/api/v1';
export const CANONICAL_API_VERSION_HEADER: 'X-LoomTV-API-Version';

export type AccountRole = 'owner' | 'admin' | 'user' | 'viewer';
export type ProfileKind = 'adult' | 'child' | 'guest';
export type AccountPermission =
  | 'admin.read'
  | 'library.read'
  | 'library.manage'
  | 'stream'
  | 'transcode'
  | 'downloads'
  | 'remote.access'
  | 'remote.manage'
  | 'audit.read'
  | 'sessions.read'
  | 'logs.read'
  | 'backup.read'
  | 'backup.create'
  | 'users.read'
  | 'users.manage'
  | 'devices.manage'
  | 'sharing.manage'
  | 'account.password'
  | 'media.delete';

export const ACCOUNT_ROLES: readonly AccountRole[];
export const PROFILE_KINDS: readonly ProfileKind[];
export const ACCOUNT_PERMISSIONS: readonly AccountPermission[];
export function canonicalProfileKind(value: unknown): ProfileKind;

/** Accounts authenticate people and carry authority. They are not viewing profiles. */
export interface Account {
  id: AccountId;
  name: string;
  role: AccountRole;
  permissions: AccountPermission[] | ['*'];
  rootIds: LibraryRootId[] | null;
  deviceIds: DeviceId[] | null;
  maxSessions: number | null;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AccountSession {
  id: AccountSessionId;
  accountId: AccountId;
  deviceId: DeviceId | null;
  createdAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

export type AccountSessionMode = 'bearer' | 'cookie';
export interface AccountSessionRequest {
  username?: string;
  password: string;
  sessionMode?: AccountSessionMode;
}
export interface BrowserAccountSession {
  sessionMode: 'cookie';
  expiresAt: number;
  user: {
    id: AccountId;
    name: string;
    type: 'owner' | 'user';
    role: AccountRole;
    permissions: AccountPermission[];
    rootIds: LibraryRootId[] | null;
    deviceIds: DeviceId[] | null;
    maxSessions: number | null;
  };
  /** Submit this value in X-Loom-CSRF for every unsafe cookie-authenticated request. */
  csrfToken: string;
}

/** Profiles carry viewing identity and personal state. They never grant account permissions. */
export interface ViewingProfile {
  id: ProfileId;
  name: string;
  kind: ProfileKind;
  avatarKey: string;
  colorKey: string;
  hasPin: boolean;
  guestDeviceId?: DeviceId;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

/** Accounts receive explicit access to profiles. Profiles do not grant account authority. */
export interface ProfileAssignment {
  accountId: AccountId;
  profileId: ProfileId;
  access: 'use' | 'manage';
  createdAt: number;
}

export interface ProfileSelection {
  accountId: AccountId;
  deviceId: DeviceId;
  profileId: ProfileId | null;
  revision: number;
  automaticSignIn: boolean;
  selectedAt?: number;
}

export interface ActiveProfileSelection {
  profileId: ProfileId | null;
  profile: ViewingProfile | null;
  selectionRevision: number;
  automaticSignIn: boolean;
  locked: boolean;
}

export interface ProfileSelectionUpdate {
  automaticSignIn: boolean;
}

export interface ProfilePinUpdate {
  pin: string | null;
}

export interface ProfilePreferences {
  themeMode?: 'dark' | 'light';
  themeColor?: 'orange' | 'yellow' | 'red' | 'blue' | 'twitch';
  showProviderRatingBadges?: boolean;
  sidebarNavOrder?: string[];
  autoplayNextEnabled?: boolean;
  skipBackSeconds?: number;
  skipForwardSeconds?: number;
}

export interface ProfileRestrictions {
  profileId: ProfileId;
  country: string;
  maximumAge: number | null;
  allowUnrated: boolean;
  /** null grants every authorized root; an empty array grants none. */
  allowedRootIds: LibraryRootId[] | null;
  revision: number;
}

export type ProfileListKind = 'watchlist' | 'favorite' | 'watched';
export interface ProfileListEntry {
  profileId: ProfileId;
  mediaId: MediaId;
  kind: ProfileListKind;
  createdAt: number;
}

export interface WatchProgress {
  profileId: ProfileId;
  mediaId: MediaId;
  positionSeconds: number;
  durationSeconds: number;
  watched: boolean;
  updatedAt: number;
}

export type TrackKind = 'video' | 'audio' | 'subtitle' | 'data' | 'unknown';
export interface MediaTrack {
  id: string;
  index: number;
  kind: TrackKind;
  codec?: string;
  language?: string;
  title?: string;
  channels?: number;
  width?: number;
  height?: number;
  profile?: string;
  pixelFormat?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  frameRate?: number;
  default?: boolean;
  forced?: boolean;
  external?: boolean;
}

export interface TrackPreference {
  enabled: boolean;
  trackId?: string;
  index?: number;
  language?: string;
  title?: string;
  codec?: string;
  forced?: boolean;
}

export interface PlaybackTrackPreferences {
  profileId: ProfileId;
  scope: string;
  audio?: TrackPreference;
  subtitle?: TrackPreference;
  updatedAt: number;
}

export type MediaSourceState = 'online' | 'offline' | 'unreadable' | 'missing';
export type IdentityEvidenceKind = 'content-sha256' | 'filesystem-id' | 'quick-hash' | 'legacy-path-hash';
export const MEDIA_SOURCE_STATES: readonly MediaSourceState[];
export const IDENTITY_EVIDENCE_KINDS: readonly IdentityEvidenceKind[];
export const IDENTITY_EVIDENCE_STRENGTH: Readonly<Record<IdentityEvidenceKind, 1 | 2 | 3 | 4>>;
export function identityEvidenceStrength(kind: IdentityEvidenceKind | string): 1 | 2 | 3 | 4;

export interface MediaProbe {
  sourceId: MediaSourceId;
  container?: string;
  durationSeconds?: number;
  bitrateKbps?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  hdr: boolean;
  hdrFormat?: 'hdr10' | 'hdr10-plus' | 'hlg' | 'dolby-vision';
  tracks: MediaTrack[];
  chapters?: Array<{ startMs: number; endMs: number; title: string }>;
  adapterGaps?: string[];
  probedAt: number;
}

export type CatalogKind = 'movie' | 'series' | 'episode' | 'video';
export interface CatalogItem {
  id: MediaId;
  kind: CatalogKind;
  title: string;
  year?: number;
  seriesId?: MediaId;
  seasonNumber?: number;
  episodeNumber?: number;
  animeLikely?: boolean;
  available: boolean;
  sourceIds: MediaSourceId[];
  legacyIds: string[];
  artwork?: Record<string, string>;
  summary?: string;
  rating?: number;
  genres?: string[];
  providerIds?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface LibraryRoot {
  id: LibraryRootId;
  kind: 'movies' | 'tv' | 'anime' | 'others';
  state: 'online' | 'offline' | 'unreadable' | 'missing';
  createdAt: number;
  lastScanAt?: number;
}

export interface CatalogSnapshot {
  contractVersion: 1;
  revision: number;
  items: CatalogItem[];
}

export interface Device {
  id: DeviceId;
  accountId: AccountId;
  name: string;
  kind: string;
  permissions: AccountPermission[];
  disabled: boolean;
  certificateFingerprint?: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
  revokedReason?: string;
}

export interface DeviceCredential {
  id: string;
  deviceId: DeviceId;
  accountId: AccountId;
  scopes: AccountPermission[];
  certificateFingerprint?: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface PairingRequestInput {
  name: string;
  kind: string;
  permissions?: AccountPermission[];
  /** Expected SHA-256 fingerprint of the server certificate, without separators. */
  certificateFingerprint?: string;
}

export type RemoteRequestClass = 'local' | 'remote';
export interface RemotePolicy {
  enabled: boolean;
  downloadQuotaBytes: number;
  downloadLeaseTtlMs: number;
  invitationTtlMs: number;
  updatedAt: number;
  updatedBy?: AccountId;
}

export type InvitationPermission = 'library.read' | 'stream' | 'downloads';
export interface InvitationScope {
  profileId: ProfileId;
  rootIds: LibraryRootId[];
  mediaIds: MediaId[] | null;
  permissions: InvitationPermission[];
  downloadQuotaBytes: number;
}

export interface Invitation {
  id: InvitationId;
  issuerAccountId: AccountId;
  scope: InvitationScope;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
  revokedAt?: number;
}

export interface InvitationCapability extends Invitation {
  /** Returned only when the invitation is created. */
  secret: string;
  scheme: 'LoomInvite';
}

export interface InvitationSession {
  id: InvitationSessionId;
  invitationId: InvitationId;
  deviceId: string;
  scope: InvitationScope;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  revokedAt?: number;
  /** Returned only when the invitation is accepted. */
  credential?: { id: InvitationSessionId; secret: string; scheme: 'LoomInvitation' };
}

export interface OfflineDownloadLease {
  id: OfflineDownloadLeaseId;
  accountId?: AccountId;
  invitationSessionId?: InvitationSessionId;
  deviceId: string;
  profileId: ProfileId;
  selectionRevision: number;
  rootId: LibraryRootId;
  mediaId: MediaId;
  sourceId: MediaSourceId;
  sizeBytes: number;
  allowRanges: boolean;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

export interface OfflineDownloadCapability extends OfflineDownloadLease {
  contentUrl: string;
  /** Returned only when the lease is created. */
  credential: { id: OfflineDownloadLeaseId; secret: string; scheme: 'LoomDownload' };
}

export interface AuditEvent {
  id: string;
  occurredAt: number;
  requestClass: RemoteRequestClass;
  actorType: 'anonymous' | 'account' | 'device' | 'invitation';
  actorId?: string;
  action: string;
  outcome: 'allowed' | 'denied' | 'created' | 'revoked' | 'expired' | 'failed';
  details?: Record<string, string | number | boolean | null>;
}

export interface PairingRequestCapability {
  requestId: string;
  requestSecret: string;
  status: 'pending';
  expiresAt: number;
}

export interface PairingApprovalInput {
  approved: boolean;
  accountId?: AccountId;
  permissions?: AccountPermission[];
}

export type PairingStatus =
  | { status: 'pending'; expiresAt: number }
  | { status: 'denied' | 'expired' }
  | {
      status: 'approved';
      deviceId: DeviceId;
      accountId: AccountId;
      permissions: AccountPermission[];
      certificateFingerprint?: string;
      /** Returned exactly once. Store it in platform secure storage. */
      credential: { id: string; secret: string; scheme: 'LoomDevice' };
      credentialExpiresAt: number;
    };

export interface ClientCapabilities {
  contractVersion: 1;
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  streamingProtocols: Array<'http' | 'hls'>;
  subtitleModes: Array<'text' | 'bitmap' | 'burn-in' | 'external'>;
  hdrFormats: Array<'hdr10' | 'hdr10-plus' | 'hlg' | 'dolby-vision'>;
  maxWidth: number;
  maxHeight: number;
  maxVideoBitrateKbps: number;
}

export interface PlaybackRequest {
  mediaId: MediaId;
  sourceId?: MediaSourceId;
  capabilities: ClientCapabilities;
  audioTrackId?: string;
  subtitleTrackId?: string | null;
  startSeconds?: number;
}

export type PlaybackPlanMode = 'direct' | 'remux' | 'transcode';
export type PlaybackTransport = 'http' | 'hls';
export const PLAYBACK_PLAN_MODES: readonly PlaybackPlanMode[];
export const PLAYBACK_TRANSPORTS: readonly PlaybackTransport[];

export interface PlaybackPlan {
  contractVersion: 1;
  mode: PlaybackPlanMode;
  transport: PlaybackTransport;
  reasonCode: string;
  sourceId: MediaSourceId;
  selectedVideoTrackId: string;
  selectedAudioTrackId?: string;
  selectedSubtitleTrackId?: string;
  outputContainer: string;
  outputVideoCodec: string;
  outputAudioCodec?: string;
  burnSubtitles: boolean;
  toneMap: boolean;
  maxWidth?: number;
  maxHeight?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
}

export interface PlaybackDelivery {
  sessionId: PlaybackSessionId;
  mode: PlaybackPlanMode;
  url: string;
  renewUrl: string;
  expiresAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export interface PlaybackSession {
  id: PlaybackSessionId;
  accountId: AccountId;
  profileId: ProfileId;
  deviceId: DeviceId | null;
  mediaId: MediaId;
  sourceId: MediaSourceId;
  plan: PlaybackPlan;
  createdAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
  requestId?: string;
  details?: Record<string, unknown>;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;
export type ApiErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'body_too_large'
  | 'auth_required'
  | 'session_expired'
  | 'permission_denied'
  | 'secure_transport_required'
  | 'remote_access_disabled'
  | 'not_found'
  | 'account_not_found'
  | 'profile_not_found'
  | 'profile_required'
  | 'profile_locked'
  | 'stale_profile_selection'
  | 'media_not_found'
  | 'source_unavailable'
  | 'playback_not_supported'
  | 'playback_capacity_exceeded'
  | 'playback_session_invalid'
  | 'transcoder_unavailable'
  | 'transcode_failed'
  | 'download_not_allowed'
  | 'download_quota_exceeded'
  | 'invalid_backup'
  | 'device_revoked'
  | 'invitation_expired'
  | 'rate_limited'
  | 'conflict'
  | 'request_failed';

export const API_ERROR_CODES: readonly ApiErrorCode[];

export type RouteAccess = 'public' | 'bootstrap' | 'owner' | 'account' | 'profile' | 'capability';
export type RouteState = 'active' | 'reserved';
export interface CanonicalRoute {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: `/api/v1${string}`;
  access: RouteAccess;
  permission?: AccountPermission;
  state: RouteState;
}

export const CANONICAL_ROUTES: readonly CanonicalRoute[];
export function canonicalRoute(routeId: string): CanonicalRoute | null;

export interface LegacyRouteAdapter {
  source: string;
  destination: string;
  removal: string;
}
export const LEGACY_ROUTE_ADAPTERS: readonly LegacyRouteAdapter[];

export type LegacyModelDecision = 'migrate' | 'preserve-and-alias' | 'resolve-and-migrate' | 'migrate-or-repair' | 'migrate-secret' | 'migrate-or-revoke' | 'adapter-only' | 'retire-after-import-window' | 'retire-after-verified-migration';
export interface LegacyModelDestination {
  source: string;
  destination: string;
  decision: LegacyModelDecision;
}
export const LEGACY_MODEL_DESTINATIONS: readonly LegacyModelDestination[];
