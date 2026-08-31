import {
  lanArtworkApplyRequestSchema,
  lanArtworkCandidatesRequestSchema,
  lanAutomaticSignInRequestSchema,
  lanPlaybackPlanRequestSchema,
  lanPlaybackTrackPreferencesSaveRequestSchema,
  lanProfileCreateRequestSchema,
  lanProfileListMutationRequestSchema,
  lanProfilePreferencesRequestSchema,
  lanProfileSelectRequestSchema,
  lanProgressSaveRequestSchema,
  lanStartHlsRequestSchema,
  lanUnpairRequestSchema,
} from '@loom-media-server/lan-protocol';
import { z } from 'zod';
import { rendererSettingsPatchSchema } from './rendererSettings.ts';
import { metadataProviderRequestSchema } from './metadataProviderGateway.ts';

const finiteNumber = z.number().finite();
const nonEmptyString = z.string().trim().min(1);
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
  videoTrackIndex: finiteNumber.int().nonnegative().optional(),
  audioTrackIndex: finiteNumber.int().optional(),
  subtitleTrackIndex: finiteNumber.int().optional(),
  subtitleStreamOrdinal: finiteNumber.int().optional(),
  subtitleCodec: z.string().optional(),
  subtitleFilePath: z.string().optional(),
  secondarySubtitleTrackIndex: finiteNumber.int().optional(),
  secondarySubtitleStreamOrdinal: finiteNumber.int().optional(),
  secondarySubtitleCodec: z.string().optional(),
  secondarySubtitleFilePath: z.string().optional(),
  subtitleStyle: z.record(z.string(), z.union([z.string(), finiteNumber, z.boolean()])).optional(),
  forceTranscode: z.boolean().optional(),
});
const iptvSourceIdSchema = nonEmptyString.max(120);
const iptvSourceIconSchema = z.enum([
  'general', 'entertainment', 'news', 'sports', 'movies', 'series', 'music', 'kids',
  'documentary', 'education', 'lifestyle', 'travel', 'cooking', 'science', 'religious', 'weather',
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

type OperationDefinition<TSchema extends z.ZodType> = {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  owner: 'catalog' | 'profiles' | 'playback' | 'artwork' | 'media' | 'metadata' | 'settings';
  scope: 'device:self' | 'catalog:read' | 'playback:write' | 'media:stream' | 'desktop';
  requestSchema: TSchema;
};

const operation = <const TSchema extends z.ZodType>(definition: OperationDefinition<TSchema>) => definition;

export const httpOperations = {
  lanUnpair: operation({ method: 'POST', path: '/api/v2/unpair', owner: 'profiles', scope: 'device:self', requestSchema: lanUnpairRequestSchema }),
  lanPlaybackPlan: operation({ method: 'POST', path: '/api/v2/playback-plan', owner: 'playback', scope: 'media:stream', requestSchema: lanPlaybackPlanRequestSchema }),
  lanStartHls: operation({ method: 'POST', path: '/api/v2/start-hls', owner: 'playback', scope: 'media:stream', requestSchema: lanStartHlsRequestSchema }),
  rendererSettingsSave: operation({ method: 'POST', path: '/api/renderer/settings', owner: 'settings', scope: 'desktop', requestSchema: rendererSettingsPatchSchema }),
  rendererIptvAdd: operation({ method: 'POST', path: '/api/renderer/iptv/sources', owner: 'settings', scope: 'desktop', requestSchema: iptvSourceInputSchema }),
  rendererIptvUpdate: operation({ method: 'PATCH', path: '/api/renderer/iptv/sources', owner: 'settings', scope: 'desktop', requestSchema: z.object({ sourceId: iptvSourceIdSchema, patch: iptvSourcePatchSchema }) }),
  rendererIptvRemove: operation({ method: 'DELETE', path: '/api/renderer/iptv/sources', owner: 'settings', scope: 'desktop', requestSchema: z.object({ sourceId: iptvSourceIdSchema }) }),
  rendererIptvRefresh: operation({ method: 'POST', path: '/api/renderer/iptv/sources/refresh', owner: 'settings', scope: 'desktop', requestSchema: z.object({ sourceId: iptvSourceIdSchema }) }),
  rendererIptvChannels: operation({ method: 'POST', path: '/api/renderer/iptv/channels', owner: 'catalog', scope: 'desktop', requestSchema: iptvChannelRequestSchema }),
  rendererMediaProbe: operation({ method: 'POST', path: '/api/renderer/media/probe', owner: 'media', scope: 'desktop', requestSchema: z.object({ filePath: nonEmptyString }) }),
  rendererSubtitleResource: operation({ method: 'POST', path: '/api/renderer/media/subtitle-resource', owner: 'media', scope: 'desktop', requestSchema: z.object({ mediaFilePath: nonEmptyString, subtitleFilePath: nonEmptyString }) }),
  rendererStartTranscode: operation({ method: 'POST', path: '/api/renderer/media/start-transcode', owner: 'media', scope: 'desktop', requestSchema: z.object({ filePath: nonEmptyString, options: transcodeOptionsSchema.optional() }) }),
  rendererStopTranscode: operation({ method: 'POST', path: '/api/renderer/media/stop-transcode', owner: 'media', scope: 'desktop', requestSchema: z.object({ sessionId: nonEmptyString }) }),
  rendererMetadataProvider: operation({ method: 'POST', path: '/api/renderer/metadata/provider', owner: 'metadata', scope: 'desktop', requestSchema: metadataProviderRequestSchema }),
  rendererMetadataRefreshIncomplete: operation({ method: 'POST', path: '/api/renderer/metadata/refresh-incomplete', owner: 'metadata', scope: 'desktop', requestSchema: z.object({ mediaId: nonEmptyString.max(512) }) }),
  rendererArtworkSave: operation({ method: 'POST', path: '/api/renderer/artwork', owner: 'artwork', scope: 'desktop', requestSchema: z.object({ mediaId: nonEmptyString.max(512), target: z.enum(['thumbnail', 'poster', 'cover', 'logo']), dataUrl: z.string().max(25 * 1024 * 1024) }) }),
  rendererArtworkCandidates: operation({ method: 'POST', path: '/api/renderer/artwork/official-candidates', owner: 'artwork', scope: 'desktop', requestSchema: z.object({ mediaId: nonEmptyString.max(512) }) }),
  rendererArtworkApply: operation({ method: 'POST', path: '/api/renderer/artwork/apply-official', owner: 'artwork', scope: 'desktop', requestSchema: z.object({
    mediaId: nonEmptyString.max(512),
    candidate: z.object({
      id: nonEmptyString.max(512),
      thumbnail: z.string().max(4096).optional(),
      cover: z.string().max(4096).optional(),
      logo: z.string().max(4096).optional(),
      logoCandidates: z.array(z.string().max(4096)).optional(),
    }),
    target: z.enum(['all', 'poster', 'cover', 'logo', 'episodes']).optional(),
  }) }),
  lanProfileCreate: operation({ method: 'POST', path: '/api/v2/profiles', owner: 'profiles', scope: 'playback:write', requestSchema: lanProfileCreateRequestSchema }),
  lanProfileSelect: operation({ method: 'POST', path: '/api/v2/profiles/select', owner: 'profiles', scope: 'catalog:read', requestSchema: lanProfileSelectRequestSchema }),
  lanAutomaticSignIn: operation({ method: 'POST', path: '/api/v2/profiles/auto-sign-in', owner: 'profiles', scope: 'catalog:read', requestSchema: lanAutomaticSignInRequestSchema }),
  lanProfilePreferences: operation({ method: 'PATCH', path: '/api/v2/profile-preferences', owner: 'profiles', scope: 'playback:write', requestSchema: lanProfilePreferencesRequestSchema }),
  lanProfileListMutation: operation({ method: 'PUT', path: '/api/v2/profile-lists', owner: 'profiles', scope: 'playback:write', requestSchema: lanProfileListMutationRequestSchema }),
  lanArtworkCandidates: operation({ method: 'POST', path: '/api/v2/artwork/official-candidates', owner: 'artwork', scope: 'catalog:read', requestSchema: lanArtworkCandidatesRequestSchema }),
  lanArtworkApply: operation({ method: 'POST', path: '/api/v2/artwork/apply-official', owner: 'artwork', scope: 'catalog:read', requestSchema: lanArtworkApplyRequestSchema }),
  lanProgressSave: operation({ method: 'POST', path: '/api/v2/progress', owner: 'playback', scope: 'playback:write', requestSchema: lanProgressSaveRequestSchema }),
  lanTrackPreferencesSave: operation({ method: 'POST', path: '/api/v2/playback-track-preferences', owner: 'playback', scope: 'playback:write', requestSchema: lanPlaybackTrackPreferencesSaveRequestSchema }),
} as const;

export type HttpOperationName = keyof typeof httpOperations;

const parser = <TSchema extends z.ZodType>(schema: TSchema) => (
  body: unknown,
): z.output<TSchema> => schema.parse(body);

export const httpBodyParsers = {
  lanUnpair: parser(httpOperations.lanUnpair.requestSchema),
  lanPlaybackPlan: parser(httpOperations.lanPlaybackPlan.requestSchema),
  lanStartHls: parser(httpOperations.lanStartHls.requestSchema),
  rendererSettingsSave: parser(httpOperations.rendererSettingsSave.requestSchema),
  rendererIptvAdd: parser(httpOperations.rendererIptvAdd.requestSchema),
  rendererIptvUpdate: parser(httpOperations.rendererIptvUpdate.requestSchema),
  rendererIptvRemove: parser(httpOperations.rendererIptvRemove.requestSchema),
  rendererIptvRefresh: parser(httpOperations.rendererIptvRefresh.requestSchema),
  rendererIptvChannels: parser(httpOperations.rendererIptvChannels.requestSchema),
  rendererMediaProbe: parser(httpOperations.rendererMediaProbe.requestSchema),
  rendererSubtitleResource: parser(httpOperations.rendererSubtitleResource.requestSchema),
  rendererStartTranscode: parser(httpOperations.rendererStartTranscode.requestSchema),
  rendererStopTranscode: parser(httpOperations.rendererStopTranscode.requestSchema),
  rendererMetadataProvider: parser(httpOperations.rendererMetadataProvider.requestSchema),
  rendererMetadataRefreshIncomplete: parser(httpOperations.rendererMetadataRefreshIncomplete.requestSchema),
  rendererArtworkSave: parser(httpOperations.rendererArtworkSave.requestSchema),
  rendererArtworkCandidates: parser(httpOperations.rendererArtworkCandidates.requestSchema),
  rendererArtworkApply: parser(httpOperations.rendererArtworkApply.requestSchema),
  lanProfileCreate: parser(httpOperations.lanProfileCreate.requestSchema),
  lanProfileSelect: parser(httpOperations.lanProfileSelect.requestSchema),
  lanAutomaticSignIn: parser(httpOperations.lanAutomaticSignIn.requestSchema),
  lanProfilePreferences: parser(httpOperations.lanProfilePreferences.requestSchema),
  lanProfileListMutation: parser(httpOperations.lanProfileListMutation.requestSchema),
  lanArtworkCandidates: parser(httpOperations.lanArtworkCandidates.requestSchema),
  lanArtworkApply: parser(httpOperations.lanArtworkApply.requestSchema),
  lanProgressSave: parser(httpOperations.lanProgressSave.requestSchema),
  lanTrackPreferencesSave: parser(httpOperations.lanTrackPreferencesSave.requestSchema),
} as const;

export function httpOperationFor(path: string, method: string) {
  return Object.values(httpOperations).find((definition) => (
    definition.path === path
    && (definition.method === method || (path === '/api/v2/profile-lists' && method === 'DELETE'))
  ));
}
