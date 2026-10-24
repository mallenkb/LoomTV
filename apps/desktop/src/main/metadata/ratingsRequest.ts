import { createHash } from 'node:crypto';
import { safeFetch } from '../safeFetch.ts';

type Provider = 'omdb' | 'mdblist';
const hosts: Record<Provider, string> = { omdb: 'www.omdbapi.com', mdblist: 'api.mdblist.com' };
const cooldowns = new Map<Provider, { credential: string; until: number }>();
const cache = new Map<string, { until: number; payload: unknown }>();
const pending = new Map<string, Promise<unknown>>();
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHED_RESPONSE_BYTES = 128 * 1024;

function retryDelay(value: string | null): number {
  const seconds = Number(value);
  const parsedDate = value ? Date.parse(value) : NaN;
  const delay = seconds > 0 ? seconds * 1000 : parsedDate - Date.now();
  return Number.isFinite(delay) && delay > 0 ? Math.min(86_400_000, delay) : 3_600_000;
}

/** Local scans and add-on lookups share quota cooldowns and a bounded cache. */
export async function requestRatingsProvider(provider: Provider, apiKey: string, input: URL | string): Promise<unknown> {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.hostname !== hosts[provider] || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Ratings provider URL is not allowed.');
  }
  // Cache identity includes the key, without retaining credentials in cache keys.
  url.searchParams.sort();
  const credential = createHash('sha256').update(apiKey).digest('hex');
  const id = createHash('sha256').update(provider).update(credential).update(url.href).digest('hex');
  const cached = cache.get(id);
  if (cached && cached.until > Date.now()) return structuredClone(cached.payload);
  if (cached) cache.delete(id);
  const cooldown = cooldowns.get(provider);
  if (cooldown?.credential === credential && cooldown.until > Date.now()) {
    throw new Error(`${provider} request limit is cooling down.`);
  }
  const existing = pending.get(id);
  if (existing) return structuredClone(await existing);

  const request = (async () => {
    const response = await safeFetch(url, { headers: { accept: 'application/json' } }, {
      allowedHosts: [hosts[provider]], retries: 0, maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000,
      provider, operation: `metadata.${provider}.lookup`,
    });
    const coolDown = () => cooldowns.set(provider, {
      credential, until: Date.now() + retryDelay(response.headers.get('retry-after')),
    });
    if (response.status === 429) {
      coolDown();
      throw new Error(`${provider} request limit reached.`);
    }
    if (!response.ok) throw new Error(`${provider} request failed with status ${response.status}.`);
    const payload: unknown = await response.json();
    const result = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (/limit|quota/i.test(String(result.Error || result.error || ''))) {
      coolDown();
      throw new Error(`${provider} request limit reached.`);
    }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_CACHED_RESPONSE_BYTES) {
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(id, { until: Date.now() + (result.Response === 'False' || result.error ? 5 : 30) * 60_000, payload });
    }
    return payload;
  })();
  // Very large scans must not grow the request registry without a bound.
  if (pending.size < MAX_CACHE_ENTRIES) pending.set(id, request);
  try { return structuredClone(await request); }
  finally { if (pending.get(id) === request) pending.delete(id); }
}
