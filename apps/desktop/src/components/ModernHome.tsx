import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Bookmark, Clapperboard, CircleHelp, FolderPlus, Play, Search, Star, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { libraryMutationMessage, type MediaItem, useLibrary } from '@/contexts/LibraryContext';
import { useProfiles } from '@/contexts/ProfileContext';
import SafeArtwork from '@/components/SafeArtwork';
import MediaPosterCard from '@/components/MediaPosterCard';
import ProviderMark from '@/components/ProviderMark';
import MediaRail from '@/components/MediaRail';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { backdropSources, logoSources, posterSources, routeArtworkState } from '@/lib/artwork';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import { resetProgress, useProgressSnapshot } from '@/lib/progress';
import { useTheme } from '@/components/ThemeProvider';
import { mediaLink, mediaMetaLine } from '@/components/MediaPosterCard.helpers';
import { desktopApi, type StoredProgress } from '@/lib/desktopApi';
import LibraryFilterBar from '@/components/LibraryFilterBar';
import { createLibraryListState, matchesLibraryFilter, type LibraryFilter } from '@/lib/libraryFilters';
import { useModalLayer } from '@/components/ui/dialog';
import ContentRatingBadge, { preferredContentRating } from '@/components/ContentRatingBadge';
import { mediaFormatLabel } from '@/shared/mediaFormat';
import WatchedToggle from '@/components/WatchedToggle';
import MediaTechnicalBadges from '@/components/MediaTechnicalBadges';
import { isLocalItemWatched, localProgressPathsForItem, localWatchedKeysForItem } from '@/lib/watched';

