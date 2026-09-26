import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { safeFetch } from '../safeFetch.ts';
import {
  countIptvChannelHealth,
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
  listIptvStreamsDueForHealthCheck,
  pruneIptvStreamHealth,
  recordIptvHealthCheck,
  recordIptvRefresh,
  recordIptvStreamHealth,
  renameIptvSource,
  replaceIptvChannels,
  replaceIptvProgrammes,
  MAX_IPTV_SOURCES,
  type IptvChannelQuery,
  type IptvStreamHealthRecord,
} from '../databaseIptvRepository.ts';
import { parseM3uPlaylist } from './m3uPlaylist.ts';
import { isPlaybackActivityActive } from '../ffmpegGovernor.ts';
import {
  checkIptvStream,
  createFfmpegRunner,
  recheckLivePlaylist,
  type FfmpegRunner,
  type StreamCheckResult,
  type StreamLiveMarker,
} from './iptvStreamHealth.ts';
import { parseXmltvGuide } from './xmltvGuide.ts';
import type {
  IptvChannelPage,
  IptvSourceHealth,
  IptvSourceInput,
  IptvSourcePatch,
  IptvSourceSummary,
} from '../../shared/desktopProtocol.ts';

const PLAYLIST_MAX_BYTES = 24 * 1024 * 1024;
const GUIDE_MAX_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 45_000;
const MAX_SOURCE_NAME_LENGTH = 60;

/**
 * Opening the app or a source's page re-verifies every stream whose last full
 * check is older than this. Each check downloads and decodes a real segment,
 * so a stream verified moments ago is not fetched again.
 */
const HEALTH_FRESH_MS = 30 * 60 * 1000;
/** While the app stays open, streams are re-verified at least this often. */
const HEALTH_RECHECK_MS = 24 * 60 * 60 * 1000;
/** A transient failure is retried this long after the run that first saw it. */
const HEALTH_FOLLOW_UP_MS = 10 * 60 * 1000;
const HEALTH_STARTUP_DELAY_MS = 10 * 1000;
const HEALTH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const HEALTH_STREAM_CONCURRENCY = 24;
const HEALTH_FFMPEG_CONCURRENCY = 4;
/** How often a paused check looks again for playback to finish. */
const HEALTH_PLAYBACK_POLL_MS = 5000;
/** A live playlist gets at least this long, and three segment lengths, to advance. */
const HEALTH_LIVE_MIN_WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Downloads and decoding wait while anything plays, so checks never compete with playback. */
async function waitForPlaybackIdle(): Promise<void> {
  while (isPlaybackActivityActive()) await sleep(HEALTH_PLAYBACK_POLL_MS);
}

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


