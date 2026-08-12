import type { SubtitleStyleOptions, TranscodeOptions } from './mediaTypes';
import { z } from 'zod';
import { parseRequiredJson } from './runtimeValidation.ts';

const subtitleStyleOptionsSchema = z.object({
  delaySeconds: z.number().finite().optional(),
  position: z.number().finite().optional(),
  scale: z.number().finite().optional(),
  fontSize: z.number().finite().optional(),
  fontColor: z.string().optional(),
  borderColor: z.string().optional(),
  borderWidth: z.number().finite().optional(),
  borderEnabled: z.boolean().optional(),
  backgroundColor: z.string().optional(),
  backgroundEnabled: z.boolean().optional(),
});

export type H264HardwareEncoder =
  | 'h264_videotoolbox'
  | 'h264_nvenc'
  | 'h264_qsv'
  | 'h264_vaapi'
  | 'h264_amf'
  | 'h264_rkmpp';

export type HardwareVideoEncoder = H264HardwareEncoder
  | 'hevc_videotoolbox'
  | 'hevc_nvenc'
  | 'hevc_qsv'
  | 'hevc_vaapi'
  | 'hevc_amf'
  | 'hevc_rkmpp'
  | 'av1_nvenc'
  | 'av1_qsv'
  | 'av1_vaapi'
  | 'av1_amf';

