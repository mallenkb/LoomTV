import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FolderPlus, Play, Star } from 'lucide-react';
import { useLibrary, MediaItem, TVShow } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { desktopApi } from '@/lib/desktopApi';
import LibrarySearch from '@/components/LibrarySearch';
import { matchesMediaItem, searchQuery } from '@/lib/search';
import SafeArtwork from '@/components/SafeArtwork';
import VirtualPosterGrid from '@/components/VirtualPosterGrid';
import { posterSources, routeArtworkState } from '@/lib/artwork';

export default function Others() {
  const { state, addLibraryFolder } = useLibrary();
  const { isLoading, libraryFolderGroups } = state;
  const othersFolders = useMemo(() => libraryFolderGroups.others || [], [libraryFolderGroups.others]);
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const [query, setQuery] = useState('');
  const normalizedQuery = searchQuery(query);
  const items = useMemo(
    () => otherFolderItems([...state.movies, ...state.tvShows, ...state.animeShows], othersFolders),
    [othersFolders, state.animeShows, state.movies, state.tvShows],
  );
  const filteredItems = useMemo(
    () => items.filter((item) => matchesMediaItem(item, normalizedQuery)),
    [items, normalizedQuery],
  );

  return (
    <div className="loom-page h-full overflow-y-auto">
      <LibrarySearch value={query} onChange={setQuery} />
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6 pt-24">
        <h2 className="loom-section-title mb-2 text-2xl font-bold text-white">Others</h2>
        {isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,200px))] justify-start gap-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-[300px] w-full max-w-[200px] rounded-lg" />
            ))}
          </div>
        ) : othersFolders.length === 0 ? (
          <EmptyOthersState onAddFolder={() => addLibraryFolder('others')} />
        ) : (
          <>
            <VirtualPosterGrid
              items={filteredItems}
              renderItem={(item) => <OtherMediaCard item={item} from={currentRoute} />}
            />
            {items.length === 0 && (
              <div className="py-12 text-center text-[var(--loom-muted)]">
                No media found in your Others folders yet.
              </div>
            )}
            {items.length > 0 && filteredItems.length === 0 && (
              <div className="py-12 text-center text-[var(--loom-muted)]">No local matches found</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EmptyOthersState({ onAddFolder }: { onAddFolder: () => Promise<void> }) {
  return (
    <div className="flex min-h-[calc(100vh-260px)] items-center justify-center px-4">
      <div className="w-full max-w-[520px] text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] border border-[var(--loom-panel-border)] bg-[var(--loom-panel)]">
          <FolderPlus className="h-9 w-9 text-[var(--loom-accent)]" />
        </div>
        <h3 className="text-2xl font-semibold text-white">Add an Others folder</h3>
        <p className="mx-auto mt-3 max-w-[420px] text-sm leading-6 text-[var(--loom-muted)]">
          Use Others for mixed folders. LoomTV will scan the files and sort detected movies, TV shows, and anime automatically.
        </p>
        <Button onClick={onAddFolder} className="mt-8 h-12 gap-2 px-5">
          <FolderPlus className="h-4 w-4" />
          Add Others Folder
        </Button>
      </div>
    </div>
  );
}

function OtherMediaCard({ item, from }: { item: MediaItem; from: string }) {
  const [fallbackThumbnail, setFallbackThumbnail] = useState('');
  const fallbackFilePath = item.type === 'movie'
    ? item.filePath
    : (item as TVShow).episodeFiles?.slice().sort((a, b) => a.season - b.season || a.episode - b.episode)[0]?.filePath;
  const baseImageSources = useMemo(() => posterSources(item), [item]);
  const generatedSources = useMemo(() => fallbackThumbnail ? [fallbackThumbnail] : [], [fallbackThumbnail]);
  const imageSources = useMemo(() => posterSources(item, undefined, generatedSources), [generatedSources, item]);
  const routeArtwork = useMemo(() => routeArtworkState(item, imageSources), [imageSources, item]);
  const seasonCount = item.type === 'movie' ? 0 : availableSeasonCount(item as TVShow);
  const metaLine = [
    item.year > 0 ? String(item.year) : '',
    seasonCount > 0 ? `${seasonCount} ${seasonCount === 1 ? 'Season' : 'Seasons'}` : '',
  ].filter(Boolean).join(' · ');

  useEffect(() => {
    setFallbackThumbnail('');
    if (!fallbackFilePath || baseImageSources.length > 0) return;

    let isMounted = true;
    void desktopApi.getThumbnail(fallbackFilePath, '00:03:00')
      .then(({ url }) => {
        if (isMounted) setFallbackThumbnail(url);
      })
      .catch(() => {
        if (isMounted) setFallbackThumbnail('');
      });

    return () => {
      isMounted = false;
    };
  }, [baseImageSources.length, fallbackFilePath]);

  return (
    <Link
      to={mediaLink(item)}
      state={{ from, artwork: routeArtwork }}
      className="loom-poster-link group block w-full max-w-[200px] [contain-intrinsic-size:300px_200px] [content-visibility:auto]"
    >
      <div className="loom-poster-frame relative aspect-[2/3] overflow-hidden rounded-lg transition-all duration-200">
        <SafeArtwork
          src={imageSources}
          alt={item.title}
          className="h-full w-full transition-transform group-hover:scale-105"
          imgClassName="object-cover"
          fallback={
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--loom-surface)] p-3">
              <Play className="h-8 w-8 shrink-0 text-[var(--loom-accent)]" />
              <p className="line-clamp-4 text-center text-xs leading-tight text-[var(--loom-muted)]">{item.title}</p>
            </div>
          }
        />
        <RatingBadge rating={item.rating} />
        <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/40" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--loom-accent)] shadow-[0_0_0_6px_rgba(251,197,0,0.14)]">
            <Play className="ml-1 h-6 w-6 text-[var(--loom-accent-foreground)]" />
          </div>
        </div>
      </div>
      <div className="mt-2">
        <h4 className="truncate text-sm font-semibold text-white">{item.title}</h4>
        {metaLine && <p className="text-xs text-[var(--loom-muted)]">{metaLine}</p>}
      </div>
    </Link>
  );
}

function otherFolderItems(items: MediaItem[], folders: string[]): MediaItem[] {
  const normalizedFolders = folders.map(normalizePathPrefix).filter(Boolean);
  if (normalizedFolders.length === 0) return [];
  return items.filter((item) => itemBelongsToFolders(item, normalizedFolders));
}

function itemBelongsToFolders(item: MediaItem, folders: string[]): boolean {
  if (item.type === 'movie') return pathBelongsToFolders(item.filePath, folders);
  return ((item as TVShow).episodeFiles || []).some((file) => pathBelongsToFolders(file.filePath, folders));
}

function pathBelongsToFolders(filePath: string | undefined, folders: string[]): boolean {
  const normalizedPath = normalizePathPrefix(filePath || '');
  return folders.some((folder) => normalizedPath === folder || normalizedPath.startsWith(`${folder}/`));
}

function normalizePathPrefix(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function availableSeasonCount(show: TVShow): number {
  const fileSeasons = new Set((show.episodeFiles || []).map((file) => file.season).filter((season) => season > 0));
  return fileSeasons.size || (show.seasons || []).length;
}

function mediaLink(item: MediaItem): string {
  if (item.type === 'movie') return `/movie/${item.id}`;
  if (item.type === 'anime') return `/anime/${item.id}`;
  return `/tv/${item.id}`;
}

function RatingBadge({ rating }: { rating?: number }) {
  if (!rating || rating <= 0) return null;
  return (
    <div className="loom-chip absolute right-2 top-2 z-10 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-semibold backdrop-blur-md">
      <Star className="h-3.5 w-3.5" fill="currentColor" />
      {rating.toFixed(1)}
    </div>
  );
}
