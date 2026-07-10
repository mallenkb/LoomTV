const FANART_BASE = 'https://webservice.fanart.tv/v3';

type FanartImage = {
  url?: string;
  lang?: string;
  likes?: string | number;
};

function normalizeFanartKey(value?: string): string {
  return (value || '').trim();
}

interface FanartResponse {
  hdmovielogo?: FanartImage[];
  movielogo?: FanartImage[];
  hdtvlogo?: FanartImage[];
  clearlogo?: FanartImage[];
}

async function fetchFanartJson(path: string, apiKey?: string): Promise<FanartResponse | null> {
  const key = normalizeFanartKey(apiKey);
  if (!key) return null;

  const url = new URL(`${FANART_BASE}/${path}`);
  url.searchParams.set('api_key', key);

  const response = await fetch(url.toString());
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Fanart.tv request failed with ${response.status}`);
  return (await response.json()) as FanartResponse;
}

function imageUrls(images: unknown): string[] {
  const entries = Array.isArray(images) ? images as FanartImage[] : [];
  const sorted = entries
    .filter((image) => image?.url)
    .sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0))
    .sort((a, b) => {
      const leftLanguageScore = !a.lang || a.lang === 'en' ? 1 : 0;
      const rightLanguageScore = !b.lang || b.lang === 'en' ? 1 : 0;
      return rightLanguageScore - leftLanguageScore;
    });
  return Array.from(new Set(sorted.map((image) => String(image.url).replace(/^http:\/\//i, 'https://'))));
}

export async function fetchFanartMovieLogos(
  tmdbId: string | undefined,
  apiKey?: string,
): Promise<string[]> {
  if (!tmdbId) return [];
  try {
    const data = await fetchFanartJson(`movies/${encodeURIComponent(tmdbId)}`, apiKey);
    return imageUrls([...(data?.hdmovielogo || []), ...(data?.movielogo || [])]);
  } catch (err) {
    console.error('[Fanart.tv movie logos]', err);
    return [];
  }
}

export async function fetchFanartTVLogos(
  tvdbId: string | undefined,
  apiKey?: string,
): Promise<string[]> {
  if (!tvdbId) return [];
  try {
    const data = await fetchFanartJson(`tv/${encodeURIComponent(tvdbId)}`, apiKey);
    return imageUrls([...(data?.hdtvlogo || []), ...(data?.clearlogo || [])]);
  } catch (err) {
    console.error('[Fanart.tv TV logos]', err);
    return [];
  }
}
