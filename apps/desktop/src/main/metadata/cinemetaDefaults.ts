import type { EpisodeMeta, MediaItem } from './types.ts';
import { remoteMatchesAnyLocalTitle } from './helpers.ts';
import { mergeProviderIds } from '../mediaTags.ts';
import { isMeaningfulCinemetaEpisodeTitle } from '../../shared/cinemetaEpisodeTitles.ts';

type FetchCandidates = typeof import('./cinemeta.ts').fetchCinemetaMetadataCandidates;

export async function lookupAutomaticCinemeta(
  fetchCandidates: FetchCandidates | undefined,
  title: string,
  type: 'movie' | 'series',
  year?: number,
  imdbId?: string,
  localTitles: string[] = [],
): Promise<Partial<MediaItem> | null> {
  if (!fetchCandidates) return null;
  try {
    const candidates = await fetchCandidates(title, type, year, imdbId, localTitles);
    if (imdbId) return candidates.find((candidate) => candidate.providerIds?.imdbId === imdbId) || null;
    const matches = candidates.filter((candidate) => (
      remoteMatchesAnyLocalTitle([title, ...localTitles], candidate.title)
      && (!year || candidate.year === year)
    ));
    // An automatic import must not choose between same-named titles by chance.
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

export function preferCinemetaEpisodes(
  episodes: EpisodeMeta[] | undefined,
  remoteEpisodes: EpisodeMeta[] | undefined,
  seriesTitle?: string,
): EpisodeMeta[] | undefined {
  if (!remoteEpisodes?.length) return episodes;
  const byKey = new Map(remoteEpisodes.map((episode) => [`${episode.season}-${episode.number}`, episode]));
  return episodes?.map((episode) => {
    const remote = byKey.get(`${episode.season}-${episode.number}`);
    if (!remote) return episode;
    return {
      ...episode,
      title: isMeaningfulCinemetaEpisodeTitle(remote.title, seriesTitle) ? remote.title : episode.title,
      summary: remote.summary || episode.summary,
      still: remote.still || episode.still,
      rating: remote.rating || episode.rating,
      airDate: remote.airDate || episode.airDate,
    };
  });
}

export function preferCinemetaMetadata<T extends Partial<MediaItem>>(
  fallback: T,
  metadata: Partial<MediaItem> | null,
  localArtwork: { poster?: string; backdrop?: string } = {},
): T & Partial<MediaItem> {
  if (!metadata) return fallback;
  const artworkCandidates = (local: string | undefined, remote: string | undefined, existing: string[] | undefined) => (
    [...new Set([local, remote, ...(existing || [])].filter((url): url is string => Boolean(url)))]
  );
  const imdb = metadata.providerRatings?.imdb;
  const episodes = preferCinemetaEpisodes(fallback.episodes, metadata.episodes, metadata.title);
  const episodeTitles = new Map(episodes?.map((episode) => [`${episode.season}-${episode.number}`, episode.title]));
  return {
    ...fallback,
    title: metadata.title || fallback.title,
    year: metadata.year || fallback.year,
    poster: localArtwork.poster || metadata.poster || fallback.poster,
    backdrop: localArtwork.backdrop || metadata.backdrop || fallback.backdrop,
    logo: metadata.logo || fallback.logo,
    posterCandidates: artworkCandidates(localArtwork.poster, metadata.poster, fallback.posterCandidates),
    backdropCandidates: artworkCandidates(localArtwork.backdrop, metadata.backdrop, fallback.backdropCandidates),
    logoCandidates: artworkCandidates(undefined, metadata.logo, fallback.logoCandidates),
    summary: metadata.summary || fallback.summary,
    rating: metadata.rating || fallback.rating,
    providerRatings: imdb ? {
      ...fallback.providerRatings,
      imdb: { ...fallback.providerRatings?.imdb, ...imdb },
    } : fallback.providerRatings,
    runtime: metadata.runtime || fallback.runtime,
    seasonCount: metadata.seasonCount || fallback.seasonCount,
    episodeCount: metadata.episodeCount || fallback.episodeCount,
    genres: metadata.genres?.length ? metadata.genres : fallback.genres,
    // Cinemeta's cast contains names only; retain character names and portraits.
    cast: fallback.cast?.length ? fallback.cast : metadata.cast || fallback.cast,
    episodes,
    episodeFiles: fallback.episodeFiles?.map((file) => ({
      ...file,
      title: episodeTitles.get(`${file.season}-${file.episode}`) || file.title,
    })),
    providerIds: mergeProviderIds(fallback.providerIds || {}, metadata.providerIds || {}),
  };
}
