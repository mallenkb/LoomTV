import { z } from 'zod';

const finiteNumber = z.number().finite();
const nonNegativeNumber = finiteNumber.nonnegative();
const nonEmptyString = z.string().trim().min(1);

export const lanContentRatingSchema = z.object({
  code: nonEmptyString,
  minimumAge: nonNegativeNumber,
  source: z.enum(['tmdb', 'omdb', 'jikan']),
});

const ratingOutOfTenSchema = z.object({
  value: nonNegativeNumber.max(10),
  scale: z.literal(10),
  votes: nonNegativeNumber.optional(),
});

const ratingOutOfOneHundredSchema = z.object({
  value: nonNegativeNumber.max(100),
  scale: z.literal(100),
});

export const lanProviderRatingsSchema = z.object({
  imdb: ratingOutOfTenSchema.optional(),
  rottenTomatoes: ratingOutOfOneHundredSchema.optional(),
  popcornmeter: ratingOutOfOneHundredSchema.optional(),
  metacritic: ratingOutOfOneHundredSchema.optional(),
});

export const lanStreamingProviderSchema = z.object({
  id: finiteNumber,
  name: nonEmptyString,
  logoUrl: z.string(),
  regions: z.array(z.string()).optional(),
  offerTypes: z.array(z.enum(['subscription', 'ads', 'free', 'rent', 'buy'])).optional(),
  availability: z.enum(['preferred-region', 'other-region']).optional(),
  source: z.literal('tmdb').optional(),
});

export const lanOriginPlatformSchema = z.object({
  id: finiteNumber.optional(),
  name: nonEmptyString,
  kind: z.enum(['network', 'web-channel']),
  countryCode: z.string().optional(),
  countryName: z.string().optional(),
  officialSite: z.string().optional(),
  logoUrl: z.string().optional(),
  source: z.literal('tvmaze'),
});

export const lanLocalMediaTrackSchema = z.object({
  index: finiteNumber,
  type: z.enum(['video', 'audio', 'subtitle', 'data', 'unknown']),
  codec: z.string().optional(),
  language: z.string().optional(),
  title: z.string().optional(),
  channels: finiteNumber.optional(),
  width: nonNegativeNumber.optional(),
  height: nonNegativeNumber.optional(),
  profile: z.string().optional(),
  pixelFormat: z.string().optional(),
  colorTransfer: z.string().optional(),
  colorPrimaries: z.string().optional(),
  colorSpace: z.string().optional(),
  default: z.boolean().optional(),
  forced: z.boolean().optional(),
});

export const lanLocalMediaDetailsSchema = z.object({
  fileSize: nonNegativeNumber.optional(),
  modifiedAtMs: nonNegativeNumber.optional(),
  durationSeconds: nonNegativeNumber.optional(),
  width: nonNegativeNumber.optional(),
  height: nonNegativeNumber.optional(),
  videoCodec: z.string().optional(),
  videoProfile: z.string().optional(),
  pixelFormat: z.string().optional(),
  colorTransfer: z.string().optional(),
  colorPrimaries: z.string().optional(),
  colorSpace: z.string().optional(),
  audioCodec: z.string().optional(),
  audioTracks: nonNegativeNumber.optional(),
  subtitleTracks: nonNegativeNumber.optional(),
  tracks: z.array(lanLocalMediaTrackSchema).optional(),
  bitrateKbps: nonNegativeNumber.optional(),
  container: z.string().optional(),
  chapters: z.array(z.object({
    startMs: nonNegativeNumber,
    endMs: nonNegativeNumber,
    title: z.string(),
  })).optional(),
});

export const lanSubtitleRecordSchema = z.object({
  lang: z.string(),
  label: z.string(),
  url: z.string(),
  source: z.enum(['sidecar', 'opensubtitles']).optional(),
  format: z.string().optional(),
});

export const lanEpisodeMetaSchema = z.object({
  season: finiteNumber,
  number: finiteNumber,
  title: z.string(),
  summary: z.string(),
  still: z.string(),
  rating: finiteNumber,
  contentRatings: z.record(z.string(), lanContentRatingSchema).optional(),
  airDate: z.string(),
  localMetadata: lanLocalMediaDetailsSchema.optional(),
});

export const lanEpisodeFileSchema = z.object({
  season: finiteNumber,
  episode: finiteNumber,
  filePath: z.string(),
  title: z.string().optional(),
  thumbnail: z.string().optional(),
  still: z.string().optional(),
  subtitles: z.array(lanSubtitleRecordSchema).optional(),
  localMetadata: lanLocalMediaDetailsSchema.optional(),
});

