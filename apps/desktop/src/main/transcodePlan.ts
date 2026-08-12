import path from 'node:path';
import { normalizePlaybackProfile } from '@loom-media-server/media-core';
import type { TranscodeOptions } from './mediaTypes';
import {
  appendHardwareEncoderOptions,
  hasBitmapSubtitleSelection,
  hasSubtitleSelection,
  streamMap,
  subtitleFilterComplex,
  subtitleSelections,
  textSubtitleFilter,
  type HardwareVideoEncoder,
} from './transcodeFilters.ts';

// Report the stream ready as soon as the first segment is written. With 2s
// segments this still buffers ~2s before playback, but roughly halves the
// time-to-first-frame after a start/seek restart versus waiting for two.
export const TRANSCODE_READY_SEGMENTS = 1;
export const HLS_SEGMENT_SECONDS = 2;
export const HLS_WINDOW_SEGMENTS = 45;
export const LOCAL_HLS_SEGMENT_SECONDS = 1;
export const LOCAL_HLS_WINDOW_SEGMENTS = 30;

export type HlsSegmentProfile = 'local-interactive' | 'lan-stable';

export const HLS_SEGMENT_PROFILES: Readonly<Record<HlsSegmentProfile, {
  segmentSeconds: number;
  windowSegments: number;
}>> = Object.freeze({
  'local-interactive': {
    segmentSeconds: LOCAL_HLS_SEGMENT_SECONDS,
    windowSegments: LOCAL_HLS_WINDOW_SEGMENTS,
  },
  'lan-stable': {
    segmentSeconds: HLS_SEGMENT_SECONDS,
    windowSegments: HLS_WINDOW_SEGMENTS,
  },
});

export function hlsSegmentProfileForScope(scope?: string): HlsSegmentProfile {
  return scope?.startsWith('lan:') ? 'lan-stable' : 'local-interactive';
}

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

export type TranscodePreset = 'software' | 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'rkmpp';

export interface HlsMediaInfo {
  videoCodec?: string;
  videoProfile?: string;
  pixelFormat?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  audioCodec?: string;
  frameRate?: number;
}

function needsToneMapping(mediaInfo?: HlsMediaInfo): boolean {
  const transfer = String(mediaInfo?.colorTransfer || '').toLowerCase();
  const primaries = String(mediaInfo?.colorPrimaries || '').toLowerCase();
  const pixelFormat = String(mediaInfo?.pixelFormat || '').toLowerCase();
  return transfer.includes('smpte2084')
    || transfer.includes('arib-std-b67')
    || transfer.includes('hlg')
    || (primaries.includes('bt2020') && /10|12/.test(pixelFormat));
}

function toneMappingFilter(preset: TranscodePreset, upload = true): string {
  const outputFormat = preset === 'vaapi' && upload ? 'nv12,hwupload' : 'yuv420p';
  return `zscale=transfer=linear:npl=100,format=gbrpf32le,tonemap=mobius,zscale=transfer=bt709:primaries=bt709:matrix=bt709,format=${outputFormat}`;
}

function outputVideoCodec(options: TranscodeOptions): 'h264' | 'hevc' | 'av1' {
  return normalizePlaybackProfile(options).codec;
}

function hardwareEncoderForPreset(preset: TranscodePreset, codec: 'h264' | 'hevc' | 'av1'): HardwareVideoEncoder | null {
  if (preset === 'software') return null;
  const suffix = preset === 'videotoolbox' ? 'videotoolbox' : preset;
  const encoder = `${codec === 'h264' ? 'h264' : codec}_${suffix}`;
  return encoder as HardwareVideoEncoder;
}

function softwareEncoderForCodec(codec: 'h264' | 'hevc' | 'av1', requested?: TranscodeOptions['softwareVideoEncoder']): string {
  if (codec === 'h264') return requested === 'libx264' ? requested : 'libx264';
  if (codec === 'hevc') return requested === 'libx265' ? requested : 'libx265';
  return requested === 'libsvtav1' || requested === 'libaom-av1' ? requested : 'libsvtav1';
}

function scaleFilter(options: TranscodeOptions): string | null {
  const profile = normalizePlaybackProfile(options);
  const width = profile.maxWidth;
  const height = profile.maxHeight;
  if (!width && !height) return null;
  return `scale=${width || -2}:${height || -2}:force_original_aspect_ratio=decrease`;
}

