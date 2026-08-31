import { buildExternalPlaybackReference } from './externalPlayback.ts';

const VIDKING_ORIGIN = 'https://www.vidking.net';
const TMDB_ID_PATTERN = /^\d+$/;

export function normalizeVidkingTmdbId(value: string | number | null | undefined): string {
  const id = String(value ?? '').trim();
  return TMDB_ID_PATTERN.test(id) ? id : '';
}

export function buildVidkingMoviePlaybackReference(tmdbId: string): string {
  const id = normalizeVidkingTmdbId(tmdbId);
  if (!id) throw new Error('A valid TMDB movie ID is required.');

  const url = new URL(`/embed/movie/${id}`, VIDKING_ORIGIN);
  url.searchParams.set('color', '1683ff');
  url.searchParams.set('autoPlay', 'true');
  return buildExternalPlaybackReference(url.toString());
}

export function buildVidkingTvPlaybackReference(
  tmdbId: string,
  season = 1,
  episode = 1,
): string {
  const id = normalizeVidkingTmdbId(tmdbId);
  if (!id) throw new Error('A valid TMDB show ID is required.');
  const safeSeason = Number.isInteger(season) && season > 0 ? season : 1;
  const safeEpisode = Number.isInteger(episode) && episode > 0 ? episode : 1;

  const url = new URL(`/embed/tv/${id}/${safeSeason}/${safeEpisode}`, VIDKING_ORIGIN);
  url.searchParams.set('color', '1683ff');
  url.searchParams.set('autoPlay', 'true');
  url.searchParams.set('nextEpisode', 'true');
  url.searchParams.set('episodeSelector', 'true');
  return buildExternalPlaybackReference(url.toString());
}
