import type { MetadataProviderIds } from '../mediaTags';
import { deduplicateProviderSegments, durationIsCompatible, normalizeSegment } from './normalize.ts';
import type { NormalizedSegmentInput } from './types';
import { safeFetch } from '../safeFetch.ts';

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 3000;

export type ProviderLookupResult =
  | { kind: 'success'; segments: NormalizedSegmentInput[] }
  | { kind: 'empty'; segments: [] }
  | { kind: 'retry'; retryAfterMs?: number }
  | { kind: 'error' };

async function responseJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error('Skip-marker response was too large.');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Skip-marker response was too large.');
  return text ? JSON.parse(text) : {};
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

async function providerFetch(url: URL): Promise<{ response: Response; payload?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await safeFetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'LoomTV/skip-markers' },
      signal: controller.signal,
    }, {
      allowedHosts: ['api.theintrodb.org', 'api.aniskip.com'],
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    if (!response.ok) return { response };
    return { response, payload: await responseJson(response) };
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function theIntroDbLookupKey(
  ids: MetadataProviderIds,
  season?: number,
  episode?: number,
): string | null {
  const identity = ids.tmdbId
    ? `tmdb:${ids.tmdbId}`
    : ids.tvdbId
      ? `tvdb:${ids.tvdbId}`
      : ids.imdbId
        ? `imdb:${ids.imdbId}`
        : '';
  if (!identity) return null;
  return season === undefined || episode === undefined
    ? `${identity}:movie`
    : `${identity}:s${season}:e${episode}`;
}

export async function fetchTheIntroDbSegments(input: {
  ids: MetadataProviderIds;
  season?: number;
  episode?: number;
  durationMs: number;
}): Promise<ProviderLookupResult> {
  const lookupKey = theIntroDbLookupKey(input.ids, input.season, input.episode);
  if (!lookupKey) return { kind: 'empty', segments: [] };

  const url = new URL('https://api.theintrodb.org/v3/media');
  if (input.ids.tmdbId) url.searchParams.set('tmdb_id', input.ids.tmdbId);
  else if (input.ids.tvdbId) url.searchParams.set('tvdb_id', input.ids.tvdbId);
  else if (input.ids.imdbId) url.searchParams.set('imdb_id', input.ids.imdbId);
  if (input.season !== undefined && input.episode !== undefined) {
    url.searchParams.set('season', String(input.season));
    url.searchParams.set('episode', String(input.episode));
  }
  url.searchParams.set('duration_ms', String(Math.round(input.durationMs)));

  try {
    const { response, payload } = await providerFetch(url);
    if (response.status === 404 || response.status === 204) return { kind: 'empty', segments: [] };
    if (response.status === 429) return { kind: 'retry', retryAfterMs: retryAfterMs(response) };
    if (!response.ok || payload === undefined) return { kind: 'error' };

    const body = asRecord(payload);
    const root = asRecord(body.data || body.media || body);
    const sourceDurationMs = numberOrUndefined(root.duration_ms ?? root.durationMs ?? body.duration_ms);
    if (!durationIsCompatible(sourceDurationMs, input.durationMs)) return { kind: 'empty', segments: [] };

    const mappings = [
      ['intro', 'intro'],
      ['recap', 'recap'],
      ['credits', 'credits'],
      ['preview', 'preview'],
    ] as const;
    const segments: NormalizedSegmentInput[] = [];
    for (const [field, type] of mappings) {
      for (const raw of asArray(root[field])) {
        const value = asRecord(raw);
        const startMs = numberOrUndefined(value.start_ms ?? value.startMs) ?? (type === 'intro' || type === 'recap' ? 0 : undefined);
        const endValue = value.end_ms ?? value.endMs;
        const endMs = endValue === null || endValue === undefined
          ? (type === 'credits' || type === 'preview' ? null : undefined)
          : numberOrUndefined(endValue);
        if (startMs === undefined || endMs === undefined) continue;
        const normalized = normalizeSegment({ type, startMs, endMs, source: 'theintrodb', confidence: 0.92 }, input.durationMs);
        if (normalized) segments.push(normalized);
      }
    }
    const deduplicated = deduplicateProviderSegments(segments, input.durationMs);
    return deduplicated.length ? { kind: 'success', segments: deduplicated } : { kind: 'empty', segments: [] };
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError') console.warn('[TheIntroDB] marker lookup failed:', error);
    return { kind: 'error' };
  }
}

export function aniSkipLookupKey(malId: string | undefined, episode: number): string | null {
  return malId ? `mal:${malId}:e${episode}` : null;
}

export async function fetchAniSkipSegments(input: {
  malId?: string;
  episode: number;
  durationMs: number;
}): Promise<ProviderLookupResult> {
  const lookupKey = aniSkipLookupKey(input.malId, input.episode);
  if (!lookupKey || !input.malId) return { kind: 'empty', segments: [] };

  const url = new URL(`https://api.aniskip.com/v2/skip-times/${encodeURIComponent(input.malId)}/${input.episode}`);
  for (const type of ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap']) url.searchParams.append('types', type);
  url.searchParams.set('episodeLength', String(Math.max(1, Math.round(input.durationMs / 1000))));

  try {
    const { response, payload } = await providerFetch(url);
    if (response.status === 404 || response.status === 204) return { kind: 'empty', segments: [] };
    if (response.status === 429) return { kind: 'retry', retryAfterMs: retryAfterMs(response) };
    if (!response.ok || payload === undefined) return { kind: 'error' };

    const body = asRecord(payload);
    if (body.found === false) return { kind: 'empty', segments: [] };
    const results = asArray(body.results ?? body.data);
    const segments: NormalizedSegmentInput[] = [];
    for (const raw of results) {
      const value = asRecord(raw);
      const interval = asRecord(value.interval);
      const skipType = String(value.skipType ?? value.skip_type ?? '').toLowerCase();
      const type = skipType === 'op' || skipType === 'mixed-op'
        ? 'intro'
        : skipType === 'ed' || skipType === 'mixed-ed'
          ? 'credits'
          : skipType === 'recap'
            ? 'recap'
            : null;
      if (!type) continue;
      const sourceDurationSeconds = numberOrUndefined(value.episodeLength ?? value.episode_length);
      if (!durationIsCompatible(sourceDurationSeconds ? sourceDurationSeconds * 1000 : undefined, input.durationMs)) continue;
      const startSeconds = numberOrUndefined(interval.startTime ?? interval.start_time);
      const endSeconds = numberOrUndefined(interval.endTime ?? interval.end_time);
      if (startSeconds === undefined || endSeconds === undefined) continue;
      const normalized = normalizeSegment({
        type,
        startMs: startSeconds * 1000,
        endMs: endSeconds * 1000,
        source: 'aniskip',
        confidence: 0.92,
      }, input.durationMs);
      if (normalized) segments.push(normalized);
    }
    const deduplicated = deduplicateProviderSegments(segments, input.durationMs);
    return deduplicated.length ? { kind: 'success', segments: deduplicated } : { kind: 'empty', segments: [] };
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError') console.warn('[AniSkip] marker lookup failed:', error);
    return { kind: 'error' };
  }
}
