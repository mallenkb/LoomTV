import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSubtitleFileName, isVideoFileName } from './fileClassification.ts';
import { safeFetch } from './safeFetch.ts';

const API_ORIGIN = 'https://api.opensubtitles.com';
const HASH_CHUNK_SIZE = 64 * 1024;
const UINT64_MASK = (1n << 64n) - 1n;

export type OpenSubtitlesScanOptions = {
  apiKey?: string;
  username?: string;
  password?: string;
  languages?: string;
  autoDownload?: boolean;
  userAgent?: string;
};

type OpenSubtitlesSession = {
  token: string;
  baseUrl: string;
};

type OpenSubtitlesFile = {
  file_id?: number;
  file_name?: string;
};

type OpenSubtitlesResult = {
  id?: string;
  attributes?: {
    language?: string;
    download_count?: number;
    hearing_impaired?: boolean;
    from_trusted?: boolean;
    files?: OpenSubtitlesFile[];
  };
};

type OpenSubtitlesSearchResponse = {
  data?: OpenSubtitlesResult[];
};

type OpenSubtitlesDownloadResponse = {
  link?: string;
  file_name?: string;
};

type OpenSubtitlesDownloadStatus = 'disabled' | 'skipped' | 'downloaded' | 'not-found' | 'error';

export type OpenSubtitlesDownloadResult = {
  status: OpenSubtitlesDownloadStatus;
  videoPath: string;
  subtitlePath?: string;
  language?: string;
  message?: string;
};

let sessionCache: { key: string; session: OpenSubtitlesSession } | null = null;

function normalizeOpenSubtitlesLanguages(value?: string): string[] {
  const source = value && value.trim() ? value : 'en';
  const aliases: Record<string, string> = {
    english: 'en',
    eng: 'en',
    spanish: 'es',
    spa: 'es',
    french: 'fr',
    fre: 'fr',
    fra: 'fr',
    german: 'de',
    ger: 'de',
    deu: 'de',
    japanese: 'ja',
    jpn: 'ja',
    portuguese: 'pt',
    por: 'pt',
  };

  return Array.from(new Set(
    source
      .split(/[,\s]+/)
      .map((language) => aliases[language.trim().toLowerCase()] || language.trim().toLowerCase())
      .filter((language) => /^[a-z]{2,3}$/.test(language)),
  )).slice(0, 6);
}

export function openSubtitlesIsConfigured(options?: OpenSubtitlesScanOptions): boolean {
  return Boolean(
    options?.autoDownload
    && options.apiKey?.trim()
    && options.username?.trim()
    && options.password?.trim()
    && normalizeOpenSubtitlesLanguages(options.languages).length > 0,
  );
}

export function openSubtitlesCacheKey(options?: OpenSubtitlesScanOptions): string {
  if (!openSubtitlesIsConfigured(options)) return '';
  const credentialFingerprint = createHash('sha256')
    .update([
      options?.apiKey?.trim() || '',
      options?.username?.trim() || '',
      options?.password?.trim() || '',
    ].join('\0'))
    .digest('hex')
    .slice(0, 12);
  return [
    'opensubtitles',
    normalizeOpenSubtitlesLanguages(options?.languages).join(','),
    credentialFingerprint,
  ].join(':');
}

