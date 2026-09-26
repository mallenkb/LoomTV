import { useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Play, Star } from 'lucide-react';
import TelevisionPlaceholder from '@/components/TelevisionPlaceholder';
import LibrarySearch from '@/components/LibrarySearch';
import ThemeFilterDropdown from '@/components/ThemeFilterDropdown';
import { ChannelGridShimmer } from '@/components/ContentShimmer';
import { useTheme } from '@/components/ThemeProvider';
import { desktopApi } from '@/lib/desktopApi';
import { iptvSourceDisplayName } from '@/lib/liveTvSources';
import type { IptvChannelPage, IptvChannelSort, IptvChannelSummary, IptvGeoFilter } from '@/shared/desktopProtocol';
import { buildIptvPlaybackReference } from '@/shared/iptvPlayback';
import { normalizeIptvLogoUrl } from '@/shared/iptvLogoUrl';
import { displayChannelName } from '@/shared/iptvChannelName';
import { setLiveLineup } from '@/lib/liveChannelLineup';

const CHANNEL_PAGE_SIZE = 120;
const SEARCH_DEBOUNCE_MS = 250;
/** How often the page picks up newly verified channels while a check runs. */
const VERIFY_POLL_MS = 15_000;
const ALL_GROUPS = '';
const ALL_SUBCATEGORIES = '';
const SORT_OPTIONS: ReadonlyArray<{ value: IptvChannelSort; label: string }> = [
  { value: 'name-asc', label: 'A–Z' },
  { value: 'name-desc', label: 'Z–A' },
  { value: 'category', label: 'Categories' },
];
type ChannelCollection = 'all' | 'favorites' | 'recent';
const COLLECTION_OPTIONS: ReadonlyArray<{ value: ChannelCollection; label: string }> = [
  { value: 'all', label: 'All channels' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'recent', label: 'Recently watched' },
];
const GEO_FILTER_OPTIONS: ReadonlyArray<{ value: IptvGeoFilter; label: string }> = [
  { value: 'all', label: 'All channels' },
  { value: 'exclude', label: 'Hide geo-blocked' },
  { value: 'only', label: 'Only geo-blocked' },
];

type LiveTvProps = {
  onPlay: (streamUrl: string, channelName: string, channelLogoUrl?: string) => void;
};

