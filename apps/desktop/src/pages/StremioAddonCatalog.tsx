import AddonKeepWatching from '@/components/AddonKeepWatching';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@/components/ThemeProvider';
import { useProfiles } from '@/contexts/ProfileContext';
import { DiscoverHeader, DiscoverPosterGrid, discoverFilterChipClass } from '@/components/DiscoverCatalogLayout';
import DiscoverDropdown from '@/components/DiscoverDropdown';
import { PosterGridShimmer } from '@/components/ContentShimmer';
import { desktopApi, type StremioPluginCatalogItem, type StremioPluginSummary } from '@/lib/desktopApi';
import { useNavigate } from '@/lib/navigation';
import { cacheDiscoverReturnRoute, cacheExploreItem } from '@/lib/discoverNavigation';
import { isCancelledError } from '@tanstack/react-query';
import { cachedDesktopRead } from '@/lib/queryClient';
import {
  addonDetailRoute, addonPlaybackTarget, invalidateRequests, isSeriesLikeType, loadAddonMeta,
  type AddonStreamPlayer,
} from '@/lib/addonPlayback';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import StremioStreamAddon from './StremioStreamAddon';

const PAGE_SIZE = 30;
const TYPE_LABELS: Record<string, string> = { movie: 'Movies', series: 'TV Shows', anime: 'Anime', channel: 'Channels', tv: 'Live TV', other: 'Other' };
type CatalogDefinition = StremioPluginSummary['catalogs'][number];
const catalogKey = (catalog: CatalogDefinition) => JSON.stringify([catalog.type, catalog.id]);

const isGenreExtra = (name: string) => /^genres?$/.test(name);
const isYearExtra = (name: string) => /^(year|releaseYear|release_year)$/.test(name);
/** Extras with a dedicated control (search box, genre, year) or handled by the host (skip). */
const isStandardExtra = (name: string) => name === 'search' || name === 'skip' || isGenreExtra(name) || isYearExtra(name);

/** A declared value with no listed options. Applies on Enter or blur, not per keystroke. */
function ExtraTextInput({ name, required, value, onCommit }: { name: string; required: boolean; value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft.trim() !== value) onCommit(draft.trim()); };
  return (
    <label className="flex h-8 shrink-0 items-center gap-2 rounded-full border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 text-xs text-[var(--loom-muted)]">
      <span>{name}{required ? ' *' : ''}</span>
      <input
        value={draft}
        maxLength={128}
        required={required}
        aria-label={`${name}${required ? ' (required)' : ''}`}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') commit(); }}
        className="w-28 bg-transparent text-[var(--loom-text)] outline-none"
      />
    </label>
  );
}

/** Open on a catalog that can list titles without input, when there is one. */
function defaultCatalog(catalogs: readonly CatalogDefinition[]): CatalogDefinition | undefined {
  return catalogs.find(catalog => !catalog.extra.some(extra => extra.isRequired)) || catalogs[0];
}