export function appendH264EncoderOptions(args: string[], encoder: H264HardwareEncoder): void {
  if (encoder === 'h264_videotoolbox') {
    args.push(
      '-allow_sw', '1',
      '-realtime', '1',
      '-b:v', '6500k',
      '-maxrate', '8500k',
      '-bufsize', '12000k',
      '-profile:v', 'main',
    );
    return;
  }

  if (encoder === 'h264_nvenc') {
    args.push('-preset', 'p4', '-cq', '23', '-b:v', '0');
    return;
  }

  if (encoder === 'h264_qsv') {
    args.push('-global_quality', '23', '-look_ahead', '0');
    return;
  }

  if (encoder === 'h264_vaapi') {
    args.push('-qp', '23');
    return;
  }

  if (encoder === 'h264_amf') {
    args.push('-quality', 'balanced', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23');
    return;
  }

  args.push('-qp_init', '23');
}

export function appendHardwareEncoderOptions(args: string[], encoder: HardwareVideoEncoder): void {
  if (encoder.startsWith('h264_')) {
    appendH264EncoderOptions(args, encoder as H264HardwareEncoder);
    return;
  }
  if (encoder.endsWith('_nvenc')) {
    args.push('-preset', 'p4', '-cq', '23', '-b:v', '0');
    return;
  }
  if (encoder.endsWith('_qsv')) {
    args.push('-global_quality', '23', '-look_ahead', '0');
    return;
  }
  if (encoder.endsWith('_vaapi')) {
    args.push('-qp', '23');
    return;
  }
  if (encoder.endsWith('_amf')) {
    args.push('-quality', 'balanced', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23');
    return;
  }
  if (encoder.endsWith('_rkmpp')) {
    args.push('-qp_init', '23');
    return;
  }
  args.push('-allow_sw', '1', '-realtime', '1', '-b:v', '6500k', '-maxrate', '8500k', '-bufsize', '12000k');
}

export function queryNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function streamMap(type: 'v' | 'a', selectedIndex?: number, optional = false): string {
  const suffix = optional ? '?' : '';
  return typeof selectedIndex === 'number' && selectedIndex >= 0
    ? `0:${selectedIndex}${suffix}`
    : `0:${type}:0${suffix}`;
}

function filterStream(selectedIndex?: number, fallback = '0:v:0'): string {
  return typeof selectedIndex === 'number' && selectedIndex >= 0 ? `0:${selectedIndex}` : fallback;
}

function escapeFilterPath(filePath: string): string {
  // Filtergraph parsing, the subtitles filter's option parser, and libass each
  // consume an escape layer. Quoting the filename cannot represent an embedded
  // apostrophe, so keep it unquoted and escape every filter-special character
  // through all three layers. Backslashes need two escaped characters per layer.
  const escapedSpecial = '\\'.repeat(3);
  return Array.from(filePath, (character) => {
    if (character === '\\') return '\\'.repeat(6);
    if (`:'[],;`.includes(character)) return `${escapedSpecial}${character}`;
    return character;
  }).join('');
}

function isBitmapSubtitleCodec(codec?: string): boolean {
  const normalized = (codec || '').toLowerCase();
  return normalized.includes('pgs') || normalized.includes('dvd') || normalized.includes('dvb');
}

type SubtitlePlacement = 'primary' | 'secondary';

export interface SubtitleSelection {
  trackIndex: number;
  streamOrdinal: number;
  codec?: string;
  filePath?: string;
  placement: SubtitlePlacement;
}

export function subtitleSelections(options: TranscodeOptions): SubtitleSelection[] {
  const selections: SubtitleSelection[] = [];
  if (options.subtitleFilePath) {
    selections.push({
      trackIndex: -1,
      streamOrdinal: 0,
      codec: options.subtitleCodec,
      filePath: options.subtitleFilePath,
      placement: 'primary',
    });
  } else if (typeof options.subtitleTrackIndex === 'number' && options.subtitleTrackIndex >= 0) {
    selections.push({
      trackIndex: options.subtitleTrackIndex,
      streamOrdinal: typeof options.subtitleStreamOrdinal === 'number' ? options.subtitleStreamOrdinal : 0,
      codec: options.subtitleCodec,
      placement: 'primary',
    });
  }

  if (
    options.secondarySubtitleFilePath
    && options.secondarySubtitleFilePath !== options.subtitleFilePath
  ) {
    selections.push({
      trackIndex: -1,
      streamOrdinal: 0,
      codec: options.secondarySubtitleCodec,
      filePath: options.secondarySubtitleFilePath,
      placement: 'secondary',
    });
  } else if (
    typeof options.secondarySubtitleTrackIndex === 'number'
    && options.secondarySubtitleTrackIndex >= 0
    && options.secondarySubtitleTrackIndex !== options.subtitleTrackIndex
  ) {
    selections.push({
      trackIndex: options.secondarySubtitleTrackIndex,
      streamOrdinal: typeof options.secondarySubtitleStreamOrdinal === 'number'
        ? options.secondarySubtitleStreamOrdinal
        : 0,
      codec: options.secondarySubtitleCodec,
      placement: 'secondary',
    });
  }

  return selections;
}

export function hasSubtitleSelection(options: TranscodeOptions): boolean {
  return subtitleSelections(options).length > 0;
}

export function hasBitmapSubtitleSelection(options: TranscodeOptions): boolean {
  return subtitleSelections(options).some((selection) => isBitmapSubtitleCodec(selection.codec));
}

function clampStyleNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function assColor(value: unknown, fallback: string): string {
  const hex = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  const red = hex.slice(1, 3);
  const green = hex.slice(3, 5);
  const blue = hex.slice(5, 7);
  return `&H00${blue}${green}${red}`.toUpperCase();
}

function subtitleForceStyle(style?: SubtitleStyleOptions, placement: SubtitlePlacement = 'primary'): string {
  const fontSize = clampStyleNumber(style?.fontSize, 32, 24, 96) * clampStyleNumber(style?.scale, 1, 0.5, 2);
  const position = placement === 'secondary' ? 8 : clampStyleNumber(style?.position, 96, 0, 100);
  const marginV = placement === 'secondary'
    ? Math.round(position * 6)
    : Math.round((100 - position) * 6);
  const borderWidth = clampStyleNumber(style?.borderWidth, 3, 0, 10);

  return [
    `Fontsize=${Math.round(fontSize)}`,
    `PrimaryColour=${assColor(style?.fontColor, '#ffffff')}`,
    `OutlineColour=${assColor(style?.borderColor, '#000000')}`,
    `BackColour=${assColor(style?.backgroundColor, '#000000')}`,
    `Outline=${borderWidth}`,
    'Shadow=0',
    `Alignment=${placement === 'secondary' ? 8 : 2}`,
    `MarginV=${marginV}`,
  ].join(',');
}

function subtitleFilterSegment(
  filePath: string,
  subtitleOrdinal: number,
  style?: SubtitleStyleOptions,
  placement: SubtitlePlacement = 'primary',
): string {
  return `subtitles=filename=${escapeFilterPath(filePath)}\\:si=${subtitleOrdinal}:force_style='${subtitleForceStyle(style, placement)}'`;
}

export function textSubtitleFilter(
  filePath: string,
  subtitleOrdinal: number,
  style?: SubtitleStyleOptions,
  startSeconds = 0,
  secondarySubtitleOrdinal?: number,
  subtitleFilePath?: string,
  secondarySubtitleFilePath?: string,
): string {
  const subtitleFilters = [subtitleFilterSegment(subtitleFilePath || filePath, subtitleOrdinal, style, 'primary')];
  if (typeof secondarySubtitleOrdinal === 'number' && secondarySubtitleOrdinal >= 0) {
    subtitleFilters.push(subtitleFilterSegment(secondarySubtitleFilePath || filePath, secondarySubtitleOrdinal, style, 'secondary'));
  }
  const subtitleFilter = subtitleFilters.join(',');
  const seekOffset = Number.isFinite(startSeconds) && startSeconds > 0 ? Math.floor(startSeconds) : 0;
  if (seekOffset <= 0) return `${subtitleFilter},format=yuv420p`;

  // FFmpeg fast input seeking resets video PTS to zero, but the subtitles
  // filter matches cues against the original file timeline. Temporarily shift
  // frames back to the original timeline while rendering subtitles, then shift
  // them back for playback output.
  return `setpts=PTS+${seekOffset}/TB,${subtitleFilter},setpts=PTS-${seekOffset}/TB,format=yuv420p`;
}

export function subtitleFilterComplex(filePath: string, options: TranscodeOptions): { filter: string; output: string } {
  const selections = subtitleSelections(options);
  let currentLabel = filterStream(options.videoTrackIndex);
  const filters: string[] = [];
  const seekOffset = Number.isFinite(options.startSeconds) && (options.startSeconds || 0) > 0
    ? Math.floor(options.startSeconds || 0)
    : 0;

  if (seekOffset > 0) {
    const output = 'vseekin';
    filters.push(`[${currentLabel}]setpts=PTS+${seekOffset}/TB[${output}]`);
    currentLabel = output;
  }

  selections.forEach((selection, index) => {
    const output = `vsub${index}`;
    if (isBitmapSubtitleCodec(selection.codec) && !selection.filePath) {
      filters.push(`[${currentLabel}][0:${selection.trackIndex}]overlay,format=yuv420p[${output}]`);
    } else {
      filters.push(
        `[${currentLabel}]${subtitleFilterSegment(selection.filePath || filePath, selection.streamOrdinal, options.subtitleStyle, selection.placement)},format=yuv420p[${output}]`,
      );
    }
    currentLabel = output;
  });

  if (seekOffset > 0) {
    const output = 'vseekout';
    filters.push(`[${currentLabel}]setpts=PTS-${seekOffset}/TB,format=yuv420p[${output}]`);
    currentLabel = output;
  }

  return { filter: filters.join(';'), output: currentLabel };
}

export function parseSubtitleStyle(value: string | null): SubtitleStyleOptions | undefined {
  if (!value) return undefined;
  try {
    const parsed = parseRequiredJson(value, subtitleStyleOptionsSchema, 'Subtitle style');
    return {
      delaySeconds: clampStyleNumber(parsed.delaySeconds, 0, -5, 5),
      position: clampStyleNumber(parsed.position, 96, 0, 100),
      scale: clampStyleNumber(parsed.scale, 1, 0.5, 2),
      fontSize: clampStyleNumber(parsed.fontSize, 32, 24, 96),
      fontColor: typeof parsed.fontColor === 'string' ? parsed.fontColor : '#ffffff',
      borderColor: typeof parsed.borderColor === 'string' ? parsed.borderColor : '#000000',
      borderWidth: clampStyleNumber(parsed.borderWidth, 3, 0, 10),
      backgroundColor: typeof parsed.backgroundColor === 'string' ? parsed.backgroundColor : '#000000',
    };
  } catch {
    return undefined;
  }
}

export type StreamSubtitleResourceIds = {
  subtitleResourceId?: string;
  secondarySubtitleResourceId?: string;
};

export function appendStreamOptionParams(
  params: URLSearchParams,
  options?: TranscodeOptions,
  subtitleResources: StreamSubtitleResourceIds = {},
): void {
  if (!options) return;
  if (typeof options.startSeconds === 'number' && options.startSeconds > 0) params.set('t', String(Math.floor(options.startSeconds)));
  if (options.targetVideoCodec) params.set('codec', options.targetVideoCodec);
  if (typeof options.maxWidth === 'number') params.set('maxWidth', String(Math.floor(options.maxWidth)));
  if (typeof options.maxHeight === 'number') params.set('maxHeight', String(Math.floor(options.maxHeight)));
  if (typeof options.videoBitrateKbps === 'number') params.set('videoBitrateKbps', String(Math.floor(options.videoBitrateKbps)));
  if (typeof options.audioBitrateKbps === 'number') params.set('audioBitrateKbps', String(Math.floor(options.audioBitrateKbps)));
  if (options.toneMap) params.set('toneMap', '1');
  if (typeof options.videoTrackIndex === 'number') params.set('video', String(options.videoTrackIndex));
  if (typeof options.audioTrackIndex === 'number') params.set('audio', String(options.audioTrackIndex));
  if (typeof options.subtitleTrackIndex === 'number') params.set('subtitle', String(options.subtitleTrackIndex));
  if (typeof options.subtitleStreamOrdinal === 'number') params.set('subtitleOrdinal', String(options.subtitleStreamOrdinal));
  if (options.subtitleCodec) params.set('subtitleCodec', options.subtitleCodec);
  if (subtitleResources.subtitleResourceId) params.set('subtitleResourceId', subtitleResources.subtitleResourceId);
  if (typeof options.secondarySubtitleTrackIndex === 'number') params.set('secondarySubtitle', String(options.secondarySubtitleTrackIndex));
  if (typeof options.secondarySubtitleStreamOrdinal === 'number') params.set('secondarySubtitleOrdinal', String(options.secondarySubtitleStreamOrdinal));
  if (options.secondarySubtitleCodec) params.set('secondarySubtitleCodec', options.secondarySubtitleCodec);
  if (subtitleResources.secondarySubtitleResourceId) {
    params.set('secondarySubtitleResourceId', subtitleResources.secondarySubtitleResourceId);
  }
  if (options.subtitleStyle) params.set('subtitleStyle', JSON.stringify(options.subtitleStyle));
  if (options.forceTranscode) params.set('forceTranscode', '1');
}
