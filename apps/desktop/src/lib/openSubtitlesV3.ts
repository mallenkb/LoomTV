export const OPEN_SUBTITLES_V3_SOURCE = 'OpenSubtitles v3';
const ORIGIN = 'https://opensubtitles-v3.strem.io';
const MAX_BYTES = 2 * 1024 * 1024;

export type SubtitleVideo = { imdbId: string; type: 'movie' | 'series'; season?: number; episode?: number };
export type OnlineSubtitle = { id: string; url: string; language: string; name: string; source: typeof OPEN_SUBTITLES_V3_SOURCE };

const languageAliases: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', por: 'pt', pob: 'pt-BR',
  dut: 'nl', nld: 'nl', rum: 'ro', ron: 'ro', chi: 'zh', zho: 'zh', gre: 'el', ell: 'el',
  cze: 'cs', ces: 'cs', slo: 'sk', slk: 'sk', scc: 'sr', srp: 'sr', alb: 'sq', sqi: 'sq',
  per: 'fa', fas: 'fa', may: 'ms', msa: 'ms', baq: 'eu', eus: 'eu', wel: 'cy', cym: 'cy',
  und: '', unk: '',
};
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

export function subtitleLanguageLabel(raw?: string): string {
  const code = (raw || '').trim().replace(/_/g, '-').toLowerCase();
  const canonical = languageAliases[code] ?? code;
  if (!canonical) return 'Unknown language';
  try { return languageNames.of(canonical) || canonical; }
  catch { return raw?.trim() || 'Unknown language'; }
}

export function subtitleSearchMatches(language: string | undefined, name: string, query: string, source = ''): boolean {
  const haystack = `${subtitleLanguageLabel(language)} ${language || ''} ${name} ${source}`.toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => haystack.includes(word));
}

export function compareSubtitleLanguages(a: string, b: string): number {
  const englishA = a === 'English' || a.startsWith('English (');
  const englishB = b === 'English' || b.startsWith('English (');
  return Number(englishB) - Number(englishA) || a.localeCompare(b);
}

export function subtitleSearchUrl(video: SubtitleVideo): string {
  if (!/^tt\d{5,12}$/.test(video.imdbId)) throw new Error('Match this title to an IMDb entry before searching for subtitles.');
  if (video.type !== 'movie' && video.type !== 'series') throw new Error('This media type does not support online subtitles.');
  let id = video.imdbId;
  if (video.type === 'series') {
    if (typeof video.season !== 'number' || !Number.isSafeInteger(video.season) || video.season < 0
      || typeof video.episode !== 'number' || !Number.isSafeInteger(video.episode) || video.episode < 1) {
      throw new Error('Choose a season and episode before searching for subtitles.');
    }
    id += `:${video.season}:${video.episode}`;
  }
  return `${ORIGIN}/subtitles/${video.type}/${encodeURIComponent(id)}.json`;
}

export function allowedSubtitleUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    // Only the official subtitle delivery hosts, never arbitrary provider URLs.
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && /^subs\d*\.strem\.io$/.test(url.hostname)
      && /^\/en\/download\//.test(url.pathname);
  } catch { return false; }
}

async function readProviderText(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, 20_000);
  try {
    const response = await fetcher(url, {
      signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    controller.signal.throwIfAborted();
    if (!response.ok) throw new Error(`OpenSubtitles v3 returned HTTP ${response.status}. Try again later.`);
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('The subtitle response is too large.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('OpenSubtitles v3 returned an empty response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error('The subtitle response is too large.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  } catch (cause) {
    if (timedOut && !signal?.aborted) throw new Error('OpenSubtitles v3 request timed out. Try again later.', { cause });
    throw cause;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function findOnlineSubtitles(video: SubtitleVideo, signal?: AbortSignal, fetcher?: typeof fetch): Promise<OnlineSubtitle[]> {
  const payload: unknown = JSON.parse(await readProviderText(subtitleSearchUrl(video), signal, fetcher));
  if (!payload || typeof payload !== 'object' || !('subtitles' in payload) || !Array.isArray(payload.subtitles)) {
    throw new Error('OpenSubtitles v3 returned an invalid subtitle list.');
  }
  const found = new Map<string, OnlineSubtitle>();
  for (const raw of payload.subtitles.slice(0, 2000)) {
    if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string' || !allowedSubtitleUrl(raw.url)
      || typeof raw.lang !== 'string' || raw.lang.length > 40) continue;
    const name = typeof raw.subtitleFileName === 'string' ? raw.subtitleFileName
      : typeof raw.movieReleaseName === 'string' ? raw.movieReleaseName : `Subtitle ${raw.id || found.size + 1}`;
    found.set(raw.url, { id: raw.url, url: raw.url, language: raw.lang, name: name.slice(0, 240), source: OPEN_SUBTITLES_V3_SOURCE });
  }
  return [...found.values()];
}

export async function downloadOnlineSubtitle(subtitle: OnlineSubtitle, signal?: AbortSignal, fetcher?: typeof fetch): Promise<string> {
  if (!allowedSubtitleUrl(subtitle.url)) throw new Error('This subtitle download is not from an approved Stremio host.');
  const text = await readProviderText(subtitle.url, signal, fetcher);
  if (!/\d{1,2}:\d{2}[.,]\d{3}\s*-->/.test(text)) throw new Error('This download does not contain supported SRT or WebVTT subtitles.');
  return text;
}
