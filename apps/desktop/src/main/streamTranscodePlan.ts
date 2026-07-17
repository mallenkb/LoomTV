import type { TranscodeOptions } from './mediaTypes';
import {
  appendH264EncoderOptions,
  hasBitmapSubtitleSelection,
  hasSubtitleSelection,
  streamMap,
  subtitleFilterComplex,
  subtitleSelections,
  textSubtitleFilter,
  type H264HardwareEncoder,
} from './transcodeFilters.ts';

export interface BrowserStreamArgsRequest {
  filePath: string;
  options: TranscodeOptions;
  copyVideo: boolean;
  copyAudio: boolean;
  hardwareEncoder: H264HardwareEncoder | null;
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
  const args: string[] = ['-nostdin'];

  if (typeof options.startSeconds === 'number' && options.startSeconds > 0) {
    args.push('-ss', String(Math.floor(options.startSeconds)));
  }
  args.push('-i', filePath);

  if (hasSubtitle && bitmapSubtitle) {
    const subtitleFilter = subtitleFilterComplex(filePath, options);
    args.push('-filter_complex', subtitleFilter.filter, '-map', `[${subtitleFilter.output}]`);
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
    args.push('-vf', textSubtitleFilter(
      filePath,
      primarySubtitle.streamOrdinal,
      options.subtitleStyle,
      options.startSeconds,
      secondarySubtitle?.streamOrdinal,
      primarySubtitle?.filePath,
      secondarySubtitle?.filePath,
    ));
  } else if (!copyVideo && !bitmapSubtitle) {
    args.push('-vf', 'format=yuv420p');
  }

  args.push('-c:v', copyVideo ? 'copy' : hardwareEncoder || 'libx264');
  if (hardwareEncoder) {
    appendH264EncoderOptions(args, hardwareEncoder);
  } else if (!copyVideo) {
    args.push('-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main');
  }

  if (options.audioTrackIndex === -1) {
    args.push('-an');
  } else {
    args.push('-c:a', copyAudio ? 'copy' : 'aac');
    if (!copyAudio) args.push('-b:a', '192k', '-ac', '2');
  }

  args.push(
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  );
  return args;
}
