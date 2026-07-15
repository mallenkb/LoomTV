type RemoteEpisode = { number: number };
type LocalEpisode = { episode: number };
type AnimeSeasonMetadata = {
  malId?: number;
  title?: string;
  aliases?: string[];
  episodes?: RemoteEpisode[];
};

function normalizedTitle(value: string): string {
  return value.toLowerCase().replace(/\b(the|a|an)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function titlesAgree(localTitle: string, remoteTitle: string): boolean {
  const local = normalizedTitle(localTitle);
  const remote = normalizedTitle(remoteTitle);
  return Boolean(local && remote && (local === remote || local.includes(remote) || remote.includes(local)));
}

export function isConfidentAnimeSeasonMapping(
  metadata: AnimeSeasonMetadata,
  localTitle: string,
  localEpisodes: LocalEpisode[],
  usedMalIds: ReadonlySet<number> = new Set(),
): boolean {
  if (!metadata.malId || usedMalIds.has(metadata.malId) || !metadata.episodes?.length) return false;
  const aliases = [metadata.title, ...(metadata.aliases || [])].filter((value): value is string => Boolean(value));
  const titleMatches = aliases.some((alias) => titlesAgree(localTitle, alias));
  const highestLocalEpisode = Math.max(0, ...localEpisodes.map((file) => file.episode));
  const highestRemoteEpisode = Math.max(0, ...metadata.episodes.map((episode) => episode.number));
  return titleMatches && highestRemoteEpisode >= highestLocalEpisode;
}
