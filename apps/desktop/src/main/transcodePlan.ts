import path from 'node:path';
import type { TranscodeOptions } from './mediaTypes';
import {
  hasBitmapSubtitleSelection,
  hasSubtitleSelection,
  streamMap,
  subtitleFilterComplex,
  subtitleSelections,
  textSubtitleFilter,
} from './transcodeFilters.ts';

// Report the stream ready as soon as the first segment is written. With 2s
// segments this still buffers ~2s before playback, but roughly halves the
// time-to-first-frame after a start/seek restart versus waiting for two.
export const TRANSCODE_READY_SEGMENTS = 1;
export const HLS_SEGMENT_SECONDS = 2;
export const HLS_WINDOW_SEGMENTS = 45;

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
  /**
   * Seekable on-demand mode. The encoder window starts at `options.startSeconds`
   * but its segments are numbered globally (`startNumber`) and timestamped on the
   * global timeline (`-output_ts_offset`) so any window's output lines up with a
   * single full-duration VOD playlist. Forces a video re-encode with uniform
   * keyframes so segment boundaries are deterministic.
   */
  seekable?: boolean;
  startNumber?: number;
  segmentSeconds?: number;
  windowSegments?: number;
}

/** Zero-padded segment file name matching FFmpeg's `segment-%05d.ts` output. */
export function transcodeSegmentName(index: number): string {
  return `segment-${String(Math.max(0, Math.floor(index))).padStart(5, '0')}.ts`;
}

/** Number of fixed-length segments needed to cover a media duration. */
export function transcodeSegmentCount(durationSeconds: number, segmentSeconds: number): number {
  if (!(durationSeconds > 0) || !(segmentSeconds > 0)) return 0;
  return Math.max(1, Math.ceil(durationSeconds / segmentSeconds));
}

export function transcodeSessionKey(filePath: string, options: TranscodeOptions): string {
  return JSON.stringify({
    filePath: path.resolve(filePath),
    options: {
      preset: options.preset || 'auto',
      videoTrackIndex: options.videoTrackIndex,
      audioTrackIndex: options.audioTrackIndex,
      subtitleTrackIndex: options.subtitleTrackIndex,
      subtitleStreamOrdinal: options.subtitleStreamOrdinal,
      subtitleCodec: options.subtitleCodec,
      subtitleFilePath: options.subtitleFilePath ? path.resolve(options.subtitleFilePath) : undefined,
      secondarySubtitleTrackIndex: options.secondarySubtitleTrackIndex,
      secondarySubtitleStreamOrdinal: options.secondarySubtitleStreamOrdinal,
      secondarySubtitleCodec: options.secondarySubtitleCodec,
      secondarySubtitleFilePath: options.secondarySubtitleFilePath ? path.resolve(options.secondarySubtitleFilePath) : undefined,
      subtitleStyle: options.subtitleStyle
        ? {
          delaySeconds: options.subtitleStyle.delaySeconds,
          position: options.subtitleStyle.position,
          scale: options.subtitleStyle.scale,
          fontSize: options.subtitleStyle.fontSize,
          fontColor: options.subtitleStyle.fontColor,
          borderColor: options.subtitleStyle.borderColor,
          borderWidth: options.subtitleStyle.borderWidth,
          backgroundColor: options.subtitleStyle.backgroundColor,
        }
        : undefined,
    },
  });
}

/**
 * Precomputed full-duration VOD playlist. Every segment is listed up front with
 * `#EXT-X-ENDLIST`, so the player treats the whole timeline as seekable and the
 * server materializes segments on demand.
 */
