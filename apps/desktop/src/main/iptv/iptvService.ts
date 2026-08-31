import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { safeFetch } from '../safeFetch.ts';
import {
  countIptvChannels,
  countIptvSources,
  deleteIptvSource,
  findIptvSourceByPlaylistUrl,
  getIptvChannelStreamUrl,
  getIptvSource,
  insertIptvSource,
  listIptvChannels,
  listIptvGroups,
  listIptvSubcategories,
  listIptvSources,
  recordIptvRefresh,
  renameIptvSource,
  replaceIptvChannels,
  replaceIptvProgrammes,
  MAX_IPTV_SOURCES,
  type IptvChannelQuery,
} from '../databaseIptvRepository.ts';
import { parseM3uPlaylist } from './m3uPlaylist.ts';
import { parseXmltvGuide } from './xmltvGuide.ts';
import type {
  IptvChannelPage,
  IptvSourceInput,
  IptvSourcePatch,
  IptvSourceSummary,
} from '../../shared/desktopProtocol.ts';

const PLAYLIST_MAX_BYTES = 24 * 1024 * 1024;
const GUIDE_MAX_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 45_000;
const MAX_SOURCE_NAME_LENGTH = 60;

export class IptvSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IptvSourceError';
  }
}

/**
 * Playlist and guide URLs go through the same fail-closed transport as every
 * other provider request: HTTPS only, no private addresses, no unbounded
 * response. A plain-HTTP playlist is rejected here rather than at play time,
 * where the renderer's media policy would refuse it anyway.
 */
