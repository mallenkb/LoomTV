import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { findFFprobe } from './mediaBinaries';
import type { MediaBackend, MediaTrack, ProbeResult } from './mediaTypes';

export const LOCAL_VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.webm', '.flv', '.m4v', '.mpeg', '.mpg', '.ts', '.m2ts', '.wmv', '.3gp',
]);

function streamType(value?: string): MediaTrack['type'] {
  if (value === 'video' || value === 'audio' || value === 'subtitle' || value === 'data') return value;
  return 'unknown';
}

export function assertLocalMediaPath(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') throw new Error('A local file path is required.');
  if (/^[a-z]+:\/\//i.test(filePath)) throw new Error('Remote URLs are not allowed.');
  if (!fs.existsSync(filePath)) throw new Error('Media file does not exist.');
  if (!fs.statSync(filePath).isFile()) throw new Error('Media path is not a file.');
  return filePath;
}

export function probeMedia(filePath: string): ProbeResult {
  assertLocalMediaPath(filePath);

  const ffprobe = findFFprobe();
  if (!ffprobe) throw new Error('ffprobe is not available.');

  const raw = execFileSync(
    ffprobe,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as {
    format?: { duration?: string; bit_rate?: string; format_name?: string };
    streams?: Array<{
      index?: number;
      codec_type?: string;
      codec_name?: string;
      profile?: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      channels?: number;
      tags?: Record<string, string>;
    }>;
  };

  const tracks: MediaTrack[] = (parsed.streams || []).map((stream) => ({
    index: stream.index || 0,
    type: streamType(stream.codec_type),
    codec: stream.codec_name,
    language: stream.tags?.language,
    title: stream.tags?.title,
    channels: stream.channels,
    width: stream.width,
    height: stream.height,
    profile: stream.profile,
    pixelFormat: stream.pix_fmt,
  }));

  const video = tracks.find((track) => track.type === 'video');
  const audio = tracks.find((track) => track.type === 'audio');

  return {
    filePath,
    container: parsed.format?.format_name?.split(',')[0],
    durationSeconds: parsed.format?.duration ? Math.round(Number(parsed.format.duration)) : undefined,
    bitrateKbps: parsed.format?.bit_rate ? Math.round(Number(parsed.format.bit_rate) / 1000) : undefined,
    videoCodec: video?.codec,
    audioCodec: audio?.codec,
    resolution: video ? { width: video.width, height: video.height } : undefined,
    subtitleStreams: tracks.filter((track) => track.type === 'subtitle'),
    tracks,
  };
}

export function canDirectPlay(_filePath: string, _probeResult: ProbeResult, backend: MediaBackend): boolean {
  if (backend === 'mpv') return true;

  if (backend === 'html5') {
    const videoCodec = (_probeResult.videoCodec || '').toLowerCase();
    const audioCodec = (_probeResult.audioCodec || '').toLowerCase();
    const video = _probeResult.tracks.find((track) => track.type === 'video');
    return videoCodec === 'h264'
      && video?.pixelFormat === 'yuv420p'
      && !String(video?.profile || '').toLowerCase().includes('10')
      && ['aac', 'mp3'].includes(audioCodec);
  }

  return false;
}
