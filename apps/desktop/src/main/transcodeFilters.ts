import type { SubtitleStyleOptions, TranscodeOptions } from './mediaTypes';

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
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
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
  return `subtitles='${escapeFilterPath(filePath)}':si=${subtitleOrdinal}:force_style='${subtitleForceStyle(style, placement)}'`;
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
    const parsed = JSON.parse(value) as SubtitleStyleOptions;
    if (!parsed || typeof parsed !== 'object') return undefined;
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

export function appendStreamOptionParams(params: URLSearchParams, options?: TranscodeOptions): void {
  if (!options) return;
  if (typeof options.startSeconds === 'number' && options.startSeconds > 0) params.set('t', String(Math.floor(options.startSeconds)));
  if (typeof options.videoTrackIndex === 'number') params.set('video', String(options.videoTrackIndex));
  if (typeof options.audioTrackIndex === 'number') params.set('audio', String(options.audioTrackIndex));
  if (typeof options.subtitleTrackIndex === 'number') params.set('subtitle', String(options.subtitleTrackIndex));
  if (typeof options.subtitleStreamOrdinal === 'number') params.set('subtitleOrdinal', String(options.subtitleStreamOrdinal));
  if (options.subtitleCodec) params.set('subtitleCodec', options.subtitleCodec);
  if (typeof options.secondarySubtitleTrackIndex === 'number') params.set('secondarySubtitle', String(options.secondarySubtitleTrackIndex));
  if (typeof options.secondarySubtitleStreamOrdinal === 'number') params.set('secondarySubtitleOrdinal', String(options.secondarySubtitleStreamOrdinal));
  if (options.secondarySubtitleCodec) params.set('secondarySubtitleCodec', options.secondarySubtitleCodec);
  if (options.subtitleStyle) params.set('subtitleStyle', JSON.stringify(options.subtitleStyle));
  if (options.forceTranscode) params.set('forceTranscode', '1');
}
