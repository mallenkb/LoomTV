import path from 'node:path';
import { cleanMediaTitle } from './metadata/helpers';
import { fetchJikanMetadata } from './metadata/jikan';
import type { JikanAnimeResult } from './metadata/jikan';
import type { OMDbResponse } from './metadata/omdb';
import type { EpisodeFile, EpisodeMeta, TVMetadata } from './metadata/types';

export function isTVPattern(folderName: string, files: string[]): boolean {
  const lower = folderName.toLowerCase();
  if (/season/i.test(lower)) return true;
  if (/[Ss]\d{1,2}[Ee]\d{1,3}/.test(folderName)) return true;
  const hasEpisodeFiles = files.some((f) => /[Ss]\d{1,2}[Ee]\d{1,3}/.test(f) || /[Ee]pisode/i.test(f));
  return files.length > 2 && hasEpisodeFiles;
}

export function createSubtitleRecords(basePath: string, subtitleFiles: string[]) {
  return subtitleFiles.map((f) => {
    const lm = f.match(/\[(\w{2,3})\]|\.(\w{2,3})\./i);
    const lang = lm ? (lm[1] || lm[2] || 'en') : 'en';
    return {
      lang: lang.toLowerCase(),
      label: lang.toUpperCase(),
      url: `/subtitle?path=${encodeURIComponent(path.join(basePath, f))}`,
    };
  });
}

export function isLikelyTVFromFileName(name: string): boolean {
  return /[Ss]\d{1,2}[Ee]\d{1,3}/.test(name) || /(?:episode|ep|e)\s*\d{1,3}\b/i.test(name);
}

export function seriesTitleFromEpisodeFileName(fileName: string): string | null {
  const withoutExt = fileName.replace(/\.[^.]+$/, '');
  const match = withoutExt.match(/^(.+?)[._ -]+[Ss]\s*\d{1,2}\s*[._ -]*[Ee]\s*\d{1,3}\b/);
  if (!match) return null;
  const title = cleanMediaTitle(match[1]).title;
  return title && !/^(season|series|episode|ep)$/i.test(title) ? title : null;
}

export function inferSeriesTitleFromEpisodeFiles(files: EpisodeFile[], fallbackTitle: string): string {
  const counts = new Map<string, { title: string; count: number }>();
  for (const file of files) {
    const title = seriesTitleFromEpisodeFileName(path.basename(file.filePath));
    if (!title) continue;
    const key = title.toLowerCase();
    counts.set(key, { title, count: (counts.get(key)?.count || 0) + 1 });
  }

  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  if (!best) return fallbackTitle;
  if (best.count === files.length || best.count >= Math.max(2, Math.ceil(files.length * 0.6))) return best.title;
  return fallbackTitle;
}

export function shouldTreatAsTV(
  titleCandidate: string,
  videoFiles: string[],
  hasSeasonDirs: boolean,
  representativeProbe?: { embeddedShowTitle?: string; season?: number; episode?: number },
): boolean {
  if (hasSeasonDirs) return true;
  if (representativeProbe?.embeddedShowTitle) return true;
  if (representativeProbe?.season || representativeProbe?.episode) return true;
  return isTVPattern(titleCandidate, videoFiles) || videoFiles.some((file) => isLikelyTVFromFileName(file));
}

export function isLikelyAnimePath(filePath: string, title = ''): boolean {
  const value = `${filePath} ${title}`.toLowerCase();
  return /(^|[\\/._ -])(anime|animes|donghua|ova|ona)([\\/._ -]|$)/i.test(value)
    || /\b(horriblesubs|subsplease|erai-raws|judas|ember|commie|hakat[a]? ramen)\b/i.test(value);
}

