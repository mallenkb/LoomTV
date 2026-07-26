import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { findFFprobe } from './mediaBinaries';
import type { MediaBackend, MediaTrack, ProbeResult } from './mediaTypes';

const PROBE_CACHE_LIMIT = 1000;
const probeCache = new Map<string, ProbeResult>();
const execFileAsync = promisify(execFile);

function statLocalMediaPath(filePath: string): fs.Stats {
  if (!filePath || typeof filePath !== 'string') throw new Error('A local file path is required.');
  if (/^[a-z]+:\/\//i.test(filePath)) throw new Error('Remote URLs are not allowed.');

  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Media file does not exist.', { cause: error });
    }
    throw error;
  }
  if (!stats.isFile()) throw new Error('Media path is not a file.');
  return stats;
}

// ffprobe reports frame rates as exact rationals ("24000/1001"). Keeping the
// division here rather than trusting a rounded decimal matters: 23.976 and
// 24000/1001 diverge by whole frames over the length of an episode.
function parseFrameRate(value?: string): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator = '1'] = value.split('/');
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0 || top <= 0) return undefined;
  const fps = top / bottom;
  return Number.isFinite(fps) && fps > 0 ? fps : undefined;
}

function streamType(value?: string): MediaTrack['type'] {
  if (value === 'video' || value === 'audio' || value === 'subtitle' || value === 'data') return value;
  return 'unknown';
}

export function assertLocalMediaPath(filePath: string): string {
  statLocalMediaPath(filePath);
  return filePath;
}

function probeCacheKey(filePath: string, stats: fs.Stats): string {
  return `${path.resolve(filePath)}:${stats.size}:${Math.round(stats.mtimeMs)}`;
}

function cacheProbeResult(cacheKey: string, result: ProbeResult): ProbeResult {
  if (probeCache.size >= PROBE_CACHE_LIMIT) {
    const oldestKey = probeCache.keys().next().value;
    if (oldestKey) probeCache.delete(oldestKey);
  }
  probeCache.set(cacheKey, result);
  return result;
}

export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const stats = statLocalMediaPath(filePath);
  const cacheKey = probeCacheKey(filePath, stats);
  const cached = probeCache.get(cacheKey);
  if (cached) return cached;

  const ffprobe = findFFprobe();
  if (!ffprobe) throw new Error('ffprobe is not available.');

  const { stdout: raw } = await execFileAsync(
    ffprobe,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const parsed = JSON.parse(raw) as {
    format?: { duration?: string; bit_rate?: string; format_name?: string };
    streams?: Array<{
      index?: number;
      codec_type?: string;
      codec_name?: string;
      profile?: string;
      pix_fmt?: string;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      width?: number;
      height?: number;
      channels?: number;
      disposition?: Record<string, number>;
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
    frameRate: parseFrameRate(stream.avg_frame_rate) ?? parseFrameRate(stream.r_frame_rate),
    default: stream.disposition?.default === 1,
    forced: stream.disposition?.forced === 1,
  }));

  const video = tracks.find((track) => track.type === 'video');
  const audio = tracks.find((track) => track.type === 'audio');

  return cacheProbeResult(cacheKey, {
    filePath,
    container: parsed.format?.format_name?.split(',')[0],
    durationSeconds: parsed.format?.duration ? Math.round(Number(parsed.format.duration)) : undefined,
    bitrateKbps: parsed.format?.bit_rate ? Math.round(Number(parsed.format.bit_rate) / 1000) : undefined,
    videoCodec: video?.codec,
    audioCodec: audio?.codec,
    resolution: video ? { width: video.width, height: video.height } : undefined,
    subtitleStreams: tracks.filter((track) => track.type === 'subtitle'),
    tracks,
  });
}

export function canDirectPlay(_filePath: string, _probeResult: ProbeResult, backend: MediaBackend): boolean {
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
