import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { AlertTriangle, Play, Tv } from 'lucide-react';
import LibrarySearch from '@/components/LibrarySearch';
import ThemeFilterDropdown from '@/components/ThemeFilterDropdown';
import { ChannelGridShimmer } from '@/components/ContentShimmer';
import { useTheme } from '@/components/ThemeProvider';
import { desktopApi } from '@/lib/desktopApi';
import { iptvSourceDisplayName } from '@/lib/liveTvSources';
import type { IptvChannelPage, IptvChannelSort, IptvChannelSummary, IptvGeoFilter } from '@/shared/desktopProtocol';
import { buildIptvPlaybackReference } from '@/shared/iptvPlayback';

const CHANNEL_PAGE_SIZE = 120;
const SEARCH_DEBOUNCE_MS = 250;
const ALL_GROUPS = '';
const ALL_SUBCATEGORIES = '';
const SORT_OPTIONS: ReadonlyArray<{ value: IptvChannelSort; label: string }> = [
  { value: 'name-asc', label: 'A–Z' },
  { value: 'name-desc', label: 'Z–A' },
  { value: 'category', label: 'Categories' },
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
}: {
  channel: IptvChannelSummary;
  nowMs: number;
  onPlay: () => void;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const progress = programmeProgress(channel, nowMs);

  return (
    <button
      type="button"
      onClick={onPlay}
      className="group relative flex h-full flex-col gap-3 rounded-xl border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-3 text-left transition-colors hover:border-[var(--loom-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
      aria-label={channel.nowTitle ? `Play ${channel.name}, now showing ${channel.nowTitle}` : `Play ${channel.name}`}
    >
      <div className="flex items-center gap-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-[var(--loom-surface-2)]">
          {channel.logoUrl && !logoFailed ? (
            <img
              src={channel.logoUrl}
              alt=""
              loading="lazy"
              onError={() => setLogoFailed(true)}
              className="h-full w-full object-contain p-1"
            />
          ) : (
            <Tv className="h-5 w-5 text-[var(--loom-muted)]" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--loom-text)]">{channel.name}</p>
          {channel.groupTitle ? (
            <p className="truncate text-xs text-[var(--loom-faint)]">{channelCategories(channel.groupTitle).join(' · ')}</p>
          ) : null}
        </div>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--loom-surface-3)] text-[var(--loom-text)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
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
  );
}

/**
 * One added provider gets one of these pages, reached from its own sidebar
 * tab. Search and group filtering are resolved in the main process against the
 * stored channel table, so a 15,000-channel playlist pages in rather than
 * shipping the whole list to the renderer.
 */
export default function LiveTv({ onPlay }: LiveTvProps) {
  const { sourceId = '' } = useParams<{ sourceId: string }>();
  const { theme } = useTheme();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [group, setGroup] = useState(ALL_GROUPS);
  const [subcategory, setSubcategory] = useState(ALL_SUBCATEGORIES);
  const [geoFilter, setGeoFilter] = useState<IptvGeoFilter>('all');
  const [sort, setSort] = useState<IptvChannelSort>('category');
  const [page, setPage] = useState<IptvChannelPage | null>(null);
  const [channels, setChannels] = useState<IptvChannelSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPaging, setIsPaging] = useState(false);
  const [isHeaderScrolled, setIsHeaderScrolled] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const requestTokenRef = useRef(0);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

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
  }, [sourceId, debouncedQuery, group, subcategory, geoFilter, sort]);

  const loadChannels = useCallback(async (offset: number) => {
    if (!sourceId) return;
    const token = ++requestTokenRef.current;
    if (offset > 0) setIsPaging(true);
    try {
      const result = await desktopApi.listIptvChannels({
        sourceId,
        query: debouncedQuery,
        group: group || undefined,
        subcategory: subcategory || undefined,
        geoFilter,
        sort,
        limit: CHANNEL_PAGE_SIZE,
        offset,
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
  }, [debouncedQuery, geoFilter, group, sort, sourceId, subcategory]);

  useEffect(() => {
    void loadChannels(0);
  }, [loadChannels]);

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

        {loadError ? (
          <div role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {loadError}
          </div>
        ) : null}

        {isLoading ? (
          <ChannelGridShimmer />
        ) : channels.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--loom-panel-border)] px-6 py-14 text-center">
            <Tv className="mx-auto mb-3 h-8 w-8 text-[var(--loom-faint)]" aria-hidden="true" />
            <p className="text-sm text-[var(--loom-muted)]">
              {debouncedQuery || group || subcategory || geoFilter !== 'all'
                ? 'No channels match that search.'
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
                          onPlay={() => onPlay(buildIptvPlaybackReference(sourceId, channel.channelId, channel.streamUrl), channel.name, channel.logoUrl)}
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
                    onPlay={() => onPlay(buildIptvPlaybackReference(sourceId, channel.channelId, channel.streamUrl), channel.name, channel.logoUrl)}
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
