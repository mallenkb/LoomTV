import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { findFFprobe } from './mediaBinaries';
import { parseYearFromText } from './metadata/helpers';
import { mergeProviderIds, parseIntegerTag, providerIdsFromTags, scrubTagText, tagValue } from './mediaTags';
import type { MetadataProviderIds } from './mediaTags';
import type { LocalMediaDetails, LocalMediaTrack } from './metadata/types';

export interface ProbeMediaFileResult {
  localMetadata?: LocalMediaDetails;
  embeddedTitle?: string;
  embeddedShowTitle?: string;
  embeddedThumbnailStreamIndex?: number;
  summary?: string;
  year?: number;
  season?: number;
  episode?: number;
  providerIds?: MetadataProviderIds;
}

const mediaProbeCache = new Map<string, ProbeMediaFileResult>();
type MediaProbeCacheIdentity = { key: string; size: number; modifiedAtMs: number };

function streamType(value?: string): LocalMediaTrack['type'] {
  if (value === 'video' || value === 'audio' || value === 'subtitle' || value === 'data') return value;
  return 'unknown';
}

function mediaProbeCacheIdentity(filePath: string): MediaProbeCacheIdentity | null {
  try {
    const stats = fs.statSync(filePath);
    return {
      key: `${path.resolve(filePath)}:${stats.size}:${Math.round(stats.mtimeMs)}`,
      size: stats.size,
      modifiedAtMs: Math.round(stats.mtimeMs),
    };
  } catch {
    return null;
  }
}

async function mediaProbeCacheIdentityAsync(filePath: string): Promise<MediaProbeCacheIdentity | null> {
  try {
    const stats = await fs.promises.stat(filePath);
    return {
      key: `${path.resolve(filePath)}:${stats.size}:${Math.round(stats.mtimeMs)}`,
      size: stats.size,
      modifiedAtMs: Math.round(stats.mtimeMs),
    };
  } catch {
    return null;
  }
}

function cacheProbeResult(cacheKey: string | null, result: ProbeMediaFileResult): ProbeMediaFileResult {
  if (!cacheKey) return result;
  if (mediaProbeCache.size > 5000) mediaProbeCache.clear();
  mediaProbeCache.set(cacheKey, result);
  return result;
}

const ffprobeArguments = (filePath: string): string[] => [
  '-v', 'quiet',
  '-print_format', 'json',
  '-show_format',
  '-show_streams',
  '-show_chapters',
  filePath,
];

const ffprobeOptions = {
  encoding: 'utf8' as const,
  timeout: 15_000,
  maxBuffer: 1024 * 1024,
  windowsHide: true,
};

