import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findFFprobe } from './mediaBinaries';
import { parseYearFromText } from './metadata/helpers';
import { mergeProviderIds, parseIntegerTag, providerIdsFromTags, scrubTagText, tagValue } from './mediaTags';
import type { MetadataProviderIds } from './mediaTags';
import type { LocalMediaDetails } from './metadata/types';

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

function mediaProbeCacheKey(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    return `${path.resolve(filePath)}:${stats.size}:${Math.round(stats.mtimeMs)}`;
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

export function probeMediaFile(filePath: string): ProbeMediaFileResult {
  const cacheKey = mediaProbeCacheKey(filePath);
  if (cacheKey) {
    const cached = mediaProbeCache.get(cacheKey);
    if (cached) return cached;
  }

  const ffprobePath = findFFprobe();
  if (!ffprobePath) return {};

  try {
    const raw = execFileSync(
      ffprobePath,
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { encoding: 'utf8' },
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
    };

    const embeddedThumbnailStream = parsed.streams?.find((stream) =>
      stream.index !== undefined
      && (
        stream.disposition?.attached_pic === 1
        || (stream.codec_type === 'attachment' && /^(mjpeg|jpeg|png|webp|bmp)$/i.test(stream.codec_name || ''))
      ),
    );
    const videoStream = parsed.streams?.find((stream) =>
      stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
    ) || parsed.streams?.find((stream) => stream.codec_type === 'video');
    const audioStreams = parsed.streams?.filter((stream) => stream.codec_type === 'audio') || [];
    const subtitleStreams = parsed.streams?.filter((stream) => stream.codec_type === 'subtitle') || [];
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
        durationSeconds: parsed.format?.duration ? Math.round(parseFloat(parsed.format.duration)) : undefined,
        width: videoStream?.width,
        height: videoStream?.height,
        videoCodec: videoStream?.codec_name,
        videoProfile: videoStream?.profile,
        pixelFormat: videoStream?.pix_fmt,
        audioCodec: audioStreams[0]?.codec_name,
        audioTracks: audioStreams.length || undefined,
        subtitleTracks: subtitleStreams.length || undefined,
        bitrateKbps: parsed.format?.bit_rate ? Math.round(parseInt(parsed.format.bit_rate, 10) / 1000) : undefined,
        container: parsed.format?.format_name?.split(',')[0],
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
