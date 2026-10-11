import { useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import { useProfiles } from '@/contexts/ProfileContext';
import { DiscoverHeader, DiscoverPosterGrid, discoverFilterChipClass } from '@/components/DiscoverCatalogLayout';
import DiscoverDropdown from '@/components/DiscoverDropdown';
import { PosterGridShimmer } from '@/components/ContentShimmer';
import { useNavigate } from '@/lib/navigation';
import { cacheDiscoverReturnRoute, cacheExploreItem } from '@/lib/discoverNavigation';
import { desktopApi, type StremioPluginCatalogItem } from '@/lib/desktopApi';
import {
  ARCHIVE_ADDON_ID, ARCHIVE_PAGE_SIZE, archiveCatalog, archiveItem,
  enrichArchiveItem, resolveArchiveStream, type ArchiveCatalogItem,
} from '@/lib/archiveCatalog';
import { invalidateRequests, type AddonStreamPlayer } from '@/lib/addonPlayback';
import StremioAddonCatalog from './StremioAddonCatalog';

type ArchiveOrgAddonProps = { onPlay: AddonStreamPlayer };
const YEAR_OPTIONS = [{ value: '', label: 'All years' }, ...Array.from({ length: new Date().getFullYear() - 1887 }, (_, index) => {
  const value = String(new Date().getFullYear() - index);
  return { value, label: value };
})];

async function requireArchiveSource() {
  const plugins = await desktopApi.listAvailableStremioPlugins();
  const source = plugins.find(plugin => plugin.addonId === ARCHIVE_ADDON_ID && plugin.state === 'enabled' && plugin.trusted);
  if (!source) throw new Error('The Archive.org add-on is not enabled for this profile.');
  return source;
}

export function ArchiveCatalog({ onPlay }: ArchiveOrgAddonProps) {
  const { theme } = useTheme();
  const { activeProfile } = useProfiles();
  const navigate = useNavigate();
  const [items, setItems] = useState<ArchiveCatalogItem[]>([]);
  const [queryInput, setQueryInput] = useState('');
  const [filters, setFilters] = useState({ query: '', order: 'popular', year: '', page: 1 });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const [error, setError] = useState('');
  const [playingId, setPlayingId] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(current => ({ ...current, query: queryInput.trim(), page: 1 })), 350);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    const refresh = () => setRevision(current => current + 1);
    window.addEventListener('loomtv:plugins-changed', refresh);
    return () => window.removeEventListener('loomtv:plugins-changed', refresh);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    const isCurrent = () => current === generation.current && !controller.signal.aborted;
    setLoading(true); setItems([]); setError(''); setTotal(0); setPlayingId('');
    void (async () => {
      try {
        const [, settings] = await Promise.all([requireArchiveSource(), desktopApi.getSettings().catch(() => null)]);
        if (!isCurrent()) return;
        const result = await archiveCatalog(filters.query, filters.page, filters.order, filters.year, controller.signal);
        if (!isCurrent()) return;
        const catalog = result.docs.map(archiveItem);
        setItems(catalog); setTotal(result.numFound);
        const hasTmdb = Boolean(settings?.metadataApiKeys?.tmdb || settings?.tmdbApiKey);
        let next = 0;
        // Every result shows at once. Artwork and descriptions fill in with
        // bounded concurrency; the video file is looked up only at Play.
        await Promise.all(Array.from({ length: Math.min(4, catalog.length) }, async () => {
          while (isCurrent() && next < catalog.length) {
            const item = catalog[next++];
            let enriched: ArchiveCatalogItem;
            try { enriched = await enrichArchiveItem(item, hasTmdb); }
            catch { continue; /* Archive artwork and metadata remain usable when a metadata provider is unavailable. */ }
            if (isCurrent()) setItems(currentItems => currentItems.map(candidate => candidate.id === item.id ? enriched : candidate));
          }
        }));
      } catch (failure) {
        if (isCurrent()) setError(failure instanceof Error ? failure.message : 'Archive.org could not be loaded.');
      } finally { if (isCurrent()) setLoading(false); }
    })();
    return () => { invalidateRequests(generation); controller.abort(); };
  }, [activeProfile?.id, filters, revision]);

  const play = useCallback(async (item: StremioPluginCatalogItem) => {
    const archive = items.find(candidate => candidate.id === item.id);
    if (!archive || playingId) return;
    const current = generation.current;
    setPlayingId(item.id); setError('');
    try {
      await requireArchiveSource();
      const streamUrl = await resolveArchiveStream(archive.identifier);
      if (current !== generation.current) return;
      const poster = archive.posterUrl || archive.archiveThumbnail;
      onPlay(streamUrl, archive.title, { poster, backdrop: archive.backgroundUrl || poster });
    } catch (failure) {
      if (current === generation.current) setError(`${archive.title}: ${failure instanceof Error ? failure.message : 'The movie could not be opened.'}`);
    } finally { if (current === generation.current) setPlayingId(''); }
  }, [items, onPlay, playingId]);

  const entries = useMemo(() => items.map((item, index) => ({ id: item.id, item, rank: index + 1 })), [items]);
  const openDetails = (item: StremioPluginCatalogItem) => {
    const from = `/addons/stremio/${ARCHIVE_ADDON_ID}`;
    cacheDiscoverReturnRoute(from); cacheExploreItem(item);
    navigate(`/movie/${encodeURIComponent(item.id)}`, { state: { from, fromDiscover: true, stremioCatalogItem: item } });
  };
  const maxPage = Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE));
  const isModern = theme.homeStyle === 'modern';
  const playbackStatus = (item: StremioPluginCatalogItem) => playingId ? item.id === playingId ? 'Opening' : 'Play' : undefined;

  return (
    <div className="loom-page loom-library-page h-full overflow-y-auto" onScroll={event => setScrolled(event.currentTarget.scrollTop > 4)}>
      <div className={`${isModern ? 'loom-modern-content-frame' : 'loom-frame'} loom-library-page-frame page-bottom-safe page-list-bottom-safe ${isModern ? 'pt-6' : 'loom-discover-page-frame'}`}>
        <DiscoverHeader title="Archive.org" description="Films marked as public domain on Archive.org." scrolled={scrolled} query={queryInput} onQueryChange={setQueryInput}>
          <div className="flex w-full items-center gap-2 overflow-x-auto pb-1">
            <button type="button" aria-pressed className={discoverFilterChipClass(true)}>Movies</button>
            <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-[var(--loom-border)]" />
            <DiscoverDropdown id="archive-order" label="Sort films" value={filters.order} options={[{ value: 'popular', label: 'Popular' }, { value: 'new', label: 'Recently added' }]} onChange={order => setFilters(current => ({ ...current, order, page: 1 }))} />
            <DiscoverDropdown id="archive-year" label="Release year" value={filters.year} options={YEAR_OPTIONS} searchable onChange={year => setFilters(current => ({ ...current, year, page: 1 }))} />
            <button type="button" onClick={() => setRevision(current => current + 1)} className={discoverFilterChipClass(false)}>Refresh</button>
          </div>
        </DiscoverHeader>
        {error ? <p role="alert" className="mb-6 rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</p> : null}
        {entries.length ? (
          <DiscoverPosterGrid entries={entries} metaLine={item => item.releaseInfo || ''} onSelect={openDetails} onPlay={item => { void play(item); }} playbackStatus={playbackStatus} />
        ) : loading ? <PosterGridShimmer className="mt-4" /> : <p className="mt-10 text-center text-sm text-[var(--loom-muted)]">No films matched this selection.</p>}
        {loading && entries.length > 0 ? <p role="status" className="mt-6 text-sm text-[var(--loom-muted)]">Loading more films…</p> : null}
        {!loading && maxPage > 1 ? (
          <nav aria-label="Archive.org pages" className="mt-8 flex items-center justify-center gap-4">
            <button type="button" disabled={filters.page <= 1} aria-label="Previous page" onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))} className="grid h-10 w-10 place-items-center rounded-full bg-[var(--loom-surface-2)] text-[var(--loom-text)] disabled:opacity-35"><ChevronLeft className="h-5 w-5" /></button>
            <span className="text-sm text-[var(--loom-muted)]">Page {filters.page} of {maxPage.toLocaleString()}</span>
            <button type="button" disabled={filters.page >= maxPage} aria-label="Next page" onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))} className="grid h-10 w-10 place-items-center rounded-full bg-[var(--loom-surface-2)] text-[var(--loom-text)] disabled:opacity-35"><ChevronRight className="h-5 w-5" /></button>
          </nav>
        ) : null}
      </div>
    </div>
  );
}

export default function ArchiveOrgAddon(props: ArchiveOrgAddonProps) {
  const { addonId = '' } = useParams({ from: '/addons/stremio/$addonId' });
  return addonId === ARCHIVE_ADDON_ID ? <ArchiveCatalog key={addonId} {...props} /> : <StremioAddonCatalog key={addonId} addonId={addonId} {...props} />;
}
