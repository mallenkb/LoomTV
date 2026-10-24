import type { LanProviderRatings } from '@loom-media-server/lan-protocol';

export function hasCompleteVideoRatings(ratings: LanProviderRatings): boolean {
  return Boolean(ratings.imdb && ratings.rottenTomatoes && ratings.metacritic && ratings.popcornmeter);
}

/** Fill missing scores without replacing ratings already matched to this title. */
export async function resolveVideoRatings(options: {
  existing?: LanProviderRatings;
  loadOMDb: () => Promise<LanProviderRatings>;
  loadMDBList: () => Promise<LanProviderRatings>;
}): Promise<LanProviderRatings> {
  const existing = options.existing || {};
  if (hasCompleteVideoRatings(existing)) return existing;
  const primary = { ...await options.loadOMDb().catch(() => ({})), ...existing };
  if (hasCompleteVideoRatings(primary)) return primary;
  const fallback = await options.loadMDBList().catch(() => ({}));
  return { ...fallback, ...primary };
}
