import { BrowserWindow, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLibraryFolderMutations } from './libraryFolderMutations';
import { addLocalAccessToken } from './serverSecurity';
import { publishMediaSessionSnapshot, releaseMediaSession } from './systemMediaKeys.ts';
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
  StremioStreamRequest,
  StremioStreamResult,
  StoredProgress,
} from '../shared/desktopProtocol.ts';
import type { TranscodeCapabilities } from '@loom-media-server/transcode-capabilities';
import { buildNetworkStatus, ffmpegAvailability } from './ipcHandlerPolicy.ts';
import { rendererSettingsPatchSchema, sanitizeRendererSettingsPatch } from './rendererSettings.ts';
import { serializeStremioPluginError } from './stremioPluginWire.ts';
import {
  commandLibMpvPlayback,
  libMpvAvailability,
  setLibMpvPlaybackFullscreenTransition,
  setLibMpvPlaybackViewport,
  startLibMpvPlayback,
  stopLibMpvPlayback,
  syncLibMpvPlaybackSurface,
} from './libmpvPlayback.ts';
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
import { z } from 'zod';
import { lanProviderRatingsSchema } from '@loom-media-server/lan-protocol';
import { playbackStartOptionsSchema, playbackCommandSchema, playbackTimeSchema, externalBrowserUrl, authorizeFolderReveal, boundedIpcRecord } from './ipcPlaybackValidation.ts';
import { parseIpcArguments } from './ipcValidation.ts';
import { metadataProviderRequestSchema } from './metadataProviderGateway.ts';
import { parseIptvPlaybackReference } from '../shared/iptvPlayback.ts';
import { parseExternalPlaybackReference } from '../shared/externalPlayback.ts';