function execFileUtf8(filePath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(filePath, args, ffprobeOptions, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}

function probeMediaFileFromOutput(
  filePath: string,
  rawOutput?: string,
  knownIdentity?: MediaProbeCacheIdentity | null,
): ProbeMediaFileResult {
  const identity = knownIdentity === undefined ? mediaProbeCacheIdentity(filePath) : knownIdentity;
  const cacheKey = identity?.key || null;
  if (cacheKey) {
    const cached = mediaProbeCache.get(cacheKey);
    if (cached) return cached;
  }

  const ffprobePath = findFFprobe();
  if (!ffprobePath) return {};

  try {
    const raw = rawOutput ?? execFileSync(
      ffprobePath,
      ffprobeArguments(filePath),
      ffprobeOptions,
    );

    const parsed = JSON.parse(raw) as {
      format?: { duration?: string; bit_rate?: string; format_name?: string; tags?: Record<string, string> };
      streams?: Array<{
        index?: number;
        codec_type?: string;
        codec_name?: string;
        profile?: string;
        pix_fmt?: string;
        width?: number;
        height?: number;
        channels?: number;
        disposition?: Record<string, number>;
        tags?: Record<string, string>;
      }>;
      chapters?: Array<{
        start_time?: string;
        end_time?: string;
        tags?: Record<string, string>;
      }>;
    };

    const embeddedThumbnailStream = parsed.streams?.find((stream) =>
      stream.index !== undefined
      && (
        stream.disposition?.attached_pic === 1
        || (stream.codec_type === 'attachment' && /^(mjpeg|jpeg|png|webp|bmp)$/i.test(stream.codec_name || ''))
      ),
    );
    const mediaTracks: LocalMediaTrack[] = (parsed.streams || [])
      .filter((stream) => stream.disposition?.attached_pic !== 1 && stream.codec_type !== 'attachment')
      .map((stream) => ({
        index: stream.index || 0,
        type: streamType(stream.codec_type),
        codec: stream.codec_name,
        language: tagValue(stream.tags || {}, 'language'),
        title: scrubTagText(tagValue(stream.tags || {}, 'title', 'name')) || undefined,
        channels: stream.channels,
        width: stream.width,
        height: stream.height,
        profile: stream.profile,
        pixelFormat: stream.pix_fmt,
        default: stream.disposition?.default === 1,
        forced: stream.disposition?.forced === 1,
      }));
    const videoStream = parsed.streams?.find((stream) =>
      stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
    ) || parsed.streams?.find((stream) => stream.codec_type === 'video');
    const audioStreams = mediaTracks.filter((track) => track.type === 'audio');
    const subtitleStreams = mediaTracks.filter((track) => track.type === 'subtitle');
    const tags = parsed.format?.tags || {};
    const videoTags = videoStream?.tags || {};
    const preferredTitle = scrubTagText(
      tagValue(tags, 'title', 'name')
      || tagValue(videoTags, 'title', 'name'),
    );
    const preferredShowTitle = scrubTagText(
      tagValue(tags, 'show', 'showtitle', 'series', 'series_title', 'tvshow', 'tv_show', 'album')
      || tagValue(videoTags, 'show', 'showtitle', 'series', 'series_title', 'tvshow', 'tv_show', 'album'),
    );
    const summary = scrubTagText(
      tagValue(tags, 'description', 'comment', 'synopsis', 'overview', 'summary')
      || tagValue(videoTags, 'description', 'comment', 'synopsis', 'overview', 'summary'),
    );
    const year = parseYearFromText(
      tagValue(tags, 'date', 'year', 'originaldate', 'original_date', 'release_date', 'releasedate')
      || tagValue(videoTags, 'date', 'year', 'originaldate', 'original_date', 'release_date', 'releasedate'),
    );
    const season = parseIntegerTag(
      tagValue(tags, 'season_number', 'season', 'season_sort', 'part_number')
      || tagValue(videoTags, 'season_number', 'season', 'season_sort', 'part_number'),
    );
    const episode = parseIntegerTag(
      tagValue(tags, 'episode_sort', 'episode_id', 'episode_number', 'episode', 'track', 'tracknumber')
      || tagValue(videoTags, 'episode_sort', 'episode_id', 'episode_number', 'episode', 'track', 'tracknumber'),
    );

    return cacheProbeResult(cacheKey, {
      localMetadata: {
        fileSize: identity?.size,
        modifiedAtMs: identity?.modifiedAtMs,
        durationSeconds: parsed.format?.duration ? Math.round(parseFloat(parsed.format.duration)) : undefined,
        width: videoStream?.width,
        height: videoStream?.height,
        videoCodec: videoStream?.codec_name,
        videoProfile: videoStream?.profile,
        pixelFormat: videoStream?.pix_fmt,
        audioCodec: audioStreams[0]?.codec,
        audioTracks: audioStreams.length || undefined,
        subtitleTracks: subtitleStreams.length || undefined,
        tracks: mediaTracks.length ? mediaTracks : undefined,
        bitrateKbps: parsed.format?.bit_rate ? Math.round(parseInt(parsed.format.bit_rate, 10) / 1000) : undefined,
        container: parsed.format?.format_name?.split(',')[0],
        chapters: (parsed.chapters || []).flatMap((chapter) => {
          const startSeconds = Number(chapter.start_time);
          const endSeconds = Number(chapter.end_time);
          const title = scrubTagText(tagValue(chapter.tags || {}, 'title', 'name'));
          if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds || !title) return [];
          return [{ startMs: Math.round(startSeconds * 1000), endMs: Math.round(endSeconds * 1000), title }];
        }),
      },
      embeddedTitle: preferredTitle || undefined,
      embeddedShowTitle: preferredShowTitle || undefined,
      embeddedThumbnailStreamIndex: embeddedThumbnailStream?.index,
      summary: summary || undefined,
      year: year || undefined,
      season,
      episode,
      providerIds: mergeProviderIds(providerIdsFromTags(tags), providerIdsFromTags(videoTags)),
    });
  } catch (error) {
    console.error('ffprobe error for', filePath, error);
    return cacheProbeResult(cacheKey, {});
  }
}

export function probeMediaFile(filePath: string): ProbeMediaFileResult {
  return probeMediaFileFromOutput(filePath);
}

export async function probeMediaFileAsync(filePath: string): Promise<ProbeMediaFileResult> {
  const identity = await mediaProbeCacheIdentityAsync(filePath);
  const cacheKey = identity?.key || null;
  if (cacheKey) {
    const cached = mediaProbeCache.get(cacheKey);
    if (cached) return cached;
  }

  const ffprobePath = findFFprobe();
  if (!ffprobePath) return {};

  try {
    const raw = await execFileUtf8(ffprobePath, ffprobeArguments(filePath));
    return probeMediaFileFromOutput(filePath, raw, identity);
  } catch (error) {
    console.error('ffprobe error for', filePath, error);
    return cacheProbeResult(cacheKey, {});
  }
}
