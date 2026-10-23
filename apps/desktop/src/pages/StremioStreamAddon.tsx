import AddonTitleSearch, { savedAddonSearch } from '@/components/AddonTitleSearch';
import { ChevronRight, Search } from 'lucide-react';
import { motion } from 'motion/react';
import AddonKeepWatching from '@/components/AddonKeepWatching';
import { useEffect, useState } from 'react';
import { useTheme } from '@/components/ThemeProvider';
import { useProfiles } from '@/contexts/ProfileContext';
import { DiscoverPosterGrid } from '@/components/DiscoverCatalogLayout';
import { PosterGridShimmer, PosterRailShimmer } from '@/components/ContentShimmer';
import MediaRail from '@/components/MediaRail';
import StremioPosterCard from '@/components/StremioPosterCard';
import { useLocation, useNavigate } from '@/lib/navigation';
import { queryScope } from '@/lib/queryClient';
import { addonDetailRoute, type AddonStreamPlayer } from '@/lib/addonPlayback';
import { cacheDiscoverReturnRoute, cacheExploreItem } from '@/lib/discoverNavigation';
import type { StremioPluginCatalogItem, StremioPluginSummary } from '@/lib/desktopApi';
import { cachedCinemetaCatalog, cinemetaCatalog } from './PluginDiscover/cinemeta';
import type { DiscoverSection } from './PluginDiscover/discoverState';

type BrowseType = 'movie' | 'tv' | 'anime';
type Section = { id: string; type: BrowseType; order: DiscoverSection; title: string };
const labels: Record<BrowseType, string> = { movie: 'Movies', tv: 'Series', anime: 'Anime' };

function CatalogSection({ section, search, expanded, onExpand, onSelect }: {
  section: Section; search: string; expanded: boolean; onExpand: () => void;
  onSelect: (item: StremioPluginCatalogItem) => void;
}) {
  const [items, setItems] = useState<StremioPluginCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    const cached = section.type === 'anime' ? undefined : cachedCinemetaCatalog(section.type, section.order, search, '', '');
    setItems(cached || []); setLoading(!cached); setError(false);
    const fetchItems = () => section.type === 'anime'
      ? import('./PluginDiscover').then(module => module.discoverAnime(search, section.order))
      : cinemetaCatalog(section.type, section.order, search, '', '');
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelDelay: (() => void) | undefined;
    const request = (async () => {
      for (let attempt = 0; ; attempt += 1) {
        try { return await fetchItems(); }
        catch (failure) {
          // IPC/provider errors do not all retain the same error type or wording.
          // Retry the read itself, just as the manual retry button does.
          const message = failure instanceof Error ? failure.message : String(failure);
          const permanent = /offline mode|not allowed|api key|unauthori[sz]ed|forbidden|status (?:400|401|403|404)\b/i.test(message);
          if (!current || permanent || attempt >= 2) throw failure;
          await new Promise<void>(resolve => {
            cancelDelay = resolve;
            retryTimer = setTimeout(resolve, 800 * (attempt + 1));
          });
          if (!current) throw failure;
        }
      }
    })();
    void request.then(result => { if (current) setItems([...result]); })
      .catch(() => { if (current) setError(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; clearTimeout(retryTimer); cancelDelay?.(); };
  }, [section.type, section.order, search, retry]);
  const title = search ? labels[section.type] : section.title;
  if (loading || (error && !items.length) || !items.length || expanded) return <section className="my-8" aria-label={title}>
    <h2 className="mb-4 text-xl font-semibold">{title}</h2>
    {loading ? expanded ? <PosterGridShimmer count={6} /> : <PosterRailShimmer /> : error && !items.length ? <div role="alert" className="flex min-h-32 flex-col items-center justify-center gap-3 text-center text-sm text-[var(--loom-muted)]">
      <p>These titles could not be loaded.</p><button type="button" onClick={() => setRetry(value => value + 1)} className="rounded-full border border-[var(--loom-border)] px-4 py-2">Try again</button>
    </div> : items.length ? <DiscoverPosterGrid entries={items.map(item => ({ id: item.id, item }))} metaLine={item => item.releaseInfo || ''} onSelect={onSelect} onPlay={onSelect} /> : <p className="py-8 text-center text-sm text-[var(--loom-muted)]">No titles found.</p>}
  </section>;
  return <MediaRail title={title} variant="modern" className="my-8" action={<button type="button" onClick={onExpand} className="text-sm text-[var(--loom-muted)]">See all</button>}>
    {items.slice(0, 15).map(item => <div key={item.id} className="w-40 shrink-0 sm:w-44"><StremioPosterCard item={item} metaLine={item.releaseInfo || ''} showContentRating={false} onSelect={onSelect} onPlay={onSelect} /></div>)}
  </MediaRail>;
}

