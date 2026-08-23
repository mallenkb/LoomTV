import {
  lanActiveProfileSchema,
  lanErrorPayloadSchema,
  lanLibraryCardSchema,
  lanLibraryIndexSchema,
  lanLibraryItemDetailsSchema,
  lanCastMemberSchema,
  lanContentRatingSchema,
  lanEpisodeMetaSchema,
  lanMediaItemSchema,
  lanProviderRatingsSchema,
  lanStreamingProviderSchema,
  lanOriginPlatformSchema,
  lanProfileListEntrySchema,
  lanProfilePreferencesSchema,
  lanProfileSummarySchema,
  lanStoredProgressSchema,
  parseJsonResponse,
} from '@loom-media-server/lan-protocol';
import { z } from 'zod';

const finiteNumber = z.number().finite();
const nonNegativeNumber = finiteNumber.nonnegative();

const libraryFolderGroupsSchema = z.object({
  movies: z.array(z.string()),
  tvShows: z.array(z.string()),
  anime: z.array(z.string()),
  others: z.array(z.string()),
});

const libraryFolderStatusSchema = z.object({
  path: z.string(),
  kind: z.enum(['movies', 'tvShows', 'anime', 'others']),
  state: z.enum(['available', 'degraded', 'unavailable']),
  isNetworkLike: z.boolean(),
  checkedAt: nonNegativeNumber,
  message: z.string(),
});

export const desktopLibrarySchema = z.object({
  movies: z.array(lanMediaItemSchema).default([]),
  tvShows: z.array(lanMediaItemSchema).default([]),
  animeShows: z.array(lanMediaItemSchema).optional(),
  others: z.array(lanMediaItemSchema).optional(),
  libraryFolders: z.array(z.string()).default([]),
  libraryFolderGroups: libraryFolderGroupsSchema.optional(),
  libraryFolderStatuses: z.array(libraryFolderStatusSchema).optional(),
});

export const desktopLibraryIndexSchema = lanLibraryIndexSchema(lanLibraryCardSchema).extend({
  libraryFolders: z.array(z.string()).optional(),
  libraryFolderGroups: libraryFolderGroupsSchema.optional(),
  libraryFolderStatuses: z.array(libraryFolderStatusSchema).optional(),
});

export const desktopLibraryItemDetailsSchema = lanLibraryItemDetailsSchema(lanMediaItemSchema);
export const desktopActiveProfileSchema = lanActiveProfileSchema;
export const desktopProfilesPayloadSchema = z.object({ profiles: z.array(lanProfileSummarySchema) });
export const desktopProfileSelectionSchema = z.object({
  profile: lanProfileSummarySchema,
  active: lanActiveProfileSchema,
});
export const desktopProfilePreferencesSchema = lanProfilePreferencesSchema;
export const desktopProfileListSchema = z.array(lanProfileListEntrySchema);
export const desktopProgressMapSchema = z.record(z.string(), lanStoredProgressSchema);
export const desktopStoredProgressSchema = lanStoredProgressSchema;
export const desktopProgressResultSchema = z.union([
  desktopProgressMapSchema,
  desktopStoredProgressSchema,
  z.null(),
]);
export const desktopErrorPayloadSchema = lanErrorPayloadSchema;
export const okResultSchema = z.object({ ok: z.boolean() });
export const resourceIdResultSchema = z.object({ resourceId: z.string().min(1) });
export const portResultSchema = z.object({ port: nonNegativeNumber });
export const stringRecordSchema = z.record(z.string(), z.string());

