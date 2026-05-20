import path from 'node:path';
import type { SubtitleStyleOptions, TranscodeOptions } from './mediaTypes';

export const TRANSCODE_READY_SEGMENTS = 2;
export const HLS_SEGMENT_SECONDS = 2;

export function buildEmbeddedSubtitleVttArgs(filePath: string, streamOrdinal: number): string[] {
  const safeOrdinal = Number.isFinite(streamOrdinal) && streamOrdinal > 0
    ? Math.floor(streamOrdinal)
    : 0;
  return [
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-map',
    `0:s:${safeOrdinal}`,
    '-f',
    'webvtt',
    'pipe:1',
  ];
}

export type TranscodePreset = 'software' | 'videotoolbox' | 'nvenc' | 'qsv';

export interface HlsMediaInfo {
  videoCodec?: string;
  videoProfile?: string;
  pixelFormat?: string;
  audioCodec?: string;
}

interface BuildHlsArgsInput {
  filePath: string;
  outputPath: string;
  options: TranscodeOptions;
  preset: TranscodePreset;
  mediaInfo?: HlsMediaInfo;
}

function streamMap(type: 'v' | 'a', selectedIndex?: number, optional = false): string {
  const suffix = optional ? '?' : '';
  return typeof selectedIndex === 'number' && selectedIndex >= 0
    ? `0:${selectedIndex}${suffix}`
    : `0:${type}:0${suffix}`;
}

function filterStream(selectedIndex?: number, fallback = '0:v:0'): string {
  return typeof selectedIndex === 'number' && selectedIndex >= 0 ? `0:${selectedIndex}` : fallback;
}

function escapeSubtitleFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function isBitmapSubtitle(codec?: string): boolean {
  const normalized = (codec || '').toLowerCase();
  return normalized.includes('pgs') || normalized.includes('dvd') || normalized.includes('dvb');
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
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

function subtitleForceStyle(style?: SubtitleStyleOptions): string {
  const fontSize = clampNumber(style?.fontSize, 55, 24, 96) * clampNumber(style?.scale, 1, 0.5, 2);
  const position = clampNumber(style?.position, 92, 0, 100);
  const marginV = Math.round((100 - position) * 6);
  const borderWidth = clampNumber(style?.borderWidth, 3, 0, 10);

  return [
    `Fontsize=${Math.round(fontSize)}`,
    `PrimaryColour=${assColor(style?.fontColor, '#ffffff')}`,
    `OutlineColour=${assColor(style?.borderColor, '#000000')}`,
    `BackColour=${assColor(style?.backgroundColor, '#000000')}`,
    `Outline=${borderWidth}`,
    'Shadow=0',
    'Alignment=2',
    `MarginV=${marginV}`,
  ].join(',');
}

function textSubtitleFilter(
  filePath: string,
  subtitleOrdinal: number,
  style?: SubtitleStyleOptions,
  startSeconds = 0,
): string {
  const subtitleFilter = `subtitles='${escapeSubtitleFilterPath(filePath)}':si=${subtitleOrdinal}:force_style='${subtitleForceStyle(style)}'`;
  const seekOffset = Number.isFinite(startSeconds) && startSeconds > 0 ? Math.floor(startSeconds) : 0;
  if (seekOffset <= 0) return `${subtitleFilter},format=yuv420p`;

  return `setpts=PTS+${seekOffset}/TB,${subtitleFilter},setpts=PTS-${seekOffset}/TB,format=yuv420p`;
}

function isCopySafeVideo(mediaInfo?: HlsMediaInfo): boolean {
  const videoCodec = (mediaInfo?.videoCodec || '').toLowerCase();
  const videoProfile = (mediaInfo?.videoProfile || '').toLowerCase();
  const pixelFormat = (mediaInfo?.pixelFormat || '').toLowerCase();
  return videoCodec === 'h264'
    && pixelFormat === 'yuv420p'
    && !videoProfile.includes('10');
}

function isCopySafeAudio(mediaInfo?: HlsMediaInfo): boolean {
  const audioCodec = (mediaInfo?.audioCodec || '').toLowerCase();
  return audioCodec === 'aac' || audioCodec === 'mp3';
}

export function buildHlsArgs({
  filePath,
  outputPath,
  options,
  preset,
  mediaInfo,
}: BuildHlsArgsInput): string[] {
  const args: string[] = [];
  const hasAudio = options.audioTrackIndex !== -1;
  const hasSubtitle = typeof options.subtitleTrackIndex === 'number' && options.subtitleTrackIndex >= 0;
  const bitmapSubtitle = hasSubtitle && isBitmapSubtitle(options.subtitleCodec);
  const copyVideo = !hasSubtitle && isCopySafeVideo(mediaInfo);
  const copyAudio = hasAudio && isCopySafeAudio(mediaInfo);

  if (typeof options.startSeconds === 'number' && options.startSeconds > 0) {
    args.push('-ss', String(Math.floor(options.startSeconds)));
  }

  if (!copyVideo && preset === 'nvenc') {
    args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  } else if (!copyVideo && preset === 'qsv') {
    args.push('-hwaccel', 'qsv');
  }

  args.push('-i', filePath);

  if (bitmapSubtitle) {
    args.push(
      '-filter_complex',
      `[${filterStream(options.videoTrackIndex)}][0:${options.subtitleTrackIndex}]overlay,format=yuv420p[v]`,
      '-map',
      '[v]',
    );
  } else {
    args.push('-map', streamMap('v', options.videoTrackIndex));
  }

  if (hasAudio) {
    args.push('-map', streamMap('a', options.audioTrackIndex, true));
  }

  args.push('-sn', '-dn');

  if (hasSubtitle && !bitmapSubtitle) {
    const subtitleOrdinal = typeof options.subtitleStreamOrdinal === 'number'
      ? options.subtitleStreamOrdinal
      : 0;
    args.push('-vf', textSubtitleFilter(filePath, subtitleOrdinal, options.subtitleStyle, options.startSeconds));
  } else if (!copyVideo && !bitmapSubtitle) {
    args.push('-vf', 'format=yuv420p');
  }

  if (copyVideo) {
    args.push('-c:v', 'copy');
  } else if (preset === 'nvenc') {
    args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-b:v', '0');
  } else if (preset === 'qsv') {
    args.push('-c:v', 'h264_qsv', '-global_quality', '23', '-look_ahead', '0');
  } else if (preset === 'videotoolbox') {
    args.push(
      '-c:v', 'h264_videotoolbox',
      '-allow_sw', '1',
      '-realtime', '1',
      '-b:v', '6500k',
      '-maxrate', '8500k',
      '-bufsize', '12000k',
      '-profile:v', 'main',
    );
  } else {
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main');
  }

  if (!hasAudio) {
    args.push('-an');
  } else {
    args.push('-c:a', copyAudio ? 'copy' : 'aac');
    if (!copyAudio) args.push('-b:a', '160k', '-ac', '2');
  }

  args.push(
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'append_list+independent_segments',
    '-hls_segment_filename', path.join(path.dirname(outputPath), 'segment-%05d.ts'),
  );

  if (!copyVideo) {
    args.push('-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`);
  }

  args.push(outputPath);

  return args;
}
