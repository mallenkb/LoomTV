import type { MediaItem, TVShow } from '@/contexts/LibraryContext';

function normalizeSearchText(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim();
}

export function searchQuery(value: string): string {
  return normalizeSearchText(value);
}

export function matchesMediaItem(item: MediaItem | TVShow, query: string): boolean {
  if (!query) return true;

  const searchable = [
    item.title,
    item.year > 0 ? String(item.year) : '',
    item.summary,
    ...(item.genres || []),
    ...(item.cast || []).flatMap((person) => [person.name, person.character]),
    ...('seasons' in item ? (item.seasons || []).map((season) => season.title) : []),
    ...('episodes' in item ? (item.episodes || []).flatMap((episode) => [
      episode.title,
      episode.summary,
      episode.airDate,
      `s${String(episode.season).padStart(2, '0')}e${String(episode.number).padStart(2, '0')}`,
    ]) : []),
    ...('episodeFiles' in item ? (item.episodeFiles || []).flatMap((episodeFile) => [
      episodeFile.title || '',
      episodeFile.filePath.split(/[\\/]/).pop() || '',
      `s${String(episodeFile.season).padStart(2, '0')}e${String(episodeFile.episode).padStart(2, '0')}`,
    ]) : []),
    item.filePath.split(/[\\/]/).pop() || '',
  ].join(' ');

  return normalizeSearchText(searchable).includes(query);
}