export const lanCastMemberSchema = z.object({
  name: z.string(),
  character: z.string(),
  image: z.string(),
  characterName: z.string().optional(),
  characterRole: z.string().optional(),
  characterImage: z.string().optional(),
  voiceActorName: z.string().optional(),
  voiceActorImage: z.string().optional(),
  voiceActorLanguage: z.string().optional(),
});

export const lanMediaItemSchema = z.object({
  id: nonEmptyString,
  type: z.enum(['movie', 'tv', 'anime']),
  format: z.string().optional(),
  title: z.string(),
  year: finiteNumber,
  poster: z.string(),
  backdrop: z.string(),
  logo: z.string().optional(),
  posterCandidates: z.array(z.string()).optional(),
  backdropCandidates: z.array(z.string()).optional(),
  logoCandidates: z.array(z.string()).optional(),
  summary: z.string(),
  rating: finiteNumber,
  providerRatings: lanProviderRatingsSchema.optional(),
  contentRatings: z.record(z.string(), lanContentRatingSchema).optional(),
  contentRating: z.string().optional(),
  streamingProviders: z.array(lanStreamingProviderSchema).optional(),
  originPlatform: lanOriginPlatformSchema.optional(),
  trailerUrl: z.string().optional(),
  runtime: z.string().optional(),
  seasonCount: nonNegativeNumber.optional(),
  episodeCount: nonNegativeNumber.optional(),
  genres: z.array(z.string()),
  cast: z.array(lanCastMemberSchema),
  filePath: z.string(),
  fileSize: nonNegativeNumber.optional(),
  lastPlayed: nonNegativeNumber.optional(),
  seasons: z.array(z.object({
    number: finiteNumber,
    title: z.string(),
    episodeCount: nonNegativeNumber,
  })).optional(),
  episodes: z.array(lanEpisodeMetaSchema).optional(),
  episodeFiles: z.array(lanEpisodeFileSchema).optional(),
  subtitles: z.array(lanSubtitleRecordSchema).optional(),
  localMetadata: lanLocalMediaDetailsSchema.optional(),
  providerIds: z.object({
    tmdbId: z.string().optional(),
    imdbId: z.string().optional(),
    tvdbId: z.string().optional(),
    tvmazeId: z.string().optional(),
    malId: z.string().optional(),
    malIdBySeason: z.record(z.string(), z.string()).optional(),
  }).optional(),
});

export type LanContentRating = z.output<typeof lanContentRatingSchema>;
export type LanProviderRatings = z.output<typeof lanProviderRatingsSchema>;
export type LanStreamingProvider = z.output<typeof lanStreamingProviderSchema>;
export type LanOriginPlatform = z.output<typeof lanOriginPlatformSchema>;
export type LanLocalMediaTrack = z.output<typeof lanLocalMediaTrackSchema>;
export type LanLocalMediaDetails = z.output<typeof lanLocalMediaDetailsSchema>;
export type LanSubtitleRecord = z.output<typeof lanSubtitleRecordSchema>;
export type LanEpisodeMeta = z.output<typeof lanEpisodeMetaSchema>;
export type LanEpisodeFile = z.output<typeof lanEpisodeFileSchema>;
export type LanCastMember = z.output<typeof lanCastMemberSchema>;
export type LanMediaItem = z.output<typeof lanMediaItemSchema>;

export const lanLibraryCardSchema = z.object({
  id: nonEmptyString,
  type: z.enum(['movie', 'tv', 'anime']),
  format: z.string().optional(),
  title: z.string(),
  year: finiteNumber.optional(),
  poster: z.string(),
  backdrop: z.string(),
  logo: z.string().optional(),
  posterCandidates: z.array(z.string()).optional(),
  backdropCandidates: z.array(z.string()).optional(),
  logoCandidates: z.array(z.string()).optional(),
  summary: z.string(),
  rating: finiteNumber,
  providerRatings: lanProviderRatingsSchema.optional(),
  contentRatings: z.record(z.string(), lanContentRatingSchema).optional(),
  contentRating: z.string().optional(),
  streamingProviders: z.array(lanStreamingProviderSchema).optional(),
  originPlatform: lanOriginPlatformSchema.optional(),
  trailerUrl: z.string().optional(),
  runtime: z.string().optional(),
  seasonCount: nonNegativeNumber.optional(),
  episodeCount: nonNegativeNumber.optional(),
  genres: z.array(z.string()),
  lastPlayed: nonNegativeNumber.optional(),
  seasons: z.array(z.object({ number: finiteNumber, title: z.string(), episodeCount: nonNegativeNumber })).optional(),
  playbackReferences: z.array(z.object({
    progressKey: z.string(),
    season: finiteNumber.optional(),
    episode: finiteNumber.optional(),
    durationSeconds: nonNegativeNumber.optional(),
  })),
});