/**
 * Snap a nominal segment length to a whole number of frames.
 *
 * `-hls_time N` cannot split mid-frame, so the encoder emits the first frame at
 * or after N — 2s of 24000/1001fps content becomes 48 frames, i.e. 2.002s. The
 * synthesized VOD playlist and the window seek math both used the nominal 2s, so
 * a segment's declared start drifted from its real content by
 * `segmentIndexWithinWindow * 0.002`. Over a 45-segment window that reaches
 * ~90ms, and because segments are cached across windows two neighbours could
 * carry different accumulated error, putting a step discontinuity mid-playback.
 * Quantizing here makes the playlist, the input seek, the timestamp offset and
 * the forced-keyframe expression agree exactly.
 */
export function frameAlignedSegmentSeconds(segmentSeconds: number, frameRate?: number): number {
  if (!(segmentSeconds > 0)) return HLS_SEGMENT_SECONDS;
  if (!frameRate || !Number.isFinite(frameRate) || frameRate <= 0) return segmentSeconds;
  const framesPerSegment = Math.round(segmentSeconds * frameRate);
  if (!(framesPerSegment > 0)) return segmentSeconds;
  return framesPerSegment / frameRate;
}

/**
 * Seconds for an FFmpeg time argument. Truncating to whole seconds would defeat
 * {@link frameAlignedSegmentSeconds}, whose grid is fractional.
 */
