export interface MetadataProviderIds {
  tmdbId?: string;
  imdbId?: string;
  tvdbId?: string;
  tvmazeId?: string;
  malId?: string;
  malIdBySeason?: Record<string, string>;
}

export function parseMetadataProviderIds(value: string): MetadataProviderIds {
  const ids: MetadataProviderIds = {};
  const matches = value.matchAll(/(?:\[|\{)(tmdbid|tmdb|themoviedbid|imdbid|imdb|tvdbid|tvdb|tvmazeid|tvmaze)-([a-z0-9]+)(?:\]|\})/gi);
  for (const match of matches) {
    const provider = match[1].toLowerCase();
    const id = match[2];
    if (provider === 'imdbid' || provider === 'imdb') ids.imdbId = id.startsWith('tt') ? id : `tt${id}`;
    else if (provider === 'tvdbid' || provider === 'tvdb') ids.tvdbId = id;
    else if (provider === 'tvmazeid' || provider === 'tvmaze') ids.tvmazeId = id;
    else ids.tmdbId = id;
  }
  return ids;
}

export function mergeProviderIds(...sources: MetadataProviderIds[]): MetadataProviderIds {
  return sources.reduce<MetadataProviderIds>((merged, source) => ({
    tmdbId: merged.tmdbId || source.tmdbId,
    imdbId: merged.imdbId || source.imdbId,
    tvdbId: merged.tvdbId || source.tvdbId,
    tvmazeId: merged.tvmazeId || source.tvmazeId,
    malId: merged.malId || source.malId,
    malIdBySeason: {
      ...(merged.malIdBySeason || {}),
      ...(source.malIdBySeason || {}),
    },
  }), {});
}

export function tagValue(tags: Record<string, string> | undefined, ...names: string[]): string {
  if (!tags) return '';
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const match = Object.entries(tags).find(([key]) => wanted.has(key.toLowerCase()));
  return typeof match?.[1] === 'string' ? match[1] : '';
}

export function parseIntegerTag(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/\d+/);
  return match ? parseInt(match[0], 10) : undefined;
}

export function scrubTagText(value?: string): string {
  return value?.replace(/\s+/g, ' ').trim() || '';
}

export function providerIdsFromTags(tags: Record<string, string>): MetadataProviderIds {
  const directIds = {
    tmdbId: scrubTagText(tagValue(tags, 'tmdbid', 'tmdb_id', 'tmdb')),
    imdbId: scrubTagText(tagValue(tags, 'imdbid', 'imdb_id', 'imdb')),
    tvdbId: scrubTagText(tagValue(tags, 'tvdbid', 'tvdb_id', 'tvdb')),
    tvmazeId: scrubTagText(tagValue(tags, 'tvmazeid', 'tvmaze_id', 'tvmaze')),
  };
  if (directIds.imdbId && !directIds.imdbId.startsWith('tt')) directIds.imdbId = `tt${directIds.imdbId}`;

  return mergeProviderIds(
    parseMetadataProviderIds(Object.entries(tags).map(([key, value]) => `${key}-${value}`).join(' ')),
    directIds,
  );
}
