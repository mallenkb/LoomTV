import { BrowserWindow, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addLocalAccessToken } from './serverSecurity';
import { setSystemMediaKeyActivity } from './systemMediaKeys.ts';
import { appendStreamOptionParams } from './transcodeFilters.ts';
import { getMimeType } from './mimeTypes';
import type { ApiResult, ProbeResult, TranscodeOptions, TranscodeSession } from './mediaTypes';
import type { MetadataKeyTestResult } from './metadataKeys';
import type { BrowserPlaybackPlan } from './transcodeDecision';
import type { ManualMediaSegmentInput, MediaSegmentRequest, MediaSegmentResponse } from './skipSegments/types';
import type { IpcInvokeChannel } from '../shared/ipcChannels';
import type { IpcContract } from '../shared/ipcContract';
import type {
  OfficialStremioAddon,
  MetadataProviderRequest,
  StremioPluginCatalogRequest,
  StremioPluginCatalogResult,
  StremioPluginConfigurationState,
  StremioPluginAuditEntry,
  StremioPluginIpcResult,
  StremioPluginMetaRequest,
  StremioPluginMetaResult,
  StremioPluginReview,
  StremioPluginSummary,
  StoredProgress,
} from '../shared/desktopProtocol.ts';
import type { TranscodeCapabilities } from '@loom-media-server/transcode-capabilities';
import { buildNetworkStatus, ffmpegAvailability } from './ipcHandlerPolicy.ts';
import { rendererSettingsPatchSchema, sanitizeRendererSettingsPatch } from './rendererSettings.ts';
import { serializeStremioPluginError } from './stremioPluginWire.ts';
import {
  commandMpvPlayback,
  mpvAvailability,
  refreshMpvAvailability,
  startMpvPlayback,
  stopMpvPlayback,
  validateMpvExecutable,
} from './mpvPlayback.ts';
import {
  commandLibVlcPlayback,
  libVlcAvailability,
  refreshLibVlcAvailability,
  startLibVlcPlayback,
  setLibVlcPlaybackFullscreenTransition,
  stopLibVlcPlayback,
  setLibVlcPlaybackViewport,
  syncLibVlcPlaybackSurface,
} from './libvlcPlayback.ts';
import type { LibVlcStartOptions } from './libvlcPlayback.ts';
import type { PlaybackViewport } from '../shared/playbackProtocol.ts';
import { z } from 'zod';
import { lanProviderRatingsSchema } from '@loom-media-server/lan-protocol';
import { parseIpcArguments } from './ipcValidation.ts';
import { metadataProviderRequestSchema } from './metadataProviderGateway.ts';

const finiteNumber = z.number().finite();
const nonEmptyString = z.string().trim().min(1);
const subtitleStyleSchema = z.object({
  fontSize: finiteNumber,
  color: z.string(),
  borderColor: z.string(),
  borderWidth: finiteNumber,
  backgroundColor: z.string(),
  position: finiteNumber,
});
const playbackStartOptionsSchema = z.object({
  startSeconds: finiteNumber.nonnegative().optional(),
  volume: finiteNumber.optional(),
  muted: z.boolean().optional(),
  speed: finiteNumber.positive().optional(),
  audioTrackId: finiteNumber.optional(),
  audioLanguage: z.string().trim().min(1).max(32).optional(),
  audioDelay: finiteNumber.optional(),
  subtitleDelay: finiteNumber.optional(),
  subtitleStyle: subtitleStyleSchema.optional(),
  subtitleFiles: z.array(z.object({
    path: nonEmptyString,
    source: z.enum(['sidecar', 'opensubtitles']),
  })).optional(),
  nativeSubtitles: z.boolean().optional(),
});
const playbackCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set-paused'), paused: z.boolean() }),
  z.object({ type: z.literal('seek'), position: finiteNumber.nonnegative() }),
  z.object({ type: z.literal('set-volume'), volume: finiteNumber }),
  z.object({ type: z.literal('set-muted'), muted: z.boolean() }),
  z.object({ type: z.literal('set-speed'), speed: finiteNumber.positive() }),
  z.object({ type: z.literal('set-video-track'), trackId: finiteNumber.nullable() }),
  z.object({ type: z.literal('set-audio-track'), trackId: finiteNumber.nullable() }),
  z.object({ type: z.literal('set-subtitle-track'), trackId: finiteNumber.nullable() }),
  z.object({ type: z.literal('set-secondary-subtitle-track'), trackId: finiteNumber.nullable() }),
  z.object({ type: z.literal('set-subtitle-delay'), seconds: finiteNumber }),
  z.object({ type: z.literal('set-audio-delay'), seconds: finiteNumber }),
  z.object({ type: z.literal('set-subtitle-style'), ...subtitleStyleSchema.shape }),
  z.object({ type: z.literal('set-video-aspect'), aspect: z.string().nullable() }),
  z.object({ type: z.literal('set-video-crop'), crop: z.string().nullable() }),
  z.object({ type: z.literal('set-video-rotation'), degrees: finiteNumber }),
]);
const playbackViewportSchema = z.object({
  x: finiteNumber,
  y: finiteNumber,
  width: finiteNumber.positive().max(100_000),
  height: finiteNumber.positive().max(100_000),
});
const mpvStartOptionsSchema = playbackStartOptionsSchema.omit({ nativeSubtitles: true });
const libraryScanOptionsSchema = z.object({
  force: z.boolean().optional(),
  mode: z.enum(['quick', 'metadata', 'full']).optional(),
});
const libraryFolderKindSchema = z.enum(['movies', 'tvShows', 'anime', 'others']);
const metadataKeysSchema = z.record(z.string(), z.string());
const remoteLibraryRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});
const profileCreateSchema = z.object({
  name: z.string(),
  avatarKey: z.string().optional(),
  colorKey: z.string().optional(),
  type: z.enum(['standard', 'kid']).optional(),
});
const profileUpdateSchema = profileCreateSchema.partial();
const profilePreferencesSchema = z.object({
  appThemeMode: z.enum(['dark', 'light']).optional(),
  appThemeColor: z.enum(['orange', 'yellow', 'red', 'blue', 'twitch']).optional(),
  appDarkTheme: z.literal('black').optional(),
  appLoaderStyle: z.enum(['play-mark', 'logo-mark', 'horizontal-logo']).optional(),
  appHomeStyle: z.enum(['default', 'modern']).optional(),
  appModernHeroMode: z.enum(['continue-watching', 'featured']).optional(),
  showProviderRatingBadges: z.boolean().optional(),
  sidebarNavOrder: z.array(z.string()).optional(),
  autoplayNextEnabled: z.boolean().optional(),
  playbackSkipBackSeconds: finiteNumber.optional(),
  playbackSkipForwardSeconds: finiteNumber.optional(),
});
const profileRestrictionsInputSchema = z.object({
  country: z.enum(['US', 'GB', 'CA', 'AU']),
  maximumAge: finiteNumber.nullable(),
  allowUnrated: z.boolean(),
  allowedFolders: z.array(z.string()),
});
const profileListKindSchema = z.enum(['watchlist', 'favorite', 'watched']);
const progressImportValueSchema = z.union([
  finiteNumber,
  z.object({
    position: finiteNumber.optional(),
    duration: finiteNumber.optional(),
    updatedAt: finiteNumber.optional(),
  }),
]);
const trackPreferenceSchema = z.object({
  enabled: z.boolean(),
  index: finiteNumber.optional(),
  language: z.string().optional(),
  title: z.string().optional(),
  codec: z.string().optional(),
  forced: z.boolean().optional(),
});
const playbackTrackPreferencesSchema = z.object({
  audio: trackPreferenceSchema.optional(),
  subtitle: trackPreferenceSchema.optional(),
});
const mediaSegmentTypeSchema = z.enum(['intro', 'recap', 'outro', 'credits', 'preview']);
const mediaSegmentRequestSchema = z.object({
  mediaId: nonEmptyString.max(240),
  season: finiteNumber.nonnegative().optional(),
  episode: finiteNumber.nonnegative().optional(),
});
const manualMediaSegmentSchema = mediaSegmentRequestSchema.extend({
  candidateId: z.string().max(240).optional(),
  type: mediaSegmentTypeSchema,
  startMs: finiteNumber.nonnegative(),
  endMs: finiteNumber.nonnegative().nullable(),
});
const artworkCandidateSchema = z.object({
  id: nonEmptyString,
  source: z.enum(['TMDB', 'OMDb', 'TVmaze', 'Jikan', 'AniList']),
  title: z.string(),
  year: finiteNumber.optional(),
  genres: z.array(z.string()).optional(),
  episodeCount: finiteNumber.nonnegative().optional(),
  episodePreview: z.array(z.string()).optional(),
  format: z.string().optional(),
  thumbnail: z.string().optional(),
  cover: z.string().optional(),
  summary: z.string().optional(),
  rating: finiteNumber.optional(),
  providerRatings: lanProviderRatingsSchema.optional(),
  posterCandidates: z.array(z.string()).optional(),
  backdropCandidates: z.array(z.string()).optional(),
  logoCandidates: z.array(z.string()).optional(),
  logo: z.string().optional(),
}).passthrough();
const transcodeOptionsSchema = z.object({
  preset: z.enum(['auto', 'software', 'videotoolbox', 'nvenc', 'qsv', 'vaapi', 'amf', 'rkmpp']).optional(),
  targetVideoCodec: z.enum(['h264', 'hevc', 'av1']).optional(),
  softwareVideoEncoder: z.enum(['libx264', 'libx265', 'libsvtav1', 'libaom-av1']).optional(),
  maxWidth: finiteNumber.positive().optional(),
  maxHeight: finiteNumber.positive().optional(),
  videoBitrateKbps: finiteNumber.positive().optional(),
  audioBitrateKbps: finiteNumber.positive().optional(),
  toneMap: z.boolean().optional(),
  startSeconds: finiteNumber.nonnegative().optional(),
  videoTrackIndex: finiteNumber.nonnegative().optional(),
  audioTrackIndex: finiteNumber.nonnegative().optional(),
  subtitleTrackIndex: finiteNumber.nonnegative().optional(),
  subtitleStreamOrdinal: finiteNumber.nonnegative().optional(),
  subtitleCodec: z.string().optional(),
  subtitleFilePath: z.string().optional(),
  secondarySubtitleTrackIndex: finiteNumber.nonnegative().optional(),
  secondarySubtitleStreamOrdinal: finiteNumber.nonnegative().optional(),
  secondarySubtitleCodec: z.string().optional(),
  secondarySubtitleFilePath: z.string().optional(),
  subtitleStyle: z.object({
    delaySeconds: finiteNumber.optional(),
    position: finiteNumber.optional(),
    scale: finiteNumber.optional(),
    fontSize: finiteNumber.optional(),
    fontColor: z.string().optional(),
    borderColor: z.string().optional(),
    borderWidth: finiteNumber.optional(),
    borderEnabled: z.boolean().optional(),
    backgroundColor: z.string().optional(),
    backgroundEnabled: z.boolean().optional(),
  }).optional(),
  forceTranscode: z.boolean().optional(),
});
const stremioExtraSchema = z.record(
  z.string(),
  z.union([z.string(), finiteNumber, z.boolean()]),
);
const stremioCatalogRequestSchema = z.object({
  type: nonEmptyString,
  catalogId: nonEmptyString,
  filters: z.object({
    query: z.string().optional(),
    genre: z.string().optional(),
    year: z.string().optional(),
  }).optional(),
  extra: stremioExtraSchema.optional(),
});
const stremioMetaRequestSchema = z.object({
  type: nonEmptyString,
  id: nonEmptyString,
  extra: stremioExtraSchema.optional(),
});

