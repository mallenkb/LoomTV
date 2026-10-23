import { desktopApi, type StremioPluginCatalogItem, type StremioPluginSummary } from '@/lib/desktopApi';
import { cachedDesktopRead, invalidateDesktopData } from '@/lib/queryClient';
import { subtitleLanguageLabel, type SubtitleVideo } from '@/lib/openSubtitlesV3';
import { enrichWithCinemeta } from './cinemetaAddonMetadata';
import { sourceFingerprint } from './addonSourceHistory';
import { sourceResolution, type AddonResolution } from './addonSourcePreferences';
import type { StremioPluginVideo, StremioStreamDescriptor, StremioStreamSubtitle } from '@/shared/desktopProtocol';

export type AddonStreamArtwork = {
  logo?: string;
  logoCandidates?: string[];
  poster?: string;
  posterCandidates?: string[];
  backdrop?: string;
  backdropCandidates?: string[];
  rating?: number;
};

/** The video a chosen add-on stream belongs to, for subtitle lookups in the player. */
export type AddonSubtitleContext = {
  opensubtitlesOnly?: boolean;
  type: string;
  videoId: string;
  /** Subtitles the chosen stream listed, by host token. */
  embedded: readonly (StremioStreamSubtitle & { sourceName: string })[];
};

export type AddonPlaybackOptions = {
  resumeLastSource?: boolean;
  addonTarget?: AddonVideoTarget;
  subtitleVideo?: SubtitleVideo;
  addonSubtitles?: AddonSubtitleContext;
};

/** Opens a chosen add-on stream in the player. */
export type AddonStreamPlayer = (streamUrl: string, title: string, artwork?: AddonStreamArtwork, options?: AddonPlaybackOptions) => void;

/** Advance a request counter so responses for earlier requests are ignored. */
export function invalidateRequests(counter: { current: number }): void {
  counter.current += 1;
}

/** Types whose titles open the episode list rather than a single video. */
const SERIES_LIKE_TYPES = new Set(['series', 'tv', 'anime', 'channel']);

export function isSeriesLikeType(type: string): boolean {
  return SERIES_LIKE_TYPES.has(type);
}

/** The detail route for a provider media type. */
export function addonDetailRoute(item: Pick<StremioPluginCatalogItem, 'id' | 'type'>): string {
  const route = item.type === 'anime' ? 'anime' : isSeriesLikeType(item.type) ? 'tv' : 'movie';
  return `/${route}/${encodeURIComponent(item.id)}`;
}

function usable(source: StremioPluginSummary): boolean {
  return source.state === 'enabled' && source.trusted && source.configured;
}

/**
 * Stremio routes a request to an add-on when the resource declares the type
 * and, if it lists ID prefixes, the ID starts with one of them. The host
 * already applied the manifest-wide fallback to each resource.
 */
export function supportsAddonResource(source: StremioPluginSummary, resource: string, type: string, id: string): boolean {
  if (!usable(source)) return false;
  const details = source.resourceDetails;
  if (!details) return source.resources.includes(resource) && source.types.includes(type);
  return details.some(detail => detail.name === resource && detail.types.includes(type)
    && (detail.idPrefixes.length === 0 || detail.idPrefixes.some(prefix => id.startsWith(prefix))));
}

