import { z } from 'zod';
import { parseRequiredJson } from './runtimeValidation.ts';

const stringRecordSchema = z.record(z.string(), z.string());
const dispositionSchema = z.record(z.string(), z.number().finite());

export const ffprobeOutputSchema = z.object({
  format: z.object({
    duration: z.string().optional(),
    bit_rate: z.string().optional(),
    format_name: z.string().optional(),
    tags: stringRecordSchema.optional(),
  }).optional(),
  streams: z.array(z.object({
    index: z.number().finite().optional(),
    codec_type: z.string().optional(),
    codec_name: z.string().optional(),
    profile: z.string().optional(),
    pix_fmt: z.string().optional(),
    color_transfer: z.string().optional(),
    color_primaries: z.string().optional(),
    color_space: z.string().optional(),
    avg_frame_rate: z.string().optional(),
    r_frame_rate: z.string().optional(),
    width: z.number().finite().optional(),
    height: z.number().finite().optional(),
    channels: z.number().finite().optional(),
    disposition: dispositionSchema.optional(),
    tags: stringRecordSchema.optional(),
  })).optional(),
  chapters: z.array(z.object({
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    tags: stringRecordSchema.optional(),
  })).optional(),
});

export function parseFfprobeOutput(raw: string) {
  return parseRequiredJson(raw, ffprobeOutputSchema, 'ffprobe output');
}
