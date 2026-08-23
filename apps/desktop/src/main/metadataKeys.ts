export type MetadataKeyTestResult = {
  provider: string;
  ok: boolean;
  message: string;
};

export function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function isTMDBReadAccessToken(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
}

async function testTMDBKey(value: string): Promise<MetadataKeyTestResult> {
  const credential = value.trim().replace(/^Bearer\s+/i, '');
  if (!credential) return { provider: 'tmdb', ok: false, message: 'Missing key.' };
  const url = new URL('https://api.themoviedb.org/3/configuration');
  const requestInit: RequestInit = {};
  if (isTMDBReadAccessToken(credential)) {
    requestInit.headers = { Authorization: `Bearer ${credential}` };
  } else {
    url.searchParams.set('api_key', credential);
  }
  const response = await safeFetch(url, requestInit, { allowedHosts: ['api.themoviedb.org'] });
  return {
    provider: 'tmdb',
    ok: response.ok,
    message: response.ok ? 'TMDB key works.' : `TMDB returned ${response.status}.`,
  };
}

async function testOMDbKey(value: string): Promise<MetadataKeyTestResult> {
  const key = value.trim();
  if (!key) return { provider: 'omdb', ok: false, message: 'Missing key.' };
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('apikey', key);
  url.searchParams.set('i', 'tt0133093');
  const response = await safeFetch(url, {}, { allowedHosts: ['www.omdbapi.com'] });
  const json = await response.json().catch(() => ({}));
  const ok = response.ok && json?.Response !== 'False';
  return {
    provider: 'omdb',
    ok,
    message: ok ? 'OMDb key works.' : String(json?.Error || `OMDb returned ${response.status}.`),
  };
}

async function testFanartKey(value: string): Promise<MetadataKeyTestResult> {
  const key = value.trim();
  if (!key) return { provider: 'fanart', ok: false, message: 'Missing key.' };
  const url = new URL('https://webservice.fanart.tv/v3/movies/120');
  url.searchParams.set('api_key', key);
  const response = await safeFetch(url, {}, { allowedHosts: ['webservice.fanart.tv'] });
  return {
    provider: 'fanart',
    ok: response.ok,
    message: response.ok ? 'Fanart.tv key works.' : `Fanart.tv returned ${response.status}.`,
  };
}

async function testOpenSubtitlesKey(value: string): Promise<MetadataKeyTestResult> {
  const key = value.trim();
  if (!key) return { provider: 'opensubtitles', ok: false, message: 'Missing key.' };
  const response = await safeFetch('https://api.opensubtitles.com/api/v1/infos/languages', {
    headers: {
      'Api-Key': key,
      'User-Agent': 'LoomTV v1',
    },
  }, { allowedHosts: ['.opensubtitles.com'] });
  return {
    provider: 'opensubtitles',
    ok: response.ok,
    message: response.ok ? 'OpenSubtitles key works.' : `OpenSubtitles returned ${response.status}.`,
  };
}

async function testTVDBKey(value: string): Promise<MetadataKeyTestResult> {
  const key = value.trim();
  if (!key) return { provider: 'tvdb', ok: false, message: 'Missing key.' };
  const response = await safeFetch('https://api4.thetvdb.com/v4/login', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: key }),
  }, { allowedHosts: ['api4.thetvdb.com'] });
  const payload = await response.json().catch(() => ({}));
  const token = payload?.data?.token || payload?.token;
  const ok = response.ok && typeof token === 'string' && token.length > 0;
  return {
    provider: 'tvdb',
    ok,
    message: ok ? 'TheTVDB key works.' : response.status === 401 || response.status === 403
      ? 'TheTVDB rejected that key.'
      : `TheTVDB returned ${response.status}.`,
  };
}

export async function testMetadataKeys(keys: Record<string, string>): Promise<MetadataKeyTestResult[]> {
  const cleaned = Object.fromEntries(
    Object.entries(keys || {})
      .map(([provider, value]) => [normalizeProviderId(provider), String(value || '').trim()])
      .filter(([provider, value]) => provider && value),
  ) as Record<string, string>;

  const tests = Object.entries(cleaned).map(async ([provider, value]) => {
    try {
      if (provider === 'tmdb') return await testTMDBKey(value);
      if (provider === 'omdb') return await testOMDbKey(value);
      if (provider === 'fanart') return await testFanartKey(value);
      if (provider === 'opensubtitles') return await testOpenSubtitlesKey(value);
      if (provider === 'tvdb') return await testTVDBKey(value);
      return { provider, ok: false, message: 'No built-in test for this provider.' };
    } catch (error) {
      return {
        provider,
        ok: false,
        message: error instanceof Error ? error.message : 'Test failed.',
      };
    }
  });

  return Promise.all(tests);
}
import { safeFetch } from './safeFetch';