type IpcLibraryFolderKind = 'movies' | 'tvShows' | 'anime' | 'others';
type IpcLibraryScanMode = 'quick' | 'metadata' | 'full';

type LibraryScanProgress<TLibraryData> = TLibraryData & {
  isComplete: boolean;
  scannedFolders: number;
  totalFolders: number;
};

type LanPairedDevice = {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  lastAddress?: string;
};

type NetworkSettings = {
  mpvExecutablePath?: string;
  localNetworkDeviceId?: string;
  localNetworkDeviceName?: string;
  localNetworkPairedDevices?: LanPairedDevice[];
};

type OpenExternalResult = ReturnType<typeof shell.openExternal>;
type IpcResult<C extends IpcInvokeChannel> = IpcContract[C]['result'];
type OfficialMetadataCandidate = IpcContract['artwork:apply-official']['args'][1];
type OfficialMetadataApplyTarget = IpcContract['artwork:apply-official']['args'][2];
type OfficialArtworkRefreshTarget = IpcContract['artwork:refresh-official']['args'][1];
export interface IpcHandlerDependencies<
  TLibraryData,
  TSettings extends NetworkSettings & IpcResult<'settings:get'>,
> {
  getMediaServerPort: () => number;
  localAccessToken: string;
  showOpenFolderDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  loadLibrary: () => TLibraryData;
  libraryForRenderer: (library?: TLibraryData) => IpcResult<'library:get'>;
  libraryIndexForRenderer: () => IpcResult<'library:get-index'>;
  libraryItemForRenderer: (mediaId: string) => IpcResult<'library:get-item'> | Promise<IpcResult<'library:get-item'>>;
  scanLibrary: (
    library: TLibraryData,
    options: {
      mode: IpcLibraryScanMode;
      onProgress?: (snapshot: LibraryScanProgress<TLibraryData>) => void;
      onCheckpoint?: (snapshot: LibraryScanProgress<TLibraryData>) => void | Promise<void>;
    },
  ) => Promise<TLibraryData>;
  saveLibraryFromScan: (library: TLibraryData, scanVersion: number) => boolean;
  saveLibraryScanCheckpoint: (library: TLibraryData, scanVersion: number) => boolean;
  getLibraryMutationVersion: () => number;
  cacheArtworkNow: (library: TLibraryData) => Promise<void>;
  addFolderToLibrary: (library: TLibraryData, folderPath: string, kind: IpcLibraryFolderKind) => TLibraryData;
  removeFolderFromLibrary: (library: TLibraryData, folderPath: string) => TLibraryData;
  saveLibraryMutation: (library: TLibraryData) => void;
  addUnifiedLibraryRoot: (folderPath: string, kind: IpcLibraryFolderKind) => Promise<boolean>;
  removeUnifiedLibraryRoot: (folderPath: string) => Promise<boolean>;
  assertLocalMediaPath: (filePath: string) => void;
  authorizeMediaPath: (filePath: string) => void;
  assertSubtitleCanAccessMediaPath?: (mediaFilePath: string, subtitleFilePath: string) => void;
  registerSubtitleResource: (mediaFilePath: string, subtitleFilePath: string) => string;
  needsBrowserTranscoding: (filePath: string) => boolean;
  browserPlaybackPlan: (filePath: string, options?: TranscodeOptions) => BrowserPlaybackPlan;
  loadSettings: () => TSettings;
  settingsForRenderer: () => TSettings;
  authorizeSettingsWrite: () => void;
  saveSettings: (settings: TSettings) => void;
  onSettingsSaved?: () => void;
  getUnifiedDesktopServerState: () => IpcResult<'server:unified-state'>;
  configureUnifiedDesktopOwner: (input: IpcContract['server:configure-owner']['args'][0]) => Promise<IpcResult<'server:configure-owner'>>;
  openUnifiedDesktopAdmin: () => Promise<IpcResult<'server:open-admin'>>;
  syncLanAdvertisement: () => void;
  testMetadataKeys: (keys: Record<string, string>) => Promise<MetadataKeyTestResult[]>;
  getLanShareToken: () => string;
  getLanServerBase: () => string | null;
  isLanSharingEnabled: () => boolean;
  getLocalNetworkNameFast: () => string;
  getLocalNetworkAddresses: () => string[];
  discoverLanPeers: (timeoutMs: number, ownDeviceId?: string) => Promise<IpcResult<'network:discover-peers'>>;
  connectRemoteLibrary: (
    baseUrl: string,
    code: string,
    device: { name: string },
    certFingerprint?: string,
  ) => Promise<IpcResult<'network:remote-connect'>>;
  requestRemoteLibrary: (
    pathname: string,
    request?: IpcContract['network:remote-request']['args'][1],
  ) => Promise<IpcResult<'network:remote-request'>>;
  getRemoteLibrarySession: () => IpcResult<'network:remote-session'>;
  disconnectRemoteLibrary: (revoke?: boolean) => Promise<boolean>;
  revokeDeviceProfileAccess: (deviceId: string) => void;
  getProgress: (filePath: string) => StoredProgress | null;
  getAllProgress: () => Record<string, StoredProgress>;
  saveProgress: (filePath: string, position: number, duration: number, expectedProfileId?: string) => IpcResult<'progress:save'>;
  importProgress: (progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>, expectedProfileId?: string) => void;
  listProfiles: () => IpcResult<'profiles:list'>;
  chooseProfileAvatar: () => Promise<IpcResult<'profiles:choose-avatar'>>;
  getActiveProfileState: () => IpcResult<'profiles:get-active'>;
  createProfile: (input: IpcContract['profiles:create']['args'][0]) => IpcResult<'profiles:create'>;
  updateProfile: (profileId: string, patch: IpcContract['profiles:update']['args'][1]) => IpcResult<'profiles:update'>;
  deleteProfile: (profileId: string) => IpcResult<'profiles:delete'>;
  exportProfile: (profileId: string) => Promise<IpcResult<'profiles:export'>>;
  importProfile: () => Promise<IpcResult<'profiles:import'>>;
  selectProfile: (profileId: string, pin?: string) => IpcResult<'profiles:select'> | Promise<IpcResult<'profiles:select'>>;
  selectGuestProfile: () => IpcResult<'profiles:select-guest'>;
  lockProfile: () => IpcResult<'profiles:lock'>;
  reorderProfiles: (profileIds: string[]) => IpcResult<'profiles:reorder'>;
  changeProfilePin: (profileId: string, pin: string | null) => Promise<IpcResult<'profiles:pin'>>;
  resetOwnerProfile: (confirmation: string) => IpcResult<'profiles:reset-owner'>;
  setAutomaticSignIn: (enabled: boolean) => IpcResult<'profiles:set-auto-sign-in'>;
  getProfilePreferences: () => IpcResult<'profile-preferences:get'>;
  saveProfilePreferences: (patch: IpcContract['profile-preferences:save']['args'][0], expectedProfileId?: string) => IpcResult<'profile-preferences:save'>;
  getProfileRestrictions: (profileId: string) => IpcResult<'profile-restrictions:get'>;
  saveProfileRestrictions: (profileId: string, input: IpcContract['profile-restrictions:save']['args'][1]) => IpcResult<'profile-restrictions:save'>;
  getProfileLists: (kind?: IpcContract['profile-lists:get']['args'][0]) => IpcResult<'profile-lists:get'>;
  setProfileListEntry: (mediaId: string, kind: IpcContract['profile-lists:set']['args'][1], present: boolean, expectedProfileId?: string) => IpcResult<'profile-lists:set'>;
  getPlaybackTrackPreferences: (scope?: string) => IpcResult<'playback-track-preferences:get'>;
  savePlaybackTrackPreferences: (
    scope: string,
    preferences: IpcContract['playback-track-preferences:save']['args'][1],
    expectedProfileId?: string,
  ) => IpcResult<'playback-track-preferences:save'>;
  getMediaSegments: (request: MediaSegmentRequest) => Promise<MediaSegmentResponse>;
  saveManualMediaSegment: (input: ManualMediaSegmentInput) => MediaSegmentResponse;
  deleteManualMediaSegment: (input: MediaSegmentRequest & { candidateId?: string; type: ManualMediaSegmentInput['type'] }) => MediaSegmentResponse;
  undoManualMediaSegment: (input: MediaSegmentRequest & { candidateId?: string; type: ManualMediaSegmentInput['type'] }) => MediaSegmentResponse;
  getManagedMediaSegments: (request?: Partial<MediaSegmentRequest>) => IpcResult<'playback:segments:manage-list'>;
  updateManagedMediaSegment: (candidateId: string, patch: IpcContract['playback:segments:manage-update']['args'][1]) => boolean;
  eraseManagedMediaSegments: (request: MediaSegmentRequest) => IpcResult<'playback:segments:manage-erase'>;
  setPlaybackActivityLease: (key: string, active: boolean, label?: string) => void;
  listStremioPlugins: () => StremioPluginSummary[];
  listAvailableStremioPlugins: () => StremioPluginSummary[];
  listOfficialStremioAddons: () => OfficialStremioAddon[];
  reviewOfficialStremioAddon: (officialId: IpcContract['plugins:stremio:review-official']['args'][0]) => Promise<StremioPluginReview>;
  reviewStremioManifestUrl: (manifestUrl: string) => Promise<StremioPluginReview>;
  approveStremioAddon: (addonId: string, reviewToken: string) => Promise<StremioPluginSummary>;
  disableStremioAddon: (addonId: string) => Promise<StremioPluginSummary>;
  removeStremioAddon: (addonId: string) => Promise<boolean>;
  listStremioProfileAccess: (profileId: string) => string[];
  setStremioProfileAccess: (profileId: string, addonId: string, enabled: boolean) => Promise<boolean>;
  fetchStremioCatalog: (addonId: string, request: StremioPluginCatalogRequest) => Promise<StremioPluginCatalogResult>;
  fetchStremioMeta: (addonId: string, request: StremioPluginMetaRequest) => Promise<StremioPluginMetaResult>;
  fetchStremioMetaByItem: (request: StremioPluginMetaRequest) => Promise<StremioPluginMetaResult>;
  getStremioAddonConfiguration: (addonId: string) => StremioPluginConfigurationState;
  saveStremioAddonConfiguration: (addonId: string, values: Record<string, unknown>) => Promise<StremioPluginConfigurationState>;
  listStremioPluginAudit: (addonId: string, limit?: number) => readonly StremioPluginAuditEntry[];
  getLocalSegmentAnalysisStatus: () => IpcResult<'playback:analysis:status'>;
  analyzeLocalSegmentSeason: (mediaId: string, season: number) => Promise<MediaSegmentResponse>;
  runLocalSegmentAnalysis: (scope?: IpcContract['playback:analysis:run']['args'][0]) => IpcResult<'playback:analysis:run'>;
  cancelLocalSegmentAnalysis: (request?: { jobKey?: string; kind?: 'manual' }) => IpcResult<'playback:analysis:cancel'>;
  pauseLocalSegmentAnalysis: () => boolean;
  resumeLocalSegmentAnalysis: () => boolean;
  cleanupLocalSegmentAnalysis: () => IpcResult<'playback:analysis:cleanup'>;
  rebuildLocalSegmentAnalysis: () => IpcResult<'playback:analysis:rebuild'>;
  customArtworkForRenderer: (mediaId: string) => IpcResult<'artwork:get'>;
  saveCustomArtwork: (mediaId: string, target: string, dataUrl: string) => void;
  getOfficialMetadataCandidates: (mediaId: string) => IpcResult<'artwork:official-candidates'> | Promise<IpcResult<'artwork:official-candidates'>>;
  applyOfficialMetadataCandidate: (mediaId: string, candidate: OfficialMetadataCandidate, target?: OfficialMetadataApplyTarget) => IpcResult<'artwork:apply-official'> | Promise<IpcResult<'artwork:apply-official'>>;
  refreshOfficialArtwork: (mediaId: string, target?: OfficialArtworkRefreshTarget) => IpcResult<'artwork:refresh-official'> | Promise<IpcResult<'artwork:refresh-official'>>;
  getPlaybackLogo: (mediaId: string) => IpcResult<'artwork:playback-logo'> | Promise<IpcResult<'artwork:playback-logo'>>;
  getStreamingProviders: (mediaId: string) => IpcResult<'metadata:streaming-providers'> | Promise<IpcResult<'metadata:streaming-providers'>>;
  refreshIncompleteMetadata: (mediaId: string) => IpcResult<'metadata:refresh-incomplete'> | Promise<IpcResult<'metadata:refresh-incomplete'>>;
  requestMetadataProvider: (request: MetadataProviderRequest) => unknown | Promise<unknown>;
  importCustomArtwork: (entries: Record<string, Record<string, string>>) => void;
  backupDatabase: () => IpcResult<'database:backup'> | Promise<IpcResult<'database:backup'>>;
  clearAppData: () => TLibraryData;
  getUpdateState: () => IpcResult<'updates:get-state'>;
  checkForUpdates: () => IpcResult<'updates:check'> | Promise<IpcResult<'updates:check'>>;
  installDownloadedUpdate: () => IpcResult<'updates:install'> | Promise<IpcResult<'updates:install'>>;
  findFFmpeg: () => string | null;
  getTranscodeCapabilities: (path: string | null) => TranscodeCapabilities;
  safeResult: <T>(fn: () => T | Promise<T>) => Promise<ApiResult<T>>;
  probeMedia: (filePath: string) => Promise<ProbeResult>;
  canDirectPlay: (filePath: string, probe: ProbeResult, backend: 'html5' | 'hls') => boolean;
  startTranscode: (filePath: string, options: TranscodeOptions, serverBase: string) => Promise<TranscodeSession>;
  stopTranscode: (sessionId: string) => boolean;
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
}