export function inferAnimeSeasonSearchTitles(episodeFiles: EpisodeFile[], fallbackTitle: string): Map<number, string> {
  const titlesBySeason = new Map<number, Map<string, { title: string; count: number }>>();

  for (const file of episodeFiles) {
    const title = seriesTitleFromEpisodeFileName(path.basename(file.filePath));
    if (!title) continue;
    const seasonTitles = titlesBySeason.get(file.season) || new Map<string, { title: string; count: number }>();
    const key = title.toLowerCase();
    const current = seasonTitles.get(key);
    seasonTitles.set(key, { title, count: (current?.count || 0) + 1 });
    titlesBySeason.set(file.season, seasonTitles);
  }

  const result = new Map<number, string>();
  for (const [season, titles] of titlesBySeason) {
    const best = [...titles.values()].sort((a, b) => b.count - a.count)[0];
    result.set(season, best?.title || fallbackTitle);
  }

  if (!result.has(1)) result.set(1, fallbackTitle);
  return result;
}

export async function fetchJikanEpisodesForLocalAnimeSeasons(
  episodeFiles: EpisodeFile[],
  fallbackTitle: string,
  firstSeasonMetadata?: JikanAnimeResult | null,
): Promise<EpisodeMeta[]> {
  const seasonTitles = inferAnimeSeasonSearchTitles(episodeFiles, fallbackTitle);
  const results: EpisodeMeta[] = [];
  const usedMalIds = new Set<number>();

  for (const [season, title] of [...seasonTitles.entries()].sort(([a], [b]) => a - b)) {
    let metadata = season === 1 ? firstSeasonMetadata : null;
    if (!metadata || (metadata.malId && usedMalIds.has(metadata.malId))) {
      metadata = await fetchJikanMetadata(title);
    }
    if (!metadata?.episodes?.length) continue;
    if (metadata.malId) usedMalIds.add(metadata.malId);

    results.push(...metadata.episodes.map((episode) => ({ ...episode, season })));
  }

  return results;
}

export function mergeLocalSeasonsWithMetadata(
  localSeasons: { number: number; title: string; episodeCount: number }[],
  remoteSeasons?: { number: number; title: string; episodeCount: number }[],
): { number: number; title: string; episodeCount: number }[] {
  if (!remoteSeasons || remoteSeasons.length === 0) return localSeasons;

  const remoteByNumber = new Map(remoteSeasons.map((season) => [season.number, season]));
  return localSeasons.map((season) => {
    const remote = remoteByNumber.get(season.number);
    if (!remote) return season;
    return {
      number: season.number,
      title: remote.title || season.title,
      episodeCount: season.episodeCount,
    };
  });
}

export function listFromApiValue(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isAnimeMetadata(
  filePath: string,
  title: string,
  omdbData?: OMDbResponse | null,
  tvMeta?: TVMetadata | null,
): boolean {
  if (isLikelyAnimePath(filePath, title)) return true;

  const omdbGenres = listFromApiValue(omdbData?.Genre);
  const omdbCountries = listFromApiValue(omdbData?.Country);
  const omdbLanguages = listFromApiValue(omdbData?.Language);
  const tvGenres = (tvMeta?.genres || []).map((genre) => genre.toLowerCase());
  const tvLanguage = (tvMeta?.language || '').toLowerCase();
  const tvCountry = (tvMeta?.country || '').toLowerCase();
  const tvType = (tvMeta?.showType || '').toLowerCase();

  if ([...omdbGenres, ...tvGenres].some((genre) => genre.includes('anime'))) return true;
  if (tvType.includes('animation') && (tvLanguage.includes('japanese') || tvCountry.includes('japan'))) return true;
  if (tvGenres.includes('animation') && (tvLanguage.includes('japanese') || tvCountry.includes('japan'))) return true;
  if (omdbGenres.includes('animation') && (omdbCountries.includes('japan') || omdbLanguages.includes('japanese'))) return true;

  return false;
}

export function isSeriesMetadata(omdbData?: OMDbResponse | null, tvMeta?: TVMetadata | null): boolean {
  const type = String(omdbData?.Type || '').toLowerCase();
  return type === 'series' || type === 'episode' || Boolean(tvMeta?.episodes?.length || tvMeta?.seasons?.length);
}
