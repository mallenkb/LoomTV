import { z } from 'zod';
import { cachedDesktopRead } from '@/lib/queryClient';
import { desktopApi, type StremioPluginCatalogItem } from '@/lib/desktopApi';
import { tmdbDetailResponseSchema, tmdbListResponseSchema } from '@/lib/tmdbSchemas';
import { cinemetaCatalog } from '@/pages/PluginDiscover/cinemeta';

export const ARCHIVE_ADDON_ID = 'org.archive.clean';
export const ARCHIVE_PAGE_SIZE = 30;
// Archive's search backend rejects leading wildcards in license URL queries.
const publicDomainLicenses = ['http:', 'https:'].flatMap(protocol => [
  `${protocol}//creativecommons.org/publicdomain/mark/1.0/`,
  `${protocol}//creativecommons.org/publicdomain/zero/1.0/`,
  `${protocol}//creativecommons.org/licenses/publicdomain/`,
]);
const textField = z.union([z.string(), z.array(z.string())]).optional();
const documentSchema = z.object({
  identifier: z.string().min(1), title: textField, description: textField,
  year: z.union([z.number(), z.string()]).optional(), date: z.string().optional(),
  downloads: z.union([z.number(), z.string()]).optional(), licenseurl: textField,
}).passthrough();
const searchSchema = z.object({ response: z.object({ numFound: z.number().nonnegative(), docs: z.array(documentSchema) }) });
const fileSchema = z.object({
  name: z.string(), format: z.string().optional(), source: z.string().optional(),
  size: z.union([z.string(), z.number()]).optional(), private: z.union([z.boolean(), z.string()]).optional(),
}).passthrough();
const metadataSchema = z.object({
  files: z.array(fileSchema).default([]),
  is_dark: z.boolean().optional(),
  metadata: z.object({ title: textField, description: textField, licenseurl: textField, access_restricted: textField }).passthrough().optional(),
}).passthrough();

export type ArchiveDocument = z.output<typeof documentSchema>;
export type ArchiveCatalogItem = StremioPluginCatalogItem & {
  identifier: string;
  archiveThumbnail: string;
  licenseUrl?: string;
};

function text(value: string | readonly string[] | undefined): string {
  return typeof value === 'string' ? value.trim() : value?.find(entry => entry.trim())?.trim() || '';
}

