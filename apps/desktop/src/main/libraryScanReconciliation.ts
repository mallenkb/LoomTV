import { mergeProviderIds } from './mediaTags';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './metadata/types';

function episodeKey(episode: Pick<EpisodeMeta, 'season' | 'number'>): string {
  return `${episode.season}-${episode.number}`;
}

function episodeFileKey(episodeFile: Pick<EpisodeFile, 'season' | 'episode'>): string {
  return `${episodeFile.season}-${episodeFile.episode}`;
}

export function preserveExistingItemDuringScan(fresh: MediaItem, existing?: MediaItem): MediaItem {
  if (!existing) return fresh;

  const episodeFiles = new Map<string, EpisodeFile>();
  for (const episodeFile of fresh.episodeFiles || []) {
    const key = episodeFileKey(episodeFile);
    // Full scans own filesystem-derived episode data. User-facing episode
    // metadata is preserved separately below, so stale probes/subtitle lists
    // must not overwrite a freshly scanned file record.
    episodeFiles.set(key, episodeFile);
  }

  const localEpisodeKeys = new Set(episodeFiles.keys());
  const episodes = new Map<string, EpisodeMeta>();
  for (const episode of existing.episodes || []) {
    const key = episodeKey(episode);
    if (localEpisodeKeys.size === 0 || localEpisodeKeys.has(key)) episodes.set(key, episode);
  }
  for (const episode of fresh.episodes || []) {
    const key = episodeKey(episode);
    if (!episodes.has(key) && (localEpisodeKeys.size === 0 || localEpisodeKeys.has(key))) {
      episodes.set(key, episode);
    }
  }

  const seasonCounts = new Map<number, number>();
  for (const episodeFile of episodeFiles.values()) {
    seasonCounts.set(episodeFile.season, (seasonCounts.get(episodeFile.season) || 0) + 1);
  }
  const seasons = new Map<number, NonNullable<MediaItem['seasons']>[number]>();
  for (const season of existing.seasons || []) {
    if (seasonCounts.has(season.number)) seasons.set(season.number, season);
  }
  for (const season of fresh.seasons || []) {
    if (!seasons.has(season.number)) seasons.set(season.number, season);
  }
  for (const [number, count] of seasonCounts) {
    const season = seasons.get(number);
    seasons.set(number, {
      number,
      title: season?.title || `Season ${String(number).padStart(2, '0')}`,
      episodeCount: count,
    });
  }

  // A scan owns filesystem-derived fields, but an existing library record owns
  // its chosen metadata and artwork. In particular, keep the complete artwork
  // candidate lists so cache pruning cannot discard a user's selected image.
  return {
    ...fresh,
    title: existing.title || fresh.title,
    year: existing.year || fresh.year,
    poster: existing.poster || fresh.poster,
    backdrop: existing.backdrop || fresh.backdrop,
    logo: existing.logo || fresh.logo,
    posterCandidates: existing.posterCandidates?.length ? existing.posterCandidates : fresh.posterCandidates,
    backdropCandidates: existing.backdropCandidates?.length ? existing.backdropCandidates : fresh.backdropCandidates,
    logoCandidates: existing.logoCandidates?.length ? existing.logoCandidates : fresh.logoCandidates,
    summary: existing.summary || fresh.summary,
    rating: existing.rating || fresh.rating,
    genres: existing.genres?.length ? existing.genres : fresh.genres,
    cast: existing.cast?.length ? existing.cast : fresh.cast,
    providerIds: mergeProviderIds(existing.providerIds || {}, fresh.providerIds || {}),
    seasons: seasons.size > 0
      ? [...seasons.values()].sort((left, right) => left.number - right.number)
      : fresh.seasons,
    episodes: episodes.size > 0
      ? [...episodes.values()].sort((left, right) => left.season - right.season || left.number - right.number)
      : fresh.episodes,
    episodeFiles: episodeFiles.size > 0
      ? [...episodeFiles.values()].sort((left, right) => left.season - right.season || left.episode - right.episode)
      : fresh.episodeFiles,
  };
}