function safeLibraryFolderKind(kind: string | undefined): IpcLibraryFolderKind {
  return kind === 'tvShows' || kind === 'anime' || kind === 'movies' || kind === 'others' ? kind : 'movies';
}

function scanProgressPayload<TLibraryData>(snapshot: LibraryScanProgress<TLibraryData>) {
  return {
    isComplete: snapshot.isComplete,
    scannedFolders: snapshot.scannedFolders,
    totalFolders: snapshot.totalFolders,
  };
}

const LIBRARY_SCAN_PROGRESS_INTERVAL_MS = 200;

function createScanProgressPublisher<TLibraryData>(
  sendSnapshot: (snapshot: LibraryScanProgress<TLibraryData>) => void,
) {
  let pendingSnapshot: LibraryScanProgress<TLibraryData> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSentAt = 0;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    clearTimer();
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    if (!snapshot) return;

    lastSentAt = Date.now();
    try {
      sendSnapshot(snapshot);
    } catch (error) {
      console.warn('Failed to publish library scan progress:', error);
    }
  };

  const publish = (snapshot: LibraryScanProgress<TLibraryData>) => {
    pendingSnapshot = snapshot;
    if (snapshot.isComplete) {
      flush();
      return;
    }

    if (timer) return;
    const elapsed = Date.now() - lastSentAt;
    const delay = Math.max(0, LIBRARY_SCAN_PROGRESS_INTERVAL_MS - elapsed);
    if (delay === 0) {
      flush();
    } else {
      timer = setTimeout(flush, delay);
    }
  };

  const cancel = () => {
    clearTimer();
    pendingSnapshot = null;
  };

  return { publish, flush, cancel };
}

