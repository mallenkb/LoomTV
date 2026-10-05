import type { EpisodeMeta } from './types.ts';

type EpisodeKey = { season: number; number?: number; episode?: number };

/**
 * Files numbered by absolute episode inside a season folder ("S04E40" for the
 * first episode of season 4 after three 13-episode seasons) match no provider
 * entry. For each such file, add a copy of the provider episode it really is,
 * keyed by the file's own numbers, so its title, summary, still and rating
 * show. Exact matches always win; numbers that do not land inside the season
 * after subtracting the earlier seasons are left alone.
 */
export function alignAbsoluteEpisodes<T extends EpisodeMeta>(
  local: readonly EpisodeKey[],
  source: readonly T[] | null | undefined,
): T[] | null | undefined {
  if (!source?.length || !local.length) return source as T[] | null | undefined;
  const byKey = new Map(source.map((episode) => [`${episode.season}:${episode.number}`, episode]));
  const seasonLength = new Map<number, number>();
  for (const episode of source) {
    if (episode.season > 0) seasonLength.set(episode.season, Math.max(seasonLength.get(episode.season) || 0, episode.number));
  }
  const earlierThan = (season: number) => {
    let earlier = 0;
    for (const [other, count] of seasonLength) if (other < season) earlier += count;
    return earlier;
  };
  // A season counts as absolute-numbered only when every file in it is past
  // the provider's season and lands inside it once earlier seasons are
  // subtracted. One extra episode a provider has not listed yet is not that.
  const localBySeason = new Map<number, number[]>();
  for (const file of local) {
    const number = file.number ?? file.episode ?? 0;
    if (file.season > 0 && number > 0) localBySeason.set(file.season, [...(localBySeason.get(file.season) || []), number]);
  }
  const extra: T[] = [];
  for (const [season, numbers] of localBySeason) {
    const length = seasonLength.get(season) || 0;
    const earlier = earlierThan(season);
    if (!length || !earlier || !numbers.every((number) => number > length && number - earlier >= 1 && number - earlier <= length)) continue;
    for (const number of numbers) {
      if (byKey.has(`${season}:${number}`)) continue;
      const mapped = byKey.get(`${season}:${number - earlier}`);
      if (mapped) extra.push({ ...mapped, season, number });
    }
  }
  return extra.length ? [...source, ...extra] : source as T[];
}