export default function StremioAddonCatalog({ addonId, onPlay }: {
  addonId: string;
  onPlay: AddonStreamPlayer;
}) {
  const { theme } = useTheme();
  const { activeProfile } = useProfiles();
  const navigate = useNavigate();
  const [source, setSource] = useState<StremioPluginSummary | null>(null);
  const [selection, setSelection] = useState<{ catalog: string; query: string; genre: string; year: string; extras: Record<string, string> }>({ catalog: '', query: '', genre: '', year: '', extras: {} });
  const [page, setPage] = useState(1);
  const [queryInput, setQueryInput] = useState('');
  const [items, setItems] = useState<StremioPluginCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const [openingId, setOpeningId] = useState('');
  const [revision, setRevision] = useState(0);
  const [facets, setFacets] = useState<Record<string, { genres: string[]; years: string[] }>>({});
  const generation = useRef(0);
  const catalog = source?.catalogs.find(candidate => catalogKey(candidate) === selection.catalog);
  // The user's value, else the first listed option of a required extra. The
  // default is computed, never written over what the user chose.
  const extraValue = (extra: CatalogDefinition['extra'][number]): string => {
    const chosen = extra.name === 'search' ? selection.query
      : isGenreExtra(extra.name) ? selection.genre
        : isYearExtra(extra.name) ? selection.year
          : selection.extras[extra.name] || '';
    return chosen || (extra.isRequired && extra.options?.length ? extra.options[0] : '');
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setSelection(current => ({ ...current, query: queryInput.trim() })), 350);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    let mounted = true;
    let refreshGeneration = 0;
    const refresh = async () => {
      const refreshId = ++refreshGeneration;
      setLoading(true); setSource(null); setItems([]); setError(''); setOpeningId(''); setFacets({});
      generation.current++;
      try {
        const available = await desktopApi.listAvailableStremioPlugins();
        if (!mounted || refreshId !== refreshGeneration) return;
        const installed = available.find(plugin => plugin.addonId === addonId && plugin.state === 'enabled' && plugin.trusted && plugin.configured);
        if (!installed) throw new Error('This add-on is not enabled for this profile.');
        setSource(installed);
        setSelection(current => {
          const fallback = defaultCatalog(installed.catalogs);
          return { ...current, catalog: installed.catalogs.some(entry => catalogKey(entry) === current.catalog) ? current.catalog : fallback ? catalogKey(fallback) : '' };
        });
        if (!installed.catalogs.length) setLoading(false);
      } catch (failure) {
        if (mounted && refreshId === refreshGeneration) { setError(failure instanceof Error ? failure.message : 'The add-on could not be loaded.'); setLoading(false); }
      }
    };
    const onPluginsChanged = () => { void refresh(); };
    void refresh();
    window.addEventListener('loomtv:plugins-changed', onPluginsChanged);
    return () => { mounted = false; invalidateRequests(generation); window.removeEventListener('loomtv:plugins-changed', onPluginsChanged); };
  }, [activeProfile?.id, addonId, revision]);

  useEffect(() => {
    if (!source || !catalog) return;
    const current = ++generation.current;
    let mounted = true;
    const isCurrent = () => mounted && generation.current === current;
    setItems([]); setLoading(true); setError(''); setOpeningId(''); setPage(1);
    // Only extras the catalog declares are sent; the adapter validates names and values.
    const supplied: Record<string, string | number | boolean> = {};
    for (const extra of catalog.extra) {
      const value = extra.name === 'skip' ? 0 : extraValue(extra);
      if (value !== '') supplied[extra.name] = value;
      else if (extra.isRequired) {
        setLoading(false);
        setError(extra.name === 'search' ? 'Enter a title to search this catalog.' : `Enter a value for ${extra.name} to browse this catalog.`);
        return;
      }
    }
    // The host follows the catalog's `skip` pages and applies filters the
    // catalog does not support, so every result here is a listed title.
    const filters = {
      query: catalog.extra.some(extra => extra.name === 'search') ? '' : selection.query,
      genre: catalog.extra.some(extra => isGenreExtra(extra.name)) ? '' : selection.genre,
      year: catalog.extra.some(extra => isYearExtra(extra.name)) ? '' : selection.year,
    };
    void cachedDesktopRead('addon-browse', [addonId, selection.catalog, supplied, filters, source.revision, revision], () => desktopApi.getStremioCatalog(addonId, {
      type: catalog.type, catalogId: catalog.id,
      filters, extra: supplied,
    })).then(result => {
      if (!isCurrent()) return;
      setItems([...result.items]);
      setFacets(currentFacets => {
        const previous = currentFacets[selection.catalog];
        return { ...currentFacets, [selection.catalog]: {
          genres: [...new Set([...(previous?.genres || []), ...result.items.flatMap(item => item.genres)])].sort(),
          years: [...new Set([...(previous?.years || []), ...result.items.map(item => (item.releaseInfo || item.released || '').match(/\b(?:18|19|20)\d{2}\b/)?.[0]).filter((year): year is string => Boolean(year))])].sort().reverse(),
        } };
      });
    }).catch(failure => {
      if (!isCurrent()) return;
      // A refresh can cancel the read after its retries; that is not an add-on failure.
      setError(isCancelledError(failure)
        ? 'The catalog request was interrupted. Select Refresh to try again.'
        : failure instanceof Error ? failure.message : 'This catalog could not be loaded.');
    }).finally(() => { if (isCurrent()) setLoading(false); });
    return () => { mounted = false; invalidateRequests(generation); };
    // extraValue reads only `selection`, which is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addonId, catalog, selection, source, revision]);

  const openDetails = useCallback((item: StremioPluginCatalogItem) => {
    const from = `/addons/stremio/${encodeURIComponent(addonId)}`;
    cacheDiscoverReturnRoute(from); cacheExploreItem(item);
    navigate(addonDetailRoute(item), { state: { from, addonId, streamAddonId: source?.resources.includes('stream') ? addonId : undefined, stremioCatalogItem: item } });
  }, [addonId, navigate, source?.resources]);

  // Play resolves sources for this title only now, after loading its metadata.
  const play = useCallback(async (item: StremioPluginCatalogItem) => {
    if (isSeriesLikeType(item.type)) { openDetails(item); return; }
    if (openingId) return;
    const current = generation.current;
    setOpeningId(item.id); setError('');
    try {
      const meta = await loadAddonMeta(item);
      if (current !== generation.current) return;
      const target = addonPlaybackTarget(meta);
      if (!target) throw new Error('This title does not name a video to play.');
      const poster = meta.artwork?.poster || meta.posterUrl || '';
      onPlay('', target.title, { poster, backdrop: meta.artwork?.background || meta.backgroundUrl || poster }, { addonTarget: { ...target, sourceAddonId: source?.resources.includes('stream') ? addonId : undefined } });
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : 'This title could not be opened.');
    } finally { if (current === generation.current) setOpeningId(''); }
  }, [addonId, openDetails, openingId, source?.resources, onPlay]);

  const genreExtra = catalog?.extra.find(extra => isGenreExtra(extra.name));
  const yearExtra = catalog?.extra.find(extra => isYearExtra(extra.name));
  const genres = genreExtra?.options || facets[selection.catalog]?.genres || [];
  const years = yearExtra?.options || facets[selection.catalog]?.years || [];
  const otherExtras = (catalog?.extra || []).filter(extra => !isStandardExtra(extra.name)).slice(0, 8);
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const entries = useMemo(() => items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    .map((item, index) => ({ id: item.id, item, rank: (page - 1) * PAGE_SIZE + index + 1 })), [items, page]);
  const types = [...new Set(source?.catalogs.map(entry => entry.type) || [])];
  const isModern = theme.homeStyle === 'modern';
  const choose = (next: Partial<typeof selection>) => setSelection(current => ({ ...current, ...next }));

  if (source && source.catalogs.length === 0 && source.resources.includes('stream')) {
    return <StremioStreamAddon key={`${source.addonId}:${activeProfile?.id}`} source={source} onPlay={onPlay} />;
  }

  const catalogResults = <>
        {error ? <p role="alert" className="mb-6 rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</p> : null}
        {entries.length ? (
          <DiscoverPosterGrid entries={entries} metaLine={item => item.releaseInfo || item.released?.slice(0, 4) || ''} onSelect={openDetails} onPlay={item => { void play(item); }} playbackStatus={openingId ? item => item.id === openingId ? 'Opening' : 'Play' : undefined} />
        ) : loading ? <PosterGridShimmer className="mt-4" /> : source && !source.catalogs.length ? (
          <p className="mt-10 text-center text-sm text-[var(--loom-muted)]">This add-on has no catalog to browse. Its sources appear when you play a title from another catalog.</p>
        ) : !error ? <p className="mt-10 text-center text-sm text-[var(--loom-muted)]">No titles match this selection.</p> : null}
        {!loading && pageCount > 1 ? <nav aria-label="Add-on catalog pages" className="mt-8 flex items-center justify-center gap-4">
          <button type="button" disabled={page <= 1} aria-label="Previous page" onClick={() => setPage(current => current - 1)} className={discoverFilterChipClass(false)}><ChevronLeft className="h-4 w-4" /></button>
          <span className="text-sm text-[var(--loom-muted)]">Page {page} of {pageCount}</span>
          <button type="button" disabled={page >= pageCount} aria-label="Next page" onClick={() => setPage(current => current + 1)} className={discoverFilterChipClass(false)}><ChevronRight className="h-4 w-4" /></button>
        </nav> : null}
  </>;

  return (
    <div className="loom-page loom-library-page h-full overflow-y-auto" onScroll={event => setScrolled(event.currentTarget.scrollTop > 4)}>
      <div className={`${isModern ? 'loom-modern-content-frame' : 'loom-frame'} loom-library-page-frame page-bottom-safe page-list-bottom-safe ${isModern ? 'pt-6' : 'loom-discover-page-frame'}`}>
        <DiscoverHeader title={source?.name.replace(/^[^\p{L}\p{N}]+/u, '').trim() || 'Add-on'} description={source?.description || 'Browse this source’s titles.'} scrolled={scrolled} query={queryInput} onQueryChange={setQueryInput}
          searchResults={catalogResults}>
          <div className="flex w-full items-center gap-2 overflow-x-auto pb-1">
            {source ? types.map(type => {
              const first = defaultCatalog(source.catalogs.filter(entry => entry.type === type));
              return <button key={type} type="button" aria-pressed={catalog?.type === type} className={discoverFilterChipClass(catalog?.type === type)} onClick={() => first && choose({ catalog: catalogKey(first), genre: '', year: '', extras: {} })}>{TYPE_LABELS[type] || type}</button>;
            }) : null}
            {source && catalog ? <>
              <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-[var(--loom-border)]" />
              <DiscoverDropdown id="addon-catalog" label="Catalog" value={selection.catalog} options={source.catalogs.filter(entry => entry.type === catalog.type).map(entry => ({ value: catalogKey(entry), label: entry.name || entry.id }))} onChange={value => choose({ catalog: value, genre: '', year: '', extras: {} })} />
              <DiscoverDropdown id="addon-genre" label="Genre" value={genreExtra ? extraValue(genreExtra) : selection.genre} options={[...(genreExtra?.isRequired ? [] : [{ value: '', label: 'All genres' }]), ...genres.map(value => ({ value, label: value }))]} searchable onChange={genre => choose({ genre })} />
              <DiscoverDropdown id="addon-year" label="Release year" value={yearExtra ? extraValue(yearExtra) : selection.year} options={[...(yearExtra?.isRequired ? [] : [{ value: '', label: 'All years' }]), ...years.map(value => ({ value, label: value }))]} onChange={year => choose({ year })} />
              {[genreExtra, yearExtra].map(extra => extra?.isRequired && !extra.options?.length ? (
                <ExtraTextInput key={extra.name} name={extra.name} required value={isGenreExtra(extra.name) ? selection.genre : selection.year}
                  onCommit={value => choose(isGenreExtra(extra.name) ? { genre: value } : { year: value })} />
              ) : null)}
              {otherExtras.map(extra => extra.options?.length ? (
                <DiscoverDropdown key={extra.name} id={`addon-extra-${extra.name}`} label={extra.name} value={extraValue(extra)}
                  options={[...(extra.isRequired ? [] : [{ value: '', label: `Any ${extra.name}` }]), ...extra.options.map(value => ({ value, label: value }))]}
                  onChange={value => setSelection(current => ({ ...current, extras: { ...current.extras, [extra.name]: value } }))} />
              ) : (
                <ExtraTextInput key={extra.name} name={extra.name} required={extra.isRequired} value={selection.extras[extra.name] || ''}
                  onCommit={value => setSelection(current => ({ ...current, extras: { ...current.extras, [extra.name]: value } }))} />
              ))}
            </> : null}
            <button type="button" className={discoverFilterChipClass(false)} onClick={() => setRevision(current => current + 1)}>Refresh</button>
          </div>
        </DiscoverHeader>
        <AddonKeepWatching addonId={addonId} onPlay={onPlay} />
        {catalogResults}
      </div>
    </div>
  );
}
