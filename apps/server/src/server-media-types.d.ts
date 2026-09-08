import type { IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'node:http';
import type { ChildProcess, spawn } from 'node:child_process';
import type { MediaProbe, PlaybackPlan, PlaybackProfileInput, PlaybackSelectionRequest, ClientPlaybackCapabilitiesInput } from '@loom-media-server/media-core';
import type { TranscodeCapabilities } from '@loom-media-server/transcode-capabilities';
import type { Invitation, InvitationScope, InvitationSession, OfflineDownloadLease, RemotePolicy, AuditEvent } from '@loom-media-server/video-contracts';
import type { Principal as AdminPrincipal } from './server-admin-types.js';

export interface FileIdentity { dev: number; ino: number }
export interface RemoteContext { address: string; requestClass: 'local' | 'remote'; secure: boolean }
export type AuthRequest = Partial<IncomingMessage> & { headers: IncomingHttpHeaders; __loomRemoteContext?: RemoteContext };
export type MediaRequest = IncomingMessage & { __loomRemoteContext?: RemoteContext };
export type MediaResponse = ServerResponse & { __loomtvPublicApi?: boolean };
export interface Principal extends AdminPrincipal {
  authentication?: string;
  devicePermissions?: readonly string[];
  deviceId?: string | null;
  sessionId?: string;
  invitationSessionId?: string;
  invitationId?: string;
  invitationProfileId?: string;
  invitationMediaIds?: string[] | null;
  invitationScope?: InvitationScope;
}
export interface ProfileBinding {
  profileId?: string;
  deviceId?: string;
  selectionRevision?: number;
  authenticationSessionId?: string | null;
  invitationSessionId?: string | null;
  remoteAccess?: boolean;
  sourceId?: string;
  fileId?: FileIdentity;
  externalSubtitleTrackId?: string;
  externalSubtitleFileId?: FileIdentity;
}
export interface ProfileContext extends ProfileBinding {
  profileId: string;
  selectionRevision: number;
  restrictions?: { allowedRootIds?: string[] | null } | null;
}
export interface SubtitleSidecar {
  id: string; path: string; format: string; codec?: string;
  language?: string; title?: string; default?: boolean; forced?: boolean;
}
export interface MediaSource {
  id: string; rootId: string; sourceId: string; rootPath: string; path: string;
  fileId: FileIdentity; sizeBytes: number; modifiedAtMs: number;
  recordedSizeBytes?: number; recordedModifiedAtMs?: number;
  localMetadata?: unknown; subtitleSidecars?: SubtitleSidecar[];
}
export interface LibraryItem {
  id: string; sourceId?: string; rootId?: string;
}
export interface MediaAdmin {
  authenticateRequest(req: MediaRequest): Promise<Principal | null>;
  authorizePrincipal?(principal: Principal, permission: string): boolean | Promise<boolean>;
  getPrincipalById?(id: string): Principal | null | Promise<Principal | null>;
  resolveMediaPath(itemId: string, principal: Principal, sourceId?: string): Promise<MediaSource>;
  getLibraryItem?(itemId: string, principal: Principal): Promise<LibraryItem | null>;
  listLibraryItems(principal: Principal): Promise<LibraryItem[]>;
  deleteLibraryItem(itemId: string, principal: Principal): Promise<unknown>;
  recordMediaProbe?(itemId: string, sourceId: string, probe: MediaProbe): Promise<unknown>;
}
export interface MediaClientState {
  requireActivePlaybackProfile(accountId: string, deviceId?: string, media?: LibraryItem | MediaSource): Promise<ProfileContext>;
  requireScopedProfile(accountId: string, profileId: string, media?: LibraryItem | MediaSource, deviceId?: string): Promise<ProfileContext>;
}
export interface RemoteMediaPolicy {
  resolveInvitationPrincipal(sessionId: string): Promise<Principal | null>;
  invitationProfileContext(principal: Principal, media?: LibraryItem | MediaSource): Promise<ProfileContext | null>;
  assertPrincipal(req: AuthRequest | undefined, principal: Principal | null | undefined, routeClass?: string): RemoteContext;
}
export interface MediaClock {
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout | undefined) => void;
  setInterval?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
}
export interface TranscodeRequest extends PlaybackProfileInput {
  mode?: string; copyVideo?: unknown; copyAudio?: unknown; burnSubtitles?: unknown;
  selectedVideoTrackIndex?: unknown; selectedAudioTrackIndex?: unknown;
  selectedSubtitleTrackIndex?: unknown; selectedSubtitleTrackOrdinal?: unknown;
  subtitleFontSize?: unknown; backend?: string; subtitleKind?: string;
  externalSubtitlePath?: string; externalSubtitleFileId?: FileIdentity;
  startSeconds?: unknown; sourceId?: string; expectedFileId?: FileIdentity;
  planToken?: string; canonicalPlanRequired?: boolean; profileId?: string;
  deviceId?: string; selectionRevision?: number | string; profileContext?: ProfileBinding | null;
}
export interface PlanningRequest extends PlaybackSelectionRequest {
  sourceId?: string; capabilities?: ClientPlaybackCapabilitiesInput;
  externalSubtitle?: { path: string; fileId: FileIdentity } | null;
}
export type ExecutionPlan = PlaybackPlan & { subtitleFontSize?: number };
export interface NormalizedTranscodeProfile {
  mode: string; codec: 'h264' | 'hevc' | 'av1'; copyVideo: boolean; copyAudio: boolean;
  burnSubtitles: boolean; subtitleKind: string;
  selectedVideoTrackIndex?: number; selectedAudioTrackIndex?: number;
  selectedSubtitleTrackIndex?: number; selectedSubtitleTrackOrdinal?: number;
  subtitleFontSize?: number; externalSubtitlePath?: string; externalSubtitleFileId?: FileIdentity;
  startSeconds: number; backend: string; maxWidth: number; maxHeight: number;
  videoBitrateKbps: number; audioBitrateKbps: number; toneMap: boolean;
  toneMapRequested: boolean; softwareFallbackAvailable: boolean; hardware: boolean;
}
export type PlaybackRegistry = ReturnType<typeof import('./playback-session-registry.js').createPlaybackSessionRegistry>;
export type RegistrySession = NonNullable<ReturnType<PlaybackRegistry['authorize']>>;
export type Admission = ReturnType<typeof import('./transcode-admission.js').createTranscodeAdmission>;
export type Quota = ReturnType<typeof import('./transcode-cache-quota.js').createTranscodeCacheQuota>;
export interface TranscodeSession {
  id: string; registryId: string; itemId: string; sourceId: string; userId: string;
  mediaRootPath: string; filePath: string; fileId: FileIdentity; outputDir: string;
  backend: string; profile: NormalizedTranscodeProfile; playbackProfile: ProfileBinding | null;
  token: string; createdAt: number; lastActivityAt: number; ready: boolean;
  fallbackAttempted: boolean; cleaned: boolean; cleanupStarting?: boolean;
  cleanupPromise?: Promise<void>; process?: ChildProcess | null; stderr?: string;
  error?: string; failureError?: Error; exitCode?: number | null;
  permit: Awaited<ReturnType<Admission['acquire']>> | null;
  quotaReservationId: string; abortController: AbortController;
}
export interface StoredTranscodePlan {
  itemId: string; principalId: string; createdAt: number; expiresAt: number;
  profileContext: ProfileBinding | null; execution: TranscodeRequest;
}
export type MediaTranscoderHealth = Pick<TranscodeCapabilities, 'backends' | 'softwareCodecs' | 'softwareEncoders' | 'recommendedBackend' | 'toneMapping'>;
export interface MediaServiceOptions {
  adminService: MediaAdmin;
  clientState?: MediaClientState;
  transcoder: { path: string | null; getHealth(): MediaTranscoderHealth; probeMedia(path: string, options: { sourceId: string }): Promise<MediaProbe> };
  cacheDir: string;
  authorize: (req: MediaRequest, permission: string) => boolean | Promise<boolean>;
  clock?: MediaClock;
  playbackSessionRegistry?: PlaybackRegistry;
  playbackSessionOptions?: Parameters<typeof import('./playback-session-registry.js').createPlaybackSessionRegistry>[0];
  transcodeAdmission?: Admission;
  transcodeAdmissionOptions?: Parameters<typeof import('./transcode-admission.js').createTranscodeAdmission>[0];
  cacheQuotaOptions?: Parameters<typeof import('./transcode-cache-quota.js').createTranscodeCacheQuota>[0];
  transcodeQuotaOptions?: Parameters<typeof import('./transcode-cache-quota.js').createTranscodeCacheQuota>[0];
  cacheFileSystem?: NonNullable<MediaServiceOptions['cacheQuotaOptions']>['fileSystem'];
  spawnProcess?: typeof spawn;
  remotePolicy?: RemoteMediaPolicy;
}
export type Authorization = { ok: false; status: number; principal?: Principal } | { ok: true; principal: Principal; playbackSession?: RegistrySession };
export interface JsonPayload {
  ok?: boolean; error?: string | { code: string; message: string; retryAfterMs?: number };
  retryAfter?: number; message?: string; [field: string]: unknown;
}
export interface StoredInvitation extends Invitation { secretHash?: string }
export interface StoredInvitationSession extends InvitationSession { secretHash?: string; issuerAccountId?: string }
export interface StoredDownloadLease extends Omit<OfflineDownloadLease, 'revokedReason'> {
  revokedReason?: string | null; secretHash?: string; quotaOwner?: string; fileVersion?: string;
}
export interface RemoteStore {
  readRemotePolicy(): RemotePolicy;
  updateRemotePolicy(input: { enabled?: unknown; downloadQuotaBytes: number; downloadLeaseTtlMs: number; invitationTtlMs: number }, actorId: string, now: number): RemotePolicy;
  appendAuditEvent(event: AuditEvent & { addressHash?: string }): unknown;
  createInvitation(input: Omit<StoredInvitation, 'state'>): StoredInvitation;
  readInvitation(id: string, includeSecret: boolean): StoredInvitation | null;
  listInvitations(actorId: string): StoredInvitation[];
  revokeInvitation(id: string, actorId: string, reason: string, now: number): unknown;
  acceptInvitation(input: { invitationId: string; invitationSecretHash?: string; sessionId: string; sessionSecretHash: string; deviceId: string; createdAt: number; idleExpiresAt: number; absoluteExpiresAt: number }): StoredInvitationSession;
  readInvitationSession(id: string, includeSecret: boolean): StoredInvitationSession | null;
  revokeInvitationSession(id: string, reason: string, now: number): unknown;
  touchInvitationSession(id: string, now: number, idleExpiresAt: number): unknown;
  listMediaSources(id: string): { rootId: string | null }[];
  createDownloadLease(input: StoredDownloadLease & { secretHash: string; quotaOwner: string; fileVersion: string }, quota: number): StoredDownloadLease;
  readDownloadLease(id: string, includeSecret: boolean): StoredDownloadLease | null;
  listDownloadLeases(owner: { invitationSessionId?: string; accountId?: string }): StoredDownloadLease[];
  revokeDownloadLease(id: string, owner: { invitationSessionId?: string; accountId?: string }, reason: string, now: number): unknown;
  listAuditEvents(input?: { limit?: number; before?: number }): unknown;
}
export interface RemoteServiceOptions {
  store: RemoteStore;
  proxyPolicy: { clientAddress(req?: AuthRequest): string; isSecureRequest(req?: AuthRequest): boolean };
  getAccount(id: string): Principal | null | Promise<Principal | null>;
  getAdminService(): Pick<MediaAdmin, 'resolveMediaPath'> & { listLibraryRoots(principal: Principal): Promise<{ id: string }[]>; getLibraryItem(id: string, principal: Principal): Promise<LibraryItem | null> };
  getClientState(): MediaClientState;
  clock?: () => number;
}
export interface InvitationInput { profileId?: unknown; rootIds?: unknown; mediaIds?: unknown; permissions?: unknown; ttlMs?: unknown; downloadQuotaBytes?: unknown }
export interface DownloadInput { mediaId?: unknown; sourceId?: string; ttlMs?: unknown; allowRanges?: unknown }