const finiteNumber = z.number().finite();
const nonEmptyString = z.string().max(8192).trim().min(1).max(8192);
const mediaSessionSnapshotSchema = z.object({
  sessionId: z.string().max(200),
  state: z.enum(['playing', 'paused', 'stopped']),
  positionSeconds: playbackTimeSchema,
  durationSeconds: playbackTimeSchema,
  rate: finiteNumber.min(0.25).max(3),
  supportedCommands: z.array(z.enum([
    'play',
    'pause',
    'toggle',
    'stop',
    'seekRelative',
    'seekAbsolute',
    'previousItem',
    'nextItem',
    'setRate',
  ])).max(16),
  skipForwardSeconds: finiteNumber.positive(),
  skipBackSeconds: finiteNumber.positive(),
  title: z.string().max(400),
  seriesTitle: z.string().max(400).optional(),
  season: finiteNumber.nonnegative().optional(),
  episode: finiteNumber.nonnegative().optional(),
  queueIndex: finiteNumber.nonnegative(),
  queueCount: finiteNumber.nonnegative(),
  engine: z.enum(['libvlc', 'mpv', 'chromium']),
  engineSessionId: z.string().max(200).optional(),
  artworkUrl: z.string().max(2048).optional(),
});
const playbackViewportSchema = z.object({
  x: finiteNumber.min(-10_000).max(100_000),
  y: finiteNumber.min(-10_000).max(100_000),
  width: finiteNumber.positive().max(100_000),
  height: finiteNumber.positive().max(100_000),
});
const mpvStartOptionsSchema = playbackStartOptionsSchema.omit({ nativeSubtitles: true });
const libraryScanOptionsSchema = z.object({
  force: z.boolean().optional(),
  mode: z.enum(['quick', 'metadata', 'full']).optional(),
});
const libraryFolderKindSchema = z.enum(['movies', 'tvShows', 'anime', 'others']);
const metadataKeysSchema = boundedIpcRecord(z.string().max(8192), 64, 65_536);
const remoteLibraryRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).optional(),
  headers: boundedIpcRecord(z.string().max(8192), 128, 65_536).optional(),
  body: z.string().max(2_000_000).optional(),
});
const profileCreateSchema = z.object({
  name: z.string().max(8192),
  avatarKey: z.string().max(8192).optional(),
  colorKey: z.string().max(8192).optional(),
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
  sidebarNavOrder: z.array(z.string().max(8192)).max(1024).optional(),
  autoplayNextEnabled: z.boolean().optional(),
  playbackSkipBackSeconds: finiteNumber.optional(),
  playbackSkipForwardSeconds: finiteNumber.optional(),
});
const profileRestrictionsInputSchema = z.object({
  country: z.enum(['US', 'GB', 'CA', 'AU']),
  maximumAge: finiteNumber.nullable(),
  allowUnrated: z.boolean(),
  allowedFolders: z.array(z.string().max(8192)).max(1024),
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
  language: z.string().max(8192).optional(),
  title: z.string().max(8192).optional(),
  codec: z.string().max(8192).optional(),
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
  source: z.enum(['TMDB', 'OMDb', 'TVmaze', 'TVDB', 'Jikan', 'AniList', 'Fanart.tv']),
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
  startSeconds: playbackTimeSchema.optional(),
  videoTrackIndex: finiteNumber.nonnegative().optional(),
  audioTrackIndex: finiteNumber.nonnegative().optional(),
  subtitleTrackIndex: finiteNumber.nonnegative().optional(),
  subtitleStreamOrdinal: finiteNumber.nonnegative().optional(),
  subtitleCodec: z.string().max(8192).optional(),
  subtitleFilePath: z.string().max(8192).optional(),
  secondarySubtitleTrackIndex: finiteNumber.nonnegative().optional(),
  secondarySubtitleStreamOrdinal: finiteNumber.nonnegative().optional(),
  secondarySubtitleCodec: z.string().max(8192).optional(),
  secondarySubtitleFilePath: z.string().max(8192).optional(),
  subtitleStyle: z.object({
    delaySeconds: finiteNumber.min(-60).max(60).optional(),
    position: finiteNumber.min(0).max(100).optional(),
    scale: finiteNumber.min(0.5).max(2).optional(),
    fontSize: finiteNumber.min(24).max(96).optional(),
    fontColor: z.string().max(8192).optional(),
    borderColor: z.string().max(8192).optional(),
    borderWidth: finiteNumber.min(0).max(10).optional(),
    borderEnabled: z.boolean().optional(),
    backgroundColor: z.string().max(8192).optional(),
    backgroundEnabled: z.boolean().optional(),
  }).optional(),
  forceTranscode: z.boolean().optional(),
});
const iptvSourceIdSchema = nonEmptyString.max(120);
const iptvSourceIconSchema = z.enum([
  'general',
  'entertainment',
  'news',
  'sports',
  'movies',
  'series',
  'music',
  'kids',
  'documentary',
  'education',
  'lifestyle',
  'travel',
  'cooking',
  'science',
  'religious',
  'weather',
]);
const iptvSourceInputSchema = z.object({
  playlistUrl: nonEmptyString.max(2048),
  epgUrl: z.string().max(2048).optional(),
  name: nonEmptyString.max(120),
  iconId: iptvSourceIconSchema.optional(),
});
const iptvSourcePatchSchema = z.object({
  name: z.string().max(120).optional(),
  playlistUrl: z.string().max(2048).optional(),
  epgUrl: z.string().max(2048).optional(),
  iconId: iptvSourceIconSchema.optional(),
});
const iptvChannelRequestSchema = z.object({
  sourceId: iptvSourceIdSchema,
  query: z.string().max(200).optional(),
  group: z.string().max(400).optional(),
  subcategory: z.string().max(400).optional(),
  geoFilter: z.enum(['all', 'exclude', 'only']).optional(),
  sort: z.enum(['name-asc', 'name-desc', 'category']).optional(),
  limit: finiteNumber.positive().max(200).optional(),
  offset: finiteNumber.nonnegative().max(1_000_000).optional(),
});

