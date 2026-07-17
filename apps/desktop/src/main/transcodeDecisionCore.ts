import path from 'node:path';
import type { TranscodeOptions } from './mediaTypes.ts';
import type { LocalMediaDetails } from './metadata/types.ts';

type BrowserPlaybackMode = 'direct' | 'remux' | 'direct-stream' | 'transcode';

export interface BrowserPlaybackPlan {
  mode: BrowserPlaybackMode;
  reason: string;
  container: string;
  videoCodec: string;
  audioCodec: string;
  contentType: string;
  copyVideo: boolean;
  copyAudio: boolean;
  requiresFfmpeg: boolean;
  requiresSeekRestart: boolean;
}

const mp4Extensions = new Set(['.mp4', '.m4v', '.mov']);
const webmExtensions = new Set(['.webm']);

function normalizeCodec(value?: string): string {
  return String(value || '').toLowerCase();
}

function normalizeContainer(filePath: string, metadata?: LocalMediaDetails): string {
  const ext = path.extname(filePath).toLowerCase();
  if (mp4Extensions.has(ext)) return 'mp4';
  if (webmExtensions.has(ext)) return 'webm';

  const raw = normalizeCodec(metadata?.container);
  if (raw.includes('matroska')) return 'matroska';
  if (raw.includes('webm')) return 'webm';
  if (raw.includes('mp4') || raw.includes('mov') || raw.includes('m4v') || raw.includes('quicktime')) return 'mp4';
  if (raw.includes('mpegts')) return 'mpegts';
  if (raw.includes('avi')) return 'avi';
  if (raw.includes('asf')) return 'asf';

  return ext ? ext.slice(1) : raw || 'unknown';
}

function isBrowserSafeContainer(container: string): boolean {
  return container === 'mp4' || container === 'webm';
}

function outputContentType(container: string, mode: BrowserPlaybackMode): string {
  if (mode !== 'direct') return 'video/mp4';
  return container === 'webm' ? 'video/webm' : 'video/mp4';
}

function isSafeH264(metadata?: LocalMediaDetails): boolean {
  const videoCodec = normalizeCodec(metadata?.videoCodec);
  const videoProfile = normalizeCodec(metadata?.videoProfile);
  const pixelFormat = normalizeCodec(metadata?.pixelFormat);
  return videoCodec === 'h264'
    && ['yuv420p', 'yuvj420p'].includes(pixelFormat)
    && !videoProfile.includes('10');
}