export default function ModernHome() {
  const { state, addLibraryFolder } = useLibrary();
  const { lists, setListEntry, watchedKeys, setWatchedEntries } = useProfiles();
  const { theme } = useTheme();
  const progress = useProgressSnapshot();
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('all');
  const [activeHeroIndex, setActiveHeroIndex] = useState(0);
  const [heroHovered, setHeroHovered] = useState(false);
  const [libraryActionError, setLibraryActionError] = useState('');
  const prefersReducedMotion = useReducedMotion();
  const searchControlRef = useRef<HTMLDivElement | null>(null);
  const searchOverlayRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const resultsGridRef = useRef<HTMLDivElement | null>(null);
  const { movies, tvShows, animeShows, isLoading, isScanning } = state;
  const allItems = useMemo(() => [...animeShows, ...tvShows, ...movies], [animeShows, movies, tvShows]);
  const listState = useMemo(() => createLibraryListState(lists), [lists]);
  const visibleItems = useMemo(
    () => allItems.filter((item) => matchesLibraryFilter(item, activeFilter, progress, listState)),
    [activeFilter, allItems, listState, progress],
  );
  const visibleAnimeShows = useMemo(
    () => animeShows.filter((item) => matchesLibraryFilter(item, activeFilter, progress, listState)),
    [activeFilter, animeShows, listState, progress],
  );
  const visibleTVShows = useMemo(
    () => tvShows.filter((item) => matchesLibraryFilter(item, activeFilter, progress, listState)),
    [activeFilter, listState, progress, tvShows],
  );
  const visibleMovies = useMemo(
    () => movies.filter((item) => matchesLibraryFilter(item, activeFilter, progress, listState)),
    [activeFilter, listState, movies, progress],
  );
  const normalizedQuery = searchQuery(query);
  const currentRoute = `${location.pathname}${location.search}`;
  const results = useMemo(
    () => normalizedQuery ? visibleItems.filter((item) => matchesMediaItem(item, normalizedQuery)) : [],
    [normalizedQuery, visibleItems],
  );
  const continueWatching = useMemo(() => {
    const recency = (item: MediaItem) => Math.max(
      progress[item.filePath]?.updatedAt || 0,
      ...(item.episodeFiles || []).map((episode) => progress[episode.filePath]?.updatedAt || 0),
    );
    const hasPlaybackProgress = (item: MediaItem): boolean => (
      (progress[item.filePath]?.position || 0) > 10
      || (item.episodeFiles || []).some((episode) => (progress[episode.filePath]?.position || 0) > 10)
    );
    return visibleItems
      .map((item) => [item, recency(item)] as const)
      .filter(([item, updatedAt]) => updatedAt > 0 && hasPlaybackProgress(item) && !matchesLibraryFilter(item, 'watched', progress))
      .sort((left, right) => right[1] - left[1])
      .map(([item]) => item);
  }, [progress, visibleItems]);
  const savedItems = useMemo(() => {
    const byId = new Map(allItems.map((item) => [item.id, item]));
    const seen = new Set<string>();
    return lists
      .filter((entry) => entry.kind === 'watchlist' || entry.kind === 'favorite')
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((entry) => {
        if (seen.has(entry.mediaId)) return false;
        seen.add(entry.mediaId);
        return true;
      })
      .map((entry) => byId.get(entry.mediaId))
      .filter((item): item is MediaItem => Boolean(item));
  }, [allItems, lists]);
  const visibleSavedItems = useMemo(
    () => savedItems.filter((item) => matchesLibraryFilter(item, activeFilter, progress, listState)),
    [activeFilter, listState, progress, savedItems],
  );
  const featuredHeroItems = useMemo(() => {
    const preferredLibrary = visibleAnimeShows.length > 0 ? visibleAnimeShows : visibleTVShows.length > 0 ? visibleTVShows : visibleMovies;
    return preferredLibrary.slice(0, 6);
  }, [visibleAnimeShows, visibleMovies, visibleTVShows]);
  const usesContinueWatchingHero = theme.modernHeroMode === 'continue-watching' && continueWatching.length > 0;
  const heroItems = usesContinueWatchingHero ? continueWatching.slice(0, 1) : featuredHeroItems;
  const hero = heroItems[activeHeroIndex] || heroItems[0];
  const heroWatchedByProgress = hero ? matchesLibraryFilter(hero, 'watched', progress) : false;
  const heroWatched = heroWatchedByProgress || (hero ? isLocalItemWatched(hero, watchedKeys) : false);
  const myListIds = listState.myListIds;
  const toggleHeroWatched = () => {
    if (!hero) return;
    const present = !heroWatched;
    if (!present && heroWatchedByProgress) void resetProgress(localProgressPathsForItem(hero));
    void setWatchedEntries(localWatchedKeysForItem(hero), present);
  };
  const handleAddFolder = async () => {
    setLibraryActionError('');
    try {
      await addLibraryFolder('anime');
    } catch (error) {
      setLibraryActionError(libraryMutationMessage(error));
    }
  };

  useEffect(() => {
    if (activeHeroIndex < heroItems.length) return;
    setActiveHeroIndex(0);
  }, [activeHeroIndex, heroItems.length]);

  // Rotation stops for a reduced-motion preference, and while the pointer or
  // keyboard focus is inside the hero, so the slide never changes out from
  // under someone who is reading or interacting with it.
  const heroAutoRotates = heroItems.length > 1
    && !prefersReducedMotion
    && !heroHovered
    && !searchOpen;

  useEffect(() => {
    if (!heroAutoRotates) return undefined;
    const rotationTimer = window.setInterval(() => {
      setActiveHeroIndex((current) => (current + 1) % heroItems.length);
    }, 8000);
    return () => window.clearInterval(rotationTimer);
  }, [heroAutoRotates, heroItems.length]);

  useEffect(() => {
    const routeState = location.state as { openLibrarySearch?: boolean } | null;
    if (!routeState?.openLibrarySearch) return;

    setSearchOpen(true);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    if (!searchOpen) return undefined;

    const dismissSearch = (event: PointerEvent) => {
      if (!searchControlRef.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    document.addEventListener('pointerdown', dismissSearch);
    return () => {
      document.removeEventListener('pointerdown', dismissSearch);
    };
  }, [searchOpen]);

  useModalLayer({
    open: searchOpen,
    contentRef: searchOverlayRef,
    onEscape: () => setSearchOpen(false),
    initialFocusRef: searchInputRef,
  });

  return (
    <div className="loom-modern-home relative h-full overflow-x-hidden overflow-y-auto bg-[var(--loom-bg)] text-[var(--loom-text)]">
      {!searchOpen && (
        <div className="loom-library-search-slot loom-no-drag pointer-events-auto fixed right-5 top-6 z-[55]">
          <LibraryFilterBar activeFilter={activeFilter} onChange={setActiveFilter} />
        </div>
      )}
      <AnimatePresence>
        {searchOpen && (
          <motion.div
            key="library-search-overlay"
            ref={searchOverlayRef}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-search-title"
            aria-describedby="library-search-description"
            tabIndex={-1}
            data-modal-layer="library-search"
            className="loom-no-drag loom-modern-search-overlay fixed inset-0 z-[60] overflow-y-auto px-6 pb-12 pt-[12vh] backdrop-blur-xl"
          >
            <div ref={searchControlRef} className="mx-auto w-full max-w-5xl">
              <h2 id="library-search-title" className="sr-only">Search your library</h2>
              <p id="library-search-description" className="sr-only">Search titles in the local library and move through matching results.</p>
              <div className="loom-modern-search-control flex h-16 items-center rounded-2xl border px-5 shadow-2xl">
                <Search className="h-6 w-6 shrink-0 text-[var(--loom-muted)]" />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    // Down from the field drops into the results, so the whole
                    // search flow works without reaching for the mouse.
                    if (event.key !== 'ArrowDown') return;
                    const firstResult = resultsGridRef.current?.querySelector<HTMLAnchorElement>('a[href]');
                    if (!firstResult) return;
                    event.preventDefault();
                    firstResult.focus();
                  }}
                  placeholder="Search your library"
                  autoComplete="off"
                  autoFocus
                  aria-label="Search your library"
                  className="loom-modern-search-input h-16 min-w-0 flex-1 bg-transparent px-4 text-lg text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)]"
                />
                <div className="loom-library-search-slot loom-no-drag pointer-events-auto shrink-0">
                  <LibraryFilterBar activeFilter={activeFilter} onChange={setActiveFilter} />
                </div>
                <button type="button" onClick={() => { setQuery(''); setSearchOpen(false); }} aria-label="Close search" className="grid h-10 w-10 place-items-center rounded-full text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]">
                  <X className="h-5 w-5" />
                </button>
              </div>
              {normalizedQuery ? (
                <SearchResults items={results} query={query} from={currentRoute} isLoading={isLoading} overlay gridRef={resultsGridRef} onExitTop={() => searchInputRef.current?.focus()} />
              ) : (
                <p className="pt-8 text-center text-sm text-[var(--loom-muted)]">Search anime, TV shows, and movies</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!searchOpen && normalizedQuery ? (
        <SearchResults items={results} query={query} from={currentRoute} isLoading={isLoading} />
      ) : !searchOpen && hero ? (
        <>
          <Hero
            item={hero}
            from={currentRoute}
            inWatchlist={myListIds.has(hero.id)}
            onToggleWatchlist={() => void setListEntry(hero.id, 'watchlist', !myListIds.has(hero.id))}
            watched={heroWatched}
            onToggleWatched={toggleHeroWatched}
            activeIndex={activeHeroIndex}
            itemCount={heroItems.length}
            mode={usesContinueWatchingHero ? 'continue-watching' : 'featured'}
            onSelect={setActiveHeroIndex}
            onHoverChange={setHeroHovered}
          />
          <main className="loom-modern-content-frame page-bottom-safe relative z-10 mt-7 space-y-10 px-[var(--loom-frame-inset)] pb-10">
            {continueWatching.length > 0 && (
              <ContinueWatchingRail items={continueWatching} from={currentRoute} progress={progress} />
            )}
            {visibleSavedItems.length > 0 && (
              <PosterRail title="My List" items={visibleSavedItems} from={currentRoute} />
            )}
            {visibleAnimeShows.length > 0 && <PosterRail title="Anime" items={visibleAnimeShows} from={currentRoute} />}
            {visibleTVShows.length > 0 && <PosterRail title="TV Shows" items={visibleTVShows} from={currentRoute} />}
            {visibleMovies.length > 0 && <PosterRail title="Movies" items={visibleMovies} from={currentRoute} />}
          </main>
        </>
      ) : !searchOpen && isLoading ? (
        <ModernHomeSkeleton />
      ) : !searchOpen && activeFilter !== 'all' && visibleItems.length === 0 ? (
        <div className="px-[var(--loom-frame-inset)] pt-24">
          <div className="flex min-h-[22rem] items-center justify-center">
            <div className="max-w-lg text-center">
              <h1 className="text-3xl font-bold">No titles match this filter</h1>
              <p className="mt-3 text-sm text-[var(--loom-muted)]">Try another filter to see more of your library.</p>
              <Button onClick={() => setActiveFilter('all')} className="mt-7 rounded-full px-6">Clear filter</Button>
            </div>
          </div>
        </div>
      ) : !searchOpen ? (
        <div className="px-[var(--loom-frame-inset)] pt-24">
          <div className="flex min-h-[22rem] items-center justify-center">
            <div className="max-w-lg text-center">
              <div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl border border-[var(--loom-border)] bg-[var(--loom-surface)]"><FolderPlus className="h-9 w-9 text-[var(--loom-accent)]" /></div>
              <h1 className="mt-6 text-3xl font-bold">Build your cinematic library</h1>
              <p className="mt-3 text-sm leading-6 text-[var(--loom-muted)]">Add anime, TV shows, or movies and LoomTV will turn your collection into a Modern home.</p>
              {libraryActionError ? <p role="alert" className="mt-4 text-sm text-red-200">{libraryActionError}</p> : null}
              <Button disabled={isScanning} onClick={() => void handleAddFolder()} className="mt-7 gap-2 rounded-full px-6"><FolderPlus className="h-4 w-4" /> Add a folder</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shown while the first scan is still populating the library. Without it the
 * Modern home falls through to the "no library yet" empty state and briefly
 * tells the user their library is empty when it is merely still loading.
 */
function ModernHomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your library">
      <Skeleton className="h-[clamp(38rem,76vh,54rem)] w-full rounded-none" />
      <div className="loom-modern-content-frame page-bottom-safe relative z-10 mt-7 space-y-10 px-[var(--loom-frame-inset)] pb-10">
        {['Continue Watching', 'Anime', 'TV Shows'].map((title) => (
          <section key={title}>
            <h2 className="mb-4 text-xl font-semibold text-[var(--loom-text)]">{title}</h2>
            <div className="flex gap-4 overflow-hidden pb-2">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="h-[340px] w-[200px] flex-none rounded-lg" />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

type HeroProps = {
  item: MediaItem;
  from: string;
  inWatchlist: boolean;
  onToggleWatchlist: () => void;
  watched: boolean;
  onToggleWatched: () => void;
  activeIndex: number;
  itemCount: number;
  mode: 'continue-watching' | 'featured';
  onSelect: (index: number) => void;
  onHoverChange: (hovered: boolean) => void;
};

function Hero({ item, from, inWatchlist, onToggleWatchlist, watched, onToggleWatched, activeIndex, itemCount, mode, onSelect, onHoverChange }: HeroProps) {
  const prefersReducedMotion = useReducedMotion();
  const metadataGenres = item.genres.slice(0, 2);
  const contentRating = preferredContentRating(item.contentRatings, item.contentRating);
  const mediaFormat = mediaFormatLabel(item.format, item.type);
  const [headline, kicker] = splitHeroTitle(item.title);
  const mediaDetails = heroMediaDetails(item);
  const durationLabel = item.type === 'movie' ? heroDurationLabel(mediaDetails?.durationSeconds) : '';
  const linkState = { from, artwork: routeArtworkState(item, posterSources(item)) };
  const heroSummary = item.summary || 'Dive in to this title and add it to your library for full details and playback.';
  const heroLogoSources = useMemo(() => logoSources(item), [item]);
  const heroArtworkSources = useMemo(() => backdropSources(item), [item]);
  const heroFilePathCandidate = item.filePath || item.episodeFiles?.find((episode) => Boolean(episode.filePath))?.filePath || '';
  // Compact/paired-library cards can carry opaque or signed playback keys.
  // Only pass an actual local filesystem path to the desktop thumbnail IPC.
  const heroFilePath = /^(?:\/|[A-Za-z]:[\\/])/.test(heroFilePathCandidate) ? heroFilePathCandidate : '';
  const [generatedHeroArtwork, setGeneratedHeroArtwork] = useState('');
  const heroThumbnailRequestRef = useRef('');
  const generatedHeroArtworkRef = useRef('');
  const heroThumbnailGenerationRef = useRef(0);
  const requestHeroThumbnail = useCallback(() => {
    if (!heroFilePath || generatedHeroArtworkRef.current || heroThumbnailRequestRef.current === heroFilePath) return;
    heroThumbnailRequestRef.current = heroFilePath;
    const generation = heroThumbnailGenerationRef.current;
    void desktopApi.getThumbnail(heroFilePath, '00:03:00')
      .then(({ url }) => {
        if (generation !== heroThumbnailGenerationRef.current) return;
        generatedHeroArtworkRef.current = url;
        setGeneratedHeroArtwork(url);
      })
      .catch(() => {
        // Metadata artwork remains the normal path; a thumbnail is only a
        // bounded local-file fallback for records without working artwork.
      });
  }, [heroFilePath]);
  useEffect(() => {
    heroThumbnailGenerationRef.current += 1;
    generatedHeroArtworkRef.current = '';
    setGeneratedHeroArtwork('');
    heroThumbnailRequestRef.current = '';
    if (heroArtworkSources.length === 0) requestHeroThumbnail();
  }, [heroArtworkSources.length, heroFilePath, requestHeroThumbnail]);
  const resolvedHeroArtwork = useMemo(
    () => backdropSources(item, undefined, generatedHeroArtwork ? [generatedHeroArtwork] : []),
    [generatedHeroArtwork, item],
  );
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [item.id]);
  const showsHeroLogo = heroLogoSources.length > 0 && !logoFailed;
  const artworkTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.8, ease: [0.22, 1, 0.36, 1] as const };
  const copyTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.42, ease: [0.22, 1, 0.36, 1] as const };
  return (
    <section
      className="loom-modern-hero relative h-[clamp(38rem,76vh,43.2rem)] overflow-hidden bg-[var(--loom-bg)] text-white"
      aria-label={mode === 'continue-watching' ? 'Continue watching' : 'Featured titles'}
      aria-roledescription={mode === 'featured' ? 'carousel' : undefined}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      // Keyboard users get the same reprieve as the pointer: focusing anything
      // inside the hero holds the current slide until focus moves back out.
      onFocusCapture={() => onHoverChange(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHoverChange(false);
      }}
    >
      <div className="loom-modern-hero-artwork absolute inset-y-0 inset-x-0 mx-auto">
        <AnimatePresence initial={false} mode="sync">
          <motion.div
            key={`hero-artwork-${item.id}`}
            className="absolute inset-0"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 1.025 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={artworkTransition}
          >
            <SafeArtwork
              src={resolvedHeroArtwork}
              alt=""
              className="h-full w-full"
              imgClassName="object-cover object-center"
              onError={requestHeroThumbnail}
              priority
            />
          </motion.div>
        </AnimatePresence>
        <div className="loom-modern-hero-vignette absolute inset-0" />
      </div>
      <div className="loom-modern-content-frame loom-modern-hero-frame relative z-10 flex h-full items-end">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={`hero-copy-${item.id}`}
            className="loom-modern-hero-copy flex w-full max-w-[60rem] flex-col px-[var(--loom-frame-inset)] pt-10"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: -22 }}
            animate={{ opacity: 1, x: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 14 }}
            transition={copyTransition}
          >
            {showsHeroLogo ? (
              <img
                src={heroLogoSources[0]}
                alt={item.title}
                decoding="async"
                fetchPriority="high"
                className="max-h-[clamp(4.2rem,12vh,7.7rem)] w-[min(21rem,34vw)] object-contain object-left-bottom drop-shadow-[0_3px_18px_rgba(0,0,0,0.75)]"
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <>
                <h1
                  className="max-w-2xl text-[clamp(2.25rem,4.2vw,3.75rem)] leading-[0.9] tracking-[-0.045em] drop-shadow-2xl"
                  style={{
                    transform: 'skew(-7deg)',
                    transformOrigin: 'left top',
                    textShadow: '0 4px 0 rgba(0,0,0,0.42), 3px 4px 0 rgba(0,0,0,0.35)',
                    color: 'var(--loom-accent)',
                    WebkitTextStroke: '2px rgb(0 23 46 / 0.95)',
                    paintOrder: 'stroke fill',
                  }}
                >
                  {headline}
                </h1>
                {kicker && (
                  <div className="mt-2 text-lg font-semibold italic tracking-[-0.028em] text-[#ffc627]/95 drop-shadow-[0_2px_3px_rgba(0,0,0,0.7)] sm:text-2xl">
                    {kicker}
                  </div>
                )}
              </>
            )}
            <div className="loom-modern-hero-text mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-[clamp(1rem,1.35vw,1.45rem)] font-semibold text-[var(--loom-on-media)]">
              <span className="inline-flex items-center gap-2">
                <ProviderMark
                  mediaId={item.id}
                  providers={item.streamingProviders}
                  originPlatform={item.originPlatform}
                />
                <span>{[heroMediaTypeLabel(item), ...metadataGenres].join(' · ')}</span>
              </span>
              <ContentRatingBadge
                rating={mediaFormat}
                className="border-[var(--loom-accent)]/75 bg-white/10 text-[var(--loom-accent)]"
              />
              {contentRating && <ContentRatingBadge rating={contentRating} className="border-white/75 bg-white/10 text-white" />}
            </div>

            <div className="mt-3 w-full max-w-[50%]">
              <p className="loom-modern-hero-text min-h-[2.9em] line-clamp-2 text-[clamp(1rem,1.35vw,1.55rem)] leading-[1.45] text-[var(--loom-on-media)]">
                {heroSummary}
              </p>
            </div>

            <div className="loom-modern-hero-text mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[clamp(0.95rem,1.2vw,1.2rem)] font-semibold text-[var(--loom-on-media-muted)]">
              {(item.rating > 0 || item.year > 0) && (
                <span className="inline-flex items-center gap-1.5">
                  {item.rating > 0 && (
                    <span className="loom-rating inline-flex items-center gap-1.5">
                      <Star className="h-4 w-4" fill="currentColor" />
                      {item.rating.toFixed(1)}
                    </span>
                  )}
                  {item.rating > 0 && item.year > 0 && <span aria-hidden="true">•</span>}
                  {item.year > 0 && <span>{item.year}</span>}
                </span>
              )}
              {durationLabel && <span>{durationLabel}</span>}
              <MediaTechnicalBadges item={item} />
            </div>

            <div className="mt-5 flex items-center gap-3">
              <Link
                to={mediaLink(item)}
                state={linkState}
                className="inline-flex h-14 items-center gap-2.5 rounded-full bg-white px-8 text-base font-bold text-black"
              >
                <Clapperboard className="h-5 w-5 fill-black" />
                <span>Play</span>
              </Link>

              <div className="inline-flex h-14 overflow-hidden rounded-full bg-white/10 backdrop-blur-[12px]">
                <button
                  type="button"
                  onClick={onToggleWatchlist}
                  aria-label={inWatchlist ? `Remove ${item.title} from My List` : `Add ${item.title} to My List`}
                  className="grid h-14 w-14 place-items-center rounded-full text-white transition-colors hover:bg-[var(--loom-active-bg)]"
                >
                  <Bookmark className="h-5 w-5" fill={inWatchlist ? 'currentColor' : 'none'} />
                </button>
                <span className="my-auto inline-block h-7 w-px bg-white/20" />
                <WatchedToggle
                  watched={watched}
                  onToggle={onToggleWatched}
                  surface="plain"
                  className="loom-modern-hero-watched-toggle h-14 w-14 rounded-full bg-transparent text-white/80"
                  label={watched ? 'Mark as unwatched' : 'Mark as watched'}
                />
                <span className="my-auto inline-block h-7 w-px bg-white/20" />
                <Link
                  to={mediaLink(item)}
                  state={linkState}
                  className="grid h-14 w-14 place-items-center rounded-full text-white transition-colors hover:bg-[var(--loom-active-bg)]"
                  aria-label={`Open details for ${item.title}`}
                >
                  <CircleHelp className="h-5 w-5" />
                </Link>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
        {itemCount > 1 && (
          <div className="loom-modern-hero-pager absolute right-[var(--loom-frame-inset)] z-20 flex h-14 items-center gap-2 drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)]">
            {Array.from({ length: itemCount }).map((_, index) => (
              <button
                key={`hero-dot-${index}`}
                type="button"
                aria-label={`Show featured title ${index + 1} of ${itemCount}`}
                aria-current={activeIndex === index ? 'true' : undefined}
                onClick={() => onSelect(index)}
                className={`h-1.5 rounded-full transition-[width,background-color] duration-300 ${activeIndex === index ? 'w-8 bg-[var(--loom-on-media)]' : 'w-1.5 bg-[var(--loom-media-hairline-strong)] hover:bg-[var(--loom-on-media)]'}`}
              />
            ))}
          </div>
        )}
      </div>
      {/* Announce slide changes without moving focus. */}
      <p className="sr-only" aria-live="polite">
        {mode === 'continue-watching'
          ? `Continue watching: ${item.title}`
          : `Featured title ${activeIndex + 1} of ${itemCount}: ${item.title}`}
      </p>
    </section>
  );
}

function splitHeroTitle(title: string): [string, string] {
  const withLineBreak = title.split(':').map((part) => part.trim()).filter(Boolean);
  if (withLineBreak.length <= 1) return [title, ''];
  return [withLineBreak[0], withLineBreak.slice(1).join(':')];
}

function heroMediaTypeLabel(item: MediaItem): string {
  if (item.type === 'anime') return 'Anime';
  if (item.type === 'tv') return 'TV Show';
  return 'Movie';
}

function heroMediaDetails(item: MediaItem): MediaItem['localMetadata'] {
  if (item.type === 'movie') return item.localMetadata;
  const episodeDetails = item.episodeFiles?.find((episode) => Boolean(episode.localMetadata))?.localMetadata;
  if (!episodeDetails) return item.localMetadata;
  return { ...episodeDetails, ...item.localMetadata };
}

function heroDurationLabel(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function PosterRail({ title, items, from }: { title: string; items: MediaItem[]; from: string }) {
  const titleHref = title === 'Anime' ? '/anime' : title === 'TV Shows' ? '/tv' : title === 'Movies' ? '/movies' : undefined;
  return (
    <MediaRail title={title} titleHref={titleHref} variant="modern">
      {items.slice(0, 24).map((item) => (
        <MediaPosterCard
          key={item.id}
          item={item}
          from={from}
          variant="home"
          metaLine={mediaMetaLine(item)}
        />
      ))}
    </MediaRail>
  );
}

function ContinueWatchingRail({
  items,
  from,
  progress,
}: {
  items: MediaItem[];
  from: string;
  progress: Record<string, StoredProgress>;
}) {
  return (
    <MediaRail title="Continue Watching" variant="modern">
      {items.slice(0, 8).map((item) => (
        <ContinueWatchingCard key={item.id} item={item} from={from} progress={progress} />
      ))}
    </MediaRail>
  );
}

function ContinueWatchingCard({
  item,
  from,
  progress,
}: {
  item: MediaItem;
  from: string;
  progress: Record<string, StoredProgress>;
}) {
  const progressPercent = latestProgressPercent(item, progress);

  return (
    <Link
      to={mediaLink(item)}
      state={{ from, artwork: routeArtworkState(item, posterSources(item)) }}
      className="loom-continue-watching-card group block w-[280px] flex-none"
    >
      <div className="relative aspect-video overflow-hidden rounded-2xl bg-[var(--loom-media-veil)] shadow-lg">
        <SafeArtwork
          src={backdropSources(item)}
          alt={item.title}
          className="h-full w-full"
          imgClassName="object-cover transition-transform duration-500 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[var(--loom-media-scrim-strong)] via-transparent to-transparent" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-white text-black shadow-xl">
            <Play className="ml-0.5 h-5 w-5 fill-current" />
          </span>
        </div>
        {item.rating > 0 && (
          <span className="absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded-full border border-[var(--loom-media-hairline)] bg-[var(--loom-media-scrim-strong)] px-2 text-[11px] font-semibold text-[var(--loom-rating)] backdrop-blur-md">
            <Star className="h-3 w-3 fill-current" />
            {item.rating.toFixed(1)}
          </span>
        )}
        <p className="absolute bottom-4 left-3 right-3 truncate text-sm font-semibold text-[var(--loom-on-media)]">{item.title}</p>
        <div className="absolute inset-x-0 bottom-0 h-1 bg-[var(--loom-media-track)]">
          <div className="h-full bg-[var(--loom-accent)]" style={{ width: `${progressPercent}%` }} />
        </div>
      </div>
    </Link>
  );
}

function latestProgressPercent(item: MediaItem, progress: Record<string, StoredProgress>): number {
  const candidates = [
    {
      filePath: item.filePath,
      durationHint: item.localMetadata?.durationSeconds || 0,
    },
    ...(item.episodeFiles || []).map((episode) => ({
      filePath: episode.filePath,
      durationHint: episode.localMetadata?.durationSeconds || 0,
    })),
  ].filter((candidate) => Boolean(candidate.filePath));
  const latest = candidates
    .map((candidate) => ({ ...candidate, stored: progress[candidate.filePath] }))
    .filter((candidate): candidate is typeof candidate & { stored: StoredProgress } => Boolean(candidate.stored))
    .sort((left, right) => (right.stored.updatedAt || 0) - (left.stored.updatedAt || 0))[0];

  if (!latest) return 0;
  const duration = latest.stored.duration > 0 ? latest.stored.duration : latest.durationHint;
  if (duration <= 0) return 0;
  return Math.min(100, Math.max(0, (latest.stored.position / duration) * 100));
}

/**
 * Number of cards in the first visual row, derived from where the cards wrap.
 * Reading it from layout rather than the grid template keeps arrow navigation
 * correct at every window width.
 */
function gridColumnCount(cards: HTMLElement[]): number {
  if (cards.length === 0) return 1;
  const firstRowTop = cards[0].offsetTop;
  const columns = cards.findIndex((card) => card.offsetTop > firstRowTop);
  return columns === -1 ? cards.length : columns;
}

type SearchResultsProps = {
  items: MediaItem[];
  query: string;
  from: string;
  isLoading: boolean;
  overlay?: boolean;
  gridRef?: RefObject<HTMLDivElement | null>;
  /** Called when Up is pressed from the first row, to hand focus back. */
  onExitTop?: () => void;
};

function SearchResults({ items, query, from, isLoading, overlay = false, gridRef, onExitTop }: SearchResultsProps) {
  const internalGridRef = useRef<HTMLDivElement | null>(null);
  const grid = gridRef || internalGridRef;

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const container = grid.current;
    if (!container) return;
    const cards = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const current = cards.indexOf(document.activeElement as HTMLAnchorElement);
    if (current === -1) return;

    const columns = gridColumnCount(cards);
    let next: number;
    switch (event.key) {
      case 'ArrowRight': next = Math.min(current + 1, cards.length - 1); break;
      case 'ArrowLeft': next = Math.max(current - 1, 0); break;
      case 'ArrowDown': next = Math.min(current + columns, cards.length - 1); break;
      case 'ArrowUp':
        if (current < columns) {
          event.preventDefault();
          onExitTop?.();
          return;
        }
        next = current - columns;
        break;
      case 'Home': next = 0; break;
      case 'End': next = cards.length - 1; break;
      default: return;
    }
    event.preventDefault();
    cards[next]?.focus();
  };

  return (
    <main className={overlay ? 'w-full pb-10 pt-10' : 'loom-modern-content-frame page-bottom-safe px-[var(--loom-frame-inset)] pb-10 pt-28'}>
      <h1 className={overlay ? 'text-2xl font-bold tracking-tight' : 'text-3xl font-bold tracking-tight'}>Search results</h1>
      <p className="mt-2 text-sm text-[var(--loom-muted)]" aria-live="polite">{items.length} {items.length === 1 ? 'title' : 'titles'} matching “{query}”</p>
      <div ref={grid} onKeyDown={moveFocus} className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(180px,200px))] justify-between gap-5">
        {items.map((item) => (
          <MediaPosterCard
            key={item.id}
            item={item}
            from={from}
            variant="home"
            metaLine={mediaMetaLine(item)}
          />
        ))}
      </div>
      {!isLoading && items.length === 0 && <p className="py-20 text-center text-[var(--loom-muted)]">No local matches found</p>}
    </main>
  );
}