const stremioExtraSchema = z.record(
  z.string().max(128),
  z.union([z.string().max(8192), finiteNumber, z.boolean()]),
).refine((values) => Object.keys(values).length <= 64);
const stremioCatalogRequestSchema = z.object({
  type: nonEmptyString,
  catalogId: nonEmptyString,
  filters: z.object({
    query: z.string().max(8192).optional(),
    genre: z.string().max(8192).optional(),
    year: z.string().max(8192).optional(),
  }).optional(),
  extra: stremioExtraSchema.optional(),
});
const stremioMetaRequestSchema = z.object({
  type: nonEmptyString,
  id: nonEmptyString,
  extra: stremioExtraSchema.optional(),
});
const stremioStreamRequestSchema = z.object({
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
  listIptvSources: () => IpcResult<'iptv:list-sources'>;
  addIptvSource: (input: IpcContract['iptv:add-source']['args'][0]) => Promise<IpcResult<'iptv:add-source'>>;
  updateIptvSource: (sourceId: string, patch: IpcContract['iptv:update-source']['args'][1]) => IpcResult<'iptv:update-source'>;
  removeIptvSource: (sourceId: string) => IpcResult<'iptv:remove-source'>;
  refreshIptvSource: (sourceId: string) => Promise<IpcResult<'iptv:refresh-source'>>;
  listIptvChannels: (request: IpcContract['iptv:list-channels']['args'][0]) => IpcResult<'iptv:list-channels'>;
  resolveIptvStreamUrl: (sourceId: string, channelId: string) => string | null;
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
  reviewInstalledStremioAddon: (addonId: string) => Promise<StremioPluginReview>;
  approveStremioAddon: (addonId: string, reviewToken: string) => Promise<StremioPluginSummary>;
  disableStremioAddon: (addonId: string) => Promise<StremioPluginSummary>;
  removeStremioAddon: (addonId: string) => Promise<boolean>;
  listStremioProfileAccess: (profileId: string) => string[];
  setStremioProfileAccess: (profileId: string, addonId: string, enabled: boolean) => Promise<boolean>;
  fetchStremioCatalog: (addonId: string, request: StremioPluginCatalogRequest) => Promise<StremioPluginCatalogResult>;
  fetchStremioMeta: (addonId: string, request: StremioPluginMetaRequest) => Promise<StremioPluginMetaResult>;
  fetchStremioMetaByItem: (request: StremioPluginMetaRequest) => Promise<StremioPluginMetaResult>;
  fetchStremioStreams: (addonId: string, request: StremioStreamRequest) => Promise<StremioStreamResult>;
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
  const folderMutations = createLibraryFolderMutations(deps);
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
      const newFolder = result.filePaths[0];
      await folderMutations.add(newFolder, safeLibraryFolderKind(kind));
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
    await folderMutations.add(normalizedFolderPath, safeLibraryFolderKind(kind));
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
    await folderMutations.remove(folderPath);
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
  }, z.tuple([z.string().max(8192).optional()]));

  handle('library:update-folder', async (_event, folderPath: string, nextFolderPath: string, kind: string) => {
    deps.authorizeSettingsWrite();
    const normalizedNextFolderPath = nextFolderPath.trim();
    if (!path.isAbsolute(normalizedNextFolderPath)) {
      throw new Error('Folder path must be an absolute path.');
    }
    if (path.resolve(folderPath) === path.resolve(normalizedNextFolderPath)) {
      return deps.libraryIndexForRenderer();
    }

    await folderMutations.update(folderPath, normalizedNextFolderPath, safeLibraryFolderKind(kind));

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

  // ─── Live TV (IPTV) ────────────────────────────────────────────────────────
  // Reading channels is open to any signed-in profile; adding, editing, and
  // removing a provider is an owner action, like linking a library folder.
  handleNoArgs('iptv:list-sources', () => deps.listIptvSources());

  handle('iptv:add-source', (_event, input) => {
    deps.authorizeSettingsWrite();
    return deps.addIptvSource(input);
  }, z.tuple([iptvSourceInputSchema]));

  handle('iptv:update-source', (_event, sourceId, patch) => {
    deps.authorizeSettingsWrite();
    return deps.updateIptvSource(sourceId, patch);
  }, z.tuple([iptvSourceIdSchema, iptvSourcePatchSchema]));

  handle('iptv:remove-source', (_event, sourceId) => {
    deps.authorizeSettingsWrite();
    return deps.removeIptvSource(sourceId);
  }, z.tuple([iptvSourceIdSchema]));

  handle('iptv:refresh-source', (_event, sourceId) => {
    deps.authorizeSettingsWrite();
    return deps.refreshIptvSource(sourceId);
  }, z.tuple([iptvSourceIdSchema]));

  handle('iptv:list-channels', (_event, request) => deps.listIptvChannels(request), z.tuple([iptvChannelRequestSchema]));

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
    const iptvReference = parseIptvPlaybackReference(filePath);
    if (iptvReference) {
      const streamUrl = deps.resolveIptvStreamUrl(iptvReference.sourceId, iptvReference.channelId);
      if (!streamUrl) throw new Error('That live TV channel is no longer available.');
      let parsedStreamUrl: URL;
      try {
        parsedStreamUrl = new URL(streamUrl);
      } catch {
        throw new Error('That live TV channel has an invalid stream address.');
      }
      if (parsedStreamUrl.protocol !== 'https:') {
        throw new Error('That live TV channel does not use a secure stream.');
      }
      const isHls = /\.m3u8?(?:$|\?)/i.test(streamUrl);
      return {
        url: streamUrl,
        contentType: isHls ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        fileName: 'Live TV stream',
        isTranscoded: false,
        isRemuxed: false,
        playbackMode: 'direct' as const,
        decisionReason: 'Validated IPTV stream from the selected Live TV source.',
      };
    }
    const externalReference = parseExternalPlaybackReference(filePath);
    if (externalReference) {
      const streamUrl = externalReference.url;
      let parsed: URL;
      try {
        parsed = new URL(streamUrl);
      } catch {
        throw new Error('That external stream has an invalid address.');
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('External streams must use http or https.');
      const isHls = /\.m3u8?(?:$|\?)/i.test(streamUrl);
      const isYoutube = /youtube-nocookie\.com|youtube\.com|youtu\.be/i.test(parsed.hostname);
      return {
        url: streamUrl,
        contentType: isHls ? 'application/vnd.apple.mpegurl' : isYoutube ? 'text/html' : 'video/mp4',
        fileName: isYoutube ? 'Trailer' : 'External stream',
        isTranscoded: false,
        isRemuxed: false,
        playbackMode: 'direct' as const,
        decisionReason: isYoutube ? 'Validated YouTube trailer.' : 'Validated external lawful stream.',
      };
    }
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
    deps.assertLocalMediaPath(filePath);
    const params = addLocalAccessToken(new URLSearchParams({ path: filePath }), deps.localAccessToken);
    if (time) params.set('t', time);
    return { url: `http://127.0.0.1:${deps.getMediaServerPort()}/api/thumbnail?${params.toString()}` };
  }, z.tuple([nonEmptyString, z.string().max(8192).optional()]));

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
  handleStremio('plugins:stremio:review-url', (_event, manifestUrl) => deps.reviewStremioManifestUrl(String(manifestUrl || '')), z.tuple([z.string().max(8192).url()]));
  handleStremio('plugins:stremio:review-installed', (_event, addonId) => deps.reviewInstalledStremioAddon(String(addonId || '')), z.tuple([nonEmptyString]));
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
  handleStremio('plugins:stremio:streams', (_event, addonId, request) => deps.fetchStremioStreams(String(addonId || ''), request), z.tuple([nonEmptyString, stremioStreamRequestSchema]));
  handleStremio('plugins:stremio:configuration', (_event, addonId) => deps.getStremioAddonConfiguration(String(addonId || '')), z.tuple([nonEmptyString]));
  handleStremio('plugins:stremio:save-configuration', (_event, addonId, values) => deps.saveStremioAddonConfiguration(String(addonId || ''), values), z.tuple([nonEmptyString, boundedIpcRecord(z.unknown(), 128, 262_144)]));
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
      name: z.string().max(8192).trim().min(1).max(80),
      password: z.string().max(8192).min(8).max(256),
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
  handleNoArgs('mpv:availability', () => libMpvAvailability());

  handleNoArgs('mpv:refresh-availability', () => libMpvAvailability(true));

  handleNoArgs('mpv:choose-executable', () => libMpvAvailability());

  handleNoArgs('mpv:reset-executable', () => libMpvAvailability());

  handle('mpv:start', (event, filePath, options) => {
    const requestedPath = String(filePath || '');
    const externalReference = parseExternalPlaybackReference(requestedPath);
    const mediaPath = externalReference?.url || requestedPath;
    if (externalReference) {
      const parsedStreamUrl = new URL(mediaPath);
      if (parsedStreamUrl.protocol !== 'https:' && parsedStreamUrl.protocol !== 'http:') {
        throw new Error('External streams must use http or https.');
      }
    } else {
      deps.authorizeMediaPath(mediaPath);
      deps.assertLocalMediaPath(mediaPath);
    }
    for (const subtitleFile of options?.subtitleFiles || []) {
      deps.authorizeMediaPath(subtitleFile.path);
      deps.assertLocalMediaPath(subtitleFile.path);
      deps.assertSubtitleCanAccessMediaPath?.(mediaPath, subtitleFile.path);
    }
    return startLibMpvPlayback(event.sender, mediaPath, options);
  }, z.tuple([nonEmptyString, mpvStartOptionsSchema.optional()]));

  handle(
    'mpv:command',
    (_event, sessionId, command) => commandLibMpvPlayback(sessionId, command),
    z.tuple([nonEmptyString, playbackCommandSchema]),
  );

  handle('mpv:stop', (_event, sessionId) => stopLibMpvPlayback(sessionId), z.tuple([nonEmptyString]));

  handle('libvlc:availability', () => libVlcAvailability(), z.tuple([]));

  handle('libvlc:refresh-availability', () => refreshLibVlcAvailability(), z.tuple([]));

  handle('libvlc:start', (event, filePath, rawOptions) => {
    const requestedPath = String(filePath || '');
    const iptvReference = parseIptvPlaybackReference(requestedPath);
    const externalReference = parseExternalPlaybackReference(requestedPath);
    const mediaPath = iptvReference
      ? deps.resolveIptvStreamUrl(iptvReference.sourceId, iptvReference.channelId)
      : externalReference?.url || requestedPath;
    if (!mediaPath) throw new Error('That live TV channel is no longer available.');
    if (iptvReference || externalReference) {
      let parsedStreamUrl: URL;
      try {
        parsedStreamUrl = new URL(mediaPath);
      } catch {
        throw new Error('That remote stream has an invalid address.');
      }
      if (parsedStreamUrl.protocol !== 'https:') {
        throw new Error('Remote LibVLC streams must use https.');
      }
    } else {
      deps.authorizeMediaPath(mediaPath);
      deps.assertLocalMediaPath(mediaPath);
    }
    const options = rawOptions ?? {};
    for (const subtitleFile of options.subtitleFiles || []) {
      const subtitlePath = String(subtitleFile?.path || '');
      deps.authorizeMediaPath(subtitlePath);
      deps.assertLocalMediaPath(subtitlePath);
      deps.assertSubtitleCanAccessMediaPath?.(mediaPath, subtitlePath);
    }
    return startLibVlcPlayback(event.sender, mediaPath, options, {
      allowRemoteHttps: Boolean(iptvReference || externalReference),
    });
  }, z.tuple([nonEmptyString, playbackStartOptionsSchema.optional()]));

  handle('libvlc:command', (_event, sessionId, command) =>
    commandLibVlcPlayback(sessionId, command),
  z.tuple([nonEmptyString, playbackCommandSchema]));

  handle('libvlc:stop', (_event, sessionId) =>
    stopLibVlcPlayback(sessionId), z.tuple([nonEmptyString]));

  handle('libvlc:sync-surface', (event) =>
    syncLibVlcPlaybackSurface(event.sender) || syncLibMpvPlaybackSurface(event.sender), z.tuple([]));

  handle('libvlc:set-fullscreen-transition', (event, transitioning, waitForFinalViewport) =>
    setLibVlcPlaybackFullscreenTransition(
      event.sender,
      Boolean(transitioning),
      waitForFinalViewport === undefined ? true : Boolean(waitForFinalViewport),
    ) || setLibMpvPlaybackFullscreenTransition(event.sender, Boolean(transitioning)),
  z.tuple([z.boolean(), z.boolean().optional()]));

  handle('libvlc:set-viewport', (event, viewport) => {
    return setLibVlcPlaybackViewport(event.sender, viewport)
      || setLibMpvPlaybackViewport(event.sender, viewport);
  }, z.tuple([playbackViewportSchema]));

  // The window uses titleBarStyle 'hiddenInset', so the macOS traffic lights
  // float over whatever is beneath them — in the player that is the video.
  // Tie them to the player's own chrome so they fade out with the controls
  // instead of sitting permanently on top of the picture.
  handle('window:set-chrome-visible', (event, visible) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) return false;
    if (process.platform !== 'darwin') return false;
    ownerWindow.setWindowButtonVisibility(Boolean(visible));
    return true;
  }, z.tuple([z.boolean()]));

  handle('window:set-fullscreen', async (event, enabled) => {
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
  }, z.tuple([nonEmptyString, z.string().max(8192), z.string().max(8192).optional()]));

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
  handle('profiles:select', (_event, profileId: string, pin?: string) => deps.selectProfile(profileId, pin), z.tuple([nonEmptyString, z.string().max(8192).optional()]));
  handleNoArgs('profiles:select-guest', () => deps.selectGuestProfile());
  handle('profiles:reorder', (_event, profileIds) => deps.reorderProfiles(profileIds), z.tuple([z.array(nonEmptyString).max(1024)]));
  handle('profiles:pin', (_event, profileId, pin) => deps.changeProfilePin(profileId, pin), z.tuple([nonEmptyString, z.string().max(8192).nullable()]));
  handle('profiles:reset-owner', (_event, confirmation) => deps.resetOwnerProfile(confirmation), z.tuple([z.string().max(8192)]));
  handle('profiles:set-auto-sign-in', (_event, enabled) => deps.setAutomaticSignIn(enabled), z.tuple([z.boolean()]));
  handleNoArgs('profile-preferences:get', () => deps.getProfilePreferences());
  handle('profile-preferences:save', (_event, patch, expectedProfileId) => deps.saveProfilePreferences(patch || {}, expectedProfileId), z.tuple([profilePreferencesSchema, z.string().max(8192).optional()]));
  handle('profile-restrictions:get', (_event, profileId) => deps.getProfileRestrictions(String(profileId || '')), z.tuple([nonEmptyString]));
  handle('profile-restrictions:save', (_event, profileId, input) => deps.saveProfileRestrictions(String(profileId || ''), input), z.tuple([nonEmptyString, profileRestrictionsInputSchema]));
  handle('profile-lists:get', (_event, kind) => deps.getProfileLists(kind), z.tuple([profileListKindSchema.optional()]));
  handle('profile-lists:set', (_event, mediaId, kind, present, expectedProfileId) => deps.setProfileListEntry(String(mediaId || ''), kind, Boolean(present), expectedProfileId), z.tuple([nonEmptyString, profileListKindSchema, z.boolean(), z.string().max(8192).optional()]));
  handle('progress:get', (_event, filePath?: string) => filePath ? deps.getProgress(filePath) : deps.getAllProgress(), z.tuple([z.string().max(8192).optional()]));
  handle('progress:save', (_event, filePath: string, position: number, duration: number, expectedProfileId?: string) =>
    deps.saveProgress(filePath, position, duration, expectedProfileId), z.tuple([
    nonEmptyString,
    finiteNumber.nonnegative(),
    finiteNumber.nonnegative(),
    z.string().max(8192).optional(),
  ]));
  handle('progress:import', (_event, progress: Record<string, number | { position?: number; duration?: number; updatedAt?: number }>, expectedProfileId?: string) => {
    deps.importProgress(progress || {}, expectedProfileId);
    return true;
  }, z.tuple([boundedIpcRecord(progressImportValueSchema, 100_000, 16_000_000), z.string().max(8192).optional()]));
  handle('playback-track-preferences:get', (_event, scope?: string) => deps.getPlaybackTrackPreferences(scope), z.tuple([z.string().max(8192).optional()]));
  handle('playback-track-preferences:save', (_event, scope: string, preferences, expectedProfileId) =>
    deps.savePlaybackTrackPreferences(scope, preferences || {}, expectedProfileId), z.tuple([nonEmptyString, playbackTrackPreferencesSchema, z.string().max(8192).optional()]));
  handle('playback:segments:get', (_event, request: MediaSegmentRequest) =>
    deps.getMediaSegments(request || { mediaId: '' }), z.tuple([mediaSegmentRequestSchema]));
  handle('playback:segments:save-manual', (_event, input: ManualMediaSegmentInput) => {
    deps.authorizeSettingsWrite();
    return deps.saveManualMediaSegment(input);
  }, z.tuple([manualMediaSegmentSchema]));
  handle('playback:segments:delete-manual', (_event, input: MediaSegmentRequest & { candidateId?: string; type: ManualMediaSegmentInput['type'] }) => {
    deps.authorizeSettingsWrite();
    return deps.deleteManualMediaSegment(input);
  }, z.tuple([mediaSegmentRequestSchema.extend({ candidateId: z.string().max(8192).optional(), type: mediaSegmentTypeSchema })]));
  handle('playback:segments:undo-manual', (_event, input: MediaSegmentRequest & { candidateId?: string; type: ManualMediaSegmentInput['type'] }) => {
    deps.authorizeSettingsWrite();
    return deps.undoManualMediaSegment(input);
  }, z.tuple([mediaSegmentRequestSchema.extend({ candidateId: z.string().max(8192).optional(), type: mediaSegmentTypeSchema })]));
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
  // The FFmpeg activity lease governs transcoder scheduling only. System media
  // ownership is published separately on `media-control:publish` so neither can
  // silently move the other.
  handle('playback:activity', (_event, key: string, active: boolean, label?: string) => {
    deps.setPlaybackActivityLease(key, Boolean(active), label);
    return true;
  }, z.tuple([nonEmptyString, z.boolean(), z.string().max(8192).optional()]));

  handle('media-control:publish', (event, snapshot) =>
    publishMediaSessionSnapshot(event.sender, snapshot), z.tuple([mediaSessionSnapshotSchema]));

  handleNoArgs('media-control:release', (event) => releaseMediaSession(event.sender));
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
  }, z.tuple([nonEmptyString, artworkCandidateSchema, z.enum(['all', 'poster', 'cover', 'logo', 'summary', 'episodes']).optional()]));
  handle('artwork:refresh-official', (_event, mediaId: string, target?: OfficialArtworkRefreshTarget) => {
    deps.authorizeSettingsWrite();
    return deps.refreshOfficialArtwork(mediaId, target);
  }, z.tuple([nonEmptyString, z.enum(['all', 'poster', 'cover', 'logo']).optional()]));
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
    return shell.openExternal(externalBrowserUrl(url));
  }, z.tuple([nonEmptyString]));
  const openFolderPath = async (filePath: string) => {
    const target = String(filePath || '').trim();
    if (!target) throw new Error('A local path is required.');
    if (/^[a-z]+:\/\//i.test(target)) throw new Error('Only local paths can be opened in the file manager.');
    const resolvedTarget = path.resolve(target);
    authorizeFolderReveal(resolvedTarget, deps.authorizeMediaPath, deps.authorizeSettingsWrite);
    let existingTarget = resolvedTarget;
    const root = path.parse(resolvedTarget).root;
    while (!fs.existsSync(existingTarget)) {
      const parent = path.dirname(existingTarget);
      if (parent === existingTarget || parent === root) {
        throw new Error('That file or folder is no longer available.');
      }
      authorizeFolderReveal(parent, deps.authorizeMediaPath, deps.authorizeSettingsWrite);
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