export function normalizeIptvUrl(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new IptvSourceError(`Enter a ${label} URL.`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new IptvSourceError(`That ${label} URL is not a valid address.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new IptvSourceError(`${label} URLs must use https. LoomTV does not open plain-HTTP providers.`);
  }
  return parsed.toString();
}

/** Fall back to the playlist's own filename when a provider gives no name. */
export function defaultSourceName(playlistUrl: string): string {
  try {
    const parsed = new URL(playlistUrl);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() || '';
    const stem = lastSegment.replace(/\.(m3u8?|txt)$/i, '').replace(/[_-]+/g, ' ').trim();
    return (stem || parsed.hostname).slice(0, MAX_SOURCE_NAME_LENGTH);
  } catch {
    return 'Live TV';
  }
}

async function fetchText(url: string, maxBytes: number, operation: string): Promise<string> {
  const response = await safeFetch(url, {}, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes,
    retries: 1,
    maxRedirects: 2,
    operation,
  });
  if (!response.ok) throw new IptvSourceError(`The provider answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  // Guide files are routinely served gzipped from a .gz path, which the
  // pinned transport does not decompress on its own.
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (isGzip ? gunzipSync(bytes) : bytes).toString('utf8');
}

function toSummary(record: ReturnType<typeof getIptvSource>): IptvSourceSummary {
  if (!record) throw new IptvSourceError('That live TV source no longer exists.');
  return {
    id: record.id,
    name: record.name,
    iconId: record.iconId,
    playlistUrl: record.playlistUrl,
    epgUrl: record.epgUrl,
    channelCount: record.channelCount,
    programmeCount: record.programmeCount,
    skippedInsecure: record.skippedInsecure,
    skippedMalformed: record.skippedMalformed,
    refreshedAt: record.refreshedAt,
    refreshError: record.refreshError,
  };
}

export type IptvServiceDependencies = {
  getDatabase: () => import('better-sqlite3').Database;
};

export function createIptvService(deps: IptvServiceDependencies) {
  // One refresh per source at a time. A second click while a 20 MB playlist is
  // downloading joins the in-flight refresh instead of racing it into the
  // same rows.
  const inFlight = new Map<string, Promise<IptvSourceSummary>>();

  const listSources = (): IptvSourceSummary[] =>
    listIptvSources(deps.getDatabase()).map((record) => toSummary(record));

  async function refreshSource(sourceId: string): Promise<IptvSourceSummary> {
    const running = inFlight.get(sourceId);
    if (running) return running;

    const run = (async () => {
      const database = deps.getDatabase();
      const source = getIptvSource(database, sourceId);
      if (!source) throw new IptvSourceError('That live TV source no longer exists.');

      try {
        const playlistText = await fetchText(source.playlistUrl, PLAYLIST_MAX_BYTES, 'iptv.playlist');
        const playlist = parseM3uPlaylist(playlistText);
        if (playlist.channels.length === 0) {
          throw new IptvSourceError(
            playlist.skippedInsecure > 0
              ? `Every channel in this playlist streams over plain HTTP, which LoomTV cannot open (${playlist.skippedInsecure} skipped).`
              : 'That playlist contains no channels.',
          );
        }
        replaceIptvChannels(database, sourceId, playlist.channels);

        // An explicit guide URL wins; otherwise use the one the playlist
        // header advertised, which is how most providers ship theirs.
        const guideUrl = source.epgUrl || playlist.epgUrl;
        let programmeCount = 0;
        if (guideUrl) {
          const knownChannelIds = new Set(
            playlist.channels.map((channel) => channel.tvgId).filter(Boolean),
          );
          const guideText = await fetchText(guideUrl, GUIDE_MAX_BYTES, 'iptv.guide');
          const guide = parseXmltvGuide(guideText, knownChannelIds);
          replaceIptvProgrammes(database, sourceId, guide.programmes);
          programmeCount = guide.programmes.length;
        } else {
          replaceIptvProgrammes(database, sourceId, []);
        }

        return toSummary(recordIptvRefresh(database, sourceId, {
          channelCount: playlist.channels.length,
          programmeCount,
          skippedInsecure: playlist.skippedInsecure,
          skippedMalformed: playlist.skippedMalformed + playlist.skippedDuplicate,
          epgUrl: guideUrl,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The refresh failed.';
        recordIptvRefresh(database, sourceId, { error: message.slice(0, 300) });
        throw error instanceof IptvSourceError ? error : new IptvSourceError(message);
      }
    })();

    inFlight.set(sourceId, run);
    try {
      return await run;
    } finally {
      inFlight.delete(sourceId);
    }
  }

  return {
    listSources,

    async addSource(input: IptvSourceInput): Promise<IptvSourceSummary[]> {
      const database = deps.getDatabase();
      if (countIptvSources(database) >= MAX_IPTV_SOURCES) {
        throw new IptvSourceError(`You can add up to ${MAX_IPTV_SOURCES} live TV sources.`);
      }
      const playlistUrl = normalizeIptvUrl(input.playlistUrl, 'playlist');
      const epgUrl = input.epgUrl?.trim() ? normalizeIptvUrl(input.epgUrl, 'guide') : '';
      if (findIptvSourceByPlaylistUrl(database, playlistUrl)) {
        throw new IptvSourceError('That playlist has already been added.');
      }
      const name = input.name.trim().slice(0, MAX_SOURCE_NAME_LENGTH);
      const created = insertIptvSource(database, {
        id: randomUUID(),
        name,
        playlistUrl,
        epgUrl,
        iconId: input.iconId || 'general',
      });

      try {
        await refreshSource(created.id);
      } catch (error) {
        // The source stays, carrying its refresh error, so the user can fix a
        // typo or retry without re-entering the URL.
        if (!(error instanceof IptvSourceError)) throw error;
      }
      return listSources();
    },

    updateSource(sourceId: string, patch: IptvSourcePatch): IptvSourceSummary[] {
      const database = deps.getDatabase();
      const existing = getIptvSource(database, sourceId);
      if (!existing) throw new IptvSourceError('That live TV source no longer exists.');
      const playlistUrl = patch.playlistUrl === undefined
        ? undefined
        : normalizeIptvUrl(patch.playlistUrl, 'playlist');
      if (playlistUrl && playlistUrl !== existing.playlistUrl) {
        const duplicate = findIptvSourceByPlaylistUrl(database, playlistUrl);
        if (duplicate && duplicate.id !== sourceId) {
          throw new IptvSourceError('That playlist has already been added.');
        }
      }
      const epgUrl = patch.epgUrl === undefined
        ? undefined
        : patch.epgUrl.trim()
          ? normalizeIptvUrl(patch.epgUrl, 'guide')
          : '';
      const updated = renameIptvSource(database, sourceId, {
        name: patch.name?.trim().slice(0, MAX_SOURCE_NAME_LENGTH) || undefined,
        playlistUrl,
        epgUrl,
        iconId: patch.iconId,
      });
      if (!updated) throw new IptvSourceError('That live TV source could not be updated.');
      return listSources();
    },

    removeSource(sourceId: string): IptvSourceSummary[] {
      deleteIptvSource(deps.getDatabase(), sourceId);
      return listSources();
    },

    refreshSource,

    listChannels(request: IptvChannelQuery): IptvChannelPage {
      const database = deps.getDatabase();
      const source = getIptvSource(database, request.sourceId);
      if (!source) throw new IptvSourceError('That live TV source no longer exists.');
      const channels = listIptvChannels(database, request);
      return {
        sourceId: request.sourceId,
        sourceName: source.name,
        channels: channels.map((channel) => ({
          channelId: channel.channelId,
          name: channel.name,
          logoUrl: channel.logoUrl,
          groupTitle: channel.groupTitle,
          streamUrl: channel.streamUrl,
          nowTitle: channel.nowTitle,
          nowStartMs: channel.nowStartMs,
          nowEndMs: channel.nowEndMs,
          nextTitle: channel.nextTitle,
          nextStartMs: channel.nextStartMs,
        })),
        total: countIptvChannels(database, request),
        offset: Math.max(Math.trunc(request.offset ?? 0), 0),
        groups: listIptvGroups(database, request.sourceId),
        subcategories: listIptvSubcategories(database, request.sourceId, request.group),
        refreshedAt: source.refreshedAt,
        refreshError: source.refreshError,
      };
    },

    getChannelStreamUrl(sourceId: string, channelId: string): string | null {
      return getIptvChannelStreamUrl(deps.getDatabase(), sourceId, channelId);
    },
  };
}

export type IptvService = ReturnType<typeof createIptvService>;