function openSubtitlesHeaders(options: OpenSubtitlesScanOptions, token?: string): HeadersInit {
  return {
    'Api-Key': options.apiKey?.trim() || '',
    'Content-Type': 'application/json',
    'User-Agent': options.userAgent || 'LoomTV v1',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function login(options: OpenSubtitlesScanOptions): Promise<OpenSubtitlesSession> {
  const username = options.username?.trim() || '';
  const password = options.password?.trim() || '';
  const apiKey = options.apiKey?.trim() || '';
  const cacheKey = `${apiKey}:${username}:${password}`;
  if (sessionCache?.key === cacheKey) return sessionCache.session;

  const response = await safeFetch(`${API_ORIGIN}/api/v1/login`, {
    method: 'POST',
    headers: openSubtitlesHeaders(options),
    body: JSON.stringify({ username, password }),
  }, { allowedHosts: ['.opensubtitles.com'], maxBytes: 512 * 1024 });
  const json = await response.json().catch(() => ({})) as { token?: string; base_url?: string; message?: string };
  if (!response.ok || !json.token) {
    throw new Error(String(json.message || `OpenSubtitles login failed with ${response.status}.`));
  }

  const baseUrl = json.base_url
    ? `https://${json.base_url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}`
    : API_ORIGIN;
  const session = { token: json.token, baseUrl };
  sessionCache = { key: cacheKey, session };
  return session;
}

function addHashChunk(hash: bigint, buffer: Buffer, bytesRead: number): bigint {
  let next = hash;
  for (let offset = 0; offset + 8 <= bytesRead; offset += 8) {
    next = (next + buffer.readBigUInt64LE(offset)) & UINT64_MASK;
  }
  return next;
}

function computeOpenSubtitlesHash(filePath: string): { moviehash: string; moviebytesize: number } {
  const stats = fs.statSync(filePath);
  const size = stats.size;
  const fd = fs.openSync(filePath, 'r');
  let hash = BigInt(size);

  try {
    const first = Buffer.alloc(Math.min(HASH_CHUNK_SIZE, size));
    const firstBytes = fs.readSync(fd, first, 0, first.length, 0);
    hash = addHashChunk(hash, first, firstBytes);

    const lastLength = Math.min(HASH_CHUNK_SIZE, size);
    const last = Buffer.alloc(lastLength);
    const lastBytes = fs.readSync(fd, last, 0, lastLength, Math.max(0, size - lastLength));
    hash = addHashChunk(hash, last, lastBytes);
  } finally {
    fs.closeSync(fd);
  }

  return {
    moviehash: hash.toString(16).padStart(16, '0').slice(-16),
    moviebytesize: size,
  };
}

function sidecarSubtitleExists(videoPath: string, language: string): boolean {
  const dir = path.dirname(videoPath);
  const baseName = path.basename(videoPath, path.extname(videoPath));
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .some((entry) => {
        if (!isSubtitleFileName(entry.name)) return false;
        const subtitleBase = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
        const lowerBase = baseName.toLowerCase();
        return subtitleBase === lowerBase
          || subtitleBase === `${lowerBase}.${language}`
          || subtitleBase.startsWith(`${lowerBase}.${language}.`);
      });
  } catch {
    return false;
  }
}

function bestSubtitleFile(result: OpenSubtitlesResult): OpenSubtitlesFile | null {
  const files = result.attributes?.files || [];
  return files.find((file) => typeof file.file_id === 'number') || null;
}

function rankedResults(results: OpenSubtitlesResult[]): OpenSubtitlesResult[] {
  return [...results].sort((a, b) => {
    const trustedDelta = Number(Boolean(b.attributes?.from_trusted)) - Number(Boolean(a.attributes?.from_trusted));
    if (trustedDelta !== 0) return trustedDelta;
    return Number(b.attributes?.download_count || 0) - Number(a.attributes?.download_count || 0);
  });
}

async function searchSubtitle(
  videoPath: string,
  language: string,
  options: OpenSubtitlesScanOptions,
  session: OpenSubtitlesSession,
): Promise<OpenSubtitlesFile | null> {
  const { moviehash, moviebytesize } = computeOpenSubtitlesHash(videoPath);
  const url = new URL('/api/v1/subtitles', session.baseUrl);
  url.searchParams.set('languages', language);
  url.searchParams.set('moviehash', moviehash);
  url.searchParams.set('moviebytesize', String(moviebytesize));
  url.searchParams.set('query', path.basename(videoPath, path.extname(videoPath)));
  url.searchParams.set('order_by', 'download_count');
  url.searchParams.set('order_direction', 'desc');

  const response = await safeFetch(url, {
    headers: openSubtitlesHeaders(options, session.token),
  }, { allowedHosts: ['.opensubtitles.com'], maxBytes: 2 * 1024 * 1024, retries: 2 });
  if (!response.ok) {
    throw new Error(`OpenSubtitles search failed with ${response.status}.`);
  }
  const json = await response.json().catch(() => ({})) as OpenSubtitlesSearchResponse;
  const matches = rankedResults((json.data || []).filter((result) => result.attributes?.language === language));
  for (const match of matches) {
    const file = bestSubtitleFile(match);
    if (file) return file;
  }
  return null;
}

async function requestDownloadLink(
  fileId: number,
  language: string,
  options: OpenSubtitlesScanOptions,
  session: OpenSubtitlesSession,
): Promise<string> {
  const response = await safeFetch(new URL('/api/v1/download', session.baseUrl), {
    method: 'POST',
    headers: openSubtitlesHeaders(options, session.token),
    body: JSON.stringify({
      file_id: fileId,
      sub_format: 'srt',
      file_name: `subtitle.${language}.srt`,
      cleanup_links: true,
      remove_adds: true,
    }),
  }, { allowedHosts: ['.opensubtitles.com'], maxBytes: 512 * 1024 });
  const json = await response.json().catch(() => ({})) as OpenSubtitlesDownloadResponse & { message?: string };
  if (!response.ok || !json.link) {
    throw new Error(String(json.message || `OpenSubtitles download failed with ${response.status}.`));
  }
  return json.link;
}

async function saveSubtitleFromLink(link: string, targetPath: string): Promise<void> {
  const response = await safeFetch(link, {}, {
    allowedHosts: ['.opensubtitles.com'],
    timeoutMs: 20_000,
    maxBytes: 20 * 1024 * 1024,
    retries: 2,
  });
  if (!response.ok) throw new Error(`Subtitle file download failed with ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(targetPath, buffer);
}

export async function downloadMissingOpenSubtitlesForVideo(
  videoPath: string,
  options?: OpenSubtitlesScanOptions,
): Promise<OpenSubtitlesDownloadResult[]> {
  if (!openSubtitlesIsConfigured(options)) {
    return [{ status: 'disabled', videoPath }];
  }

  const languages = normalizeOpenSubtitlesLanguages(options?.languages);
  const results: OpenSubtitlesDownloadResult[] = [];

  for (const language of languages) {
    if (sidecarSubtitleExists(videoPath, language)) {
      results.push({ status: 'skipped', videoPath, language });
      continue;
    }

    try {
      const session = await login(options as OpenSubtitlesScanOptions);
      const file = await searchSubtitle(videoPath, language, options as OpenSubtitlesScanOptions, session);
      if (!file?.file_id) {
        results.push({ status: 'not-found', videoPath, language });
        continue;
      }

      const targetPath = path.join(
        path.dirname(videoPath),
        `${path.basename(videoPath, path.extname(videoPath))}.${language}.srt`,
      );
      const link = await requestDownloadLink(file.file_id, language, options as OpenSubtitlesScanOptions, session);
      await saveSubtitleFromLink(link, targetPath);
      results.push({ status: 'downloaded', videoPath, subtitlePath: targetPath, language });
    } catch (error) {
      results.push({
        status: 'error',
        videoPath,
        language,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export async function downloadMissingOpenSubtitlesForFolder(
  folderPath: string,
  options?: OpenSubtitlesScanOptions,
): Promise<OpenSubtitlesDownloadResult[]> {
  if (!openSubtitlesIsConfigured(options)) return [];
  const results: OpenSubtitlesDownloadResult[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (lower === 'subs' || lower === 'subtitles' || lower === 'sample' || lower === 'samples') continue;
        walk(fullPath);
      } else if (isVideoFileName(entry.name)) {
        results.push({ status: 'skipped', videoPath: fullPath });
      }
    }
  }

  walk(folderPath);
  const videos = results.map((result) => result.videoPath);
  results.length = 0;

  for (const videoPath of videos) {
    results.push(...await downloadMissingOpenSubtitlesForVideo(videoPath, options));
  }

  return results;
}