export function registerIpcHandlers<
  TLibraryData,
  TSettings extends NetworkSettings & IpcResult<'settings:get'>,
>(deps: IpcHandlerDependencies<TLibraryData, TSettings>): void {
  const handle = <C extends IpcInvokeChannel>(
    channel: C,
    listener: (
      event: IpcMainInvokeEvent,
      ...args: IpcContract[C]['args']
    ) => IpcContract[C]['result'] | Promise<IpcContract[C]['result']>,
    argsSchema: z.ZodType<IpcContract[C]['args']>,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!deps.isTrustedSender(event)) throw new Error('Untrusted IPC sender.');
      const validatedArgs = parseIpcArguments(channel, args, argsSchema);
      return listener(event, ...validatedArgs);
    });
  };

  type NoArgChannel = {
    [C in IpcInvokeChannel]: IpcContract[C]['args'] extends [] ? C : never;
  }[IpcInvokeChannel];
  const handleNoArgs = <C extends NoArgChannel>(
    channel: C,
    listener: (
      event: IpcMainInvokeEvent,
    ) => IpcContract[C]['result'] | Promise<IpcContract[C]['result']>,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!deps.isTrustedSender(event)) throw new Error('Untrusted IPC sender.');
      parseIpcArguments(channel, args, z.tuple([]));
      return listener(event);
    });
  };

  const handleExperimental = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>,
    argsSchema: z.ZodType<unknown[]>,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!deps.isTrustedSender(event)) throw new Error('Untrusted IPC sender.');
      return listener(event, ...parseIpcArguments(channel, args, argsSchema));
    });
  };

  type StremioPluginChannel = Extract<IpcInvokeChannel, `plugins:stremio:${string}`>;
  type StremioPluginData<C extends StremioPluginChannel> = IpcContract[C]['result'] extends StremioPluginIpcResult<infer T> ? T : never;
  const handleStremio = <C extends StremioPluginChannel>(
    channel: C,
    listener: (
      event: IpcMainInvokeEvent,
      ...args: IpcContract[C]['args']
    ) => StremioPluginData<C> | Promise<StremioPluginData<C>>,
    argsSchema: z.ZodType<IpcContract[C]['args']>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!deps.isTrustedSender(event)) {
        return {
          ok: false,
          error: serializeStremioPluginError({
            code: 'STREMIO_PLUGIN_IPC_UNTRUSTED_SENDER',
            message: 'Untrusted IPC sender.',
          }),
        } satisfies IpcContract[C]['result'];
      }
      try {
        const validatedArgs = parseIpcArguments(channel, args, argsSchema);
        const data = await listener(event, ...validatedArgs);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: serializeStremioPluginError(error) } satisfies IpcContract[C]['result'];
      }
    });
  };

  let libraryScanQueue: Promise<void> = Promise.resolve();
  const enqueueLibraryScan = <T>(run: () => Promise<T>): Promise<T> => {
    const queued = libraryScanQueue.then(() => run(), () => run());
    libraryScanQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };

  handleNoArgs('library:get', () => deps.libraryForRenderer());
  handleNoArgs('library:get-index', () => deps.libraryIndexForRenderer());
  handle('library:get-item', (_event, mediaId) => deps.libraryItemForRenderer(mediaId), z.tuple([nonEmptyString]));

  handle('library:scan', async (event, options?: { force?: boolean; mode?: IpcLibraryScanMode }) => {
    deps.authorizeSettingsWrite();
    return enqueueLibraryScan(async () => {
      const data = deps.loadLibrary();
      const scanVersion = deps.getLibraryMutationVersion();
      const mode: IpcLibraryScanMode = options?.force
        ? 'full'
        : options?.mode === 'metadata' || options?.mode === 'full'
          ? options.mode
          : 'quick';
      const progressPublisher = createScanProgressPublisher<TLibraryData>((snapshot) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('library:scan-progress', scanProgressPayload(snapshot));
        }
      });
      try {
        const scanned = await deps.scanLibrary(data, {
          mode,
          onProgress: progressPublisher.publish,
          onCheckpoint: (snapshot) => {
            deps.saveLibraryScanCheckpoint(snapshot, scanVersion);
          },
        });
        progressPublisher.flush();
        if (deps.saveLibraryFromScan(scanned, scanVersion)) {
          await deps.cacheArtworkNow(scanned);
        }
        return deps.libraryIndexForRenderer();
      } finally {
        progressPublisher.cancel();
      }
    });
  }, z.tuple([libraryScanOptionsSchema.optional()]));

  handle('library:add-folder', async (_event, kind: string = 'movies') => {
    deps.authorizeSettingsWrite();
    const result = await deps.showOpenFolderDialog({
      properties: ['openDirectory'],
      buttonLabel: 'Add Folder',
      message: 'Select a folder to add to your LoomTV library.',
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const data = deps.loadLibrary();
      const newFolder = result.filePaths[0];
      const updated = deps.addFolderToLibrary(data, newFolder, safeLibraryFolderKind(kind));
      deps.saveLibraryMutation(updated);
      await deps.addUnifiedLibraryRoot(newFolder, safeLibraryFolderKind(kind));
      return enqueueLibraryScan(async () => {
        const scanData = deps.loadLibrary();
        const scanVersion = deps.getLibraryMutationVersion();
        const progressPublisher = createScanProgressPublisher<TLibraryData>((snapshot) => {
          BrowserWindow.getAllWindows().forEach((window) => {
            if (!window.webContents.isDestroyed()) {
              window.webContents.send('library:scan-progress', scanProgressPayload(snapshot));
            }
          });
        });
        try {
          const scanned = await deps.scanLibrary(scanData, {
            mode: 'quick',
            onProgress: progressPublisher.publish,
            onCheckpoint: (snapshot) => {
              deps.saveLibraryScanCheckpoint(snapshot, scanVersion);
            },
          });
          progressPublisher.flush();
          if (deps.saveLibraryFromScan(scanned, scanVersion)) {
            await deps.cacheArtworkNow(scanned);
          }
          return deps.libraryIndexForRenderer();
        } finally {
          progressPublisher.cancel();
        }
      });
    }
    return null;
  }, z.tuple([libraryFolderKindSchema.optional()]));

  handle('library:add-folder-path', async (_event, kind: string, folderPath: string) => {
    deps.authorizeSettingsWrite();
    const normalizedFolderPath = folderPath.trim();
    if (!path.isAbsolute(normalizedFolderPath)) throw new Error('Folder path must be an absolute path.');
    const data = deps.loadLibrary();
    const updated = deps.addFolderToLibrary(data, path.resolve(normalizedFolderPath), safeLibraryFolderKind(kind));
    deps.saveLibraryMutation(updated);
    await deps.addUnifiedLibraryRoot(normalizedFolderPath, safeLibraryFolderKind(kind));
    return enqueueLibraryScan(async () => {
      const scanData = deps.loadLibrary();
      const scanVersion = deps.getLibraryMutationVersion();
      const progressPublisher = createScanProgressPublisher<TLibraryData>((snapshot) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.webContents.isDestroyed()) window.webContents.send('library:scan-progress', scanProgressPayload(snapshot));
        });
      });
      try {
        const scanned = await deps.scanLibrary(scanData, {
          mode: 'quick',
          onProgress: progressPublisher.publish,
          onCheckpoint: (snapshot) => { deps.saveLibraryScanCheckpoint(snapshot, scanVersion); },
        });
        progressPublisher.flush();
        if (deps.saveLibraryFromScan(scanned, scanVersion)) await deps.cacheArtworkNow(scanned);
        return deps.libraryIndexForRenderer();
      } finally {
        progressPublisher.cancel();
      }
    });
  }, z.tuple([libraryFolderKindSchema, nonEmptyString]));

  handle('library:remove-folder', async (_event, folderPath: string) => {
    deps.authorizeSettingsWrite();
    const data = deps.loadLibrary();
    const updated = deps.removeFolderFromLibrary(data, folderPath);
    deps.saveLibraryMutation(updated);
    await deps.removeUnifiedLibraryRoot(folderPath);
    return deps.libraryIndexForRenderer();
  }, z.tuple([nonEmptyString]));

  handle('library:pick-folder', async (_event, currentPath?: string) => {
    deps.authorizeSettingsWrite();
    const result = await deps.showOpenFolderDialog({
      properties: ['openDirectory'],
      buttonLabel: 'Choose Folder',
      message: 'Choose a folder for this LoomTV library entry.',
      ...(currentPath?.trim() ? { defaultPath: currentPath.trim() } : {}),
    });
    return result.canceled ? null : result.filePaths[0] || null;
  }, z.tuple([z.string().optional()]));

  handle('library:update-folder', async (_event, folderPath: string, nextFolderPath: string, kind: string) => {
    deps.authorizeSettingsWrite();
    const normalizedNextFolderPath = nextFolderPath.trim();
    if (!path.isAbsolute(normalizedNextFolderPath)) {
      throw new Error('Folder path must be an absolute path.');
    }
    if (path.resolve(folderPath) === path.resolve(normalizedNextFolderPath)) {
      return deps.libraryIndexForRenderer();
    }

    const data = deps.loadLibrary();
    const withoutPreviousFolder = deps.removeFolderFromLibrary(data, folderPath);
    const updated = deps.addFolderToLibrary(
      withoutPreviousFolder,
      path.resolve(normalizedNextFolderPath),
      safeLibraryFolderKind(kind),
    );
    deps.saveLibraryMutation(updated);
    await deps.removeUnifiedLibraryRoot(folderPath);
    await deps.addUnifiedLibraryRoot(normalizedNextFolderPath, safeLibraryFolderKind(kind));

    return enqueueLibraryScan(async () => {
      const scanData = deps.loadLibrary();
      const scanVersion = deps.getLibraryMutationVersion();
      const progressPublisher = createScanProgressPublisher<TLibraryData>((snapshot) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.webContents.isDestroyed()) {
            window.webContents.send('library:scan-progress', scanProgressPayload(snapshot));
          }
        });
      });
      try {
        const scanned = await deps.scanLibrary(scanData, {
          mode: 'quick',
          onProgress: progressPublisher.publish,
          onCheckpoint: (snapshot) => {
            deps.saveLibraryScanCheckpoint(snapshot, scanVersion);
          },
        });
        progressPublisher.flush();
        if (deps.saveLibraryFromScan(scanned, scanVersion)) {
          await deps.cacheArtworkNow(scanned);
        }
        return deps.libraryIndexForRenderer();
      } finally {
        progressPublisher.cancel();
      }
    });
  }, z.tuple([nonEmptyString, nonEmptyString, libraryFolderKindSchema]));

  handle('media:play', async (_event, filePath: string) => {
    try {
      deps.authorizeMediaPath(filePath);
      deps.assertLocalMediaPath(filePath);
      return false;
    } catch {
      return false;
    }
  }, z.tuple([nonEmptyString]));

  handleNoArgs('media:get-server-port', () => deps.getMediaServerPort());

  // The renderer's loopback credential. It is delivered here, behind the same
  // sender and frame validation as every other channel, because an HTTP route
  // could only authenticate the caller by a header the caller writes — and any
  // local process can write it (audit A.2).
  handleNoArgs('renderer:session', () => ({
    port: deps.getMediaServerPort(),
    localAccessToken: deps.localAccessToken,
  }));

  handle('media:get-stream-url', (_event, filePath: string, options?: TranscodeOptions) => {
    deps.authorizeMediaPath(filePath);
    deps.assertLocalMediaPath(filePath);
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), deps.localAccessToken);
    const subtitleResources = {
      ...(options?.subtitleFilePath
        ? { subtitleResourceId: deps.registerSubtitleResource(filePath, options.subtitleFilePath) }
        : {}),
      ...(options?.secondarySubtitleFilePath
        ? { secondarySubtitleResourceId: deps.registerSubtitleResource(filePath, options.secondarySubtitleFilePath) }
        : {}),
    };
    appendStreamOptionParams(params, options, subtitleResources);
    const playbackPlan = deps.browserPlaybackPlan(filePath, options || {});
    const url = `http://127.0.0.1:${deps.getMediaServerPort()}/stream?${params.toString()}`;
    return {
      url,
      contentType: playbackPlan.mode === 'direct' ? getMimeType(filePath) : playbackPlan.contentType,
      fileName: path.basename(filePath),
      isTranscoded: playbackPlan.requiresSeekRestart,
      isRemuxed: playbackPlan.mode === 'remux',
      playbackMode: playbackPlan.mode,
      decisionReason: playbackPlan.reason,
    };
  }, z.tuple([nonEmptyString, transcodeOptionsSchema.optional()]));

  handle('media:get-subtitle-url', (_event, filePath: string, streamOrdinal?: number) => {
    deps.authorizeMediaPath(filePath);
    deps.assertLocalMediaPath(filePath);
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), deps.localAccessToken);
    if (typeof streamOrdinal === 'number' && streamOrdinal >= 0) params.set('streamOrdinal', String(Math.floor(streamOrdinal)));
    return { url: `http://127.0.0.1:${deps.getMediaServerPort()}/subtitle?${params.toString()}` };
  }, z.tuple([nonEmptyString, finiteNumber.int().nonnegative().optional()]));

  handle('media:get-thumbnail', (_event, filePath: string, time?: string) => {
    deps.authorizeMediaPath(filePath);
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), deps.localAccessToken);
    if (time) params.set('t', time);
    return { url: `http://127.0.0.1:${deps.getMediaServerPort()}/api/thumbnail?${params.toString()}` };
  }, z.tuple([nonEmptyString, z.string().optional()]));

  handle('media:get-file-info', (_event, filePath: string) => {
    try {
      deps.authorizeMediaPath(filePath);
      deps.assertLocalMediaPath(filePath);
      const exists = fs.existsSync(filePath);
      const size = exists ? fs.statSync(filePath).size : 0;
      return { size, path: filePath, exists };
    } catch {
      return { size: 0, path: filePath, exists: false };
    }
  }, z.tuple([nonEmptyString]));

  handleNoArgs('settings:get', () => deps.settingsForRenderer());

  handleStremio('plugins:stremio:list', () => deps.listStremioPlugins(), z.tuple([]));
  handleStremio('plugins:stremio:available', () => deps.listAvailableStremioPlugins(), z.tuple([]));
  handleStremio('plugins:stremio:official', () => deps.listOfficialStremioAddons(), z.tuple([]));
  handleStremio('plugins:stremio:review-official', (_event, officialId) => deps.reviewOfficialStremioAddon(officialId), z.tuple([z.enum(['cinemeta', 'opensubtitles-v3'])]));
  handleStremio('plugins:stremio:review-url', (_event, manifestUrl) => deps.reviewStremioManifestUrl(String(manifestUrl || '')), z.tuple([z.string().url()]));
  handleStremio('plugins:stremio:approve', (_event, addonId, reviewToken) => deps.approveStremioAddon(String(addonId || ''), String(reviewToken || '')), z.tuple([nonEmptyString, nonEmptyString]));
  handleStremio('plugins:stremio:disable', (_event, addonId) => deps.disableStremioAddon(String(addonId || '')), z.tuple([nonEmptyString]));
  handleStremio('plugins:stremio:remove', (_event, addonId) => deps.removeStremioAddon(String(addonId || '')), z.tuple([nonEmptyString]));
  handleStremio('plugins:stremio:profile-access', (_event, profileId) => deps.listStremioProfileAccess(String(profileId || '')), z.tuple([nonEmptyString]));
  handleStremio('plugins:stremio:set-profile-access', (_event, profileId, addonId, enabled) => deps.setStremioProfileAccess(
    String(profileId || ''),
    String(addonId || ''),
    enabled === true,
  ), z.tuple([nonEmptyString, nonEmptyString, z.boolean()]));
  handleStremio('plugins:stremio:catalog', (_event, addonId, request) => deps.fetchStremioCatalog(String(addonId || ''), request), z.tuple([nonEmptyString, stremioCatalogRequestSchema]));
  handleStremio('plugins:stremio:meta', (_event, addonId, request) => deps.fetchStremioMeta(String(addonId || ''), request), z.tuple([nonEmptyString, stremioMetaRequestSchema]));
  handleStremio('plugins:stremio:meta-item', (_event, request) => deps.fetchStremioMetaByItem(request), z.tuple([stremioMetaRequestSchema]));
  handleStremio('plugins:stremio:configuration', (_event, addonId) => deps.getStremioAddonConfiguration(String(addonId || '')), z.tuple([nonEmptyString]));
  handleStremio('plugins:stremio:save-configuration', (_event, addonId, values) => deps.saveStremioAddonConfiguration(String(addonId || ''), values), z.tuple([nonEmptyString, z.record(z.string(), z.unknown())]));
  handleStremio('plugins:stremio:audit', (_event, addonId, limit) => deps.listStremioPluginAudit(String(addonId || ''), limit), z.tuple([nonEmptyString, finiteNumber.int().positive().max(1_000).optional()]));

  handle('settings:save', (_event, settings) => {
    deps.authorizeSettingsWrite();
    deps.saveSettings({
      ...deps.loadSettings(),
      ...sanitizeRendererSettingsPatch(settings),
    });
    deps.onSettingsSaved?.();
    deps.syncLanAdvertisement();
    return true;
  }, z.tuple([rendererSettingsPatchSchema]));

  handleNoArgs('server:unified-state', () => deps.getUnifiedDesktopServerState());
  handle('server:configure-owner', (_event, input) => deps.configureUnifiedDesktopOwner(input), z.tuple([
    z.object({
      name: z.string().trim().min(1).max(80),
      password: z.string().min(8).max(256),
    }),
  ]));
  handleNoArgs('server:open-admin', () => deps.openUnifiedDesktopAdmin());

  handle('metadata:test-keys', (_event, keys: Record<string, string>) => {
    deps.authorizeSettingsWrite();
    return deps.testMetadataKeys(keys || {});
  }, z.tuple([metadataKeysSchema]));
  handle('metadata:refresh-incomplete', (_event, mediaId: string) => {
    deps.authorizeSettingsWrite();
    return deps.refreshIncompleteMetadata(String(mediaId || ''));
  }, z.tuple([nonEmptyString]));
  handle('metadata:provider-request', (_event, request) => deps.requestMetadataProvider(request), z.tuple([metadataProviderRequestSchema]));
  handle('metadata:streaming-providers', (_event, mediaId: string) => deps.getStreamingProviders(mediaId), z.tuple([nonEmptyString]));

  handleNoArgs('mpv:availability', () => mpvAvailability());

  handleNoArgs('mpv:refresh-availability', () => refreshMpvAvailability());

  handleNoArgs('mpv:choose-executable', async () => {
    deps.authorizeSettingsWrite();
    const result = await deps.showOpenFolderDialog({
      title: 'Choose mpv executable',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'mpv executable', extensions: ['exe'] }]
        : [{ name: 'mpv executable', extensions: ['*'] }],
    });
    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) return mpvAvailability();
    const validated = validateMpvExecutable(selectedPath);
    deps.saveSettings({ ...deps.loadSettings(), mpvExecutablePath: validated.executablePath });
    deps.onSettingsSaved?.();
    return refreshMpvAvailability();
  });

  handleNoArgs('mpv:reset-executable', () => {
    deps.authorizeSettingsWrite();
    const settings = deps.loadSettings();
    deps.saveSettings({ ...settings, mpvExecutablePath: undefined });
    deps.onSettingsSaved?.();
    return refreshMpvAvailability();
  });

  handle('mpv:start', (event, filePath, options) => {
    deps.authorizeMediaPath(filePath);
    deps.assertLocalMediaPath(filePath);
    for (const subtitleFile of options?.subtitleFiles || []) {
      deps.authorizeMediaPath(subtitleFile.path);
      deps.assertLocalMediaPath(subtitleFile.path);
    }
    return startMpvPlayback(event.sender, filePath, options);
  }, z.tuple([nonEmptyString, mpvStartOptionsSchema.optional()]));

  handle(
    'mpv:command',
    (_event, sessionId, command) => commandMpvPlayback(sessionId, command),
    z.tuple([nonEmptyString, playbackCommandSchema]),
  );

  handle('mpv:stop', (_event, sessionId) => stopMpvPlayback(sessionId), z.tuple([nonEmptyString]));

  handleExperimental('libvlc:availability', () => libVlcAvailability(), z.tuple([]));

  handleExperimental('libvlc:refresh-availability', () => refreshLibVlcAvailability(), z.tuple([]));

  handleExperimental('libvlc:start', (event, filePath, rawOptions) => {
    const mediaPath = String(filePath || '');
    deps.authorizeMediaPath(mediaPath);
    deps.assertLocalMediaPath(mediaPath);
    const options: LibVlcStartOptions = playbackStartOptionsSchema.parse(rawOptions ?? {});
    for (const subtitleFile of options.subtitleFiles || []) {
      const subtitlePath = String(subtitleFile?.path || '');
      deps.authorizeMediaPath(subtitlePath);
      deps.assertLocalMediaPath(subtitlePath);
      deps.assertSubtitleCanAccessMediaPath?.(mediaPath, subtitlePath);
    }
    return startLibVlcPlayback(event.sender, mediaPath, options);
  }, z.tuple([nonEmptyString, playbackStartOptionsSchema.optional()]));

  handleExperimental('libvlc:command', (_event, sessionId, command) =>
    commandLibVlcPlayback(String(sessionId || ''), playbackCommandSchema.parse(command)),
  z.tuple([nonEmptyString, playbackCommandSchema]));

  handleExperimental('libvlc:stop', (_event, sessionId) =>
    stopLibVlcPlayback(sessionId ? String(sessionId) : undefined), z.tuple([z.string().optional()]));

  handleExperimental('libvlc:sync-surface', (event) => syncLibVlcPlaybackSurface(event.sender), z.tuple([]));

  handleExperimental('libvlc:set-fullscreen-transition', (event, transitioning, waitForFinalViewport) =>
    setLibVlcPlaybackFullscreenTransition(
      event.sender,
      Boolean(transitioning),
      waitForFinalViewport === undefined ? true : Boolean(waitForFinalViewport),
    ), z.tuple([z.boolean(), z.boolean().optional()]));

  handleExperimental('libvlc:set-viewport', (event, rawViewport) => {
    const result = playbackViewportSchema.safeParse(rawViewport);
    if (!result.success || result.data.x < -10_000 || result.data.y < -10_000) return false;
    const viewport: PlaybackViewport = result.data;
    return setLibVlcPlaybackViewport(event.sender, viewport);
  }, z.tuple([playbackViewportSchema]));

  // The window uses titleBarStyle 'hiddenInset', so the macOS traffic lights
  // float over whatever is beneath them — in the player that is the video.
  // Tie them to the player's own chrome so they fade out with the controls
  // instead of sitting permanently on top of the picture.
  handleExperimental('window:set-chrome-visible', (event, visible) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) return false;
    if (process.platform !== 'darwin') return false;
    ownerWindow.setWindowButtonVisibility(Boolean(visible));
    return true;
  }, z.tuple([z.boolean()]));

  handleExperimental('window:set-fullscreen', async (event, enabled) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) return false;
    const nextFullscreen = Boolean(enabled);
    // This IPC route is retained as a compatibility fallback, but it must use
    // macOS's normal fullscreen lifecycle. `setSimpleFullScreen` expands the
    // window over the current desktop and bypasses the proven Loom player
    // behavior, which made LibVLC feel like a second application.
    const isFullscreen = () => ownerWindow.isFullScreen();
    const setFullscreen = (value: boolean) => ownerWindow.setFullScreen(value);
    if (isFullscreen() === nextFullscreen) {
      if (!event.sender.isDestroyed()) event.sender.send('window:fullscreen-changed', nextFullscreen);
      return true;
    }
    // Electron types on/once/removeListener as per-event overloads, so a union
    // of event names matches none of them. Branch on the literal instead of
    // casting, which keeps the listener signature checked.
    const onceTransition = (listener: () => void): void => {
      if (nextFullscreen) ownerWindow.once('enter-full-screen', listener);
      else ownerWindow.once('leave-full-screen', listener);
    };
    const offTransition = (listener: () => void): void => {
      if (nextFullscreen) ownerWindow.removeListener('enter-full-screen', listener);
      else ownerWindow.removeListener('leave-full-screen', listener);
    };
    setLibVlcPlaybackFullscreenTransition(event.sender, true);
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (changed: boolean) => {
        if (settled) return;
        // AppKit can deliver enter/leave-full-screen just before Electron's
        // isFullScreen() value catches up. Do not resolve the renderer's
        // readiness handshake until the state agrees with the requested
        // transition; otherwise the native surface receives the opposite
        // window geometry and playback can remain stuck after exit.
        if (changed && !ownerWindow.isDestroyed() && isFullscreen() !== nextFullscreen) {
          if (!pollTimer) {
            pollTimer = setTimeout(() => {
              pollTimer = null;
              finish(true);
            }, 16);
            pollTimer.unref();
          }
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (pollTimer) clearTimeout(pollTimer);
        offTransition(onTransition);
        const actual = !ownerWindow.isDestroyed() && isFullscreen() === nextFullscreen;
        setLibVlcPlaybackFullscreenTransition(event.sender, false, Boolean(changed && actual));
        if (!event.sender.isDestroyed()) event.sender.send('window:fullscreen-changed', isFullscreen());
        resolve(Boolean(changed && actual));
      };
      const onTransition = () => finish(true);
      const poll = () => {
        pollTimer = null;
        if (ownerWindow.isDestroyed()) {
          finish(false);
          return;
        }
        if (isFullscreen() === nextFullscreen) {
          finish(true);
          return;
        }
        pollTimer = setTimeout(poll, 50);
        pollTimer.unref();
      };
      const timeout = setTimeout(() => finish(false), 5_000);
      timeout.unref();
      onceTransition(onTransition);
      try {
        setFullscreen(nextFullscreen);
        pollTimer = setTimeout(poll, 50);
        pollTimer.unref();
      } catch {
        finish(false);
      }
    });
  }, z.tuple([z.boolean()]));

  handleNoArgs('network:status', () => {
    const status = buildNetworkStatus(deps);
    return { ...status, deviceName: status.deviceName || os.hostname() };
  });

  handle('network:discover-peers', async (_event, timeoutMs?: number) => {
    const settings = deps.loadSettings();
    try {
      return await deps.discoverLanPeers(Number(timeoutMs) || 2500, settings.localNetworkDeviceId);
    } catch (error) {
      console.warn('[mdns] discover failed:', error);
      return [];
    }
  }, z.tuple([finiteNumber.positive().max(30_000).optional()]));

  handle('network:remote-connect', (_event, baseUrl, code, certFingerprint) => {
    const settings = deps.loadSettings();
    return deps.connectRemoteLibrary(String(baseUrl || ''), String(code || ''), {
      name: settings.localNetworkDeviceName || os.hostname(),
    }, String(certFingerprint || ''));
  }, z.tuple([nonEmptyString, z.string(), z.string().optional()]));

  handle('network:remote-request', (_event, pathname, request) =>
    deps.requestRemoteLibrary(String(pathname || ''), request),
  z.tuple([nonEmptyString, remoteLibraryRequestSchema.optional()]));

  handleNoArgs('network:remote-session', () => deps.getRemoteLibrarySession());

  handle('network:remote-disconnect', (_event, revoke) =>
    deps.disconnectRemoteLibrary(Boolean(revoke)), z.tuple([z.boolean().optional()]));

  handle('network:revoke-paired-device', (_event, deviceId: string) => {
    deps.authorizeSettingsWrite();
    const settings = deps.loadSettings();
    const pairedDevices = settings.localNetworkPairedDevices || [];
    const revoked = pairedDevices.find((device) => device.id === deviceId);
    if (!revoked) return pairedDevices;
    const remaining = pairedDevices.filter((device) => device.id !== revoked.id);
    deps.revokeDeviceProfileAccess(revoked.id);
    deps.saveSettings({ ...settings, localNetworkPairedDevices: remaining });
    return remaining;
  }, z.tuple([nonEmptyString]));

  handle('network:set-device-name', (_event, name: string) => {
    deps.authorizeSettingsWrite();
    const settings = deps.loadSettings();
    const nextName = String(name || '').trim().slice(0, 80) || os.hostname();
    deps.saveSettings({ ...settings, localNetworkDeviceName: nextName });
    deps.syncLanAdvertisement();
    return nextName;
  }, z.tuple([nonEmptyString.max(80)]));

  handleNoArgs('profiles:list', () => deps.listProfiles());
  handleNoArgs('profiles:choose-avatar', () => deps.chooseProfileAvatar());
  handleNoArgs('profiles:get-active', () => deps.getActiveProfileState());
  handleNoArgs('profiles:lock', () => deps.lockProfile());
  handle('profiles:create', (_event, input) => deps.createProfile(input || { name: '' }), z.tuple([profileCreateSchema]));
  handle('profiles:update', (_event, profileId: string, patch) => deps.updateProfile(String(profileId || ''), patch || {}), z.tuple([nonEmptyString, profileUpdateSchema]));
  handle('profiles:delete', (_event, profileId: string) => deps.deleteProfile(profileId), z.tuple([nonEmptyString]));
  handle('profiles:export', (_event, profileId: string) => deps.exportProfile(profileId), z.tuple([nonEmptyString]));
  handleNoArgs('profiles:import', () => deps.importProfile());
  handle('profiles:select', (_event, profileId: string, pin?: string) => deps.selectProfile(profileId, pin), z.tuple([nonEmptyString, z.string().optional()]));
  handleNoArgs('profiles:select-guest', () => deps.selectGuestProfile());
  handle('profiles:reorder', (_event, profileIds) => deps.reorderProfiles(profileIds), z.tuple([z.array(nonEmptyString)]));
  handle('profiles:pin', (_event, profileId, pin) => deps.changeProfilePin(profileId, pin), z.tuple([nonEmptyString, z.string().nullable()]));
  handle('profiles:reset-owner', (_event, confirmation) => deps.resetOwnerProfile(confirmation), z.tuple([z.string()]));
  handle('profiles:set-auto-sign-in', (_event, enabled) => deps.setAutomaticSignIn(enabled), z.tuple([z.boolean()]));
  handleNoArgs('profile-preferences:get', () => deps.getProfilePreferences());
  handle('profile-preferences:save', (_event, patch, expectedProfileId) => deps.saveProfilePreferences(patch || {}, expectedProfileId), z.tuple([profilePreferencesSchema, z.string().optional()]));
  handle('profile-restrictions:get', (_event, profileId) => deps.getProfileRestrictions(String(profileId || '')), z.tuple([nonEmptyString]));
  handle('profile-restrictions:save', (_event, profileId, input) => deps.saveProfileRestrictions(String(profileId || ''), input), z.tuple([nonEmptyString, profileRestrictionsInputSchema]));
  handle('profile-lists:get', (_event, kind) => deps.getProfileLists(kind), z.tuple([profileListKindSchema.optional()]));
  handle('profile-lists:set', (_event, mediaId, kind, present, expectedProfileId) => deps.setProfileListEntry(String(mediaId || ''), kind, Boolean(present), expectedProfileId), z.tuple([nonEmptyString, profileListKindSchema, z.boolean(), z.string().optional()]));
  handle('progress:get', (_event, filePath?: string) => filePath ? deps.getProgress(filePath) : deps.getAllProgress(), z.tuple([z.string().optional()]));
  handle('progress:save', (_event, filePath: string, position: number, duration: number, expectedProfileId?: string) =>
    deps.saveProgress(filePath, position, duration, expectedProfileId), z.tuple([
    nonEmptyString,
    finiteNumber.nonnegative(),
    finiteNumber.nonnegative(),
    z.string().optional(),
  ]));
  handle('progress:import', (_event, progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>, expectedProfileId?: string) => {
    deps.importProgress(progress || {}, expectedProfileId);
    return true;
  }, z.tuple([z.record(z.string(), progressImportValueSchema), z.string().optional()]));
  handle('playback-track-preferences:get', (_event, scope?: string) => deps.getPlaybackTrackPreferences(scope), z.tuple([z.string().optional()]));
  handle('playback-track-preferences:save', (_event, scope: string, preferences, expectedProfileId) =>
    deps.savePlaybackTrackPreferences(scope, preferences || {}, expectedProfileId), z.tuple([nonEmptyString, playbackTrackPreferencesSchema, z.string().optional()]));
  handle('playback:segments:get', (_event, request: MediaSegmentRequest) =>
    deps.getMediaSegments(request || { mediaId: '' }), z.tuple([mediaSegmentRequestSchema]));
  handle('playback:segments:save-manual', (_event, input: ManualMediaSegmentInput) => {
    deps.authorizeSettingsWrite();
    return deps.saveManualMediaSegment(input);
  }, z.tuple([manualMediaSegmentSchema]));
  handle('playback:segments:delete-manual', (_event, input: MediaSegmentRequest & { candidateId?: string; type: ManualMediaSegmentInput['type'] }) => {
    deps.authorizeSettingsWrite();
    return deps.deleteManualMediaSegment(input);
  }, z.tuple([mediaSegmentRequestSchema.extend({ candidateId: z.string().optional(), type: mediaSegmentTypeSchema })]));
  handle('playback:segments:undo-manual', (_event, input: MediaSegmentRequest & { candidateId?: string; type: ManualMediaSegmentInput['type'] }) => {
    deps.authorizeSettingsWrite();
    return deps.undoManualMediaSegment(input);
  }, z.tuple([mediaSegmentRequestSchema.extend({ candidateId: z.string().optional(), type: mediaSegmentTypeSchema })]));
  handle('playback:segments:manage-list', (_event, request) => {
    deps.authorizeSettingsWrite();
    return deps.getManagedMediaSegments(request ? {
      mediaId: request.mediaId ? String(request.mediaId).slice(0, 240) : undefined,
      season: request.season === undefined ? undefined : Math.max(0, Math.floor(Number(request.season) || 0)),
      episode: request.episode === undefined ? undefined : Math.max(0, Math.floor(Number(request.episode) || 0)),
    } : undefined);
  }, z.tuple([mediaSegmentRequestSchema.partial().optional()]));
  handle('playback:segments:manage-update', (_event, candidateId, patch) => {
    deps.authorizeSettingsWrite();
    const status = patch?.status === 'active' || patch?.status === 'review' || patch?.status === 'rejected' ? patch.status : undefined;
    const type = patch?.type === 'intro' || patch?.type === 'recap' || patch?.type === 'outro' || patch?.type === 'credits' || patch?.type === 'preview' ? patch.type : undefined;
    return deps.updateManagedMediaSegment(String(candidateId || '').slice(0, 240), { status, type });
  }, z.tuple([nonEmptyString.max(240), z.object({
    status: z.enum(['active', 'review', 'rejected']).optional(),
    type: mediaSegmentTypeSchema.optional(),
  })]));
  handle('playback:segments:manage-erase', (_event, request) => {
    deps.authorizeSettingsWrite();
    return deps.eraseManagedMediaSegments({
      mediaId: String(request?.mediaId || '').slice(0, 240),
      season: request?.season === undefined ? undefined : Math.max(0, Math.floor(Number(request.season) || 0)),
      episode: request?.episode === undefined ? undefined : Math.max(0, Math.floor(Number(request.episode) || 0)),
    });
  }, z.tuple([mediaSegmentRequestSchema]));
  handle('playback:activity', (event, key: string, active: boolean, label?: string) => {
    deps.setPlaybackActivityLease(key, Boolean(active), label);
    setSystemMediaKeyActivity(event.sender, key, Boolean(active));
    return true;
  }, z.tuple([nonEmptyString, z.boolean(), z.string().optional()]));
  handleNoArgs('playback:analysis:status', () => {
    deps.authorizeSettingsWrite();
    return deps.getLocalSegmentAnalysisStatus();
  });
  handle('playback:analysis:season', (_event, mediaId: string, season: number) => {
    deps.authorizeSettingsWrite();
    return deps.analyzeLocalSegmentSeason(
      String(mediaId || '').slice(0, 240),
      Number.isFinite(Number(season)) ? Math.max(0, Math.floor(Number(season))) : 1,
    );
  }, z.tuple([nonEmptyString.max(240), finiteNumber.nonnegative()]));
  handle('playback:analysis:run', (_event, scope) => {
    deps.authorizeSettingsWrite();
    return deps.runLocalSegmentAnalysis(scope ? {
      mediaId: scope.mediaId ? String(scope.mediaId).slice(0, 240) : undefined,
      season: scope.season === undefined || !Number.isFinite(Number(scope.season)) ? undefined : Math.max(0, Math.floor(Number(scope.season))),
      episode: scope.episode === undefined || !Number.isFinite(Number(scope.episode)) ? undefined : Math.max(0, Math.floor(Number(scope.episode))),
      mode: scope.mode === 'quick' ? 'quick' : scope.mode === 'full' ? 'full' : undefined,
    } : undefined);
  }, z.tuple([z.object({
    mediaId: z.string().max(240).optional(),
    season: finiteNumber.nonnegative().optional(),
    episode: finiteNumber.nonnegative().optional(),
    mode: z.enum(['quick', 'full']).optional(),
  }).optional()]));
  handle('playback:analysis:cancel', (_event, request) => {
    deps.authorizeSettingsWrite();
    return deps.cancelLocalSegmentAnalysis(request ? {
      jobKey: request.jobKey ? String(request.jobKey).slice(0, 128) : undefined,
      kind: request.kind === 'manual' ? 'manual' : undefined,
    } : undefined);
  }, z.tuple([z.object({
    jobKey: z.string().max(128).optional(),
    kind: z.literal('manual').optional(),
  }).optional()]));
  handleNoArgs('playback:analysis:pause', () => {
    deps.authorizeSettingsWrite();
    return deps.pauseLocalSegmentAnalysis();
  });
  handleNoArgs('playback:analysis:resume', () => {
    deps.authorizeSettingsWrite();
    return deps.resumeLocalSegmentAnalysis();
  });
  handleNoArgs('playback:analysis:cleanup', () => {
    deps.authorizeSettingsWrite();
    return deps.cleanupLocalSegmentAnalysis();
  });
  handleNoArgs('playback:analysis:rebuild', () => {
    deps.authorizeSettingsWrite();
    return deps.rebuildLocalSegmentAnalysis();
  });
  handle('artwork:get', (_event, mediaId: string) => deps.customArtworkForRenderer(mediaId), z.tuple([nonEmptyString]));
  handle('artwork:save', (_event, mediaId: string, target: string, dataUrl: string) => {
    deps.authorizeSettingsWrite();
    deps.saveCustomArtwork(mediaId, target, dataUrl);
    return deps.customArtworkForRenderer(mediaId);
  }, z.tuple([nonEmptyString, nonEmptyString, z.string().max(25 * 1024 * 1024)]));
  handle('artwork:official-candidates', (_event, mediaId: string) => {
    deps.authorizeSettingsWrite();
    return deps.getOfficialMetadataCandidates(mediaId);
  }, z.tuple([nonEmptyString]));
  handle('artwork:apply-official', (_event, mediaId: string, candidate: OfficialMetadataCandidate, target?: OfficialMetadataApplyTarget) => {
    deps.authorizeSettingsWrite();
    return deps.applyOfficialMetadataCandidate(mediaId, candidate, target);
  }, z.tuple([nonEmptyString, artworkCandidateSchema, z.enum(['all', 'poster', 'cover', 'episodes']).optional()]));
  handle('artwork:refresh-official', (_event, mediaId: string, target?: OfficialArtworkRefreshTarget) => {
    deps.authorizeSettingsWrite();
    return deps.refreshOfficialArtwork(mediaId, target);
  }, z.tuple([nonEmptyString, z.enum(['all', 'poster', 'cover']).optional()]));
  handle('artwork:playback-logo', (_event, mediaId: string) => deps.getPlaybackLogo(mediaId), z.tuple([nonEmptyString]));
  handle('artwork:import', (_event, entries: Record<string, Record<string, string>>) => {
    deps.authorizeSettingsWrite();
    deps.importCustomArtwork(entries || {});
    return true;
  }, z.tuple([z.record(z.string(), z.record(z.string(), z.string()))]));
  handleNoArgs('database:backup', () => { deps.authorizeSettingsWrite(); return deps.backupDatabase(); });
  handleNoArgs('database:clear', () => {
    deps.authorizeSettingsWrite();
    deps.clearAppData();
    return deps.libraryIndexForRenderer();
  });
  handle('shell:open-external', (_event, url: string): OpenExternalResult => {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only http and https links can be opened externally.');
    }
    return shell.openExternal(parsed.toString());
  }, z.tuple([nonEmptyString]));
  const openFolderPath = async (filePath: string) => {
    const target = String(filePath || '').trim();
    if (!target) throw new Error('A local path is required.');
    if (/^[a-z]+:\/\//i.test(target)) throw new Error('Only local paths can be opened in the file manager.');
    const resolvedTarget = path.resolve(target);
    let existingTarget = resolvedTarget;
    const root = path.parse(resolvedTarget).root;
    while (!fs.existsSync(existingTarget)) {
      const parent = path.dirname(existingTarget);
      if (parent === existingTarget || parent === root) {
        throw new Error('That file or folder is no longer available.');
      }
      existingTarget = parent;
    }

    if (existingTarget !== resolvedTarget || fs.statSync(existingTarget).isDirectory()) {
      const error = await shell.openPath(existingTarget);
      if (error) throw new Error(error);
    } else {
      shell.showItemInFolder(existingTarget);
    }
    return true;
  };
  handle('shell:open-folder-path', (_event, filePath: string) => openFolderPath(filePath), z.tuple([nonEmptyString]));
  handle('shell:show-item', (_event, filePath: string) => openFolderPath(filePath), z.tuple([nonEmptyString]));
  handleNoArgs('updates:get-state', () => deps.getUpdateState());
  handleNoArgs('updates:check', () => deps.checkForUpdates());
  handleNoArgs('updates:install', () => {
    const updateState = deps.getUpdateState();
    if (updateState.status !== 'downloaded') return updateState;
    return deps.installDownloadedUpdate();
  });

  handleNoArgs('media:ffmpeg-available', () => ffmpegAvailability(deps.findFFmpeg, deps.getTranscodeCapabilities));

  handle('media:probe', (_event, filePath: string) => deps.safeResult(() => {
    deps.authorizeMediaPath(filePath);
    return deps.probeMedia(filePath);
  }), z.tuple([nonEmptyString]));

  handle('media:can-direct-play', (_event, filePath: string, backend: 'html5' | 'hls' = 'html5') =>
    deps.safeResult(async () => {
      deps.authorizeMediaPath(filePath);
      if (backend === 'html5') return deps.browserPlaybackPlan(filePath).mode === 'direct';
      const result = await deps.probeMedia(filePath);
      return deps.canDirectPlay(filePath, result, backend);
    }), z.tuple([nonEmptyString, z.enum(['html5', 'hls']).optional()]),
  );

  handle('media:start-transcode', (_event, filePath: string, options?: TranscodeOptions) =>
    deps.safeResult(async () => {
      deps.authorizeMediaPath(filePath);
      return deps.startTranscode(filePath, options || {}, `http://127.0.0.1:${deps.getMediaServerPort()}`);
    }), z.tuple([nonEmptyString, transcodeOptionsSchema.optional()]),
  );
  handle('media:stop-transcode', (_event, sessionId: string) => deps.safeResult(() => deps.stopTranscode(sessionId)), z.tuple([nonEmptyString]));
}
