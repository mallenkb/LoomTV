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

export interface BrowserStreamArgsRequest {
  filePath: string;
  options: TranscodeOptions;
  copyVideo: boolean;
  copyAudio: boolean;
  hardwareEncoder: HardwareVideoEncoder | null;
}

export function buildBrowserStreamArgs({
  filePath,
  options,
  copyVideo,
  copyAudio,
  hardwareEncoder,
}: BrowserStreamArgsRequest): string[] {
  const hasSubtitle = hasSubtitleSelection(options);
  const bitmapSubtitle = hasBitmapSubtitleSelection(options);
  const targetCodec = options.targetVideoCodec === 'hevc' || options.targetVideoCodec === 'av1' ? options.targetVideoCodec : 'h264';
  const scale = Number.isFinite(options.maxWidth) || Number.isFinite(options.maxHeight)
    ? `scale=${Number.isFinite(options.maxWidth) && options.maxWidth ? Math.floor(options.maxWidth) : -2}:${Number.isFinite(options.maxHeight) && options.maxHeight ? Math.floor(options.maxHeight) : -2}:force_original_aspect_ratio=decrease`
    : null;
  const args: string[] = ['-nostdin'];

  const needsVideoFilter = hasSubtitle || bitmapSubtitle || Boolean(scale) || Boolean(options.toneMap);
  if (hardwareEncoder?.endsWith('_vaapi')) {
    args.push('-vaapi_device', process.env.LOOMTV_VAAPI_DEVICE || process.env.VAAPI_DEVICE || '/dev/dri/renderD128');
  }
  if (!needsVideoFilter && hardwareEncoder?.endsWith('_nvenc')) {
    args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  } else if (!needsVideoFilter && hardwareEncoder?.endsWith('_qsv')) {
    args.push('-init_hw_device', 'qsv=hw', '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
  } else if (!needsVideoFilter && hardwareEncoder?.endsWith('_videotoolbox')) {
    args.push('-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld');
  } else if (!needsVideoFilter && hardwareEncoder?.endsWith('_vaapi')) {
    args.push('-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi');
  }

  if (typeof options.startSeconds === 'number' && options.startSeconds > 0) {
    // Stream-copy seeks can land video and audio on different packet
    // boundaries. Preserve their shared source timestamps, then shift that
    // shared timeline to zero for Chromium instead of normalizing each stream
    // independently.
    args.push(
      '-ss', String(Math.floor(options.startSeconds)),
      '-copyts',
      '-start_at_zero',
    );
  }
  args.push('-i', filePath);

  if (hasSubtitle && bitmapSubtitle) {
    const subtitleFilter = subtitleFilterComplex(filePath, options);
    const needsUpload = Boolean(hardwareEncoder && (hardwareEncoder.endsWith('_vaapi') || hardwareEncoder.endsWith('_qsv')));
    const output = needsUpload ? `${subtitleFilter.output}hw` : subtitleFilter.output;
    args.push(
      '-filter_complex',
      needsUpload
        ? `${subtitleFilter.filter};[${subtitleFilter.output}]format=nv12,hwupload[${output}]`
        : subtitleFilter.filter,
      '-map',
      `[${output}]`,
    );
  } else {
    args.push('-map', streamMap('v', options.videoTrackIndex));
  }

  if (options.audioTrackIndex !== -1) {
    args.push('-map', streamMap('a', options.audioTrackIndex, true));
  }

  args.push('-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1');

  if (hasSubtitle && !bitmapSubtitle) {
    const textSelections = subtitleSelections(options);
    const primarySubtitle = textSelections.find((selection) => selection.placement === 'primary') || textSelections[0];
    const secondarySubtitle = textSelections.find((selection) => selection !== primarySubtitle);
    const subtitleFilter = textSubtitleFilter(
      filePath,
      primarySubtitle.streamOrdinal,
      options.subtitleStyle,
      options.startSeconds,
      secondarySubtitle?.streamOrdinal,
      primarySubtitle?.filePath,
      secondarySubtitle?.filePath,
    );
    args.push('-vf', [subtitleFilter, scale, hardwareEncoder && (hardwareEncoder.endsWith('_vaapi') || hardwareEncoder.endsWith('_qsv')) ? 'format=nv12,hwupload' : null].filter(Boolean).join(','));
  } else if (!copyVideo && !bitmapSubtitle) {
    const toneMap = options.toneMap ? 'zscale=transfer=linear:npl=100,format=gbrpf32le,tonemap=mobius,zscale=transfer=bt709:primaries=bt709:matrix=bt709,format=yuv420p' : 'format=yuv420p';
    args.push('-vf', [toneMap, scale, hardwareEncoder && (hardwareEncoder.endsWith('_vaapi') || hardwareEncoder.endsWith('_qsv')) ? 'format=nv12,hwupload' : null].filter(Boolean).join(','));
  }

  const softwareEncoder = targetCodec === 'h264'
    ? 'libx264'
    : targetCodec === 'hevc'
      ? 'libx265'
      : options.softwareVideoEncoder === 'libaom-av1' ? 'libaom-av1' : 'libsvtav1';
  args.push('-c:v', copyVideo ? 'copy' : hardwareEncoder || softwareEncoder);
  if (hardwareEncoder) {
    appendHardwareEncoderOptions(args, hardwareEncoder);
  } else if (!copyVideo) {
    if (targetCodec === 'h264') args.push('-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main');
    if (targetCodec === 'hevc') args.push('-preset', 'medium', '-crf', '28', '-pix_fmt', 'yuv420p');
    if (targetCodec === 'av1') args.push('-preset', '8', '-crf', '32', '-pix_fmt', 'yuv420p');
  }
  if (!copyVideo && options.videoBitrateKbps && Number.isFinite(options.videoBitrateKbps)) {
    const bitrate = Math.max(128, Math.floor(options.videoBitrateKbps));
    args.push('-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`);
  }

  if (options.audioTrackIndex === -1) {
    args.push('-an');
  } else {
    args.push('-c:a', copyAudio ? 'copy' : 'aac');
    if (!copyAudio) args.push('-b:a', `${Number.isFinite(options.audioBitrateKbps) ? Math.max(32, Math.floor(options.audioBitrateKbps || 192)) : 192}k`, '-ac', '2');
  }

  args.push(
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  );
  return args;
}
