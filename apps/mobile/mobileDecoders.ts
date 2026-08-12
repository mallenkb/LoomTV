import {
  lanActiveProfileSchema,
  lanErrorPayloadSchema,
  lanLibraryCardSchema,
  lanLibraryIndexSchema,
  lanLibraryItemDetailsSchema,
  lanLibraryPayloadSchema,
  lanMediaItemSchema,
  lanPairApprovalRequestSchema,
  lanPairResponseSchema,
  lanProviderRatingsSchema,
  lanProfileListEntrySchema,
  lanProfilePreferencesSchema,
  lanProfileSummarySchema,
  lanStoredProgressSchema,
  parseJsonResponse,
} from '@loom-media-server/lan-protocol';
import { z } from 'zod';

const finiteTimestamp = z.number().finite().nonnegative();

export const mobileLibrarySchema = lanLibraryPayloadSchema(lanMediaItemSchema);
export const mobileLibraryIndexSchema = lanLibraryIndexSchema(lanLibraryCardSchema);
export const mobileLibraryItemDetailsSchema = lanLibraryItemDetailsSchema(lanMediaItemSchema);
export const mobilePairResponseSchema = lanPairResponseSchema(mobileLibrarySchema);
export const mobilePairApprovalRequestSchema = lanPairApprovalRequestSchema;
export const mobileErrorPayloadSchema = lanErrorPayloadSchema;
export const mobileStoredProgressSchema = lanStoredProgressSchema;
export const mobileProgressMapSchema = z.record(z.string(), lanStoredProgressSchema);
export const mobileProfileSchema = lanProfileSummarySchema;
export const mobileProfilesPayloadSchema = z.object({ profiles: z.array(lanProfileSummarySchema) });
export const mobileActiveProfileSchema = lanActiveProfileSchema;
export const mobileProfilePreferencesSchema = lanProfilePreferencesSchema;
export const mobileProfileListSchema = z.array(lanProfileListEntrySchema);
export const mobileProfileSelectionSchema = z.object({
  profile: lanProfileSummarySchema,
  active: lanActiveProfileSchema,
});

export const savedConnectionSchema = z.object({
  baseUrl: z.string().url(),
  deviceId: z.string().min(1),
  deviceToken: z.string().min(1),
  accessTokenExpiresAt: finiteTimestamp,
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: finiteTimestamp,
  certFingerprint: z.string(),
  hostDeviceId: z.string().min(1),
  hostDeviceName: z.string(),
  clientDeviceName: z.string(),
});

export const refreshedCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: finiteTimestamp,
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: finiteTimestamp,
});

const officialArtworkSchema = z.object({
  thumbnail: z.string().optional(),
  cover: z.string().optional(),
  summary: z.string().optional(),
  rating: z.number().finite().optional(),
  providerRatings: lanProviderRatingsSchema.optional(),
  genres: z.array(z.string()).optional(),
  episodes: z.array(z.unknown()).optional(),
  episodeSource: z.enum(['TMDB', 'OMDb', 'TVmaze', 'Jikan']).optional(),
  posterCandidates: z.array(z.string()).optional(),
  backdropCandidates: z.array(z.string()).optional(),
  logo: z.string().optional(),
  logoCandidates: z.array(z.string()).optional(),
  error: z.string().optional(),
});

export const officialArtworkResponseSchema = officialArtworkSchema;
export const officialMetadataCandidateSchema = officialArtworkSchema.extend({
  id: z.string().optional(),
  source: z.enum(['TMDB', 'OMDb', 'TVmaze', 'Jikan']).optional(),
  title: z.string().optional(),
  year: z.number().finite().optional(),
  episodeCount: z.number().finite().nonnegative().optional(),
});
export const officialMetadataCandidatesSchema = z.array(officialMetadataCandidateSchema);

export const hlsSessionResultSchema = z.object({
  ok: z.boolean(),
  data: z.object({ playlistUrl: z.string() }).optional(),
  code: z.string().optional(),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
});

export const mediaSegmentsPayloadSchema = z.object({
  segments: z.array(z.object({
    id: z.string(),
    type: z.enum(['intro', 'recap', 'outro', 'credits', 'preview']),
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().nonnegative().nullable(),
    confidence: z.number().finite(),
    source: z.enum(['manual', 'chapter', 'theintrodb', 'aniskip', 'chromaprint']),
    mediaDurationMs: z.number().finite().nonnegative(),
    updatedAt: z.string(),
  })).optional(),
});

const trackPreferenceSchema = z.object({
  enabled: z.boolean(),
  index: z.number().finite().optional(),
  language: z.string().optional(),
  title: z.string().optional(),
  codec: z.string().optional(),
  forced: z.boolean().optional(),
});

export const playbackTrackPreferencesSchema = z.object({
  audio: trackPreferenceSchema.optional(),
  subtitle: trackPreferenceSchema.optional(),
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
  return parseJsonResponse(text, mobileErrorPayloadSchema, context);
}
