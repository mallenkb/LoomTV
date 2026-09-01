import type { EpisodeMeta } from './types.ts';

export function parseYearFromText(value?: string): number {
  if (!value) return 0;
  const match = value.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1], 10) : 0;
}

export function yearFromDateString(value?: string): number {
  if (!value) return 0;
  const year = new Date(value).getFullYear();
  return Number.isFinite(year) ? year : parseYearFromText(value);
}

function yearsMatch(localYear?: number, remoteYear?: number): boolean {
  if (!localYear || !remoteYear) return true;
  return Math.abs(localYear - remoteYear) <= 1;
}

export function numericRating(value: unknown): number {
  const rating = typeof value === 'number' ? value : parseFloat(String(value || ''));
  return Number.isFinite(rating) && rating > 0 ? rating : 0;
}

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
interface TMDBLogoImage {
  file_path?: string;
  iso_639_1?: string | null;
  vote_average?: number;
}

export function tmdbLogoCandidates(details: unknown): string[] {
  const rawLogos = (details as { images?: { logos?: unknown } } | null | undefined)?.images?.logos;
  const logos: TMDBLogoImage[] = Array.isArray(rawLogos) ? rawLogos : [];

  return Array.from(new Set(logos
    .filter((logo) => logo?.file_path && (logo.iso_639_1 === 'en' || logo.iso_639_1 === null))
    .sort((a, b) => {
      const leftLanguageScore = a.iso_639_1 === 'en' ? 1 : 0;
      const rightLanguageScore = b.iso_639_1 === 'en' ? 1 : 0;
      return rightLanguageScore - leftLanguageScore
        || (Number(b.vote_average) || 0) - (Number(a.vote_average) || 0);
    })
    .map((logo) => `${TMDB_IMAGE_BASE}/original${logo.file_path}`)
    .slice(0, 6)));
}