export function lanLibraryPayloadSchema<TItem extends z.ZodType>(itemSchema: TItem) {
  return z.object({
    movies: z.array(itemSchema).optional(),
    tvShows: z.array(itemSchema).optional(),
    animeShows: z.array(itemSchema).optional(),
    others: z.array(itemSchema).optional(),
  });
}

export function lanLibraryIndexSchema<TCard extends z.ZodType>(cardSchema: TCard) {
  return z.object({
    catalogVersion: z.literal(1),
    revision: nonNegativeNumber,
    movies: z.array(cardSchema),
    tvShows: z.array(cardSchema),
    animeShows: z.array(cardSchema),
    others: z.array(cardSchema).optional(),
  });
}

export function lanLibraryItemDetailsSchema<TItem extends z.ZodType>(itemSchema: TItem) {
  return z.object({
    catalogVersion: z.literal(1),
    revision: nonNegativeNumber,
    item: itemSchema,
  });
}

export const lanPairApprovalRequestSchema = z.object({
  requestId: nonEmptyString,
  requestSecret: nonEmptyString,
  expiresAt: nonNegativeNumber,
  status: z.literal('pending'),
});

export const lanPairApprovalStatusSchema = z.object({
  status: z.enum(['pending', 'denied', 'expired']),
  expiresAt: nonNegativeNumber.optional(),
});

export function lanPairResponseSchema<TLibrary extends z.ZodType>(librarySchema: TLibrary) {
  return z.object({
    deviceId: nonEmptyString,
    accessToken: nonEmptyString,
    accessTokenExpiresAt: nonNegativeNumber,
    refreshToken: nonEmptyString,
    refreshTokenExpiresAt: nonNegativeNumber,
    certFingerprint: nonEmptyString,
    hostDeviceId: z.string().optional(),
    hostDeviceName: z.string().optional(),
    library: librarySchema,
    libraryEtag: z.string(),
  });
}

export const lanStoredProgressSchema = z.object({
  position: nonNegativeNumber,
  duration: nonNegativeNumber,
  updatedAt: nonNegativeNumber,
  watched: z.boolean(),
});

export const lanProfileSummarySchema = z.object({
  id: nonEmptyString,
  name: z.string(),
  avatarKey: z.string(),
  colorKey: z.string(),
  type: z.enum(['owner', 'standard', 'kid', 'guest']),
  hasPin: z.boolean(),
  isGuest: z.boolean(),
  sortOrder: finiteNumber,
  lastUsedAt: nonNegativeNumber.optional(),
});

export const lanActiveProfileSchema = z.object({
  profileId: z.string().nullable(),
  selectionRequired: z.boolean(),
  selectionRevision: nonNegativeNumber,
  automaticSignIn: z.boolean(),
});

export const lanProfilePreferencesSchema = z.object({
  appThemeMode: z.enum(['dark', 'light']).optional(),
  appThemeColor: z.enum(['orange', 'yellow', 'red', 'blue', 'twitch']).optional(),
  appDarkTheme: z.literal('black').optional(),
  appLoaderStyle: z.enum(['play-mark', 'logo-mark', 'horizontal-logo']).optional(),
  appHomeStyle: z.enum(['default', 'modern']).optional(),
  appModernHeroMode: z.enum(['continue-watching', 'featured']).optional(),
  showProviderRatingBadges: z.boolean().optional(),
  sidebarNavOrder: z.array(z.string()).optional(),
  autoplayNextEnabled: z.boolean().optional(),
  playbackSkipBackSeconds: nonNegativeNumber.optional(),
  playbackSkipForwardSeconds: nonNegativeNumber.optional(),
});

export const lanProfileListEntrySchema = z.object({
  mediaId: nonEmptyString,
  kind: z.enum(['watchlist', 'favorite', 'watched']),
  createdAt: nonNegativeNumber,
});

const selectionRevisionSchema = nonNegativeNumber.int().optional();

export const lanPlaybackCapabilitiesSchema = z.object({
  containers: z.array(z.string()).optional(),
  videoCodecs: z.array(z.string()).optional(),
  audioCodecs: z.array(z.string()).optional(),
  supportsHls: z.boolean().optional(),
  supportsHdr: z.boolean().optional(),
  supportsTextSubtitles: z.boolean().optional(),
  maxWidth: nonNegativeNumber.optional(),
  maxHeight: nonNegativeNumber.optional(),
  maxVideoBitrateKbps: nonNegativeNumber.optional(),
});