function plainDescription(value: string | readonly string[] | undefined): string {
  return text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function archiveItem(document: ArchiveDocument): ArchiveCatalogItem {
  const thumbnail = `https://archive.org/services/img/${encodeURIComponent(document.identifier)}`;
  const year = String(document.year ?? document.date?.slice(0, 4) ?? '');
  return {
    id: `archive:${document.identifier}`, identifier: document.identifier,
    type: 'movie', source: 'archive.org', title: text(document.title) || document.identifier.replaceAll(/[_-]+/g, ' '),
    genres: [], description: plainDescription(document.description),
    releaseInfo: /^(18|19|20)\d{2}$/.test(year) ? year : '',
    posterUrl: thumbnail, posterFallbackUrl: thumbnail, archiveThumbnail: thumbnail,
    licenseUrl: text(document.licenseurl),
  };
}

export async function archiveCatalog(query: string, page: number, order: string, year: string, signal: AbortSignal) {
  const url = new URL('https://archive.org/advancedsearch.php');
  const terms = [
    'mediatype:movies', 'collection:feature_films',
    `(${publicDomainLicenses.map(license => `licenseurl:"${license}"`).join(' OR ')})`,
    'NOT subject:(adult OR nudity OR sex OR porn OR pornography OR exploitation)',
  ];
  if (query.trim()) terms.push(`title:"${query.trim().replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);
  if (/^(18|19|20)\d{2}$/.test(year)) terms.push(`year:${year}`);
  url.searchParams.set('q', terms.join(' AND '));
  ['identifier', 'title', 'description', 'year', 'date', 'licenseurl'].forEach(field => url.searchParams.append('fl[]', field));
  url.searchParams.set('sort[]', order === 'new' ? 'publicdate desc' : 'downloads desc');
  url.searchParams.set('rows', String(ARCHIVE_PAGE_SIZE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('output', 'json');
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Archive.org returned ${response.status}.`);
  const payload: unknown = await response.json();
  if (payload && typeof payload === 'object' && 'error' in payload) {
    throw new Error('Archive.org search is temporarily unavailable. Please try again.');
  }
  const parsed = searchSchema.safeParse(payload);
  if (!parsed.success) throw new Error('Archive.org returned an unreadable catalog.');
  return parsed.data.response;
}

function videoPriority(file: z.output<typeof fileSchema>): number {
  const name = file.name.toLowerCase();
  if (file.private === true || file.private === 'true' || /(?:^|[_. -])(sample|trailer|preview|thumb)(?:[_. -]|$)/i.test(name)) return -1;
  if (Number(file.size) === 0) return -1;
  if (/\.mp4$/.test(name)) return /512kb|lowres/.test(name) ? 70 : 100;
  if (/\.m4v$/.test(name)) return 95;
  if (/\.webm$/.test(name)) return 90;
  if (/\.og[gv]$/.test(name)) return 80;
  if (/\.(mkv|mov|avi|mpg|mpeg|flv|ts)$/.test(name)) return 60;
  return -1;
}

/** Read the item record at Play and return its best video file. */
export async function resolveArchiveStream(identifier: string): Promise<string> {
  return cachedDesktopRead('archive-media', [identifier], async () => {
    const response = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Archive.org returned ${response.status}.`);
    const parsed = metadataSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Archive.org returned an unreadable media record.');
    const metadata = parsed.data;
    if (metadata.is_dark || text(metadata.metadata?.access_restricted) === 'true') throw new Error('Archive.org restricts access to this item.');
    const files = metadata.files.filter(file => videoPriority(file) >= 0);
    files.sort((a, b) => videoPriority(b) - videoPriority(a) || Number(b.size || 0) - Number(a.size || 0));
    const selected = files[0];
    if (!selected) throw new Error('Archive.org no longer lists a playable video file for this item.');
    return `https://archive.org/download/${encodeURIComponent(identifier)}/${selected.name.split('/').map(encodeURIComponent).join('/')}`;
  });
}

function normalizedTitle(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

export async function enrichArchiveItem(item: ArchiveCatalogItem, hasTmdb: boolean): Promise<ArchiveCatalogItem> {
  return cachedDesktopRead('archive-artwork', [item.identifier, item.title, item.releaseInfo, hasTmdb], async () => {
    const matches = (title: string, year?: string) => normalizedTitle(title) === normalizedTitle(item.title)
      && (!item.releaseInfo || Boolean(year && Math.abs(Number(year.slice(0, 4)) - Number(item.releaseInfo)) <= 1));
    if (hasTmdb) try {
      const response = tmdbListResponseSchema.parse(await desktopApi.requestMetadataProvider({
        provider: 'tmdb', path: 'search/movie', query: { query: item.title, include_adult: false, ...(item.releaseInfo ? { year: item.releaseInfo } : {}) },
      }));
      const candidates = response.results?.filter(movie => movie.adult !== true && matches(movie.title || movie.original_title || '', movie.release_date || '')) || [];
      const match = item.releaseInfo || candidates.length === 1 ? candidates[0] : undefined;
      if (match) {
        const details = await desktopApi.requestMetadataProvider({ provider: 'tmdb', path: `movie/${match.id}`, query: { append_to_response: 'credits' } })
          .then(payload => tmdbDetailResponseSchema.parse(payload)).catch(() => null);
        return {
          ...item, title: match.title || item.title, description: details?.overview || match.overview || item.description,
          posterUrl: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : item.posterUrl,
          backgroundUrl: match.backdrop_path ? `https://image.tmdb.org/t/p/w1280${match.backdrop_path}` : item.backgroundUrl,
          rating: typeof match.vote_average === 'number' ? match.vote_average : item.rating,
          genres: details?.genres?.map(genre => genre.name) || item.genres,
          runtime: details?.runtime ? `${details.runtime} min` : item.runtime,
          cast: details?.credits?.cast?.slice(0, 12).flatMap(person => person.name ? [{ name: person.name, character: person.character }] : []) || item.cast,
        };
      }
    } catch { /* Continue with the key-free metadata provider. */ }
    const results = await cinemetaCatalog('movie', 'popular', item.title, '', '');
    const candidates = results.filter(movie => matches(movie.title, movie.releaseInfo || movie.released));
    const match = item.releaseInfo || candidates.length === 1 ? candidates[0] : undefined;
    return match ? {
      ...item, title: match.title, description: match.description || item.description,
      posterUrl: match.posterUrl || item.posterUrl, backgroundUrl: match.backgroundUrl,
      rating: match.rating, runtime: match.runtime, genres: match.genres, cast: match.cast,
    } : item;
  });
}
