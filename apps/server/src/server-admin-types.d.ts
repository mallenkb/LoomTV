import type { IncomingMessage } from 'node:http';
import type { CatalogKind } from '@loom-media-server/video-contracts';
import type { CanonicalStateSnapshot } from '@loom-media-server/video-contracts/server';

export interface PolicyPrincipal {
  id?: string; name?: string; type?: string; role?: string;
  permissions?: readonly string[]; devicePermissions?: readonly string[];
  rootIds?: readonly string[] | null; deviceIds?: readonly string[] | null;
  maxSessions?: number | null; deviceId?: string | null;
}
export interface Principal extends PolicyPrincipal {
  id: string; name: string; type: string; role: string; permissions: string[];
  rootIds: string[] | null; deviceIds: string[] | null; maxSessions: number | null;
  authentication?: string; deviceCredentialId?: string; sessionId?: string;
  invitationMediaIds?: string[] | null;
}
export interface Account {
  id: string; name: string; salt: string; hash: string;
  disabled?: boolean; updatedAt?: number;
}
export interface User extends Account {
  role: string; permissions: string[]; rootIds: string[] | null;
  deviceIds: string[] | null; maxSessions: number | null; createdAt: number;
}
export interface Session {
  id: string; tokenHash: string; userId?: string; deviceId: string | null;
  createdAt: number; lastSeenAt: number; idleExpiresAt: number;
  absoluteExpiresAt: number; expiresAt: number; revokedAt?: number; revokedReason?: string;
}
export interface Root { id: string; path: string; kind: string; createdAt: number; lastScanAt?: number }
export interface Scan {
  state: string; id?: string; mode?: string; rootId?: string; startedAt?: number;
  scannedFiles?: number; indexedFiles?: number; completedAt?: number; interruptedAt?: number;
  offlineRoots?: string[]; errors?: { rootId: string; path: string; code: string; message: string }[];
  warning?: string; error?: string;
}
export interface Probe {
  sourceId?: string; container: string; durationSeconds?: number; bitrateKbps?: number;
  width?: number; height?: number; videoCodec?: string; audioCodec?: string; hdr?: boolean;
  tracks: unknown[]; chapters?: unknown[]; probedAt?: number;
}
export interface Media {
  id: string; rootId: string; path: string; relativePath: string; type: string; title: string;
  kind: CatalogKind; extension: string; available: boolean; indexedAt: number;
  sourceId?: string; seriesId?: string; state?: string; probe?: Probe;
  year?: number; animeLikely?: boolean; seasonNumber?: number; episodeNumber?: number;
  series?: { title: string; season?: number; episode?: number | null };
  sizeBytes?: number; modifiedAtMs?: number; localMetadata?: Probe | Record<string, unknown>;
  contentRatings?: Record<string, { minimumAge: number }>;
  summary?: string; rating?: number; genres?: string[]; providerIds?: Record<string, string>;
  subtitleSidecars?: { id: string; path: string; relativeName: string; format: string; codec: string;
    language?: string; title?: string; forced: boolean; default: boolean; origin: string;
    sizeBytes?: number; modifiedAtMs?: number }[];
  legacyIds?: string[]; createdAt?: number; updatedAt?: number;
}
export interface BackupHistory {
  kind: string; createdAt: number; destination?: string; checksum?: string;
  formatVersion: number; sizeBytes?: number; source?: string; status?: string;
}
export interface BackupStatus {
  state: string; lastBackupAt?: number; lastRestoreAt?: number; destination?: string;
  sizeBytes?: number; checksum?: string; formatVersion?: number; restoredFrom?: string;
  rollbackDestination?: string; error?: string; history: BackupHistory[];
}
export interface OperationalLog {
  id?: unknown; timestamp: unknown; level?: unknown; source?: unknown;
  message?: unknown; details?: unknown;
}
export interface AdminState {
  owner: Account | null; users: User[]; sessions: Session[];
  loginAttempts: { key: string; failures: number; firstAttemptAt: number; lastAttemptAt: number; lockedUntil: number }[];
  roots: Root[]; catalog: Media[]; profiles: unknown[]; watchState: Record<string, unknown>;
  scan: Scan; backup: BackupStatus; logs: OperationalLog[];
}
export interface Device {
  id: string; accountId: string | null; name: string; kind: string; permissions: string[];
  disabled: boolean; createdAt: number; updatedAt: number; lastSeenAt?: number;
  revokedAt?: number; revokedReason?: string | null; certificateFingerprint?: string;
}
export interface DeviceCredential {
  id: string; deviceId: string; accountId: string | null; permissions: string[];
  disabled: boolean; revokedAt?: number; expiresAt: number; secretHash: string; algorithm: string;
}
export interface PairingRecord {
  id: string; requestSecretHash: string; credentialId: string; credentialSecretHash: string;
  credentialCiphertext: string | null; credentialIv: string | null; credentialTag: string | null;
  deviceId: string; name: string; kind: string; requestedPermissions: string[];
  certificateFingerprint?: string; accountId?: string; state: string; createdAt: number; expiresAt: number;
}
export interface PairingStore {
  createPairingRequest(input: Omit<PairingRecord, 'state' | 'requestedPermissions'> & { permissions: string[] }): unknown;
  readPairingRequest(id: string): PairingRecord | null;
  consumePairingRequest(id: string, hash: string, now: number):
    { state: 'approved'; credentialId: string; deviceId: string; accountId: string; permissions: string[]; certificateFingerprint?: string }
    | { state: 'pending' | 'expired'; expiresAt: number } | { state: 'denied' } | null;
  approvePairingRequest(input: { requestId: string; accountId: string; permissions: string[]; approvedAt: number; credentialExpiresAt: number }):
    { deviceId: string; accountId: string; permissions: string[]; certificateFingerprint?: string; createdAt: number };
  denyPairingRequest(id: string, now: number): unknown;
  readDeviceCredential(id: string): DeviceCredential | null;
  readDeviceCredentialForDevice(id: string): DeviceCredential | null;
  touchDevice(id: string, now: number): unknown;
  resolveBoundDevice(accountId: string, deviceId: string): string | null;
  listDevices(): Device[];
  revokeDevice(id: string, reason: string, now: number): { [key: string]: unknown } | null;
}
export interface PairingOptions {
  store: PairingStore; getAccount: (id: string) => PolicyPrincipal | null | Promise<PolicyPrincipal | null>;
  getCertificateFingerprint?: () => string | undefined; clock?: () => number;
}
export interface StreamCapabilityInput {
  deviceId: string; mediaId: string; profileId: string; selectionRevision: number;
  sourceId: string; fileVersion: string; authenticationSessionId?: string; ttlMs?: number;
}
export interface BootstrapOptions {
  dataDir: string; required?: boolean; secretFile?: string; secret?: string;
  onWarning?: (message: string, error: unknown) => void;
  onGenerated?: (value: { secret: string; file: string }) => void;
}
export interface RuntimeHealth {
  media?: { state?: string; path?: string | null }; deploymentMode?: string; version?: string; uptimeSeconds?: number;
  transcoder?: { available?: boolean; hardwareAcceleration?: boolean; recommendedBackend?: string;
    state?: string; codecs?: unknown; softwareCodecs?: unknown; softwareFallback?: unknown;
    toneMapping?: unknown; mediaStreaming?: unknown; admission?: Record<string, unknown> };
}
export interface MediaSourceSummary {
  id: string; mediaId?: string; rootId: string | null;
  state: string; extension?: string | null;
  modifiedAtMs?: number; sizeBytes?: number;
}
export interface MediaSource extends MediaSourceSummary {
  rootPath: string | null; relativePath: string; path: string;
  rootState: 'online' | 'offline' | 'unreadable' | 'missing'; probe?: Probe | Record<string, unknown>;
}
export interface AdminStore {
  readAdminState(): unknown; replaceAdminState(state: AdminState): unknown;
  updateBackupState?(state: BackupStatus): unknown; appendOperationalLog?(entry: OperationalLog): unknown;
  exportCanonicalSnapshot?(): CanonicalStateSnapshot;
  restoreCanonicalSnapshot?(snapshot: unknown, now: number): unknown;
  catalogRevision?(): string | number;
  listMediaSources?(id: string): MediaSourceSummary[];
  readMediaSource?(id: string, sourceId?: string): MediaSource | null;
  recordMediaProbe?(id: string, sourceId: string, probe: Probe): unknown;
}
export interface AdminOptions {
  dataDir: string; mediaDir?: string; version?: string; baseUrl?: string; requireBootstrapSecret?: boolean;
  bootstrapSecurity: ReturnType<typeof import('./secure-bootstrap.js').createBootstrapSecurity>;
  getRuntimeHealth?: () => Promise<RuntimeHealth>; getSessions?: () => Promise<unknown[]>;
  getClientState?: () => Promise<unknown>; replaceClientState?: (state: unknown) => Promise<unknown>;
  replaceAllState?: (state: { adminState: AdminState; clientState: unknown }) => Promise<unknown>;
  stateStore?: AdminStore;
  onCanonicalRestore?: () => Promise<unknown> | unknown;
  onPlaybackSessionsRevoked?: (id: string, reason: string) => Promise<unknown> | unknown;
  onPlaybackSessionsRevokedForItem?: (id: string, reason: string) => Promise<unknown> | unknown;
  onAuthenticationSessionRevoked?: (id: string, reason: string) => Promise<unknown> | unknown;
  onAllPlaybackSessionsRevoked?: (reason: string) => Promise<unknown> | unknown;
  loginDelay?: (milliseconds: number) => Promise<unknown>;
  storageFileSystem?: Partial<typeof import('node:fs/promises')>;
  storageWriteProbe?: (path: string, options: { fileSystem: typeof import('node:fs/promises'); probePath: string }) => Promise<unknown>;
  storageProbeTimeoutMs?: number;
  probeMedia?: (path: string, options: { sourceId: string; signal: AbortSignal }) => Promise<import('./library-scanner.js').MediaProbe | null>;
  pairingService?: ReturnType<typeof import('./pairing-service.js').createPairingService>;
  clientAddress?: (req: IncomingMessage) => string;
}