function isBrowserFriendly420PixelFormat(metadata?: LocalMediaDetails): boolean {
  const pixelFormat = normalizeCodec(metadata?.pixelFormat);
  return !pixelFormat || ['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(pixelFormat);
}

function isMp4CopyableVideo(metadata?: LocalMediaDetails): boolean {
  const videoCodec = normalizeCodec(metadata?.videoCodec);
  if (isSafeH264(metadata)) return true;
  if (['hevc', 'h265', 'hvc1', 'hev1', 'av1', 'av01'].includes(videoCodec)) {
    return isBrowserFriendly420PixelFormat(metadata);
  }
  return false;
}

function isBrowserSafeVideo(container: string, metadata?: LocalMediaDetails): boolean {
  const videoCodec = normalizeCodec(metadata?.videoCodec);
  if (container === 'webm') {
    return ['vp8', 'vp9', 'av1'].includes(videoCodec);
  }
  if (container === 'mp4') return isMp4CopyableVideo(metadata);
  return false;
}

function hasAudio(metadata?: LocalMediaDetails): boolean {
  if (typeof metadata?.audioTracks === 'number') return metadata.audioTracks > 0;
  return Boolean(metadata?.audioCodec);
}

function isBrowserSafeAudio(container: string, metadata?: LocalMediaDetails): boolean {
  if (!hasAudio(metadata)) return true;
  const audioCodec = normalizeCodec(metadata?.audioCodec);
  if (container === 'webm') return ['opus', 'vorbis'].includes(audioCodec);
  return ['aac', 'mp3'].includes(audioCodec);
}

function selectedTrackOptions(options: TranscodeOptions): boolean {
  return typeof options.videoTrackIndex === 'number'
    || typeof options.audioTrackIndex === 'number'
    || typeof options.subtitleTrackIndex === 'number'
    || typeof options.secondarySubtitleTrackIndex === 'number'
    || Boolean(options.subtitleFilePath)
    || Boolean(options.secondarySubtitleFilePath);
}

function makePlan(
  mode: BrowserPlaybackMode,
  reason: string,
  container: string,
  metadata: LocalMediaDetails | undefined,
  copyVideo: boolean,
  copyAudio: boolean,
): BrowserPlaybackPlan {
  return {
    mode,
    reason,
    container,
    videoCodec: normalizeCodec(metadata?.videoCodec) || 'unknown',
    audioCodec: normalizeCodec(metadata?.audioCodec) || (hasAudio(metadata) ? 'unknown' : 'none'),
    contentType: outputContentType(container, mode),
    copyVideo,
    copyAudio,
    requiresFfmpeg: mode !== 'direct',
    requiresSeekRestart: mode !== 'direct',
  };
}

export function browserPlaybackPlanForMetadata(
  filePath: string,
  metadata?: LocalMediaDetails,
  options: TranscodeOptions = {},
): BrowserPlaybackPlan {
  const container = normalizeContainer(filePath, metadata);
  const hasSelectedTracks = selectedTrackOptions(options);
  const videoCodec = normalizeCodec(metadata?.videoCodec);
  const audioCodec = normalizeCodec(metadata?.audioCodec);
  const audioPresent = hasAudio(metadata) && options.audioTrackIndex !== -1;

  if (options.forceTranscode) {
    return makePlan('transcode', 'forced transcode requested', container, metadata, false, false);
  }

  if (
    typeof options.subtitleTrackIndex === 'number'
    || typeof options.secondarySubtitleTrackIndex === 'number'
    || options.subtitleFilePath
    || options.secondarySubtitleFilePath
  ) {
    return makePlan('transcode', 'selected subtitles must be burned into the video stream', container, metadata, false, audioPresent && isBrowserSafeAudio('mp4', metadata));
  }

  if (!metadata || !videoCodec) {
    if (isBrowserSafeContainer(container)) {
      return makePlan('direct', 'metadata unavailable; trying browser-safe container directly', container, metadata, false, false);
    }
    return makePlan('transcode', 'metadata unavailable for a browser-unsafe container', container, metadata, false, false);
  }

  const safeContainer = isBrowserSafeContainer(container);
  const safeVideoInSource = isBrowserSafeVideo(container, metadata);
  const safeAudioInSource = isBrowserSafeAudio(container, metadata);

  if (safeContainer && safeVideoInSource && safeAudioInSource && !hasSelectedTracks) {
    return makePlan('direct', 'container and streams match the browser playback profile', container, metadata, false, false);
  }

  const copyVideoToMp4 = isMp4CopyableVideo(metadata);
  const copyAudioToMp4 = audioPresent && ['aac', 'mp3'].includes(audioCodec);
  const audioPlayableInMp4 = !audioPresent || copyAudioToMp4;

  if (copyVideoToMp4 && audioPlayableInMp4) {
    const reason = hasSelectedTracks
      ? 'selected tracks require repackaging while streams remain browser-safe'
      : 'container is not browser-safe but video and audio can be stream-copied';
    return makePlan('remux', reason, container, metadata, true, copyAudioToMp4);
  }

  if (copyVideoToMp4) {
    return makePlan('direct-stream', 'video can be copied but audio must be converted for the browser', container, metadata, true, false);
  }

  return makePlan('transcode', 'video codec, profile, or pixel format is outside the browser playback profile', container, metadata, false, audioPresent && ['aac', 'mp3'].includes(audioCodec));
}
