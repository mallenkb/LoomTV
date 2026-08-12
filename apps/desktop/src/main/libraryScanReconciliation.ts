import { mergeProviderIds } from './mediaTags';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './metadata/types';
import { normalizeAnimeCast } from '../shared/animeCast';

function episodeKey(episode: Pick<EpisodeMeta, 'season' | 'number'>): string {
  return `${episode.season}-${episode.number}`;
}

function episodeFileKey(episodeFile: Pick<EpisodeFile, 'season' | 'episode'>): string {
  return `${episodeFile.season}-${episodeFile.episode}`;
}

function hasStructuredAnimeCast(cast: MediaItem['cast'] | undefined): boolean {
  return Boolean(cast?.some((credit) => (
    credit.characterName || credit.characterImage || credit.voiceActorName
  )));
}

function hasValues(value: Record<string, unknown> | undefined): boolean {
  return Object.keys(value || {}).length > 0;
}

function uniqueValues(existing: string[] | undefined, fresh: string[] | undefined): string[] | undefined {
  const values = [...new Set([...(existing || []), ...(fresh || [])].filter(Boolean))];
  return values.length > 0 ? values : undefined;
}

function isGenericEpisodeTitle(title: string | undefined, episodeNumber: number): boolean {
  const normalized = title?.trim().toLowerCase() || '';
  return !normalized
    || normalized === `episode ${episodeNumber}`
    || normalized === `ep ${episodeNumber}`
    || normalized === `episode ${String(episodeNumber).padStart(2, '0')}`
    || normalized === `ep ${String(episodeNumber).padStart(2, '0')}`;
}

function animeCastKey(credit: MediaItem['cast'][number]): string {
  return (credit.characterName || credit.name || credit.character || '').trim().toLowerCase();
}

function mergeAnimeCast(existing: MediaItem['cast'], fresh: MediaItem['cast']): MediaItem['cast'] {
  if (!existing.length) return fresh;
  if (!fresh.length) return existing;

  const freshByCharacter = new Map(fresh.map((credit) => [animeCastKey(credit), credit]));
  const existingKeys = new Set(existing.map(animeCastKey));
  const mergeCredit = (current: MediaItem['cast'][number], incoming?: MediaItem['cast'][number]) => {
    if (!incoming) return current;
    const currentRole = current.characterRole?.trim().toLowerCase();
    const incomingRole = incoming.characterRole?.trim().toLowerCase();
    const role = currentRole === 'main' || currentRole === 'supporting' || currentRole === 'background'
      ? current.characterRole
      : incomingRole === 'main' || incomingRole === 'supporting' || incomingRole === 'background'
        ? incoming.characterRole
        : current.characterRole || incoming.characterRole || current.character || incoming.character;
    return {
      ...incoming,
      ...current,
      name: current.name || incoming.name,
      character: role || '',
      image: current.image || incoming.image,
      characterName: current.characterName || incoming.characterName,
      characterRole: role,
      characterImage: current.characterImage || incoming.characterImage,
      voiceActorName: current.voiceActorName || incoming.voiceActorName,
      voiceActorImage: current.voiceActorImage || incoming.voiceActorImage,
      voiceActorLanguage: current.voiceActorLanguage || incoming.voiceActorLanguage,
    };
  };

  return [
    ...existing.map((credit) => mergeCredit(credit, freshByCharacter.get(animeCastKey(credit)))),
    ...fresh.filter((credit) => !existingKeys.has(animeCastKey(credit))),
  ];
}

function genericCastKey(credit: MediaItem['cast'][number]): string {
  return `${credit.name || ''}\u0000${credit.character || ''}`.trim().toLowerCase();
}

function mergeGenericCast(existing: MediaItem['cast'], fresh: MediaItem['cast']): MediaItem['cast'] {
  if (!existing.length) return fresh;
  const existingKeys = new Set(existing.map(genericCastKey));
  return [...existing, ...fresh.filter((credit) => !existingKeys.has(genericCastKey(credit)))];
}

export function preserveExistingItemDuringScan(
  fresh: MediaItem,
  existing?: MediaItem,
  options: { refreshRatings?: boolean } = {},
): MediaItem {
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
  const existingEpisodes = new Map((existing.episodes || []).map((episode) => [episodeKey(episode), episode]));
  const episodes = new Map<string, EpisodeMeta>();
  for (const episode of fresh.episodes || []) {
    const key = episodeKey(episode);
    if (localEpisodeKeys.size > 0 && !localEpisodeKeys.has(key)) continue;
    const current = existingEpisodes.get(key);
    const keepCurrentTitle = current && !isGenericEpisodeTitle(current.title, episode.number);
    episodes.set(key, {
      ...episode,
      title: keepCurrentTitle ? current.title : episode.title || current?.title || '',
      summary: current?.summary || episode.summary || '',
      still: current?.still || episode.still || '',
      rating: options.refreshRatings && episode.rating > 0
        ? episode.rating
        : current?.rating || episode.rating || 0,
      airDate: current?.airDate || episode.airDate || '',
      localMetadata: episode.localMetadata || current?.localMetadata,
    });
  }
  for (const episode of existing.episodes || []) {
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
  const freshCast = fresh.type === 'anime' ? normalizeAnimeCast(fresh.cast) : fresh.cast;
  const existingCast = fresh.type === 'anime' ? normalizeAnimeCast(existing.cast) : existing.cast;
  const cast = fresh.type === 'anime'
    ? mergeAnimeCast(existingCast || [], hasStructuredAnimeCast(freshCast) ? freshCast || [] : [])
    : mergeGenericCast(existingCast || [], freshCast || []);
  const refreshRating = options.refreshRatings && fresh.rating > 0;

  return {
    ...fresh,
    format: existing.format || fresh.format,
    title: existing.title || fresh.title,
    year: existing.year || fresh.year,
    poster: existing.poster || fresh.poster,
    backdrop: existing.backdrop || fresh.backdrop,
    logo: existing.logo || fresh.logo,
    posterCandidates: uniqueValues(existing.posterCandidates, fresh.posterCandidates),
    backdropCandidates: uniqueValues(existing.backdropCandidates, fresh.backdropCandidates),
    logoCandidates: uniqueValues(existing.logoCandidates, fresh.logoCandidates),
    summary: existing.summary || fresh.summary,
    rating: refreshRating ? fresh.rating : existing.rating || fresh.rating,
    genres: existing.genres?.length ? existing.genres : fresh.genres,
    cast,
    contentRatings: hasValues(existing.contentRatings)
      ? { ...(fresh.contentRatings || {}), ...existing.contentRatings }
      : fresh.contentRatings,
    streamingProviders: existing.streamingProviders?.length
      ? existing.streamingProviders
      : fresh.streamingProviders,
    originPlatform: existing.originPlatform || fresh.originPlatform,
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