function formatClock(value: number): string {
  if (!value) return '';
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatRefreshedAt(value: number): string {
  if (!value) return 'Never refreshed';
  return `Updated ${new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

function channelCategories(groupTitle: string): string[] {
  return groupTitle.split(';').map((category) => category.trim()).filter(Boolean);
}

/** How far through the current programme the channel is, as a 0–1 fraction. */
function programmeProgress(channel: IptvChannelSummary, nowMs: number): number {
  if (!channel.nowStartMs || channel.nowEndMs <= channel.nowStartMs) return 0;
  const elapsed = (nowMs - channel.nowStartMs) / (channel.nowEndMs - channel.nowStartMs);
  return Math.min(Math.max(elapsed, 0), 1);
}

function ChannelCard({
  channel,
  nowMs,
  onPlay,
  onToggleFavorite,
}: {
  channel: IptvChannelSummary;
  nowMs: number;
  onPlay: () => void;
  onToggleFavorite: () => void;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const logoUrl = useMemo(() => normalizeIptvLogoUrl(channel.logoUrl), [channel.logoUrl]);
  const progress = programmeProgress(channel, nowMs);
  const name = displayChannelName(channel.name);

  useEffect(() => setLogoFailed(false), [logoUrl]);

  return (
    <div className="group relative h-full">
    <button
      type="button"
      onClick={onPlay}
      className="relative flex h-full w-full flex-col gap-3 rounded-xl border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-3 text-left transition-colors hover:border-[var(--loom-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
      aria-label={channel.nowTitle ? `Play ${name}, now showing ${channel.nowTitle}` : `Play ${name}`}
    >
      <div className="flex items-center gap-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-[var(--loom-surface-2)]">
          {logoUrl && !logoFailed ? (
            <img
              src={logoUrl}
              alt=""
              loading="eager"
              decoding="async"
              referrerPolicy="no-referrer"
              width={48}
              height={48}
              onError={() => setLogoFailed(true)}
              className="h-full w-full object-contain p-1"
            />
          ) : (
            <TelevisionPlaceholder className="h-8 w-8 shrink-0 opacity-80" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--loom-text)]" title={channel.name}>{name}</p>
          {channel.groupTitle ? (
            <p className="truncate text-xs text-[var(--loom-faint)]">{channelCategories(channel.groupTitle).join(' · ')}</p>
          ) : null}
        </div>
        <span className="mr-9 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--loom-surface-3)] text-[var(--loom-text)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Play className="h-4 w-4 fill-current" strokeWidth={0} aria-hidden="true" />
        </span>
      </div>

      {channel.nowTitle ? (
        <div className="mt-auto min-w-0">
          <p className="truncate text-xs font-medium text-[var(--loom-text)]">{channel.nowTitle}</p>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--loom-surface-3)]">
            <div
              className="h-full rounded-full bg-[var(--loom-accent)]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="mt-1 truncate text-[11px] text-[var(--loom-faint)]">
            {formatClock(channel.nowStartMs)} - {formatClock(channel.nowEndMs)}
            {channel.nextTitle ? ` · Next: ${channel.nextTitle}` : ''}
          </p>
        </div>
      ) : null}
    </button>
    <button
      type="button"
      onClick={onToggleFavorite}
      aria-pressed={channel.favorite}
      aria-label={channel.favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
      title={channel.favorite ? 'Remove from favorites' : 'Add to favorites'}
      className={`absolute right-3 top-5 grid h-8 w-8 place-items-center rounded-full transition-opacity hover:bg-[var(--loom-surface-3)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${channel.favorite ? 'text-[var(--loom-accent)] opacity-100' : 'text-[var(--loom-muted)] opacity-0 group-hover:opacity-100'}`}
    >
      <Star className={`h-4 w-4 ${channel.favorite ? 'fill-current' : ''}`} aria-hidden="true" />
    </button>
    </div>
  );
}

/**
 * One added provider gets one of these pages, reached from its own sidebar
 * tab. Search and group filtering are resolved in the main process against the
 * stored channel table, so a 15,000-channel playlist pages in rather than
 * shipping the whole list to the renderer.
 */
export default function LiveTv({ onPlay }: LiveTvProps) {
  const { sourceId = '' } = useParams({ from: '/live/$sourceId' });
  const { theme } = useTheme();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [group, setGroup] = useState(ALL_GROUPS);
  const [subcategory, setSubcategory] = useState(ALL_SUBCATEGORIES);
  const [geoFilter, setGeoFilter] = useState<IptvGeoFilter>('all');
  const [sort, setSort] = useState<IptvChannelSort>('category');
  const [collection, setCollection] = useState<ChannelCollection>('all');
  const [page, setPage] = useState<IptvChannelPage | null>(null);
  const [channels, setChannels] = useState<IptvChannelSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPaging, setIsPaging] = useState(false);
  const [isHeaderScrolled, setIsHeaderScrolled] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const requestTokenRef = useRef(0);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  // The first load of each source asks the main process to re-verify its
  // stale streams; later loads (paging, filters, polling) only read.
  const verifyRequestedForRef = useRef('');

  const isModern = theme.homeStyle === 'modern';

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Guide progress is the only thing on this page that moves on its own.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // A new source, query, or group starts a fresh list rather than appending.
  useEffect(() => {
    setChannels([]);
    setIsLoading(true);
  }, [sourceId, debouncedQuery, group, subcategory, geoFilter, sort, collection]);

  const loadChannels = useCallback(async (offset: number) => {
    if (!sourceId) return;
    const token = ++requestTokenRef.current;
    if (offset > 0) setIsPaging(true);
    const verify = verifyRequestedForRef.current !== sourceId;
    verifyRequestedForRef.current = sourceId;
    try {
      const result = await desktopApi.listIptvChannels({
        sourceId,
        query: debouncedQuery,
        group: group || undefined,
        subcategory: subcategory || undefined,
        geoFilter,
        sort,
        collection,
        limit: CHANNEL_PAGE_SIZE,
        offset,
        verify,
      });
      if (token !== requestTokenRef.current) return;
      setPage(result);
      setChannels((previous) => offset > 0 ? [...previous, ...result.channels] : [...result.channels]);
      setLoadError('');
    } catch (error) {
      if (token !== requestTokenRef.current) return;
      setLoadError(error instanceof Error ? error.message : 'Could not load channels.');
    } finally {
      if (token === requestTokenRef.current) {
        setIsLoading(false);
        setIsPaging(false);
      }
    }
  }, [collection, debouncedQuery, geoFilter, group, sort, sourceId, subcategory]);

  useEffect(() => {
    void loadChannels(0);
  }, [loadChannels]);

  // Channels appear only once verified, so while a check runs the first page
  // is re-read to pick up new passes. Past the first page the list is left
  // alone rather than yanked from under the scroll position; it reloads once
  // the check finishes.
  const isVerifying = page?.health.checking ?? false;
  const listIsFirstPage = channels.length <= CHANNEL_PAGE_SIZE;
  const wasVerifyingRef = useRef(false);
  useEffect(() => {
    if (wasVerifyingRef.current && !isVerifying) void loadChannels(0);
    wasVerifyingRef.current = isVerifying;
    if (!isVerifying) return undefined;
    const timer = window.setInterval(() => {
      if (listIsFirstPage) {
        void loadChannels(0);
        return;
      }
      desktopApi.listIptvSources()
        .then((sources) => {
          const source = sources.find((entry) => entry.id === sourceId);
          if (source) setPage((current) => (current ? { ...current, health: source.health } : current));
        })
        .catch(() => undefined);
    }, VERIFY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isVerifying, listIsFirstPage, loadChannels, sourceId]);

  const groupOptions = useMemo(
    () => [{ name: ALL_GROUPS, channelCount: page?.total ?? 0 }, ...(page?.groups || [])],
    [page],
  );
  const remainingCount = page ? Math.max(page.total - channels.length, 0) : 0;
  const frameClass = isModern ? 'loom-modern-content-frame' : 'loom-frame';
  const topPaddingClass = isModern ? 'pt-6' : 'loom-discover-page-frame';
  const filterOptions = groupOptions.map((option) => ({
    value: option.name,
    label: `${option.name || 'All groups'} (${option.channelCount.toLocaleString()})`,
  }));
  const subcategoryOptions = useMemo(() => [
    { value: ALL_SUBCATEGORIES, label: 'All subcategories' },
    ...(page?.subcategories || []).map((option) => ({
      value: option.name,
      label: `${option.name} (${option.channelCount.toLocaleString()})`,
    })),
  ], [page?.subcategories]);
  const categorySections = useMemo(() => {
    if (sort !== 'category') return [];
    const sections = new Map<string, IptvChannelSummary[]>();
    channels.forEach((channel) => {
      const sectionName = channelCategories(channel.groupTitle)[0] || 'Other';
      const section = sections.get(sectionName);
      if (section) section.push(channel);
      else sections.set(sectionName, [channel]);
    });
    return [...sections.entries()];
  }, [channels, sort]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || isLoading || isPaging || remainingCount <= 0) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadChannels(channels.length);
      }
    }, { rootMargin: '360px 0px' });

    observer.observe(target);
    return () => observer.disconnect();
  }, [channels.length, isLoading, isPaging, loadChannels, remainingCount]);

  // Star or unstar at once; the list catches up when it next loads.
  const toggleFavorite = (channel: IptvChannelSummary) => {
    const favorite = !channel.favorite;
    setChannels((current) => current
      .map((entry) => (entry.channelId === channel.channelId ? { ...entry, favorite } : entry))
      .filter((entry) => collection !== 'favorites' || entry.favorite));
    void desktopApi.setIptvFavorite(sourceId, channel.channelId, favorite).catch((error) => {
      setLoadError(error instanceof Error ? error.message : 'Could not update favorites.');
      void loadChannels(0);
    });
  };

  // Opening a channel records the list it was opened from, so the player can
  // step through the same channels in the same order.
  const playChannel = (channel: IptvChannelSummary) => {
    const lineup = channels.map((entry) => ({
      reference: buildIptvPlaybackReference(sourceId, entry.channelId, entry.streamUrl),
      name: displayChannelName(entry.name),
      logoUrl: normalizeIptvLogoUrl(entry.logoUrl) || undefined,
    }));
    const reference = buildIptvPlaybackReference(sourceId, channel.channelId, channel.streamUrl);
    setLiveLineup(lineup, reference);
    onPlay(reference, displayChannelName(channel.name), normalizeIptvLogoUrl(channel.logoUrl) || undefined);
  };

  if (!sourceId) return null;

  return (
    <div
      className="loom-page loom-library-page h-full overflow-y-auto"
      onScroll={(event) => setIsHeaderScrolled(event.currentTarget.scrollTop > 4)}
    >
      <div className={`${frameClass} loom-library-page-frame page-bottom-safe page-list-bottom-safe ${topPaddingClass}`}>
        <header className={`loom-library-page-heading sticky top-0 z-40 isolate mb-6 flex min-h-8 shrink-0 flex-wrap items-start justify-between gap-4 border-b bg-[var(--loom-bg)] py-3 backdrop-blur-xl transition-[border-color,box-shadow] duration-150 ${isHeaderScrolled ? 'border-[var(--loom-border)] shadow-[0_12px_24px_-22px_rgb(0_0_0_/_0.9)]' : 'border-transparent'}`}>
          <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold text-[var(--loom-text)]">
                {iptvSourceDisplayName(page?.sourceName)}
              </h1>
              <p className="mt-1 text-sm text-[var(--loom-muted)]">
                {page
                  ? `${page.total.toLocaleString()} ${page.total === 1 ? 'channel' : 'channels'}${debouncedQuery ? ' matching' : ''} · ${formatRefreshedAt(page.refreshedAt)}`
                  : 'Loading channels'}
              </p>
            </div>
            <LibrarySearch
              value={query}
              onChange={setQuery}
              placeholder="Search channels"
              placement="inline"
            />
          </div>
          <div className="w-full">
            <div className="flex items-center gap-2 overflow-x-auto overflow-y-visible pb-1">
              {groupOptions.length > 1 ? (
                <ThemeFilterDropdown
                  id="live-tv-group-filter"
                  label="Filter channel group"
                  value={group}
                  options={filterOptions}
                  onChange={(value) => {
                    setGroup(value);
                    setSubcategory(ALL_SUBCATEGORIES);
                  }}
                  searchable
                  searchPlaceholder="Search groups"
                  emptySearchMessage="No matching groups"
                />
              ) : null}
              {group && subcategoryOptions.length > 1 ? (
                <ThemeFilterDropdown
                  id="live-tv-subcategory-filter"
                  label="Filter subcategory"
                  value={subcategory}
                  options={subcategoryOptions}
                  onChange={setSubcategory}
                  searchable
                  searchPlaceholder="Search subcategories"
                  emptySearchMessage="No matching subcategories"
                />
              ) : null}
              <ThemeFilterDropdown
                id="live-tv-collection"
                label="Show channels"
                value={collection}
                options={COLLECTION_OPTIONS}
                onChange={(value) => setCollection(value as ChannelCollection)}
              />
              <ThemeFilterDropdown
                id="live-tv-geo-filter"
                label="Filter channel availability"
                value={geoFilter}
                options={GEO_FILTER_OPTIONS}
                onChange={(value) => setGeoFilter(value as IptvGeoFilter)}
              />
              <ThemeFilterDropdown
                id="live-tv-sort"
                label="Sort channels"
                value={sort}
                options={SORT_OPTIONS}
                onChange={(value) => setSort(value as IptvChannelSort)}
              />
            </div>
          </div>
        </header>

        {page?.refreshError ? (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              The last refresh failed: {page.refreshError} These channels are from the previous successful refresh.
            </span>
          </div>
        ) : null}

        {page?.health.checking ? (
          <div
            role="status"
            aria-live="polite"
            className="mb-4 rounded-xl border border-[var(--loom-panel-border)] px-4 py-3 text-sm text-[var(--loom-muted)]"
          >
            {page.health.total > 0
              ? `Verifying channels: ${page.health.checked.toLocaleString()} of ${page.health.total.toLocaleString()} checked.`
              : 'Waiting to verify channels.'}
            {' '}Only channels that play are shown, and more appear as they pass.
          </div>
        ) : null}

        {loadError ? (
          <div role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {loadError}
          </div>
        ) : null}

        {isLoading ? (
          <ChannelGridShimmer />
        ) : channels.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--loom-panel-border)] px-6 py-14 text-center">
            <TelevisionPlaceholder className="mx-auto mb-3 h-12 w-12 opacity-80" />
            <p className="text-sm text-[var(--loom-muted)]">
              {debouncedQuery || group || subcategory || geoFilter !== 'all'
                ? 'No channels match that search.'
                : page?.health.checking
                  ? 'No channels have been verified yet. They appear here as they pass.'
                  : page && page.health.pending + page.health.failed > 0
                    ? 'None of this source\'s channels are playing right now.'
                    : "This source has no channels yet. It will populate after the provider's next playlist sync."}
            </p>
          </div>
        ) : (
          <>
            {sort === 'category' ? (
              <div className="space-y-7">
                {categorySections.map(([sectionName, sectionChannels]) => (
                  <section key={sectionName}>
                    <h2 className="mb-3 text-sm font-semibold text-[var(--loom-text)]">
                      {sectionName}
                    </h2>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                      {sectionChannels.map((channel) => (
                        <ChannelCard
                          key={channel.channelId}
                          channel={channel}
                          nowMs={nowMs}
                          onPlay={() => playChannel(channel)}
                          onToggleFavorite={() => toggleFavorite(channel)}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                {channels.map((channel) => (
                  <ChannelCard
                    key={channel.channelId}
                    channel={channel}
                    nowMs={nowMs}
                    onPlay={() => playChannel(channel)}
                    onToggleFavorite={() => toggleFavorite(channel)}
                  />
                ))}
              </div>
            )}
            {remainingCount > 0 ? (
              <div
                ref={loadMoreRef}
                className="mt-6 flex min-h-12 items-center justify-center text-sm text-[var(--loom-muted)]"
                role="status"
                aria-live="polite"
              >
                {isPaging ? 'Loading more channels…' : `${remainingCount.toLocaleString()} more channels`}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
