import { safeFetch } from '../safeFetch.ts';
import type { EpisodeMeta, MediaItem, TVMetadata } from './types.ts';
import { remoteMatchesAnyLocalTitle, uniqueLocalTitles, yearFromDateString } from './helpers.ts';

const TVDB_BASE = 'https://api4.thetvdb.com/v4';
const TVDB_ARTWORK_BASE = 'https://artworks.thetvdb.com/banners';
const TOKEN_TTL_MS = 28 * 24 * 60 * 60 * 1000;
const ARTWORK_TYPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

type TokenEntry = { token: string; expiresAt: number };

const tokenCache = new Map<string, TokenEntry>();
const loginRequests = new Map<string, Promise<string | null>>();
const artworkTypeCache = new Map<string, { values: Map<string, string>; expiresAt: number }>();
const artworkTypeRequests = new Map<string, Promise<Map<string, string>>>();

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function yearFromValue(value: unknown): number {
  const numeric = number(value);
  if (numeric >= 1900 && numeric <= 2200) return Math.round(numeric);
  return yearFromDateString(text(value));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeImage(value: unknown): string {
  const source = text(value);
  if (!source) return '';
  if (/^https?:\/\//i.test(source)) return source.replace(/^http:\/\//i, 'https://');
  if (source.startsWith('//')) return `https:${source}`;
  const path = source.replace(/^\/?banners\//i, '');
  return `${TVDB_ARTWORK_BASE}/${path}`;
}

function artworkType(record: JsonRecord, artworkTypes: Map<string, string>): string {
  const rawType = text(record.type);
  return `${rawType} ${artworkTypes.get(rawType) || ''} ${text(record.artworkType)} ${text(record.name)} ${text(record.slug)}`.toLowerCase();
}

function isPosterArtworkType(type: string): boolean {
  return type.includes('poster');
}

function isClearLogoArtworkType(type: string): boolean {
  return type.includes('clearlogo') || type.includes('clear logo');
}

function isTransparentLogoUrl(url: string): boolean {
  try {
    return /\.(?:png|webp)$/i.test(new URL(url).pathname);
  } catch {
    return /\.(?:png|webp)(?:$|[?#])/i.test(url);
  }
}

function isCoverArtworkType(type: string): boolean {
  return type.includes('background') && !type.includes('logo');
}

function typedArtworkUrls(series: JsonRecord, matcher: (type: string) => boolean, artworkTypes = new Map<string, string>()): string[] {
  return unique(asArray(series.artworks || series.artwork).flatMap((artwork) => {
    const record = asRecord(artwork);
    return record && matcher(artworkType(record, artworkTypes))
      ? [normalizeImage(record.image || record.image_url), normalizeImage(record.thumbnail), normalizeImage(record.url)]
      : [];
  }));
}

function remoteIdValue(record: JsonRecord): { source: string; id: string } | null {
  const id = text(record.id || record.value || record.remoteId);
  if (!id) return null;
  return { source: `${text(record.sourceName)} ${text(record.source)} ${text(record.type)}`.toLowerCase(), id };
}

function providerIds(series: JsonRecord, id: string): MediaItem['providerIds'] {
  const result: MediaItem['providerIds'] = { tvdbId: id || undefined };
  for (const raw of asArray(series.remoteIds || series.remote_ids)) {
    const remote = asRecord(raw);
    if (!remote) continue;
    const entry = remoteIdValue(remote);
    if (!entry) continue;
    if (entry.source.includes('imdb') && !result.imdbId) result.imdbId = entry.id.startsWith('tt') ? entry.id : `tt${entry.id}`;
    if (entry.source.includes('tmdb') && !result.tmdbId) result.tmdbId = entry.id;
    if (entry.source.includes('tvmaze') && !result.tvmazeId) result.tvmazeId = entry.id;
  }
  return result;
}

function genres(series: JsonRecord): string[] {
  return unique(asArray(series.genres).map((genre) => {
    const record = asRecord(genre);
    return record ? text(record.name || record.slug) : text(genre);
  }));
}

function tvdbEpisodeToMeta(episode: JsonRecord): EpisodeMeta {
  const season = number(episode.seasonNumber || episode.season || episode.season_number);
  const episodeNumber = number(episode.number || episode.episodeNumber || episode.episode_number);
  return {
    season: Math.max(0, Math.round(season)),
    number: Math.max(0, Math.round(episodeNumber)),
    title: text(episode.name || episode.title),
    summary: text(episode.overview || episode.summary),
    still: normalizeImage(episode.image || episode.filename),
    // TVDB search metadata does not provide a user rating. Keep the value empty
    // instead of treating its popularity score as a rating.
    rating: 0,
    airDate: text(episode.aired || episode.airDate || episode.air_date),
  };
}

function seasonsFromEpisodes(episodes: EpisodeMeta[]): Array<{ number: number; title: string; episodeCount: number }> {
  const counts = new Map<number, number>();
  episodes.forEach((episode) => {
    if (episode.season > 0 && episode.number > 0) counts.set(episode.season, (counts.get(episode.season) || 0) + 1);
  });
  return Array.from(counts, ([number, episodeCount]) => ({ number, title: `Season ${number}`, episodeCount }))
    .sort((left, right) => left.number - right.number);
}

function tvdbSeriesToMetadata(
  series: JsonRecord,
  fallbackTitle: string,
  localYear?: number,
  artworkTypes = new Map<string, string>(),
): TVMetadata | null {
  const id = text(series.id || series.tvdb_id || series.tvdbId);
  const title = text(series.name || series.title) || fallbackTitle;
  if (!id && !title) return null;

  const episodes = asArray(series.episodes)
    .map((episode) => tvdbEpisodeToMeta(asRecord(episode) || {}))
    .filter((episode) => episode.season > 0 && episode.number > 0);
  const seasons = asArray(series.seasons)
    .map((season) => {
      const record = asRecord(season) || {};
      return {
        number: Math.max(0, Math.round(number(record.number || record.seasonNumber || record.season_number))),
        title: text(record.name || record.title),
        episodeCount: Math.max(0, Math.round(number(record.episodeCount || record.episode_count || record.episodes))),
      };
    })
    .filter((season) => season.number > 0)
    .map((season) => ({ ...season, title: season.title || `Season ${season.number}` }));
  const posterCandidates = unique([
    ...typedArtworkUrls(series, isPosterArtworkType, artworkTypes),
    normalizeImage(series.image),
    normalizeImage(series.image_url),
    normalizeImage(series.poster),
    ...asArray(series.posters).map(normalizeImage),
  ]);
  const poster = posterCandidates[0] || '';
  const backdropCandidates = unique([
    ...typedArtworkUrls(series, isCoverArtworkType, artworkTypes),
  ]);
  const backdrop = backdropCandidates[0] || '';
  const logoCandidates = unique([
    ...typedArtworkUrls(series, isClearLogoArtworkType, artworkTypes),
  ]).filter(isTransparentLogoUrl);
  const cast = asArray(series.characters || series.cast).slice(0, 8).map((entry) => {
    const record = asRecord(entry) || {};
    return {
      name: text(record.personName || record.name || record.person_name),
      character: text(record.characterName || record.character || record.character_name),
      image: normalizeImage(record.personImgURL || record.image || record.personImage),
    };
  }).filter((credit) => credit.name || credit.character);
  const remoteSeasons = seasons.length > 0 ? seasons : seasonsFromEpisodes(episodes);
  const firstAired = series.firstAired || series.first_aired || series.firstAirDate || series.first_air_date;
  const resolvedYear = yearFromValue(series.year) || yearFromDateString(text(firstAired)) || localYear || 0;

  return {
    title,
    year: resolvedYear,
    poster,
    backdrop,
    posterCandidates,
    backdropCandidates,
    // Some TVDB records include transparent clear-logo artwork. Keep it in the
    // logo list so it cannot be presented as a poster or cover.
    logo: logoCandidates[0] || '',
    logoCandidates,
    summary: text(series.overview || series.summary),
    genres: genres(series),
    cast,
    language: text(series.originalLanguage || series.original_language || series.language),
    country: text(series.originalCountry || series.original_country || series.country),
    seasons: remoteSeasons.length > 0 ? remoteSeasons : undefined,
    episodes: episodes.length > 0 ? episodes : undefined,
    seasonCount: remoteSeasons.length || undefined,
    episodeCount: episodes.length || undefined,
    providerIds: providerIds(series, id),
  };
}

function searchResultTitle(result: JsonRecord): string {
  return text(result.name || result.title || result.seriesName);
}

function searchResultYear(result: JsonRecord): number {
  return yearFromValue(result.year || result.firstAired || result.first_aired || result.first_air_time);
}

async function login(apiKey: string): Promise<string | null> {
  const key = apiKey.trim();
  if (!key) return null;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const pending = loginRequests.get(key);
  if (pending) return pending;
  const request = (async () => {
    const response = await safeFetch(`${TVDB_BASE}/login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: key }),
    }, { allowedHosts: ['api4.thetvdb.com'], retries: 1, provider: 'tvdb' });
    if (!response.ok) return null;
    const payload = asRecord(await response.json().catch(() => null));
    const data = asRecord(payload?.data);
    const token = text(data?.token || payload?.token);
    if (!token) return null;
    tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
  })().catch(() => null).finally(() => loginRequests.delete(key));
  loginRequests.set(key, request);
  return request;
}

async function fetchTVDBJson(pathname: string, apiKey: string, retry = true): Promise<unknown | null> {
  const token = await login(apiKey);
  if (!token) return null;
  const response = await safeFetch(`${TVDB_BASE}${pathname}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  }, { allowedHosts: ['api4.thetvdb.com'], retries: 2, provider: 'tvdb' });
  if (response.status === 401 && retry) {
    tokenCache.delete(apiKey.trim());
    return fetchTVDBJson(pathname, apiKey, false);
  }
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

async function fetchTVDBArtworkTypes(apiKey: string): Promise<Map<string, string>> {
  const key = apiKey.trim();
  if (!key) return new Map();
  const cached = artworkTypeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.values;
  const pending = artworkTypeRequests.get(key);
  if (pending) return pending;
  const request = (async () => {
    const payload = await fetchTVDBJson('/artwork/types', key);
    const values = new Map<string, string>();
    for (const raw of asArray(responseData(payload))) {
      const record = asRecord(raw);
      if (!record) continue;
      const id = text(record.id);
      const name = text(record.name || record.slug);
      if (id && name) values.set(id, name.toLowerCase());
    }
    artworkTypeCache.set(key, { values, expiresAt: Date.now() + ARTWORK_TYPE_TTL_MS });
    return values;
  })().catch(() => new Map<string, string>()).finally(() => artworkTypeRequests.delete(key));
  artworkTypeRequests.set(key, request);
  return request;
}

function responseData(payload: unknown): unknown {
  const record = asRecord(payload);
  return record?.data ?? payload;
}

async function searchTVDB(title: string, localYear: number | undefined, apiKey: string): Promise<JsonRecord[]> {
  const query = new URLSearchParams({ query: title, type: 'series' });
  if (localYear) query.set('year', String(localYear));
  const payload = await fetchTVDBJson(`/search?${query.toString()}`, apiKey);
  return asArray(responseData(payload)).map(asRecord).filter((result): result is JsonRecord => Boolean(result));
}

export async function fetchTVDBMetadataById(tvdbId: string | undefined, apiKey?: string): Promise<TVMetadata | null> {
  const id = text(tvdbId);
  const key = text(apiKey);
  if (!id || !key) return null;
  try {
    const payload = await fetchTVDBJson(`/series/${encodeURIComponent(id)}/extended?meta=episodes`, key);
    const series = asRecord(responseData(payload));
    const artworkTypes = series ? await fetchTVDBArtworkTypes(key) : new Map<string, string>();
    return series ? tvdbSeriesToMetadata(series, '', undefined, artworkTypes) : null;
  } catch (error) {
    console.error('[TVDB series]', error);
    return null;
  }
}

export async function fetchTVDBMetadataCandidates(title: string, localYear?: number, apiKey?: string): Promise<TVMetadata[]> {
  const key = text(apiKey);
  if (!key || !title.trim()) return [];
  try {
    const results = await searchTVDB(title, localYear, key);
    const artworkTypes = await fetchTVDBArtworkTypes(key);
    const candidates = await Promise.all(results.map(async (result) => {
      const id = text(result.id || result.tvdb_id || result.tvdbId);
      return id
        ? fetchTVDBMetadataById(id, key)
        : tvdbSeriesToMetadata(result, searchResultTitle(result) || title, localYear, artworkTypes);
    }));
    return candidates.filter((candidate): candidate is TVMetadata => Boolean(candidate));
  } catch (error) {
    console.error('[TVDB candidates]', error);
    return [];
  }
}

export async function fetchTVDBMetadata(title: string, localYear?: number, apiKey?: string): Promise<TVMetadata | null> {
  const key = text(apiKey);
  if (!key || !title.trim()) return null;
  try {
    const results = await searchTVDB(title, localYear, key);
    if (results.length === 0) return null;
    const artworkTypes = await fetchTVDBArtworkTypes(key);
    const localTitles = uniqueLocalTitles([title]);
    const selected = results.find((result) => {
      const resultTitle = searchResultTitle(result);
      const resultYear = searchResultYear(result);
      return remoteMatchesAnyLocalTitle(localTitles, resultTitle) && (!localYear || !resultYear || Math.abs(localYear - resultYear) <= 1);
    }) || results[0];
    const id = text(selected.id || selected.tvdb_id || selected.tvdbId);
    return id
      ? fetchTVDBMetadataById(id, key)
      : tvdbSeriesToMetadata(selected, searchResultTitle(selected) || title, localYear, artworkTypes);
  } catch (error) {
    console.error('[TVDB]', error);
    return null;
  }
}