export const stremioCatalogItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  source: z.string().optional(),
  format: z.string().optional(),
  title: z.string(),
  genres: z.array(z.string()),
  artwork: z.object({
    poster: z.string().optional(),
    background: z.string().optional(),
    logo: z.string().optional(),
  }).optional(),
  posterUrl: z.string().optional(),
  backgroundUrl: z.string().optional(),
  logoUrl: z.string().optional(),
  cast: z.array(z.object({
    name: z.string(),
    character: z.string().optional(),
    image: z.string().optional(),
    characterName: z.string().optional(),
    characterRole: z.string().optional(),
    characterImage: z.string().optional(),
    voiceActorName: z.string().optional(),
    voiceActorImage: z.string().optional(),
    voiceActorLanguage: z.string().optional(),
  })).optional(),
  description: z.string().optional(),
  releaseInfo: z.string().optional(),
  released: z.string().optional(),
  rating: finiteNumber.optional(),
  providerRatings: lanProviderRatingsSchema.optional(),
  imdbId: z.string().optional(),
  contentRating: z.string().optional(),
  streamingProviders: z.array(z.object({ id: finiteNumber, name: z.string(), logoUrl: z.string() })).optional(),
  trailerUrl: z.string().optional(),
  runtime: z.string().optional(),
  seasonCount: nonNegativeNumber.optional(),
  episodeCount: nonNegativeNumber.optional(),
});

export const remoteDesktopSessionSchema = z.object({
  baseUrl: z.string().url(),
  deviceId: z.string().min(1),
  deviceToken: z.string(),
  accessTokenExpiresAt: nonNegativeNumber,
  refreshToken: z.string(),
  refreshTokenExpiresAt: nonNegativeNumber,
  hostDeviceId: z.string().optional(),
  hostDeviceName: z.string().optional(),
  library: desktopLibrarySchema,
  libraryEtag: z.string(),
  selectionRevision: nonNegativeNumber.optional(),
  selectedProfileId: z.string().nullable().optional(),
});