export function buildVodPlaylist({
  durationSeconds,
  segmentSeconds,
}: {
  durationSeconds: number;
  segmentSeconds: number;
}): string {
  const count = transcodeSegmentCount(durationSeconds, segmentSeconds);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(segmentSeconds))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (let index = 0; index < count; index += 1) {
    const remaining = durationSeconds - index * segmentSeconds;
    const segDuration = Math.max(0.001, Math.min(segmentSeconds, remaining));
    lines.push(`#EXTINF:${segDuration.toFixed(6)},`);
    lines.push(transcodeSegmentName(index));
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

/**
 * Decide whether a `.ts` request must reposition the encoder. Sequential
 * playback requests segments contiguously (each one near the last), so those
 * just wait for the running encoder. A request that jumps forward past the
 * contiguity window, or back before the current window with no cached file, is a
 * seek and restarts the encoder at that segment.
 */
export function shouldRepositionEncoder({
  requestedIndex,
  windowStartIndex,
  lastRequestedIndex,
  segmentOnDisk,
  processAlive,
  contiguityTolerance,
}: {
  requestedIndex: number;
  windowStartIndex: number;
  lastRequestedIndex: number;
  segmentOnDisk: boolean;
  processAlive: boolean;
  contiguityTolerance: number;
}): boolean {
  if (segmentOnDisk) return false;
  if (!processAlive) return true;
  if (requestedIndex < windowStartIndex) return true;
  return requestedIndex > lastRequestedIndex + contiguityTolerance;
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
  seekable = false,
  startNumber = 0,
  segmentSeconds = HLS_SEGMENT_SECONDS,
  windowSegments = HLS_WINDOW_SEGMENTS,
}: BuildHlsArgsInput): string[] {
  const args: string[] = [];
  const hasAudio = options.audioTrackIndex !== -1;
  const hasSubtitle = hasSubtitleSelection(options);
  const bitmapSubtitle = hasBitmapSubtitleSelection(options);
  // Seekable windows must re-encode so keyframes (and therefore segment
  // boundaries) land on a deterministic grid that matches the VOD playlist.
  const copyVideo = !seekable && !hasSubtitle && isCopySafeVideo(mediaInfo);
  // Audio must also be re-encoded in seekable mode: a stream-copied audio track
  // mixed with a re-encoded video track under input-seek + output_ts_offset gets
  // its timestamps handled differently and drifts out of A/V (and subtitle)
  // sync. Re-encoding both streams keeps them on a single, shifted timeline.
  const copyAudio = !seekable && hasAudio && isCopySafeAudio(mediaInfo);
  const segSeconds = segmentSeconds > 0 ? segmentSeconds : HLS_SEGMENT_SECONDS;

  if (typeof options.startSeconds === 'number' && options.startSeconds > 0) {
    args.push('-ss', String(Math.floor(options.startSeconds)));
  }

  if (!copyVideo && preset === 'nvenc') {
    args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  } else if (!copyVideo && preset === 'qsv') {
    args.push('-hwaccel', 'qsv');
  }

  args.push('-i', filePath);

  if (seekable && windowSegments > 0) {
    args.push('-t', String(Math.ceil(segSeconds * windowSegments)));
  }

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
      primarySubtitle?.filePath,
      secondarySubtitle?.filePath,
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
  } else if (copyAudio) {
    args.push('-c:a', 'copy');
  } else {
    // Re-encoded audio is resampled against the video clock so it stays locked to
    // the picture. Without this, an input seek (and every on-demand window
    // respawn during scrubbing) lets audio and video start on slightly different
    // source timestamps, which the viewer perceives as lip-sync drift. `async=1`
    // hard-compensates gaps larger than ~0.1s and soft-corrects ongoing drift;
    // `first_pts=0` pins the first sample to the window's zero so it lines up with
    // the first video frame before `-output_ts_offset` shifts both onto the
    // global timeline.
    args.push('-c:a', 'aac', '-af', 'aresample=async=1:first_pts=0', '-b:a', '160k', '-ac', '2');
  }

  args.push('-fflags', '+genpts');
  if (seekable) {
    // Shift this window's output onto the global timeline so segment N lines up
    // at N*segSeconds regardless of which window produced it. This lets us cache
    // segments across repositions without playlist discontinuities.
    args.push(
      '-avoid_negative_ts', 'disabled',
      '-output_ts_offset', String(Math.max(0, Math.floor(options.startSeconds || 0))),
    );
  } else {
    args.push('-avoid_negative_ts', 'make_zero');
  }
  args.push(
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'hls',
    '-hls_time', String(segSeconds),
    '-hls_list_size', seekable ? '0' : '12',
  );

  if (seekable) {
    args.push('-hls_playlist_type', 'event');
  }

  args.push(
    // Seekable windows must NOT append: append_list continues the sequence
    // number from an existing playlist, which would override -start_number when
    // a window respawns at a new position. A fresh playlist keeps global
    // numbering authoritative; cached .ts files are left in place either way.
    '-hls_flags', seekable ? 'independent_segments' : 'append_list+delete_segments+independent_segments',
    '-hls_segment_filename', path.join(path.dirname(outputPath), 'segment-%05d.ts'),
  );

  if (seekable) {
    args.push('-start_number', String(Math.max(0, Math.floor(startNumber))));
  }

  if (!copyVideo) {
    args.push('-force_key_frames', `expr:gte(t,n_forced*${segSeconds})`);
  }

  args.push(outputPath);

  return args;
}