export const lanStreamOptionsSchema = z.object({
  forceTranscode: z.boolean().optional(),
  startSeconds: nonNegativeNumber.optional(),
  targetVideoCodec: z.enum(['h264', 'hevc', 'av1']).optional(),
  maxWidth: nonNegativeNumber.optional(),
  maxHeight: nonNegativeNumber.optional(),
  videoBitrateKbps: nonNegativeNumber.optional(),
  audioBitrateKbps: nonNegativeNumber.optional(),
  toneMap: z.boolean().optional(),
  preset: z.enum(['auto', 'software', 'videotoolbox', 'nvenc', 'qsv', 'vaapi', 'amf', 'rkmpp']).optional(),
  audioTrackIndex: finiteNumber.int().optional(),
  subtitleTrackIndex: finiteNumber.int().optional(),
  subtitleStreamOrdinal: finiteNumber.int().optional(),
  subtitleCodec: z.string().optional(),
  subtitleFilePath: z.string().optional(),
  subtitleStyle: z.object({ fontSize: finiteNumber.positive().optional() }).optional(),
});

export const lanUnpairRequestSchema = z.object({}).strict();
export const lanPlaybackPlanRequestSchema = z.object({
  mediaId: nonEmptyString.max(512),
  capabilities: lanPlaybackCapabilitiesSchema.optional(),
  selectionRevision: selectionRevisionSchema,
});
export const lanStartHlsRequestSchema = z.object({
  mediaId: nonEmptyString.max(512),
  options: lanStreamOptionsSchema.optional(),
  selectionRevision: selectionRevisionSchema,
});
export const lanProfileCreateRequestSchema = z.object({
  name: nonEmptyString.max(120),
  avatarKey: z.string().max(120).optional(),
  colorKey: z.string().max(120).optional(),
  type: z.enum(['standard', 'kid']).default('standard'),
});
export const lanProfileSelectRequestSchema = z.object({
  profileId: nonEmptyString.max(240),
  pin: z.string().max(64).optional(),
});
export const lanAutomaticSignInRequestSchema = z.object({ enabled: z.boolean() });
export const lanProfilePreferencesRequestSchema = lanProfilePreferencesSchema.extend({
  selectionRevision: selectionRevisionSchema,
});
export const lanProfileListMutationRequestSchema = z.object({
  selectionRevision: selectionRevisionSchema,
  kind: z.enum(['watchlist', 'favorite', 'watched']),
  mediaId: nonEmptyString.max(512),
});
export const lanArtworkCandidatesRequestSchema = z.object({
  selectionRevision: selectionRevisionSchema,
  mediaId: nonEmptyString.max(512),
});
export const lanArtworkApplyRequestSchema = lanArtworkCandidatesRequestSchema.extend({
  candidate: z.object({ id: nonEmptyString.max(512) }),
  target: z.enum(['all', 'poster', 'cover', 'episodes']).optional(),
});
export const lanProgressSaveRequestSchema = z.object({
  selectionRevision: selectionRevisionSchema,
  mediaId: nonEmptyString.max(512),
  position: nonNegativeNumber,
  duration: nonNegativeNumber,
});
export const lanTrackPreferenceSchema = z.object({
  enabled: z.boolean(),
  index: finiteNumber.int().optional(),
  language: z.string().optional(),
  title: z.string().optional(),
  codec: z.string().optional(),
  forced: z.boolean().optional(),
});
export const lanPlaybackTrackPreferencesSaveRequestSchema = z.object({
  selectionRevision: selectionRevisionSchema,
  scope: nonEmptyString.max(512),
  preferences: z.object({
    audio: lanTrackPreferenceSchema.optional(),
    subtitle: lanTrackPreferenceSchema.optional(),
  }),
});

export type LanPlaybackPlanRequestPayload = z.output<typeof lanPlaybackPlanRequestSchema>;
export type LanStartHlsRequestPayload = z.output<typeof lanStartHlsRequestSchema>;
export type LanProfileCreateRequest = z.output<typeof lanProfileCreateRequestSchema>;
export type LanProfileSelectRequest = z.output<typeof lanProfileSelectRequestSchema>;
export type LanProgressSaveRequest = z.output<typeof lanProgressSaveRequestSchema>;

export const lanErrorPayloadSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  status: z.string().optional(),
  retryAfterMs: nonNegativeNumber.optional(),
});

export function parseJsonResponse<TSchema extends z.ZodType>(
  text: string,
  schema: TSchema,
  context: string,
): z.output<TSchema> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON.`, { cause: error });
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${context} returned an invalid payload.`, { cause: result.error });
  }
  return result.data;
}
