import type { MediaItem, TVShow } from '@/contexts/LibraryContext';

export function firstPlayableMediaPath(item: MediaItem): string {
  if (item.type === 'movie') return item.filePath;
  return (item as TVShow).episodeFiles
    ?.slice()
    .sort((a, b) => a.season - b.season || a.episode - b.episode)[0]?.filePath || '';
}

export function availableSeasonCount(show: TVShow): number {
  const fileSeasons = new Set(
    (show.episodeFiles || []).map((file) => file.season).filter((season) => season > 0),
  );
  return fileSeasons.size || (show.seasons || []).length;
}

export function mediaLink(item: MediaItem): string {
  if (item.type === 'movie') return `/movie/${item.id}`;
  if (item.type === 'anime') return `/anime/${item.id}`;
  return `/tv/${item.id}`;
}

export function mediaMetaLine(item: MediaItem): string {
  const seasonCount = item.type === 'movie' ? 0 : availableSeasonCount(item as TVShow);
  return [
    item.year > 0 ? String(item.year) : '',
    seasonCount > 0 ? `${seasonCount} ${seasonCount === 1 ? 'Season' : 'Seasons'}` : '',
  ].filter(Boolean).join(' · ');
}
