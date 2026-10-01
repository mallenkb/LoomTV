import { z } from 'zod';
import type { MetadataProviderRequest, WireMediaItem } from '../shared/desktopProtocol.ts';
import { subtitleSearchUrl, type SubtitleVideo } from './openSubtitlesV3.ts';

type SubtitleItem = Pick<WireMediaItem, 'title' | 'year' | 'type' | 'providerIds'>;
type ProviderRequest = (request: MetadataProviderRequest) => Promise<unknown>;
const IMDB_ID = /^tt\d{5,12}$/;
const PROVIDER_ID = /^[1-9]\d{0,9}$/;
const externalIdsSchema = z.object({
  imdb_id: z.string().nullish(),
  externals: z.object({ imdb: z.string().nullish() }).nullish(),
});
const catalogSchema = z.object({ metas: z.array(z.object({
  id: z.string(), name: z.string(), type: z.string(),
  releaseInfo: z.string().nullish(), released: z.string().nullish(),
})) });

export function hasSubtitleImdbId(value?: string): value is string {
  return typeof value === 'string' && IMDB_ID.test(value);
}

function titleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function offlineError(error: unknown): boolean {
  return error instanceof Error && /metadata offline mode/i.test(error.message);
}

/** Resolve subtitle identity without changing the library's metadata or files. */
export async function resolveOnlineSubtitleVideo(
  item: SubtitleItem,
  episode: { season?: number; episode?: number },
  request: ProviderRequest,
  signal?: AbortSignal,
): Promise<SubtitleVideo> {
  const type = item.type === 'movie' ? 'movie' : 'series';
  const video: SubtitleVideo = { imdbId: item.providerIds?.imdbId || 'tt0000000', type, ...episode };
  // Reject missing episode coordinates before contacting any provider.
  subtitleSearchUrl({ ...video, imdbId: 'tt0000000' });
  signal?.throwIfAborted();
  if (hasSubtitleImdbId(item.providerIds?.imdbId)) return video;

  const ids = item.providerIds || {};
  const lookups: MetadataProviderRequest[] = [];
  if (ids.tmdbId && PROVIDER_ID.test(ids.tmdbId)) {
    lookups.push({ provider: 'tmdb', path: `${type === 'movie' ? 'movie' : 'tv'}/${ids.tmdbId}/external_ids` });
  }
  if (type === 'series') {
    if (ids.tvmazeId && PROVIDER_ID.test(ids.tvmazeId)) {
      lookups.push({ provider: 'tvmaze', path: `shows/${ids.tvmazeId}` });
    } else if (ids.tvdbId && PROVIDER_ID.test(ids.tvdbId)) {
      lookups.push({ provider: 'tvmaze', path: 'lookup/shows', query: { thetvdb: ids.tvdbId } });
    }
  }
  const crossReferences = await Promise.all(lookups.map(async (lookup) => {
    try {
      const raw = await request(lookup);
      signal?.throwIfAborted();
      const data = externalIdsSchema.parse(raw);
      const imdbId = data.imdb_id || data.externals?.imdb;
      return hasSubtitleImdbId(imdbId || undefined) ? imdbId : null;
    } catch (error) {
      signal?.throwIfAborted();
      if (offlineError(error)) throw error;
      // A missing API key or unavailable cross-reference need not block
      // the public, credential-free title lookup below.
      return null;
    }
  }));
  signal?.throwIfAborted();
  const matchedIds = new Set(crossReferences.filter((id): id is string => Boolean(id)));
  if (matchedIds.size > 1) throw new Error('The saved metadata IDs identify different IMDb titles. Correct the library match before searching for subtitles.');
  const knownId = [...matchedIds][0];
  if (knownId) return { ...video, imdbId: knownId };

  const title = item.title?.trim();
  if (!title) throw new Error('This video needs a title in your library before searching for subtitles.');
  const path = `catalog/${type}/top/search=${encodeURIComponent(title)}.json`;
  const raw = await request({ provider: 'cinemeta', path });
  signal?.throwIfAborted();
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) throw new Error('The title lookup returned invalid metadata. Try again later.');
  const data = parsed.data;
  const year = Number.isSafeInteger(item.year) && item.year > 0 ? item.year : null;
  const candidates = new Set(data.metas.filter((meta) => {
    const releasedYear = Number((meta.releaseInfo || meta.released || '').match(/^\d{4}/)?.[0]);
    return meta.type === type && hasSubtitleImdbId(meta.id) && titleKey(meta.name) === titleKey(title)
      && (year === null || releasedYear === year);
  }).map((meta) => meta.id));
  if (candidates.size !== 1) {
    throw new Error(candidates.size > 1
      ? 'More than one IMDb title matches this video. Correct the library match before searching for subtitles.'
      : 'Could not find an exact IMDb match for this title and year. Correct the library match before searching for subtitles.');
  }
  return { ...video, imdbId: [...candidates][0] };
}
