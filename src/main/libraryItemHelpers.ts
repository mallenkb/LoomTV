import { createHash } from 'node:crypto';
import path from 'node:path';
import { isGenericGroupingFolderTitle, normalizeTitleForMatch, titleMatchesLocal, usefulLocalTitle } from './metadata/helpers';
import type { MediaItem } from './metadata/types';
import { durableArtworkSource } from './artworkSources';

const VTT_BOM_PREFIX = new RegExp(`^\\u{FEFF}?WEBVTT\\s*\\n+`, 'iu');

export function srtToVtt(input: string): string {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `WEBVTT\n\n${normalized
    .replace(VTT_BOM_PREFIX, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

export function createMediaItemId(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 32);
}

function mediaItemHasUsableArtwork(item: MediaItem): boolean {
  return Boolean(
    durableArtworkSource(item.poster)
    || durableArtworkSource(item.backdrop)
    || durableArtworkSource(item.logo)
    || item.posterCandidates?.some((source) => durableArtworkSource(source))
    || item.backdropCandidates?.some((source) => durableArtworkSource(source))
    || item.logoCandidates?.some((source) => durableArtworkSource(source)),
  );
}

export function looksLikeLocalEpisodeFileTitle(title?: string, seriesTitle?: string): boolean {
  const value = (title || '').trim();
  if (!value) return true;
  const normalized = value.toLowerCase();
  const normalizedSeries = (seriesTitle || '').trim().toLowerCase();
  return /\bS\d{1,2}E\d{1,3}\b/i.test(value)
    || /^episode\s+\d{1,3}$/i.test(value)
    || /^ep\s+\d{1,3}$/i.test(value)
    || /\.(?:720p|1080p|2160p|4k|amzn|nf|web|webrip|web-dl|hdtv|bluray|x264|x265|galaxytv)\b/i.test(value)
    || /\b(720p|1080p|2160p|4k|amzn|web[- .]?rip|web[- .]?dl|hdtv|bluray|x264|x265|galaxytv)\b/i.test(value)
    || /\b(visit|support|subscribe|telegram|downloaded|encoded|uploaded|released)\b/i.test(value)
    || /\b(anikaizoku|pahe|rarbg|eztv|yts|tgx|galaxyrg)\b/i.test(value)
    || /\bwww\.|\.com\b|\.net\b|\.org\b/i.test(value)
    || (Boolean(normalizedSeries) && normalized === normalizedSeries);
}

function seriesHasGenericEpisodeTitles(item: MediaItem): boolean {
  if (item.type === 'movie' || !item.episodeFiles?.length) return false;
  const byKey = new Map((item.episodes || []).map((episode) => [`${episode.season}-${episode.number}`, episode]));
  return item.episodeFiles.some((file) => {
    const title = byKey.get(`${file.season}-${file.episode}`)?.title || file.title || '';
    return looksLikeLocalEpisodeFileTitle(title, item.title);
  });
}

function cachedItemNeedsMetadataRefresh(item: MediaItem): boolean {
  const isSeries = item.type === 'tv' || item.type === 'anime' || Boolean(item.episodeFiles?.length);
  if (isSeries && (!item.year || item.year <= 0)) return true;
  if (isSeries && seriesHasGenericEpisodeTitles(item)) return true;
  return !mediaItemHasUsableArtwork(item);
}

export function cachedItemsAreComplete(items: MediaItem[]): boolean {
  return items.length > 0 && items.every((item) => !cachedItemNeedsMetadataRefresh(item));
}

export function isTrustedLocalTagTitle(structureTitle: string | null, tagTitle: string | null, rawStructureTitle: string): boolean {
  if (!tagTitle) return false;
  if (!structureTitle) return true;
  if (isGenericGroupingFolderTitle(rawStructureTitle)) return true;
  return titleMatchesLocal(structureTitle, tagTitle);
}

export function mostCommonUsefulTitle(candidates: Array<string | null | undefined>): string | null {
  const counts = new Map<string, { title: string; count: number }>();

  candidates.forEach((candidate) => {
    const title = usefulLocalTitle(candidate);
    if (!title) return;
    const key = normalizeTitleForMatch(title);
    counts.set(key, { title, count: (counts.get(key)?.count || 0) + 1 });
  });

  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.title || null;
}