async function fetchText(url: string, maxBytes: number, operation: string, label: string): Promise<string> {
  const response = await safeFetch(url, {}, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes,
    retries: 1,
    maxRedirects: 2,
    operation,
  });
  if (!response.ok) throw new IptvSourceError(`The ${label} server answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  // Guide files are routinely served gzipped from a .gz path, which the
  // pinned transport does not decompress on its own.
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (isGzip ? gunzipSync(bytes) : bytes).toString('utf8');
}

function toSummary(record: ReturnType<typeof getIptvSource>, health: IptvSourceHealth): IptvSourceSummary {
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
    refreshWarning: record.refreshWarning,
    health,
  };
}

export type IptvServiceDependencies = {
  getDatabase: () => import('better-sqlite3').Database;
  /** Locates ffmpeg, which decodes each sample; without it no channel can be verified. */
  findFFmpeg?: () => string | null;
};

function limitConcurrency(runner: FfmpegRunner, limit: number): FfmpegRunner {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (input) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await runner(input);
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/**
 * Fold one check into the stored health. A definitive failure (gone, refused,
 * blank picture) hides the stream at once; a transient one (timeout, 5xx) must
 * repeat on the next run first. An inconclusive check changes nothing.
 */
function nextHealth(entry: IptvStreamHealthRecord, result: StreamCheckResult, now: number) {
  if (result.outcome === 'inconclusive') return null;
  if (result.outcome === 'ok') {
    return {
      streamUrl: entry.streamUrl,
      status: 'ok' as const,
      reason: '',
      failures: 0,
      hidden: false,
      checkedAt: now,
      analyzedAt: result.analyzed ? now : entry.analyzedAt,
    };
  }
  const failures = entry.status && entry.status !== 'ok' ? entry.failures + 1 : 1;
  return {
    streamUrl: entry.streamUrl,
    status: result.outcome,
    reason: result.reason,
    failures,
    hidden: result.definitive || failures >= 2,
    checkedAt: now,
    analyzedAt: result.analyzed ? now : entry.analyzedAt,
  };
}

export function createIptvService(deps: IptvServiceDependencies) {
  // One refresh per source at a time. A second click while a 20 MB playlist is
  // downloading joins the in-flight refresh instead of racing it into the
  // same rows.
  const inFlight = new Map<string, Promise<IptvSourceSummary>>();

  // Health checks run one source at a time behind a single queue: a check
  // holds dozens of connections open and should not stack with another.
  const healthQueued = new Set<string>();
  const healthProgress = new Map<string, { checked: number; total: number }>();
  let healthChain: Promise<void> = Promise.resolve();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const healthFor = (database: import('better-sqlite3').Database, sourceId: string, checkedAt: number): IptvSourceHealth => {
    const progress = healthProgress.get(sourceId);
    return {
      ...countIptvChannelHealth(database, sourceId),
      checking: healthQueued.has(sourceId),
      checked: progress?.checked ?? 0,
      total: progress?.total ?? 0,
      checkedAt,
    };
  };

  const summaryFor = (database: import('better-sqlite3').Database, record: ReturnType<typeof getIptvSource>) => (
    toSummary(record, record ? healthFor(database, record.id, record.healthCheckedAt) : {
      verified: 0, failed: 0, pending: 0, checking: false, checked: 0, total: 0, checkedAt: 0,
    })
  );

  const listSources = (): IptvSourceSummary[] => {
    const database = deps.getDatabase();
    return listIptvSources(database).map((record) => summaryFor(database, record));
  };

  async function checkSourceHealth(sourceId: string, dueBefore: number): Promise<{ transientFailures: number }> {
    const database = deps.getDatabase();
    if (!getIptvSource(database, sourceId)) return { transientFailures: 0 };
    const ffmpegPath = deps.findFFmpeg?.() ?? null;
    if (!ffmpegPath) {
      console.warn('[iptv] ffmpeg was not found, so live TV channels cannot be verified.');
      return { transientFailures: 0 };
    }
    const startedAt = Date.now();
    const due = listIptvStreamsDueForHealthCheck(database, sourceId, dueBefore);
    const runFfmpeg = limitConcurrency(createFfmpegRunner(ffmpegPath), HEALTH_FFMPEG_CONCURRENCY);
    const progress = { checked: 0, total: due.length };
    healthProgress.set(sourceId, progress);
    const markers: Array<{ entry: IptvStreamHealthRecord; marker: StreamLiveMarker }> = [];
    let transientFailures = 0;
    let sourceRemoved = false;

    const record = (entry: IptvStreamHealthRecord, result: StreamCheckResult) => {
      const next = nextHealth(entry, result, Date.now());
      if (!next) return;
      recordIptvStreamHealth(database, next);
      if (next.status !== 'ok' && !next.hidden) transientFailures += 1;
    };

    // Each worker carries one stream through every step before taking the
    // next. Queuing individual requests instead lets a stream's live segment
    // roll out of the provider's window while it waits its turn.
    const queue = [...due];
    const worker = async () => {
      for (let entry = queue.shift(); entry && !sourceRemoved; entry = queue.shift()) {
        let result: StreamCheckResult;
        do {
          await waitForPlaybackIdle();
          if (!getIptvSource(database, sourceId)) {
            sourceRemoved = true;
            return;
          }
          result = await checkIptvStream(entry.streamUrl, runFfmpeg);
        } while (result.outcome === 'inconclusive' && result.interrupted);
        if (!getIptvSource(database, sourceId)) {
          sourceRemoved = true;
          return;
        }
        progress.checked += 1;
        // A live stream decoded fine but is not verified until a second look
        // shows its playlist moving; nothing is recorded for it yet.
        if (result.outcome === 'ok' && result.live) markers.push({ entry, marker: result.live });
        else record(entry, result);
      }
    };
    await Promise.all(Array.from({ length: HEALTH_STREAM_CONCURRENCY }, worker));
    if (sourceRemoved) return { transientFailures: 0 };

    // Second look at every live playlist, each timed from its own first look:
    // three segment lengths, and never under the minimum, so a stream sampled
    // late in a large pass is not checked before it had a chance to move.
    const readyAt = (marker: StreamLiveMarker) => marker.fetchedAt + Math.max(marker.targetSeconds * 3000, HEALTH_LIVE_MIN_WAIT_MS);
    const liveQueue = [...markers].sort((left, right) => readyAt(left.marker) - readyAt(right.marker));
    const liveWorker = async () => {
      for (let item = liveQueue.shift(); item; item = liveQueue.shift()) {
        const wait = readyAt(item.marker) - Date.now();
        if (wait > 0) await sleep(wait);
        let second: Awaited<ReturnType<typeof recheckLivePlaylist>>;
        do {
          await waitForPlaybackIdle();
          if (!getIptvSource(database, sourceId)) {
            sourceRemoved = true;
            return;
          }
          second = await recheckLivePlaylist(item.marker);
        } while (second === 'interrupted');
        if (second === 'advanced') {
          record(item.entry, { outcome: 'ok', analyzed: true, live: null });
        } else if (second === 'frozen') {
          record(item.entry, { outcome: 'blank', reason: 'The stream stopped updating.', definitive: true, analyzed: false });
        }
        // Inconclusive: nothing is promoted. The stream keeps whatever it had
        // and is due again on the next check.
      }
    };
    await Promise.all(Array.from({ length: HEALTH_STREAM_CONCURRENCY }, liveWorker));

    if (getIptvSource(database, sourceId)) recordIptvHealthCheck(database, sourceId, startedAt);
    pruneIptvStreamHealth(database);
    return { transientFailures };
  }

  /**
   * Queue a check of every stream in the source last verified more than
   * `freshMs` ago. The cut-off is taken when the check starts, so a source
   * queued behind another still skips streams verified in the meantime.
   */
  function scheduleHealthCheck(sourceId: string, freshMs = HEALTH_FRESH_MS, followUp = false): void {
    if (healthQueued.has(sourceId)) return;
    healthQueued.add(sourceId);
    healthChain = healthChain.then(async () => {
      let transientFailures = 0;
      try {
        ({ transientFailures } = await checkSourceHealth(sourceId, Date.now() - freshMs));
      } catch (error) {
        console.warn('[iptv] Channel health check failed:', error instanceof Error ? error.message : error);
      } finally {
        healthQueued.delete(sourceId);
        healthProgress.delete(sourceId);
      }
      if (transientFailures > 0 && !followUp) {
        setTimeout(() => scheduleHealthCheck(sourceId, freshMs, true), HEALTH_FOLLOW_UP_MS).unref?.();
      }
    });
  }

  function sweepHealth(freshMs: number): void {
    for (const source of listIptvSources(deps.getDatabase())) {
      if (source.refreshedAt > 0) scheduleHealthCheck(source.id, freshMs);
    }
  }

  async function refreshSource(sourceId: string): Promise<IptvSourceSummary> {
    const running = inFlight.get(sourceId);
    if (running) return running;

    const run = (async () => {
      const database = deps.getDatabase();
      const source = getIptvSource(database, sourceId);
      if (!source) throw new IptvSourceError('That live TV source no longer exists.');

      try {
        const playlistText = await fetchText(source.playlistUrl, PLAYLIST_MAX_BYTES, 'iptv.playlist', 'playlist');
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
        let warning = '';
        if (guideUrl) {
          const knownChannelIds = new Set(
            playlist.channels.map((channel) => channel.tvgId).filter(Boolean),
          );
          // The guide only annotates channels. A guide host that is down must
          // not hold back the channel list; keep the last listings and say so.
          try {
            const guideText = await fetchText(guideUrl, GUIDE_MAX_BYTES, 'iptv.guide', 'guide');
            const guide = parseXmltvGuide(guideText, knownChannelIds);
            replaceIptvProgrammes(database, sourceId, guide.programmes);
            programmeCount = guide.programmes.length;
          } catch (guideError) {
            const reason = guideError instanceof Error ? guideError.message : 'The guide could not be read.';
            warning = `Channels were updated, but the guide was not: ${reason}`.slice(0, 300);
            programmeCount = source.programmeCount;
          }
        } else {
          replaceIptvProgrammes(database, sourceId, []);
        }

        const refreshed = recordIptvRefresh(database, sourceId, {
          channelCount: playlist.channels.length,
          programmeCount,
          skippedInsecure: playlist.skippedInsecure,
          skippedMalformed: playlist.skippedMalformed + playlist.skippedDuplicate,
          epgUrl: guideUrl,
          warning,
        });
        // Streams the playlist just added have no health yet; check them
        // (and anything due) in the background rather than hold the refresh.
        scheduleHealthCheck(sourceId);
        return summaryFor(database, refreshed);
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
      const database = deps.getDatabase();
      deleteIptvSource(database, sourceId);
      pruneIptvStreamHealth(database);
      return listSources();
    },

    refreshSource,

    /**
     * Verify every source shortly after launch, then keep streams no older
     * than a day while the app stays open.
     */
    startHealthChecks(): void {
      if (sweepTimer) return;
      setTimeout(() => sweepHealth(HEALTH_FRESH_MS), HEALTH_STARTUP_DELAY_MS).unref?.();
      sweepTimer = setInterval(() => sweepHealth(HEALTH_RECHECK_MS), HEALTH_SWEEP_INTERVAL_MS);
      sweepTimer.unref?.();
    },

    listChannels(request: IptvChannelQuery & { verify?: boolean }): IptvChannelPage {
      const database = deps.getDatabase();
      const source = getIptvSource(database, request.sourceId);
      if (!source) throw new IptvSourceError('That live TV source no longer exists.');
      // Opening a source's page re-verifies its stale streams. Paging and
      // filtering do not, or browsing would re-download every sample.
      if (request.verify) scheduleHealthCheck(source.id);
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
        health: healthFor(database, source.id, source.healthCheckedAt),
      };
    },

    getChannelStreamUrl(sourceId: string, channelId: string): string | null {
      return getIptvChannelStreamUrl(deps.getDatabase(), sourceId, channelId);
    },
  };
}