export default function StremioStreamAddon({ source, onPlay }: { source: StremioPluginSummary; onPlay: AddonStreamPlayer }) {
  const { theme } = useTheme();
  const { activeProfile, generation } = useProfiles();
  const navigate = useNavigate();
  const location = useLocation();
  const searchRestoreKey = `${JSON.stringify(queryScope())}:${generation}:${source.addonId}:${source.revision}:${location.key}`;
  const savedSearch = savedAddonSearch(searchRestoreKey);
  const [type, setType] = useState<BrowseType | 'all'>(() => savedSearch && !savedSearch.types.includes(',') ? savedSearch.types as BrowseType : 'all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(Boolean(savedSearch));
  const search = '';

  const types: BrowseType[] = [
    ...(source.types.includes('movie') ? ['movie' as const] : []),
    ...(source.types.includes('series') ? ['tv' as const] : []),
    ...(source.types.some(value => ['anime', 'series', 'movie'].includes(value)) ? ['anime' as const] : []),
  ];
  const sections: Section[] = (search ? ['popular' as const] : ['popular' as const, 'new' as const]).flatMap(order => types.filter(value => type === 'all' || value === type).map(value => ({
    id: `${order}-${value}`, type: value, order, title: `${order === 'popular' ? 'Popular' : 'New releases'} · ${labels[value]}`,
  })));
  const open = (item: StremioPluginCatalogItem) => {
    const from = `/addons/stremio/${encodeURIComponent(source.addonId)}`;
    cacheDiscoverReturnRoute(from); cacheExploreItem(item);
    navigate(addonDetailRoute(item), { state: { from, addonId: source.addonId, streamAddonId: source.addonId, stremioCatalogItem: item } });
  };
  const modern = theme.homeStyle === 'modern';
  return <div className="loom-page loom-library-page h-full overflow-y-auto">
    {expanded ? (
      <button
        type="button"
        onClick={() => setExpanded(null)}
        aria-label="Back"
        style={modern ? { left: 'var(--loom-detail-frame-start)', top: 'calc(1.5rem + 0.25rem)', borderRadius: '9999px' } : undefined}
        className="loom-detail-back loom-no-drag pointer-events-auto fixed top-6 z-[80] flex h-10 items-center gap-2 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] px-3 text-sm text-[var(--loom-text)] shadow-lg backdrop-blur-md transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
      >
        <ChevronRight aria-hidden="true" className="h-5 w-5 rotate-180" />
        <span>Back</span>
      </button>
    ) : null}
    <div className={`${modern ? 'loom-modern-content-frame' : 'loom-frame'} loom-library-page-frame page-bottom-safe page-list-bottom-safe pt-24`}>
      <header className="loom-modern-header loom-no-drag pointer-events-none fixed inset-x-0 top-6 z-50 flex h-12 items-center justify-center px-5">
        <div className="pointer-events-auto flex max-w-full flex-col items-center gap-3">
          <div className="flex max-w-full items-center gap-3">
          <nav aria-label="Add-on categories" className="loom-modern-category-pill loom-no-drag flex h-12 max-w-full items-center rounded-full border p-1 backdrop-blur-xl">
            {(['all', ...types] as const).map(value => <button key={value} type="button" aria-pressed={type === value}
              className={`relative inline-flex h-full items-center justify-center rounded-full px-3 text-xs font-semibold transition-colors sm:px-5 ${type === value ? 'loom-modern-category-active' : 'loom-modern-category-idle'}`}
              onClick={() => { setType(value); setExpanded(null); }}>
              {type === value ? <motion.span layoutId="addon-category-selection" className="loom-modern-category-selection absolute inset-0 rounded-full" transition={{ type: 'spring', stiffness: 520, damping: 42, mass: 0.7 }} aria-hidden="true" /> : null}
              <span className="relative z-10">{value === 'all' ? 'All' : labels[value]}</span>
            </button>)}
          </nav>
            <button type="button" aria-label="Search titles" aria-expanded={searchOpen} onClick={() => setSearchOpen(true)} className="loom-modern-category-pill loom-modern-category-idle loom-no-drag grid h-12 w-12 shrink-0 place-items-center rounded-full border backdrop-blur-xl">
              <Search aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>
      <AddonTitleSearch restoreKey={searchRestoreKey} key={`${activeProfile?.id}:${generation}`} open={searchOpen} onOpenChange={setSearchOpen} types={types} initialFilter={type} onSelect={open} />
      {type === 'all' && !expanded && <AddonKeepWatching addonId={source.addonId} onPlay={onPlay} />}
      {sections.filter(section => !expanded || section.id === expanded).map(section => <CatalogSection key={`${activeProfile?.id}:${generation}:${source.revision}:${section.id}`} section={section} search={search} expanded={expanded === section.id} onExpand={() => setExpanded(section.id)} onSelect={open} />)}
    </div>
  </div>;
}
