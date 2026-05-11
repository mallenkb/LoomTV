export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

export function looksLikeGenericEpisodeTitle(title?: string, seriesTitle?: string, episode?: number): boolean {
  const value = (title || '').replace(/\s+/g, ' ').trim();
  if (!value) return true;

  const normalized = value.toLowerCase();
  const normalizedSeries = (seriesTitle || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const optionalEpisode = Number.isFinite(episode) ? String(episode) : '\\d{1,3}';

  return new RegExp(`^(?:episode|ep|e)\\s*0*${optionalEpisode}$`, 'i').test(value)
    || /\bS\d{1,2}E\d{1,3}\b/i.test(value)
    || /\.(?:720p|1080p|2160p|4k|amzn|nf|web|webrip|web-dl|hdtv|bluray|x264|x265|hevc|galaxytv)\b/i.test(value)
    || /\b(480p|720p|1080p|2160p|4k|uhd|amzn|nf|web[- .]?rip|web[- .]?dl|hdtv|bluray|blu[- .]?ray|x264|x265|h264|h265|hevc|galaxytv)\b/i.test(value)
    || /\b(visit|support|subscribe|telegram|downloaded|encoded|uploaded|released)\b/i.test(value)
    || /\b(anikaizoku|pahe|rarbg|eztv|yts|tgx|galaxyrg)\b/i.test(value)
    || /\bwww\.|\.com\b|\.net\b|\.org\b/i.test(value)
    || (Boolean(normalizedSeries) && normalized === normalizedSeries);
}

export function cleanEpisodeTitleForDisplay(
  title: string | undefined,
  seriesTitle: string | undefined,
  season: number,
  episode: number,
): string {
  const fallback = `Episode ${episode}`;
  const code = episodeCode(season, episode);
  const normalizedTitle = (title || '').replace(/\s+/g, ' ').trim();
  if (!normalizedTitle || looksLikeGenericEpisodeTitle(normalizedTitle, seriesTitle, episode)) return fallback;

  const titleWithoutCode = normalizedTitle
    .replace(new RegExp(`\\b${code}\\b`, 'ig'), '')
    .replace(new RegExp(`\\bS0*${season}E0*${episode}\\b`, 'ig'), '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!titleWithoutCode || looksLikeGenericEpisodeTitle(titleWithoutCode, seriesTitle, episode)) return fallback;
  return titleWithoutCode;
}