function errorText(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/** Raised when a result was produced under an add-on revision that no longer applies. */
export class StaleAddonSourceError extends Error {}

/** The current summary of a source the active profile can still use. */
export async function requireUsableSource(addonId: string, revision?: string): Promise<StremioPluginSummary> {
  const sources = await desktopApi.listAvailableStremioPlugins();
  const source = sources.find(candidate => candidate.addonId === addonId);
  if (!source || !usable(source)) throw new Error('This source is no longer enabled for this profile.');
  if (revision !== undefined && source.revision !== revision) {
    throw new StaleAddonSourceError(`${source.name} changed since this list loaded.`);
  }
  return source;
}

/**
 * Give a Discover title (IMDb identity, no add-on item) a host key so add-ons
 * that declare `tt` metadata can describe it. Add-on items pass through.
 */
export async function addonIdentityForItem(item: StremioPluginCatalogItem): Promise<StremioPluginCatalogItem> {
  if (item.providerId || !item.imdbId || !/^tt\d{5,12}$/.test(item.imdbId)) return item;
  const type = item.type === 'movie' ? 'movie' : item.type === 'tv' || item.type === 'series' ? 'series' : '';
  if (!type) return item;
  const metaKey = await desktopApi.issueStremioItemKey(type, item.imdbId);
  return { ...item, type, providerId: item.imdbId, metaKey };
}

/**
 * Load full metadata the way Stremio does: the catalog's own add-on first,
 * then any other usable add-on that declares `meta` for this type and ID.
 * The result keeps the item's identity, catalog source, and provider ID.
 * A Discover title keeps its own details and takes only the video list.
 */
export async function loadAddonMeta(item: StremioPluginCatalogItem, onMetadata?: (item: StremioPluginCatalogItem) => void): Promise<StremioPluginCatalogItem> {
  const providerId = item.providerId;
  if (!providerId) return enrichWithCinemeta(item, onMetadata);
  const sources = await desktopApi.listAvailableStremioPlugins();
  const candidates = sources
    .filter(source => supportsAddonResource(source, 'meta', item.type, providerId))
    .sort((a, b) => Number(b.addonId === item.source) - Number(a.addonId === item.source));
  const revisions = candidates.map(source => [source.addonId, source.revision]);
  const key = item.metaKey || item.id;
  const resolved = await cachedDesktopRead('addon-meta', [key, item.type, revisions], async () => {
    for (const source of candidates) {
      try {
        const result = await desktopApi.getStremioMeta(source.addonId, { type: item.type, id: key });
        const meta = result.item;
        if (!meta) continue;
        const binding = {
          providerId,
          metaSource: source.addonId,
          ...(result.sourceRevision ? { metaSourceRevision: result.sourceRevision } : {}),
          ...(meta.defaultVideoId ? { defaultVideoId: meta.defaultVideoId } : {}),
          ...(meta.videos ? { videos: meta.videos } : {}),
        };
        if (item.metaKey) return { ...item, ...binding };
        return {
          ...item,
          ...meta,
          ...binding,
          id: item.id,
          type: item.type,
          source: item.source,
          artwork: { ...item.artwork, ...meta.artwork },
          genres: meta.genres.length ? meta.genres : item.genres,
        };
      } catch {
        // Try the next metadata source; the catalog item stays usable.
      }
    }
    return item;
  }, 5 * 60_000);
  return enrichWithCinemeta(resolved, onMetadata);
}

/**
 * The video a single-video title plays: `defaultVideoId`, else its only
 * listed video, else the title's own ID.
 */
export function defaultAddonVideo(item: StremioPluginCatalogItem): { id: string; video?: StremioPluginVideo } | null {
  const id = item.defaultVideoId || (item.videos?.length === 1 ? item.videos[0].id : item.providerId);
  if (!id) return null;
  return { id, video: item.videos?.find(video => video.id === id) };
}

export type AddonVideoTarget = {
  selectedSourceFingerprint?: string;
  preferredSource?: { addonId: string; resolution: AddonResolution };
  /** A source explicitly chosen by a dedicated add-on route, rather than a last-used preference. */
  sourceRestriction?: string;
  metadataNeedsRefresh?: boolean;
  detailId?: string;
  detailType?: StremioPluginCatalogItem['type'];
  type: string;
  videoId: string;
  title: string;
  /** A dedicated add-on page requests playback only from its selected source. */
  sourceAddonId?: string;
  season?: number;
  episode?: number;
  /**
   * Inline `video.streams`. Defined (even empty) means only these are used;
   * undefined means stream add-ons are asked.
   */
  inlineStreams?: readonly StremioStreamDescriptor[];
  inlineSource?: string;
  /** Revision of `inlineSource` when the inline streams were fetched. */
  inlineRevision?: string;
  /** The title the metadata came from, used to reload stale inline streams. */
  metaItem?: StremioPluginCatalogItem;
};

/** A target for one listed video, keeping its inline streams and their binding. */
export function addonVideoTarget(item: StremioPluginCatalogItem, videoId: string, title: string, video?: StremioPluginVideo, position?: { season: number; episode: number }): AddonVideoTarget {
  return {
    type: item.type,
    detailId: item.id,
    detailType: item.type,
    videoId,
    title,
    ...(position ? { metaItem: item } : {}),
    ...(position ? { season: position.season, episode: position.episode } : {}),
    ...(video?.streams !== undefined ? {
      inlineStreams: video.streams,
      inlineSource: item.metaSource || item.source,
      inlineRevision: item.metaSourceRevision,
      metaItem: item,
    } : {}),
  };
}

/** The stream request a remote title plays: an add-on's own ID, or an IMDb ID from Discover. */
export function addonPlaybackTarget(item: StremioPluginCatalogItem | null | undefined): AddonVideoTarget | null {
  if (!item || item.source === 'archive.org') return null;
  if (item.providerId) {
    const video = defaultAddonVideo(item);
    return video ? addonVideoTarget(item, video.id, item.title, video.video) : null;
  }
  return item.type === 'movie' && item.imdbId && /^tt\d{5,12}$/.test(item.imdbId)
    ? { type: 'movie', videoId: item.imdbId, title: item.title, detailId: item.id, detailType: item.type }
    : null;
}

export type AddonEpisode = { season: number; number: number; video: StremioPluginVideo };

/**
 * Number an add-on's videos as episodes. Videos with season and episode keep
 * them. Others (channel uploads, for example) take the next free number in
 * their season, in the provider's order. A repeated pair keeps its first video.
 */
export function addonEpisodes(videos: readonly StremioPluginVideo[] | undefined): AddonEpisode[] {
  const list = videos || [];
  const taken = new Set<string>();
  const episodes: AddonEpisode[] = [];
  for (const video of list) {
    if (video.season === undefined || video.episode === undefined) continue;
    const key = `${video.season}:${video.episode}`;
    if (taken.has(key)) continue;
    taken.add(key);
    episodes.push({ season: video.season, number: video.episode, video });
  }
  const counters = new Map<number, number>();
  for (const video of list) {
    if (video.season !== undefined && video.episode !== undefined) continue;
    const season = video.season ?? 1;
    let number = video.episode ?? (counters.get(season) ?? 0) + 1;
    if (video.episode === undefined) {
      while (taken.has(`${season}:${number}`)) number += 1;
      counters.set(season, number);
    } else if (taken.has(`${season}:${number}`)) continue;
    taken.add(`${season}:${number}`);
    episodes.push({ season, number, video });
  }
  return episodes;
}

export type AddonSourceGroup = {
  addonId: string;
  addonName: string;
  /** Revision of the add-on when these streams were fetched. */
  revision?: string;
  status: 'loading' | 'ready' | 'empty' | 'error';
  streams: readonly StremioStreamDescriptor[];
  error?: string;
};

/** Reload a title's metadata under the current revisions and rebuild the target for the same video. */
async function refreshInlineTarget(target: AddonVideoTarget): Promise<AddonVideoTarget> {
  if (!target.metaItem) throw new StaleAddonSourceError('This title’s details changed. Open it again to load current sources.');
  invalidateDesktopData(['addon-meta']);
  const item = await loadAddonMeta(target.metaItem);
  if (item === target.metaItem) throw new Error('Current inline sources could not be loaded. Try refreshing again.');
  const video = item.videos?.find(candidate => candidate.id === target.videoId);
  const { inlineStreams: _streams, inlineSource: _source, inlineRevision: _revision, metaItem: _item, ...base } = target;
  return video?.streams !== undefined ? { ...base, ...addonVideoTarget(item, target.videoId, target.title, video), season: target.season, episode: target.episode } : { ...base, metaItem: item };
}

/**
 * Resolve the sources for one video. Inline streams win, as in Stremio, and
 * are reloaded first if their add-on changed. Otherwise every usable add-on
 * that declares `stream` for this type and ID is asked in parallel, and a
 * failure stays inside its own group.
 */
export async function loadAddonSources(initial: AddonVideoTarget, options: {
  signal?: AbortSignal;
  refreshInline?: boolean;
  onUpdate?: (result: { target: AddonVideoTarget; groups: AddonSourceGroup[] }) => void;
} = {}): Promise<{ target: AddonVideoTarget; groups: AddonSourceGroup[] }> {
  let target = initial;
  if (target.metadataNeedsRefresh && target.metaItem) {
    const metadata = await loadAddonMeta(await addonIdentityForItem(target.metaItem));
    options.signal?.throwIfAborted();
    const video = metadata.videos?.find(candidate => candidate.id === target.videoId);
    target = {
      ...target, metaItem: metadata, metadataNeedsRefresh: false,
      ...(video?.streams !== undefined ? {
        inlineStreams: video.streams, inlineSource: metadata.metaSource || metadata.source,
        inlineRevision: metadata.metaSourceRevision,
      } : {}),
    };
  }
  let sources = await desktopApi.listAvailableStremioPlugins();
  options.signal?.throwIfAborted();
  if (target.inlineStreams !== undefined && (!target.sourceAddonId || target.sourceAddonId === target.inlineSource)) {
    let owner = sources.find(source => source.addonId === target.inlineSource && usable(source));
    if (!owner) throw new Error('The source that listed this video is no longer enabled for this profile.');
    if (options.refreshInline || owner.revision !== target.inlineRevision) {
      target = await refreshInlineTarget(target);
      options.signal?.throwIfAborted();
      sources = await desktopApi.listAvailableStremioPlugins();
      owner = sources.find(source => source.addonId === target.inlineSource && usable(source));
    }
    if (target.inlineStreams !== undefined) {
      if (!owner || owner.revision !== target.inlineRevision) throw new StaleAddonSourceError('This title’s source changed again. Try again.');
      return { target, groups: [{ addonId: owner.addonId, addonName: owner.name, revision: owner.revision, status: 'ready', streams: target.inlineStreams }] };
    }
  }
  const current = target;
  const providers = sources.filter(source => (!current.sourceAddonId || source.addonId === current.sourceAddonId)
    && supportsAddonResource(source, 'stream', current.type, current.videoId));
  const groups: AddonSourceGroup[] = providers.map(source => ({
    addonId: source.addonId, addonName: source.name, revision: source.revision, status: 'loading', streams: [],
  }));
  const emit = () => {
    options.signal?.throwIfAborted();
    options.onUpdate?.({ target, groups: [...groups] });
  };
  emit();
  let next = 0;
  // Match the host's bounded concurrency without filling its queue with every addon.
  await Promise.all(Array.from({ length: Math.min(4, providers.length) }, async () => {
    while (next < providers.length) {
      options.signal?.throwIfAborted();
      const index = next++;
      const source = providers[index];
      try {
        const result = await desktopApi.getStremioStreams(source.addonId, { type: current.type, id: current.videoId }, options.signal);
        if (result.sourceRevision !== source.revision) throw new StaleAddonSourceError('This addon changed. Refresh the sources.');
        groups[index] = { addonId: source.addonId, addonName: source.name, revision: result.sourceRevision,
          status: result.streams.length ? 'ready' : 'empty', streams: result.streams };
      } catch (failure) {
        options.signal?.throwIfAborted();
        groups[index] = { addonId: source.addonId, addonName: source.name, status: 'error', streams: [], error: errorText(failure, 'This source did not respond.') };
      }
      emit();
    }
  }));
  return { target, groups };
}

/** OpenSubtitles needs an IMDb title, and an episode for series. */
export function addonSubtitleVideo(target: AddonVideoTarget): SubtitleVideo | undefined {
  const match = target.videoId.match(/^(tt\d{5,12})(?::(\d+):(\d+))?$/);
  if (!match) return undefined;
  if (match[2] !== undefined) return { imdbId: match[1], type: 'series', season: Number(match[2]), episode: Number(match[3]) };
  return target.type === 'movie' ? { imdbId: match[1], type: 'movie' } : undefined;
}

/** Player options for a chosen stream: OpenSubtitles identity and add-on subtitle context. */
export function addonPlaybackOptions(target: AddonVideoTarget, stream: StremioStreamDescriptor, sourceName: string): AddonPlaybackOptions {
  return {
    addonTarget: { ...target, selectedSourceFingerprint: target.sourceAddonId ? sourceFingerprint(target.sourceAddonId, stream) : undefined,
      preferredSource: target.sourceAddonId ? { addonId: target.sourceAddonId, resolution: sourceResolution(stream) } : target.preferredSource },
    subtitleVideo: addonSubtitleVideo(target),
    addonSubtitles: {
      opensubtitlesOnly: stream.transport === 'torrent',
      type: target.type,
      videoId: target.videoId,
      embedded: (stream.subtitles || []).map(subtitle => ({ ...subtitle, sourceName })),
    },
  };
}

export type AddonSubtitleOption = { id: string; token: string; language: string; name: string; source: string };

/**
 * List subtitles for one video: those the chosen stream listed, then every
 * usable add-on that declares `subtitles` for it. Nothing is downloaded here.
 */
export async function findAddonSubtitles(context: AddonSubtitleContext): Promise<{ subtitles: AddonSubtitleOption[]; errors: string[] }> {
  const sources = (await desktopApi.listAvailableStremioPlugins())
    .filter(source => supportsAddonResource(source, 'subtitles', context.type, context.videoId));
  const settled = await Promise.allSettled(sources.map(source => desktopApi.getStremioSubtitles(source.addonId, {
    type: context.type,
    id: context.videoId,
  })));
  // Labels come from the language, provider, and position only. Provider IDs
  // and URLs can carry credentials and never reach the renderer.
  const subtitles: AddonSubtitleOption[] = [];
  const counts = new Map<string, number>();
  const add = (subtitle: StremioStreamSubtitle, source: string, kind: string) => {
    const language = subtitleLanguageLabel(subtitle.language);
    const count = (counts.get(`${source}:${language}`) || 0) + 1;
    counts.set(`${source}:${language}`, count);
    subtitles.push({ id: subtitle.token, token: subtitle.token, language: subtitle.language, name: `${language} ${count} · ${kind}`, source });
  };
  for (const subtitle of context.embedded) add(subtitle, subtitle.sourceName, 'from this stream');
  const errors: string[] = [];
  settled.forEach((result, index) => {
    const source = sources[index];
    if (result.status === 'rejected') { errors.push(`${source.name}: ${errorText(result.reason, 'did not respond.')}`); return; }
    for (const subtitle of result.value.subtitles) add(subtitle, source.name, source.name);
  });
  return { subtitles, errors };
}