export const localNetworkStatusSchema = z.object({
  sharingEnabled: z.boolean(),
  token: z.string(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  networkName: z.string(),
  port: nonNegativeNumber,
  addresses: z.array(z.string()),
  baseUrl: z.string().nullable(),
  libraryUrl: z.string().nullable(),
  pairedDevices: z.array(z.object({
    id: z.string(),
    name: z.string(),
    createdAt: nonNegativeNumber,
    lastSeenAt: nonNegativeNumber,
    lastAddress: z.string().optional(),
  })).optional(),
});

export const settingsPayloadSchema = z.object({
  omdbApiKey: z.string().optional(),
  tmdbApiKey: z.string().optional(),
  metadataApiKeys: z.record(z.string(), z.string()).optional(),
  metadataOfflineMode: z.boolean().optional(),
  openSubtitlesUsername: z.string().optional(),
  openSubtitlesPassword: z.string().optional(),
  openSubtitlesLanguages: z.string().optional(),
  openSubtitlesAutoDownload: z.boolean().optional(),
  autoSyncIntervalHours: finiteNumber.optional(),
  playbackSkipBackSeconds: finiteNumber.optional(),
  playbackSkipForwardSeconds: finiteNumber.optional(),
  playbackDisplaySleepTimeoutMinutes: finiteNumber.optional(),
  localSkipAnalysisEnabled: z.boolean().optional(),
  skipAnalysis: z.object({
    enabled: z.boolean(),
    analyzeNewMedia: z.boolean(),
    enabledTypes: z.record(z.enum(['intro', 'recap', 'outro', 'credits', 'preview']), z.boolean()),
    promptTypes: z.record(z.enum(['intro', 'recap', 'outro', 'credits', 'preview']), z.boolean()),
    durationLimits: z.object({
      intro: z.object({ minSeconds: finiteNumber, maxSeconds: finiteNumber }),
      recap: z.object({ minSeconds: finiteNumber, maxSeconds: finiteNumber }),
      outro: z.object({ minSeconds: finiteNumber, maxSeconds: finiteNumber }),
      credits: z.object({ minSeconds: finiteNumber, maxSeconds: finiteNumber }),
      preview: z.object({ minSeconds: finiteNumber, maxSeconds: finiteNumber }),
      movieCredits: z.object({ minSeconds: finiteNumber, maxSeconds: finiteNumber }),
    }),
    suppressFirstEpisodeIntro: z.boolean(),
    analyzeSpecials: z.boolean(),
    exclusions: z.object({
      seriesIds: z.array(z.string()),
      movieIds: z.array(z.string()),
      seasons: z.array(z.string()),
      paths: z.array(z.string()),
    }),
    seasonOverrides: z.record(z.string(), z.enum(['full', 'chapter-only', 'providers-only'])),
  }).optional(),
  sidebarNavOrder: z.array(z.string()).optional(),
  customFolderNames: z.record(z.string(), z.string()).optional(),
  otherFolderGroups: z.record(z.string(), z.object({
    name: z.string(),
    icon: z.string(),
    folders: z.array(z.string()),
  })).optional(),
  otherFolderIcon: z.string().optional(),
  appThemeMode: z.enum(['dark', 'light']).optional(),
  appThemeColor: z.enum(['orange', 'yellow', 'red', 'blue', 'twitch']).optional(),
  appDarkTheme: z.literal('black').optional(),
  appLoaderStyle: z.enum(['play-mark', 'logo-mark', 'horizontal-logo']).optional(),
  localNetworkSharingEnabled: z.boolean().optional(),
  localNetworkShareToken: z.string().optional(),
});

export const metadataKeyTestResultsSchema = z.array(z.object({
  provider: z.string(),
  ok: z.boolean(),
  message: z.string(),
}));

const codecCapabilitySchema = z.object({
  encoder: z.string(),
  compiled: z.boolean(),
  available: z.boolean(),
  verified: z.boolean(),
  reason: z.string(),
});
const transcodeCodecSchema = z.enum(['h264', 'hevc', 'av1']);
const transcodeBackendSchema = z.enum(['videotoolbox', 'nvenc', 'qsv', 'vaapi', 'amf', 'rkmpp']);
const transcodeCapabilitiesSchema = z.object({
  state: z.enum(['available', 'limited', 'unavailable']),
  ffmpegPath: z.string().nullable(),
  platform: z.string(),
  backends: z.array(z.object({
    id: transcodeBackendSchema,
    label: z.string(),
    hwaccel: z.string(),
    platformSupported: z.boolean(),
    device: z.string().nullable(),
    hwaccelAvailable: z.boolean(),
    available: z.boolean(),
    codecs: z.partialRecord(transcodeCodecSchema, codecCapabilitySchema),
    decode: z.object({ advertised: z.boolean(), available: z.boolean() }),
  })),
  recommendedBackend: z.union([transcodeBackendSchema, z.literal('software')]),
  hardwareAcceleration: z.boolean(),
  softwareFallback: z.literal(true),
  codecs: z.record(transcodeCodecSchema, z.boolean()),
  softwareCodecs: z.record(transcodeCodecSchema, z.boolean()),
  softwareEncoders: z.partialRecord(transcodeCodecSchema, z.string().nullable()),
  toneMapping: z.boolean(),
  probedAt: nonNegativeNumber,
  reason: z.string().optional(),
});
export const ffmpegStatusSchema = z.object({
  available: z.boolean(),
  path: z.string().nullable(),
  capabilities: transcodeCapabilitiesSchema.optional(),
});

export const profileCreateResponseSchema = z.object({
  profile: lanProfileSummarySchema,
  profiles: z.array(lanProfileSummarySchema),
});

const trackPreferenceSchema = z.object({
  enabled: z.boolean(),
  index: finiteNumber.optional(),
  language: z.string().optional(),
  title: z.string().optional(),
  codec: z.string().optional(),
  forced: z.boolean().optional(),
});
export const playbackTrackPreferencesSchema = z.object({
  audio: trackPreferenceSchema.optional(),
  subtitle: trackPreferenceSchema.optional(),
});
export const playbackTrackPreferencesResultSchema = z.union([
  playbackTrackPreferencesSchema,
  z.record(z.string(), playbackTrackPreferencesSchema),
]);

const mediaSegmentSchema = z.object({
  id: z.string(),
  type: z.enum(['intro', 'recap', 'outro', 'credits', 'preview']),
  startMs: finiteNumber,
  endMs: finiteNumber.nullable(),
  confidence: finiteNumber,
  source: z.enum(['manual', 'chapter', 'theintrodb', 'aniskip', 'chromaprint']),
  mediaDurationMs: finiteNumber,
  updatedAt: z.string(),
  analysisMetadata: z.object({
    detector: z.enum(['chromaprint', 'blackframe', 'chapter']).optional(),
    peerSupport: finiteNumber.optional(),
    originalStartMs: finiteNumber.optional(),
    originalEndMs: finiteNumber.nullable().optional(),
    startSnap: z.enum(['chapter', 'silence', 'keyframe', 'media-edge', 'original']).optional(),
    endSnap: z.enum(['chapter', 'silence', 'keyframe', 'media-edge', 'original']).optional(),
    confidenceComponents: z.record(z.string(), finiteNumber).optional(),
    userDecision: z.object({
      status: z.enum(['active', 'rejected']).optional(),
      type: z.enum(['intro', 'recap', 'outro', 'credits', 'preview']).optional(),
    }).optional(),
  }).optional(),
});
export const mediaSegmentResponseSchema = z.object({
  segments: z.array(mediaSegmentSchema),
  revision: z.string(),
});

export const playbackLogoResultSchema = z.object({
  logo: z.string().optional(),
  logoCandidates: z.array(z.string()).optional(),
});

export const officialArtworkResultSchema = z.object({
  format: z.string().optional(),
  thumbnail: z.string().optional(),
  cover: z.string().optional(),
  summary: z.string().optional(),
  rating: finiteNumber.optional(),
  providerRatings: lanProviderRatingsSchema.optional(),
  contentRatings: z.record(z.string(), lanContentRatingSchema).optional(),
  contentRating: z.string().optional(),
  trailerUrl: z.string().optional(),
  runtime: z.string().optional(),
  seasonCount: nonNegativeNumber.optional(),
  episodeCount: nonNegativeNumber.optional(),
  genres: z.array(z.string()).optional(),
  seasons: z.array(z.object({
    number: finiteNumber,
    title: z.string(),
    episodeCount: nonNegativeNumber,
  })).optional(),
  episodes: z.array(lanEpisodeMetaSchema).optional(),
  episodeSource: z.enum(['TMDB', 'OMDb', 'TVmaze', 'TVDB', 'Jikan', 'AniList']).optional(),
  posterCandidates: z.array(z.string()).optional(),
  backdropCandidates: z.array(z.string()).optional(),
  logoCandidates: z.array(z.string()).optional(),
  logo: z.string().optional(),
  cast: z.array(lanCastMemberSchema).optional(),
  streamingProviders: z.array(lanStreamingProviderSchema).optional(),
  originPlatform: lanOriginPlatformSchema.optional(),
});
export const officialMetadataCandidateSchema = officialArtworkResultSchema.extend({
  id: z.string(),
  source: z.enum(['TMDB', 'OMDb', 'TVmaze', 'TVDB', 'Jikan', 'AniList']),
  title: z.string(),
  year: finiteNumber.optional(),
  genres: z.array(z.string()).optional(),
  episodeCount: nonNegativeNumber.optional(),
  episodePreview: z.array(z.string()).optional(),
});

export const backupResultSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  error: z.string().optional(),
});

