const MEDIA_FORMAT_LABELS: Record<string, string> = {
  MOVIE: 'Movie',
  FILM: 'Movie',
  TV: 'TV',
  TV_SHOW: 'TV',
  TV_SHORT: 'TV Short',
  TV_SPECIAL: 'TV Special',
  OVA: 'OVA',
  ONA: 'ONA',
  SPECIAL: 'Special',
  MUSIC: 'Music',
  CM: 'Commercial',
  PV: 'Promotional Video',
  MV: 'Music Video',
};

function normalizedFormat(value?: string | null): string {
  return (value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

export function mediaFormatLabel(
  format?: string | null,
  type?: 'movie' | 'tv' | 'anime' | string,
): string {
  const normalized = normalizedFormat(format);
  const normalizedType = normalizedFormat(type);
  // "Anime" identifies the catalog category, not the AniList medium. Keep
  // the category in the hero text and use the medium badge for TV, Movie,
  // OVA, ONA, Special, and similar formats.
  if (normalizedType === 'ANIME' && normalized === 'ANIME') return 'TV';
  if (normalized && MEDIA_FORMAT_LABELS[normalized]) return MEDIA_FORMAT_LABELS[normalized];
  if (format?.trim()) {
    return format
      .trim()
      .toLowerCase()
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }
  if (normalizedType === 'ANIME') return 'TV';
  if (normalizedType === 'TV' || normalizedType === 'TV_SHOW' || normalizedType === 'SERIES' || normalizedType === 'SHOW') return 'TV';
  if (normalizedType === 'MOVIE' || normalizedType === 'FILM') return 'Movie';
  return 'Movie';
}
