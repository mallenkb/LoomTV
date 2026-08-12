import { z } from 'zod';
import {
  lanProfileListEntrySchema,
  lanProfilePreferencesSchema,
  lanStoredProgressSchema,
} from '@loom-media-server/lan-protocol';
import type { ProfileExportV1 } from '../shared/desktopProtocol.ts';

export const unknownRecordSchema = z.record(z.string(), z.unknown());

const trackPreferenceSchema = z.object({
  enabled: z.boolean(),
  index: z.number().finite().optional(),
  language: z.string().optional(),
  title: z.string().optional(),
  codec: z.string().optional(),
  forced: z.boolean().optional(),
});
const playbackTrackPreferencesSchema = z.object({
  audio: trackPreferenceSchema.optional(),
  subtitle: trackPreferenceSchema.optional(),
});

export const profileExportSchema = z.object({
  format: z.literal('loomtv.profile.v1'),
  exportedAt: z.number().finite().nonnegative(),
  profile: z.object({
    name: z.string(),
    avatarKey: z.string(),
    colorKey: z.string(),
    type: z.enum(['owner', 'standard', 'kid', 'guest']),
  }),
  progress: z.record(z.string(), lanStoredProgressSchema),
  trackPreferences: z.record(z.string(), playbackTrackPreferencesSchema),
  preferences: lanProfilePreferencesSchema,
  restrictions: z.object({
    country: z.enum(['US', 'GB', 'CA', 'AU']),
    maximumAge: z.number().finite().nullable(),
    allowUnrated: z.boolean(),
    allowedFolders: z.array(z.string()),
    revision: z.number().finite().nonnegative(),
  }),
  lists: z.array(lanProfileListEntrySchema),
}) satisfies z.ZodType<ProfileExportV1>;

export function parseStoredJson<TSchema extends z.ZodType>(
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

export function parseRequiredJson<TSchema extends z.ZodType>(
  value: string,
  schema: TSchema,
  context: string,
): z.output<TSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${context} contains invalid JSON.`, { cause: error });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`${context} has an invalid shape.`, { cause: result.error });
  return result.data;
}
