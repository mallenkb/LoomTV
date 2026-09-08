import { z } from 'zod';

const finiteNumber = z.number().finite();
const nonEmptyString = z.string().trim().min(1).max(8192);
// Native time uses int64 milliseconds; keep conversion exact in JavaScript.
export const playbackTimeSchema = finiteNumber.min(0).max(Math.floor(Number.MAX_SAFE_INTEGER / 1000));
const trackIdSchema = finiteNumber.int().min(-1).max(2_147_483_647);
const delaySchema = finiteNumber.min(-60).max(60);
export function boundedIpcRecord<T extends z.ZodType>(value: T, maxEntries: number, maxCharacters = 2_000_000) {
  return z.record(z.string().max(8192), value).refine((record) => {
    if (Object.keys(record).length > maxEntries) return false;
    try {
      return JSON.stringify(record).length <= maxCharacters;
    } catch {
      return false;
    }
  }, 'The IPC record is too large or cannot be serialized.');
}

const subtitleStyleSchema = z.object({
  fontSize: finiteNumber.positive().max(192),
  color: z.string().max(128),
  borderColor: z.string().max(128),
  borderWidth: finiteNumber.min(0).max(10),
  backgroundColor: z.string().max(128),
  position: finiteNumber.min(0).max(100),
});
export const playbackStartOptionsSchema = z.object({
  startSeconds: playbackTimeSchema.optional(),
  volume: finiteNumber.min(0).max(1).optional(),
  muted: z.boolean().optional(),
  speed: finiteNumber.min(0.25).max(3).optional(),
  audioTrackId: trackIdSchema.optional(),
  audioLanguage: z.string().max(128).trim().min(1).max(32).optional(),
  audioDelay: delaySchema.optional(),
  subtitleDelay: delaySchema.optional(),
  subtitleStyle: subtitleStyleSchema.optional(),
  subtitleFiles: z.array(z.object({
    path: nonEmptyString,
    source: z.enum(['sidecar', 'opensubtitles']),
  })).max(128).optional(),
  nativeSubtitles: z.boolean().optional(),
});
export const playbackCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set-paused'), paused: z.boolean() }),
  z.object({ type: z.literal('seek'), position: playbackTimeSchema }),
  z.object({ type: z.literal('set-volume'), volume: finiteNumber.min(0).max(1) }),
  z.object({ type: z.literal('set-muted'), muted: z.boolean() }),
  z.object({ type: z.literal('set-speed'), speed: finiteNumber.min(0.25).max(3) }),
  z.object({ type: z.literal('set-video-track'), trackId: trackIdSchema.nullable() }),
  z.object({ type: z.literal('set-audio-track'), trackId: trackIdSchema.nullable() }),
  z.object({ type: z.literal('set-subtitle-track'), trackId: trackIdSchema.nullable() }),
  z.object({ type: z.literal('set-secondary-subtitle-track'), trackId: trackIdSchema.nullable() }),
  z.object({ type: z.literal('set-subtitle-delay'), seconds: delaySchema }),
  z.object({ type: z.literal('set-audio-delay'), seconds: delaySchema }),
  z.object({ type: z.literal('set-subtitle-style'), ...subtitleStyleSchema.shape }),
  z.object({ type: z.literal('set-video-aspect'), aspect: z.string().max(128).nullable() }),
  z.object({ type: z.literal('set-video-crop'), crop: z.string().max(128).nullable() }),
  z.object({ type: z.literal('set-video-rotation'), degrees: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]) }),
]);

export function externalBrowserUrl(value: string): string {
  if (value.length > 8192) throw new Error('The browser link is too long.');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https links can be opened externally.');
  }
  if (parsed.username || parsed.password) throw new Error('Browser links cannot contain credentials.');
  const normalized = parsed.toString();
  if (normalized.length > 8192) throw new Error('The browser link is too long.');
  return normalized;
}

export function authorizeFolderReveal(
  target: string,
  authorizeMediaPath: (target: string) => void,
  authorizeSettingsWrite: () => void,
): void {
  try {
    authorizeMediaPath(target);
  } catch {
    authorizeSettingsWrite();
  }
}