export function normalizeTitleForMatch(value?: string | null): string {
  return (value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGenericMediaFolderTitle(value: string): boolean {
  const normalized = normalizeTitleForMatch(value);
  return /^(movie|movies|film|films|tv|tv shows|shows|series|season|anime|animations?)$/i
    .test(normalized)
    || /^(?:season|series|s)\s*0*\d{1,2}(?:\s|$)/i.test(normalized);
}

export function isGenericGroupingFolderTitle(value: string): boolean {
  const normalized = normalizeTitleForMatch(value);
  return isGenericMediaFolderTitle(value)
    || /^(complete|completed|batch|batches|pack|packs|collection|collections|part|part \d+|pt|pt \d+|cour|cour \d+|volume|volume \d+|vol|vol \d+|episodes|episode|1080p|720p|2160p|4k)$/.test(normalized);
}

export function cleanMediaTitle(name: string): { title: string; year: number } {
  const withoutExt = name.replace(/\.(3gp|avi|divx|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|mxf|ogm|ogv|ts|vob|webm|wmv|vtt|srt|ass|ssa)$/i, '');
  const yearMatches = [...withoutExt.matchAll(/\b(19\d{2}|20\d{2})\b/g)];
  const maxReleaseYear = new Date().getFullYear() + 1;
  const releaseYearMatch =
    yearMatches.find((match) => match.index !== undefined && match.index > 0 && parseInt(match[1], 10) <= maxReleaseYear)
    || yearMatches.find((match) => parseInt(match[1], 10) <= maxReleaseYear);
  const titleSource = releaseYearMatch?.index && releaseYearMatch.index > 0
    ? withoutExt.slice(0, releaseYearMatch.index).replace(/[\s([._-]+$/, ' ')
    : withoutExt;
  const title = titleSource
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\b(480p|720p|1080p|2160p|4k|uhd|hdr10|hdr|dv|dolby|vision|bluray|blu-ray|brrip|webrip|web-rip|web-dl|webdl|hdtv|remux|proper|repack|extended|directors?|cut|imax|x264|x265|h264|h265|hevc|av1|aac|ac3|eac3|dts|truehd|atmos)\b/gi, ' ')
    .replace(/\b(yts|rarbg|ettv|eztv|tgx|galaxyrg|psa|pahe|ntb|successfulcrab)\b/gi, ' ')
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(/\s+[Ss]\d{1,2}[Ee]\d{1,3}.*$/, '')
    .replace(/\s+[Ss]\d{1,2}\s*$/, '')
    .replace(/\s+season\s+\d{1,2}\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title: title || withoutExt.trim() || name,
    year: releaseYearMatch ? parseInt(releaseYearMatch[1], 10) : 0,
  };
}

export function usefulLocalTitle(value?: string | null): string | null {
  const title = cleanMediaTitle(value || '').title;
  if (!title || isGenericGroupingFolderTitle(title)) return null;
  return title;
}

export function uniqueLocalTitles(candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];

  candidates.forEach((candidate) => {
    const title = usefulLocalTitle(candidate);
    if (!title) return;
    const key = normalizeTitleForMatch(title);
    if (seen.has(key)) return;
    seen.add(key);
    titles.push(title);
  });

  return titles;
}

function countUsefulTitles(candidates: Array<string | null | undefined>): Array<{ title: string; count: number }> {
  const counts = new Map<string, { title: string; count: number }>();

  candidates.forEach((candidate) => {
    const title = usefulLocalTitle(candidate);
    if (!title) return;
    const key = normalizeTitleForMatch(title);
    counts.set(key, { title, count: (counts.get(key)?.count || 0) + 1 });
  });

  return [...counts.values()];
}

function basenameFromPath(value?: string | null): string {
  return (value || '').split(/[\\/]/).pop() || '';
}

export function seriesTitleFromEpisodeFileName(value?: string | null): string | null {
  if (!value) return null;
  const withoutExt = basenameFromPath(value).replace(/\.(3gp|avi|divx|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|mxf|ogm|ogv|ts|vob|webm|wmv)$/i, '');
  const withoutReleaseGroups = withoutExt.replace(/\[[^\]]*]/g, ' ');
  const beforeEpisodeMarker = withoutReleaseGroups
    .replace(/\s+-\s+S\d{1,2}E\d{1,3}\s+-\s+.*$/i, ' ')
    .replace(/\s+[Ss]\d{1,2}[Ee]\d{1,3}\s+.*$/i, ' ')
    .replace(/\s+-\s+\d{1,3}\s*$/i, ' ')
    .replace(/\s+\d{1,3}\s*$/i, ' ');
  const title = cleanMediaTitle(beforeEpisodeMarker).title;
  if (!title || isGenericGroupingFolderTitle(title)) return null;
  return title;
}

/**
 * Extract the human-readable title after an SxxExx marker. File names are the
 * canonical local source here: embedded MKV titles can describe a different
 * release of the same episode.
 */
export function episodeTitleFromFileName(value?: string | null): string {
  if (!value) return '';
  const withoutExt = basenameFromPath(value).replace(/\.(3gp|avi|divx|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|mxf|ogm|ogv|ts|vob|webm|wmv)$/i, '');
  const match = withoutExt.match(/[Ss]\s*0*\d{1,2}\s*[._ -]*[Ee]\s*0*\d{1,3}[\s._-]*(.*)$/i);
  if (!match?.[1]) return '';
  return match[1]
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function bestSeriesTitleFromEpisodeFiles(files: Array<{ filePath?: string | null }>): string | null {
  const counts = countUsefulTitles(files.map((file) => seriesTitleFromEpisodeFileName(file.filePath)));
  if (counts.length === 0) return null;
  return counts
    .sort((a, b) =>
      b.count - a.count
      || normalizeTitleForMatch(a.title).length - normalizeTitleForMatch(b.title).length)[0].title;
}

export function chooseMetadataSearchTitle({
  itemTitle,
  embeddedTitle,
  folderTitle,
  parsedPathTitle,
  episodeSeriesTitle,
  fallbackTitle,
}: {
  itemTitle?: string | null;
  embeddedTitle?: string | null;
  folderTitle?: string | null;
  parsedPathTitle?: string | null;
  episodeSeriesTitle?: string | null;
  fallbackTitle?: string | null;
}): string {
  const displayTitle = usefulLocalTitle(itemTitle);
  const structuralTitle =
    usefulLocalTitle(folderTitle)
    || usefulLocalTitle(parsedPathTitle)
    || usefulLocalTitle(episodeSeriesTitle);
  const trustedDisplayTitle = displayTitle
    && (!structuralTitle || titleMatchesLocal(structuralTitle, displayTitle))
    ? displayTitle
    : null;

  return trustedDisplayTitle
    || structuralTitle
    || displayTitle
    || usefulLocalTitle(embeddedTitle)
    || fallbackTitle
    || '';
}

export function titleMatchesLocal(localTitle: string, remoteTitle?: string): boolean {
  const local = normalizeTitleForMatch(localTitle);
  const remote = normalizeTitleForMatch(remoteTitle);
  if (!local || !remote) return false;
  if (local === remote) return true;

  const localTokens = new Set(local.split(' ').filter((token) => token.length > 2));
  const remoteTokens = new Set(remote.split(' ').filter((token) => token.length > 2));
  if (localTokens.size === 0 || remoteTokens.size === 0) return false;
  if (localTokens.size > 1 && [...localTokens].every((token) => remoteTokens.has(token))) return true;
  if (remoteTokens.size > 1 && [...remoteTokens].every((token) => localTokens.has(token))) return true;

  let shared = 0;
  localTokens.forEach((token) => {
    if (remoteTokens.has(token)) shared++;
  });
  return shared / Math.max(localTokens.size, remoteTokens.size) >= 0.75;
}

export function remoteMatchesAnyLocalTitle(localTitles: string[], remoteTitle?: string): boolean {
  return localTitles.some((localTitle) => titleMatchesLocal(localTitle, remoteTitle));
}

export function movieHitMatchesLocal(
  hit: { title?: string; original_title?: string; release_date?: string },
  localTitles: string[],
  localYear?: number,
): boolean {
  if (!remoteMatchesAnyLocalTitle(localTitles, hit.title) && !remoteMatchesAnyLocalTitle(localTitles, hit.original_title)) {
    return false;
  }
  return yearsMatch(localYear, yearFromDateString(hit.release_date));
}

export function uniqueMetadataSearchHits<T>(hits: T[], keyForHit: (hit: T) => string): T[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = keyForHit(hit);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function episodeKey(episode: Pick<EpisodeMeta, 'season' | 'number'>): string {
  return `${episode.season}-${episode.number}`;
}

function normalizedSpecialEpisodeTitle(value?: string | null): string {
  return normalizeTitleForMatch(value)
    .replace(/\b(first|one)\b/g, '1')
    .replace(/\b(second|two)\b/g, '2')
    .replace(/\b(third|three)\b/g, '3')
    .replace(/\b(fourth|four)\b/g, '4')
    .replace(/\b(?:specials?|part|pt|episodes?|eps?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function specialEpisodeTitlesMatch(localTitle: string, remoteTitle: string): boolean {
  const local = normalizedSpecialEpisodeTitle(localTitle);
  const remote = normalizedSpecialEpisodeTitle(remoteTitle);
  if (!local || !remote) return false;
  return local === remote || local.endsWith(` ${remote}`) || remote.endsWith(` ${local}`);
}

export function findEpisodeMetadataMatch(
  local: EpisodeMeta,
  remoteEpisodes: EpisodeMeta[],
): EpisodeMeta | undefined {
  // Specials are often numbered differently by providers. Prefer a matching
  // title before falling back to the numeric key, otherwise local S00E01 can
  // incorrectly receive an unrelated provider S00E01 recap.
  if (local.season === 0 && local.title) {
    const titledMatch = remoteEpisodes.find((remote) => (
      remote.season === 0 && specialEpisodeTitlesMatch(local.title, remote.title)
    ));
    if (titledMatch) return titledMatch;
  }

  return remoteEpisodes.find((remote) => episodeKey(remote) === episodeKey(local));
}

export function mergeEpisodeMetadataSources(
  localEpisodes: EpisodeMeta[],
  remoteSources: Array<EpisodeMeta[] | null | undefined>,
  options: { ratingSourceOrder?: number[] } = {},
): EpisodeMeta[] {
  const availableSources = remoteSources
    .map((source, index) => ({ source, index }))
    .filter((entry): entry is { source: EpisodeMeta[]; index: number } => Boolean(entry.source?.length));

  if (availableSources.length === 0) return localEpisodes;

  return localEpisodes.map((local) => {
    const remotes = availableSources
      .map(({ source, index }) => ({ index, episode: findEpisodeMetadataMatch(local, source) }))
      .filter((entry): entry is { index: number; episode: EpisodeMeta } => Boolean(entry.episode));

    if (remotes.length === 0) return local;

    const ratingRemotes = options.ratingSourceOrder
      ? options.ratingSourceOrder
        .map((sourceIndex) => remotes.find((entry) => entry.index === sourceIndex)?.episode)
        .filter((episode): episode is EpisodeMeta => Boolean(episode))
      : remotes.map(({ episode }) => episode);

    return {
      ...local,
      title: remotes.find(({ episode }) => Boolean(episode.title))?.episode.title || local.title,
      summary: local.summary || remotes.find(({ episode }) => Boolean(episode.summary))?.episode.summary || '',
      still: remotes.find(({ episode }) => Boolean(episode.still))?.episode.still || local.still,
      rating: local.rating || ratingRemotes.find((episode) => numericRating(episode.rating) > 0)?.rating || 0,
      airDate: local.airDate || remotes.find(({ episode }) => Boolean(episode.airDate))?.episode.airDate || '',
    };
  });
}
