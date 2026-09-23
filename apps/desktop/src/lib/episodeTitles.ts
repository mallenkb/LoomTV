export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function isFilePath(value: string): boolean {
  return /^(?:file:\/\/|[A-Za-z]:[\\/]|[\\/])/.test(value)
    || /[\\/][^\\/]+\.(?:mkv|mp4|m4v|mov|avi|webm|ts|wmv)$/i.test(value);
}

export function looksLikeGenericEpisodeTitle(title?: string, seriesTitle?: string, episode?: number): boolean {
  const value = (title || '').replace(/\s+/g, ' ').trim();
  if (!value) return true;
  if (isFilePath(value)) return true;

  const normalized = value.toLowerCase();
  const normalizedSeries = (seriesTitle || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const optionalEpisode = Number.isFinite(episode) ? String(episode) : '\\d{1,3}';
  const codeOnly = /^(?:S\d{1,2}\s*[-_. ]?\s*E\d{1,3}|\d{1,2}\s*x\s*\d{1,3})$/i.test(value);

  return new RegExp(`^(?:episode|ep|e)\\s*0*${optionalEpisode}$`, 'i').test(value)
    || codeOnly
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
  if (!normalizedTitle) return fallback;

  const titleWithoutCode = normalizedTitle
    .replace(new RegExp(`\\b${code}\\b`, 'ig'), '')
    .replace(new RegExp(`\\bS0*${season}\\s*[-_. ]?\\s*E0*${episode}\\b`, 'ig'), '')
    .replace(new RegExp(`\\b${season}\\s*x\\s*0*${episode}\\b`, 'ig'), '')
    .replace(new RegExp(`^0*${episode}\\s*[-–:._]+\\s*`, 'i'), '')
    .replace(/^[\s._:;|()[\]-]+|[\s._:;|()[\]-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const candidate = titleWithoutCode || normalizedTitle;
  if (!candidate || looksLikeGenericEpisodeTitle(candidate, seriesTitle, episode)) return fallback;
  return candidate;
}

export function episodeTitleFromFilePath(filePath: string | undefined, seriesTitle: string | undefined, season: number, episode: number): string {
  const fallback = `Episode ${episode}`;
  if (!filePath) return fallback;
  const fileName = filePath.split(/[\\/]/).pop()?.replace(/\.(?:3gp|avi|divx|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|mxf|ogm|ogv|ts|vob|webm|wmv)$/i, '') || '';
  const withoutCode = fileName.replace(new RegExp(`^.*?[Ss]0*${season}\\s*[Ee]0*${episode}\\s*[-–_.\\s]*`, 'i'), '');
  if (withoutCode === fileName) return fallback;
  const candidate = withoutCode
    .replace(/[\s._-]*(?:\[|\()?(?:2160p|1080p|720p|480p|4K|BluRay|BDRip|WEB-DL|WEBRip|HDTV|AMZN|NF|DSNP|x264|x265|H\.264|H\.265|HEVC|AAC|AC3|DTS)\b.*$/i, '')
    .replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleanEpisodeTitleForDisplay(candidate, seriesTitle, season, episode);
}