export const githubReleaseSchema = z.object({
  tag_name: z.string().optional(),
  html_url: z.string().optional(),
});

export const unknownApiResultSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export function apiResultSchema<TSchema extends z.ZodType>(dataSchema: TSchema) {
  return z.object({
    ok: z.boolean(),
    data: dataSchema.optional(),
    error: z.string().optional(),
  });
}

export const transcodeSessionSchema = z.object({
  sessionId: z.string(),
  filePath: z.string(),
  playlistUrl: z.string(),
  outputDir: z.string(),
  seekable: z.boolean(),
  startSeconds: finiteNumber,
  preset: z.enum(['software', 'videotoolbox', 'nvenc', 'qsv', 'vaapi', 'amf', 'rkmpp']).optional(),
  codec: z.enum(['h264', 'hevc', 'av1']).optional(),
});

const playbackCapabilitiesSchema = z.object({
  containers: z.array(z.string()),
  videoCodecs: z.array(z.string()),
  audioCodecs: z.array(z.string()),
  supportsHls: z.boolean(),
  supportsHdr: z.boolean(),
  supportsTextSubtitles: z.boolean(),
  maxWidth: finiteNumber,
  maxHeight: finiteNumber,
  maxVideoBitrateKbps: finiteNumber,
});
const playbackPlanSchema = z.object({
  mode: z.enum(['direct', 'remux', 'direct-stream', 'transcode']),
  reason: z.string(),
  sourceAction: z.enum(['direct', 'transcode']),
  codec: z.string().optional(),
  backend: z.string().optional(),
  facts: z.object({
    container: z.string(),
    videoCodec: z.string(),
    audioCodec: z.string(),
    width: finiteNumber,
    height: finiteNumber,
    bitrate: finiteNumber,
    hdr: z.boolean(),
  }).optional(),
});
const streamOptionsSchema = z.object({
  forceTranscode: z.boolean().optional(),
  startSeconds: finiteNumber.optional(),
  targetVideoCodec: z.enum(['h264', 'hevc', 'av1']).optional(),
  maxWidth: finiteNumber.optional(),
  maxHeight: finiteNumber.optional(),
  videoBitrateKbps: finiteNumber.optional(),
  audioBitrateKbps: finiteNumber.optional(),
  toneMap: z.boolean().optional(),
  preset: z.enum(['auto', 'software', 'videotoolbox', 'nvenc', 'qsv', 'vaapi', 'amf', 'rkmpp']).optional(),
  audioTrackIndex: finiteNumber.optional(),
  subtitleTrackIndex: finiteNumber.optional(),
  subtitleStreamOrdinal: finiteNumber.optional(),
  subtitleCodec: z.string().optional(),
  subtitleFilePath: z.string().optional(),
  subtitleStyle: z.object({ fontSize: finiteNumber.optional() }).optional(),
});
export const playbackPlanResultSchema = apiResultSchema(z.object({
  mediaCoreContractVersion: finiteNumber,
  capabilities: playbackCapabilitiesSchema,
  plan: playbackPlanSchema,
  recommendedOptions: streamOptionsSchema.optional(),
}));

export const refreshedCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  deviceToken: z.string().min(1).optional(),
  accessTokenExpiresAt: nonNegativeNumber,
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: nonNegativeNumber,
});

export const browserPairResponseSchema = z.object({
  deviceId: z.string().min(1),
  accessToken: z.string().min(1),
  accessTokenExpiresAt: nonNegativeNumber,
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: nonNegativeNumber,
  hostDeviceId: z.string().optional(),
  hostDeviceName: z.string().optional(),
  library: desktopLibrarySchema.optional(),
  libraryEtag: z.string().optional(),
});

export async function readJsonResponse<TSchema extends z.ZodType>(
  response: Response,
  schema: TSchema,
  context: string,
): Promise<z.output<TSchema>> {
  const text = await response.text();
  if (!text.trim()) throw new Error(`${context} returned an empty response.`);
  return parseJsonResponse(text, schema, context);
}

export async function readErrorResponse(response: Response, context: string) {
  const text = await response.text();
  if (!text.trim()) return {};
  return parseJsonResponse(text, desktopErrorPayloadSchema, context);
}

export function parseStoredValue<TSchema extends z.ZodType>(
  value: string | null | undefined,
  schema: TSchema,
  fallback: z.output<TSchema>,
): z.output<TSchema> {
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}