function ffmpegSeconds(value: number): string {
  return Math.max(0, Number.isFinite(value) ? value : 0).toFixed(6);
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
      targetVideoCodec: options.targetVideoCodec || 'h264',
      softwareVideoEncoder: options.softwareVideoEncoder,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      videoBitrateKbps: options.videoBitrateKbps,
      audioBitrateKbps: options.audioBitrateKbps,
      toneMap: options.toneMap,
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
  const playbackProfile = normalizePlaybackProfile(options);
  const hasAudio = options.audioTrackIndex !== -1;
  const hasSubtitle = hasSubtitleSelection(options);
  const bitmapSubtitle = hasBitmapSubtitleSelection(options);
  const targetCodec = outputVideoCodec(options);
  const profileVideo = Boolean(options.maxWidth || options.maxHeight || options.videoBitrateKbps || options.toneMap);
  // Seekable windows must re-encode so keyframes (and therefore segment
  // boundaries) land on a deterministic grid that matches the VOD playlist.
  const copyVideo = !seekable && !profileVideo && targetCodec === 'h264' && !hasSubtitle && isCopySafeVideo(mediaInfo);
  // Audio must also be re-encoded in seekable mode: a stream-copied audio track
  // mixed with a re-encoded video track under input-seek + output_ts_offset gets
  // its timestamps handled differently and drifts out of A/V (and subtitle)
  // sync. Re-encoding both streams keeps them on a single, shifted timeline.
  const copyAudio = !seekable && !options.audioBitrateKbps && hasAudio && isCopySafeAudio(mediaInfo);
  const segSeconds = segmentSeconds > 0 ? segmentSeconds : HLS_SEGMENT_SECONDS;
  const toneMap = !copyVideo && options.toneMap !== false && (Boolean(options.toneMap) || needsToneMapping(mediaInfo));
  const scaling = !copyVideo ? scaleFilter(options) : null;

  if (typeof options.startSeconds === 'number' && options.startSeconds > 0) {
    args.push('-ss', ffmpegSeconds(options.startSeconds));
  }

  // Use a zero-copy decode/encode chain only when no software filter needs to
  // touch the decoded frames. Subtitle burn-in, scaling, and tone mapping stay
  // on the explicit software-upload path below so CUDA/QSV/VA-API frames are
  // never handed to an incompatible filter.
  const canUseHardwareDecode = !copyVideo
    && !hasSubtitle
    && !bitmapSubtitle
    && !toneMap
    && !scaling
    && ['videotoolbox', 'nvenc', 'qsv', 'vaapi'].includes(preset);
  if (canUseHardwareDecode && preset === 'nvenc') {
    args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  } else if (canUseHardwareDecode && preset === 'qsv') {
    args.push('-init_hw_device', 'qsv=hw', '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
  } else if (canUseHardwareDecode && preset === 'videotoolbox') {
    args.push('-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld');
  } else if (preset === 'vaapi') {
    const vaapiDevice = process.env.LOOMTV_VAAPI_DEVICE || process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
    args.push('-vaapi_device', vaapiDevice);
    if (canUseHardwareDecode) args.push('-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi');
  }

  args.push('-i', filePath);

  if (seekable && windowSegments > 0) {
    // Keep the encoder window on the same precise grid as the synthetic
    // playlist. Rounding up would create one trailing partial segment that
    // could later be mistaken for a complete cached segment.
    args.push('-t', ffmpegSeconds(segSeconds * windowSegments));
  }

  if (bitmapSubtitle) {
    const subtitleFilter = subtitleFilterComplex(filePath, options);
    const needsPostFilter = preset === 'vaapi' || toneMap || scaling;
    const output = needsPostFilter ? `${subtitleFilter.output}processed` : subtitleFilter.output;
    args.push(
      '-filter_complex',
      preset === 'vaapi' || toneMap || scaling
        ? `${subtitleFilter.filter};[${subtitleFilter.output}]${[toneMap ? toneMappingFilter(preset) : 'format=yuv420p', scaling].filter(Boolean).join(',')}${preset === 'vaapi' ? ',format=nv12,hwupload' : ''}[${output}]`
        : subtitleFilter.filter,
      '-map',
      `[${output}]`,
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
    const subtitleFilter = textSubtitleFilter(
      filePath,
      primarySubtitle?.streamOrdinal ?? subtitleOrdinal,
      options.subtitleStyle,
      options.startSeconds,
      secondarySubtitle?.streamOrdinal,
      primarySubtitle?.filePath,
      secondarySubtitle?.filePath,
    );
    const toneMappedSubtitleFilter = toneMap
      ? `${toneMappingFilter(preset, false)},${subtitleFilter}${preset === 'vaapi' ? ',format=nv12,hwupload' : ''}`
      : preset === 'vaapi'
        ? `${subtitleFilter},format=nv12,hwupload`
        : subtitleFilter;
    args.push('-vf', [toneMappedSubtitleFilter, scaling].filter(Boolean).join(','));
  } else if (!copyVideo && !bitmapSubtitle) {
    if (!canUseHardwareDecode) {
      const baseFilter = toneMap ? toneMappingFilter(preset, false) : 'format=yuv420p';
      args.push('-vf', [baseFilter, scaling, preset === 'vaapi' ? 'format=nv12,hwupload' : null].filter(Boolean).join(','));
    }
  }

  if (copyVideo) {
    args.push('-c:v', 'copy');
  } else if (hardwareEncoderForPreset(preset, targetCodec)) {
    const encoder = hardwareEncoderForPreset(preset, targetCodec);
    args.push('-c:v', encoder as string);
    appendHardwareEncoderOptions(args, encoder as HardwareVideoEncoder);
    if (playbackProfile.videoBitrateKbps) {
      const bitrate = Math.max(128, playbackProfile.videoBitrateKbps);
      args.push('-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`);
    }
  } else {
    args.push('-c:v', softwareEncoderForCodec(targetCodec, options.softwareVideoEncoder));
    if (targetCodec === 'h264') args.push('-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main');
    if (targetCodec === 'hevc') args.push('-preset', 'medium', '-crf', '28', '-pix_fmt', 'yuv420p');
    if (targetCodec === 'av1') args.push('-preset', '8', '-crf', '32', '-pix_fmt', 'yuv420p');
    if (playbackProfile.videoBitrateKbps) {
      const bitrate = Math.max(128, playbackProfile.videoBitrateKbps);
      args.push('-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`);
    }
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
    const audioBitrate = playbackProfile.audioBitrateKbps;
    args.push('-c:a', 'aac', '-af', 'aresample=async=1:first_pts=0', '-b:a', `${audioBitrate}k`, '-ac', '2');
  }

  args.push('-fflags', '+genpts');
  if (seekable) {
    // Shift this window's output onto the global timeline so segment N lines up
    // at N*segSeconds regardless of which window produced it. This lets us cache
    // segments across repositions without playlist discontinuities.
    args.push(
      '-avoid_negative_ts', 'disabled',
      '-output_ts_offset', ffmpegSeconds(options.startSeconds || 0),
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
