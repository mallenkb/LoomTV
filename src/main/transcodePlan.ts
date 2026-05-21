import path from 'node:path';
import type { TranscodeOptions } from './mediaTypes';
import {
  hasBitmapSubtitleSelection,
  hasSubtitleSelection,
  streamMap,
  subtitleFilterComplex,
  subtitleSelections,
  textSubtitleFilter,
} from './transcodeFilters';
} from './transcodeFilters.ts';

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
  const hasSubtitle = hasSubtitleSelection(options);
  const bitmapSubtitle = hasBitmapSubtitleSelection(options);
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
    const subtitleFilter = subtitleFilterComplex(filePath, options);
    args.push(
      '-filter_complex',
      subtitleFilter.filter,
      '-map',
      `[${subtitleFilter.output}]`,
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
    const textSelections = subtitleSelections(options);
    const primarySubtitle = textSelections.find((selection) => selection.placement === 'primary') || textSelections[0];
    const secondarySubtitle = textSelections.find((selection) => selection !== primarySubtitle);
    args.push('-vf', textSubtitleFilter(
      filePath,
      primarySubtitle?.streamOrdinal ?? subtitleOrdinal,
      options.subtitleStyle,
      options.startSeconds,
      secondarySubtitle?.streamOrdinal,
    ));
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
