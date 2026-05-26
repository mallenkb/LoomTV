import path from 'node:path';
import { probeMediaFile } from './mediaProbeFile';

export function needsTranscoding(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.mkv', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.m2ts', '.3gp', '.ts'].includes(ext);
}

export function needsBrowserTranscoding(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (needsTranscoding(filePath)) return true;
  if (!['.mp4', '.m4v', '.mov', '.webm'].includes(ext)) return true;

  const probe = probeMediaFile(filePath);
  const videoCodec = (probe.localMetadata?.videoCodec || '').toLowerCase();
  const videoProfile = (probe.localMetadata?.videoProfile || '').toLowerCase();
  const pixelFormat = (probe.localMetadata?.pixelFormat || '').toLowerCase();
  const audioCodec = (probe.localMetadata?.audioCodec || '').toLowerCase();

  if (ext === '.webm') {
    return !['vp8', 'vp9', 'av1'].includes(videoCodec) || !['opus', 'vorbis'].includes(audioCodec);
  }

  const safeH264 = videoCodec === 'h264'
    && pixelFormat === 'yuv420p'
    && !videoProfile.includes('10');

  return !safeH264 || !['aac', 'mp3'].includes(audioCodec);
}
