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

export function yearsMatch(localYear?: number, remoteYear?: number): boolean {
  if (!localYear || !remoteYear) return true;
  return Math.abs(localYear - remoteYear) <= 1;
}

export function numericRating(value: unknown): number {
  const rating = typeof value === 'number' ? value : parseFloat(String(value || ''));
  return Number.isFinite(rating) && rating > 0 ? rating : 0;
}

export function normalizeTitleForMatch(value?: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGenericMediaFolderTitle(value: string): boolean {
  return /^(movie|movies|film|films|tv|tv shows|shows|series|season|season \d+|anime|animations?)$/i
    .test(normalizeTitleForMatch(value));
}

export function isGenericGroupingFolderTitle(value: string): boolean {
  const normalized = normalizeTitleForMatch(value);
  return isGenericMediaFolderTitle(value)
    || /^(complete|completed|batch|batches|pack|packs|collection|collections|part|part \d+|pt|pt \d+|cour|cour \d+|volume|volume \d+|vol|vol \d+|episodes|episode|1080p|720p|2160p|4k)$/.test(normalized);
}

export function cleanMediaTitle(name: string): { title: string; year: number } {
  const withoutExt = name.replace(/\.(mkv|mp4|avi|mov|webm|m4v|wmv|flv|mpg|mpeg|m2ts|3gp|ts|vtt|srt|ass|ssa)$/i, '');
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
