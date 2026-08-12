import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Bookmark, Play, ArrowLeft } from 'lucide-react';
import { libraryMutationMessage, useLibrary, MediaItem } from '@/contexts/LibraryContext';
import { useProfiles } from '@/contexts/ProfileContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { desktopApi } from '@/lib/desktopApi';
import SafeArtwork from '@/components/SafeArtwork';
import { backdropSources, logoSources, posterSources, RouteArtworkState, uniqueArtworkSources } from '@/lib/artwork';
import { getProgressState, resetProgress, useProgressRefreshRevision } from '@/lib/progress';
import { getCachedDiscoverReturnRoute, getCachedExploreItem } from '@/lib/discoverNavigation';
import { loadCustomArtwork } from '@/lib/customArtwork';
import ArtworkEditorControls, { CustomArtworkState } from '@/components/ArtworkEditorControls';
import { useTheme } from '@/components/ThemeProvider';
import type { StremioPluginCatalogItem } from '@/shared/desktopProtocol';
import TrailerDialog from '@/components/TrailerDialog';
import HeroMetadata from '@/components/HeroMetadata';
import WatchedToggle from '@/components/WatchedToggle';
import { cacheWatchedDiscoverItem, discoverWatchedKey, localProgressPathsForItem, localWatchedKey } from '@/lib/watched';

type MovieDetailRouteState = {
  from?: string;
  fromDiscover?: boolean;
  addonId?: string;
  stremioCatalogItem?: StremioPluginCatalogItem;
  artwork?: RouteArtworkState;
};

interface MovieDetailProps {
  onPlay?: (
    filePath: string,
    title: string,
    subtitles?: MediaItem['subtitles'],
    episodes?: undefined,
    episodeFiles?: undefined,
    currentSeason?: undefined,
    currentEpisode?: undefined,
    mediaId?: string,
    artwork?: Pick<RouteArtworkState, 'logo' | 'logoCandidates' | 'poster' | 'posterCandidates' | 'backdrop' | 'backdropCandidates'>,
  ) => void;
}

const CUSTOM_MOVIE_ARTWORK_KEY = 'loomtvCustomMovieArtwork';

function formatDuration(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function resolveMovieArtwork(
  customArtwork: CustomArtworkState,
  movie: MediaItem,
  routeArtwork?: RouteArtworkState,
  generated: string[] = [],
): { heroArtwork: string[]; posterArtwork: string[]; heroKey: string; posterKey: string } {
  const effectivePoster = customArtwork.thumbnail || customArtwork.poster || '';
  const effectiveCover = customArtwork.cover || effectivePoster;
  const heroArtwork = uniqueArtworkSources(
    effectiveCover,
    backdropSources(movie, routeArtwork, generated),
  );
  const posterArtwork = uniqueArtworkSources(
    effectivePoster,
    posterSources(movie, routeArtwork, generated),
  );

  return {
    heroArtwork,
    posterArtwork,
    heroKey: effectiveCover || heroArtwork[0] || 'hero-fallback',
    posterKey: effectivePoster || posterArtwork[0] || 'poster-fallback',
  };
}

function formatShortMinutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

function formatThumbnailTime(seconds: number, duration = 0): string {
  const upperBound = duration > 30 ? duration - 10 : seconds;
  const safeSeconds = Math.max(10, Math.min(Math.floor(seconds || 180), Math.floor(upperBound || seconds || 180)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
}

function normalizeRouteYear(releaseInfo?: string, released?: string): number {
  const match = `${releaseInfo || ''} ${released || ''}`.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : 0;
}

function mediaFromStremioCatalogItem(item: StremioPluginCatalogItem | null | undefined): MediaItem | null {
  if (!item || item.type !== 'movie') return null;
  const poster = item.artwork?.poster || item.posterUrl || '';
  const backdrop = item.artwork?.background || item.backgroundUrl || poster;
  return {
    id: item.id,
    type: 'movie',
    format: item.format,
    title: item.title,
    year: normalizeRouteYear(item.releaseInfo, item.released),
    poster,
    backdrop,
    logo: item.artwork?.logo || item.logoUrl || '',
    summary: item.description || '',
    rating: item.rating || 0,
    providerRatings: item.providerRatings,
    contentRating: item.contentRating,
    streamingProviders: item.streamingProviders,
    trailerUrl: item.trailerUrl,
    runtime: item.runtime,
    genres: [...item.genres],
    cast: (item.cast || []).map((person) => ({
      name: person.name,
      character: person.character || '',
      image: person.image || '',
    })),
    filePath: '',
    subtitles: [],
    posterCandidates: poster ? [poster] : [],
    backdropCandidates: backdrop ? [backdrop] : [],
    logoCandidates: item.artwork?.logo || item.logoUrl ? [item.artwork?.logo || item.logoUrl || ''] : [],
  };
}

function findLocalMovieMatch(movies: readonly MediaItem[], mediaId: string | undefined): MediaItem | null {
  return mediaId ? movies.find((item) => item.id === mediaId) || null : null;
}

export default function MovieDetail({ onPlay }: MovieDetailProps) {
  const { id: mediaId } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { state, refreshLibrary, hydrateLibraryItem } = useLibrary();
  const { canManageProfiles, lists, setListEntry, watchedKeys, setWatched } = useProfiles();
  const { theme } = useTheme();
  const [movie, setMovie] = useState<MediaItem | null>(null);
  const [fallbackThumbnails, setFallbackThumbnails] = useState<string[]>([]);
  const progressTick = useProgressRefreshRevision();
  const [customArtwork, setCustomArtwork] = useState<CustomArtworkState>({});
  const [libraryActionError, setLibraryActionError] = useState('');
  const [detailsReady, setDetailsReady] = useState(false);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [metadataRefreshState, setMetadataRefreshState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const metadataFetchKeyRef = useRef('');
  const routeState = (location.state as MovieDetailRouteState | null) || null;
  // The Explore cache is a remote-provider detail bridge.  Never consult it
  // for an ordinary library route: local IDs are opaque and can legitimately
  // collide with a TMDB/AniList ID stored in the session cache.
  const isRemoteDetailRoute = Boolean(
    routeState?.stremioCatalogItem
    || routeState?.fromDiscover
    || routeState?.from?.startsWith('/discover'),
  );
  const routeCatalogItem = useMemo(
    () => routeState?.stremioCatalogItem || (isRemoteDetailRoute ? getCachedExploreItem('movie', mediaId) : null),
    [isRemoteDetailRoute, mediaId, routeState?.stremioCatalogItem],
  );
  const routeFallbackMovie = useMemo(
    () => mediaFromStremioCatalogItem(routeCatalogItem || undefined),
    [routeCatalogItem],
  );
  const routeAddonId = routeState?.addonId;
  const [isRemoteStremioMovie, setIsRemoteStremioMovie] = useState(Boolean(routeState?.stremioCatalogItem));

  useEffect(() => {
    let cancelled = false;
    // A provider title/year is descriptive metadata, never proof that a
    // specific local file is the same work. Discover items remain remote-only
    // until the host supplies an explicit provider-to-library binding.
    const found = routeFallbackMovie ? null : findLocalMovieMatch(state.movies, mediaId);
    const nextMovie = routeFallbackMovie || found;
    if (routeFallbackMovie) setIsRemoteStremioMovie(true);
    else if (found) setIsRemoteStremioMovie(false);
    setMovie(nextMovie);
    const fetchKey = mediaId ? `${routeAddonId || 'opaque'}|movie|${mediaId}` : '';
    if (!nextMovie && mediaId && metadataFetchKeyRef.current !== fetchKey) {
      metadataFetchKeyRef.current = fetchKey;
      const metadataRequest = routeAddonId
        ? desktopApi.getStremioMeta(routeAddonId, { type: 'movie', id: mediaId })
        : desktopApi.getStremioMetaByItem({ type: 'movie', id: mediaId });
      void metadataRequest
        .then((result) => {
          if (cancelled) return;
          const remoteMovie = mediaFromStremioCatalogItem(result.item);
          if (remoteMovie) {
            setMovie(remoteMovie);
            setIsRemoteStremioMovie(true);
          }
        })
        .catch((error) => {
          if (!cancelled) console.warn('Could not load Discover movie metadata:', error);
          metadataFetchKeyRef.current = '';
        });
    } else if (!fetchKey) {
      metadataFetchKeyRef.current = '';
    }
    if (found?.catalogRevision !== undefined) {
      void hydrateLibraryItem(found.id)
        .then((details) => {
          if (cancelled || !details) return;
          setMovie(details);
        })
        .catch((error) => console.warn('Could not hydrate movie details:', error));
    }
    return () => { cancelled = true; };
  }, [hydrateLibraryItem, mediaId, routeAddonId, routeFallbackMovie, routeState?.from, routeState?.fromDiscover, state.catalogRevision, state.movies]);

  const handleRefreshIncompleteMetadata = async () => {
    if (!movie?.id || isRemoteStremioMovie || metadataRefreshState === 'loading') return;
    setMetadataRefreshState('loading');
    try {
      await desktopApi.refreshIncompleteMetadata(movie.id);
      const refreshed = await hydrateLibraryItem(movie.id);
      if (refreshed) setMovie(refreshed);
      else await refreshLibrary();
      setMetadataRefreshState('success');
      window.setTimeout(() => setMetadataRefreshState('idle'), 2200);
    } catch (error) {
      console.warn('Could not refresh incomplete metadata:', error);
      setMetadataRefreshState('error');
      window.setTimeout(() => setMetadataRefreshState('idle'), 2600);
    }
  };

  useEffect(() => {
    setDetailsReady(false);
    const frame = window.requestAnimationFrame(() => setDetailsReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [movie?.id]);

  useEffect(() => {
    setCustomArtwork({});
    if (movie?.id) {
      void loadCustomArtwork(movie.id, CUSTOM_MOVIE_ARTWORK_KEY)
        .then((artwork) => setCustomArtwork(artwork as CustomArtworkState));
    }
  }, [movie?.id]);

  useEffect(() => {
    setFallbackThumbnails([]);

    const hasStoredArtwork = Boolean(
      movie?.poster
      || movie?.backdrop
      || movie?.posterCandidates?.length
      || movie?.backdropCandidates?.length,
    );
    if (!movie?.filePath) return;

    let cancelled = false;
    const progress = getProgressState(movie.filePath, movie.localMetadata?.durationSeconds);
    const preferredTime = progress.position > 10
      ? formatThumbnailTime(progress.position, progress.duration)
      : '00:03:00';
    const times = hasStoredArtwork ? [preferredTime] : Array.from(new Set([
      progress.position > 10 ? formatThumbnailTime(progress.position, progress.duration) : '',
      '00:03:00',
      '00:01:00',
      '00:00:10',
    ].filter(Boolean)));

    void Promise.all(times.map((time) =>
      desktopApi.getThumbnail(movie.filePath, time)
        .then(({ url }) => url)
        .catch(() => ''),
    )).then((urls) => {
      if (!cancelled) setFallbackThumbnails(urls.filter(Boolean));
    });

    return () => {
      cancelled = true;
    };
  }, [movie?.backdrop, movie?.backdropCandidates?.length, movie?.filePath, movie?.localMetadata?.durationSeconds, movie?.poster, movie?.posterCandidates?.length]);

  // refreshLibrary() updates the item, but the artwork snapshot captured in
  // router state when navigating in takes precedence over it inside
  // posterSources()/backdropSources(). Dropping that snapshot is what makes a
  // newly applied poster or cover appear immediately instead of only after
  // reopening the title.
  const handleArtworkSaved = useCallback(async () => {
    setLibraryActionError('');
    try {
      await refreshLibrary();
    } catch (error) {
      setLibraryActionError(libraryMutationMessage(error));
      return;
    }
    const routeState = (location.state || {}) as Record<string, unknown>;
    if (!routeState.artwork) return;
    const { artwork: _staleArtwork, ...rest } = routeState;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: rest });
  }, [location.pathname, location.search, location.state, navigate, refreshLibrary]);

  if (!movie) {
    return (
      <div className="loom-page h-full overflow-y-auto">
        <div className="loom-frame page-bottom-safe pt-6">
          <Skeleton className="h-[400px] w-full rounded-lg" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      </div>
    );
  }

  const inMyList = lists.some((entry) => entry.mediaId === movie.id && (entry.kind === 'watchlist' || entry.kind === 'favorite'));
  const isRemoteContent = isRemoteStremioMovie || Boolean(routeCatalogItem);
  const watchedKey = isRemoteContent
    ? discoverWatchedKey({ id: movie.id, type: 'movie', source: routeCatalogItem?.source })
    : localWatchedKey(movie.id);
  const progress = getProgressState(movie.filePath, movie.localMetadata?.durationSeconds);
  const watchedByProgress = !isRemoteContent && progress.watched;
  const isWatched = watchedByProgress || watchedKeys.has(watchedKey);
  const sourceArtwork = routeState?.artwork;
  const { heroArtwork, posterArtwork, heroKey, posterKey } = resolveMovieArtwork(
    customArtwork,
    movie,
    sourceArtwork,
    fallbackThumbnails,
  );
  const officialPosterArtwork = uniqueArtworkSources(movie.posterCandidates, movie.poster, sourceArtwork?.posterCandidates, sourceArtwork?.poster);
  const officialCoverArtwork = uniqueArtworkSources(movie.backdropCandidates, movie.backdrop, sourceArtwork?.backdropCandidates, sourceArtwork?.backdrop);
  const playerLogoArtwork = logoSources(movie, sourceArtwork);
  const playerArtwork = {
    logo: playerLogoArtwork[0] || '',
    logoCandidates: playerLogoArtwork,
    poster: posterArtwork[0] || movie.poster,
    posterCandidates: posterArtwork,
    backdrop: heroArtwork[0] || movie.backdrop,
    backdropCandidates: heroArtwork,
    rating: movie.rating,
  };
  const hasResumeProgress = progress.inProgress;
  const progressPercent = Math.min(100, Math.max(0, progress.fraction * 100));
  const progressCopy = progress.duration > 0
    ? `${formatShortMinutes(progress.position)} of ${formatShortMinutes(progress.duration)}`
    : null;
  const canPlayMovie = Boolean(onPlay && movie.filePath);
  void progressTick;

  const handlePlay = async () => {
    if (canPlayMovie && onPlay) {
      onPlay(movie.filePath, movie.title, movie.subtitles, undefined, undefined, undefined, undefined, movie.id, playerArtwork);
    }
  };

  const sourceRoute = routeState?.from?.startsWith('/discover')
    ? routeState.from
    : routeState?.fromDiscover || isRemoteStremioMovie
      ? getCachedDiscoverReturnRoute()
      : routeState?.from;
  const backTarget = sourceRoute && !sourceRoute.startsWith('/movie/') ? sourceRoute : '/movies';
  const handleBack = () => navigate(backTarget);


  return (
    <div className={`loom-page loom-detail-page h-full overflow-y-auto ${theme.homeStyle === 'modern' ? 'loom-detail-page-modern' : ''}`}>
      <div className="loom-detail-cover relative h-[50vh] w-full overflow-hidden">
        <div className="loom-detail-cover-image absolute inset-y-0 left-0 right-0 mx-auto w-full max-w-[var(--loom-frame-max-width)]">
          <SafeArtwork
            key={heroKey}
            src={heroArtwork}
            placeholderSrc={fallbackThumbnails[0] || ''}
            alt={movie.title}
            className="h-full w-full"
            imgClassName="object-cover"
            priority
            fallback={<div className="h-full w-full" />}
          />
        </div>
        <div className="loom-detail-hero-fade absolute inset-0" />
        {libraryActionError ? <div role="alert" className="absolute inset-x-6 bottom-4 z-20 rounded-lg bg-red-950/85 px-3 py-2 text-sm text-red-100">{libraryActionError}</div> : null}
        {canManageProfiles && !isRemoteStremioMovie && <ArtworkEditorControls
          mediaId={movie.id}
          legacyStorageKey={CUSTOM_MOVIE_ARTWORK_KEY}
          onCustomArtworkChange={setCustomArtwork}
          onSaved={handleArtworkSaved}
          officialThumbnailSources={officialPosterArtwork}
          officialCoverSources={officialCoverArtwork}
          fallbackFrameSource={fallbackThumbnails[0] || ''}
          revealPath={movie.filePath}
          onFetchOfficialArtwork={(target) => desktopApi.refreshOfficialArtwork(movie.id, target)}
          onFetchOfficialArtworkCandidates={() => desktopApi.getOfficialMetadataCandidates(movie.id)}
          onApplyOfficialArtworkCandidate={(candidate, target) => desktopApi.applyOfficialMetadata(movie.id, candidate, target)}
          refreshMetadataState={metadataRefreshState}
          onRefreshIncompleteMetadata={handleRefreshIncompleteMetadata}
        />}
        <button
          type="button"
          onClick={handleBack}
          className="loom-detail-back loom-no-drag fixed top-6 z-50 flex h-10 items-center gap-2 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-panel)] px-3 text-sm text-[var(--loom-text)] shadow-lg backdrop-blur-md transition-colors hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-active-text)]"
        >
          <ArrowLeft className="w-5 h-5" />
          Back
        </button>

        <div className="loom-detail-hero-content-wrap absolute bottom-0 left-0 right-0">
          <div className="loom-detail-hero-content mx-auto flex w-full max-w-[var(--loom-frame-max-width)] items-end gap-6 p-8">
          <SafeArtwork
            key={posterKey}
            src={posterArtwork}
            placeholderSrc={fallbackThumbnails[0] || ''}
            alt={movie.title}
            className="loom-poster-frame hidden aspect-[2/3] w-28 shrink-0 rounded-lg shadow-xl md:block"
            imgClassName="object-cover"
            priority
            fallback={
              <div className="flex h-full w-full items-center justify-center p-2">
                <span className="line-clamp-4 text-center text-[10px] font-medium leading-tight text-white/60">
                  {movie.title}
                </span>
              </div>
            }
          />
          <div className="loom-detail-hero-info min-w-0 flex-1">
            <h1 className="text-4xl font-bold text-white">{movie.title}</h1>
            <HeroMetadata item={movie} />
          </div>
          <div className="loom-detail-hero-controls flex shrink-0 items-center gap-[6px]">
          {movie.trailerUrl && <Button
            variant="outline"
            onClick={() => setTrailerOpen(true)}
            className="h-12 gap-2 rounded-full border-white/25 bg-white/10 px-4 text-white backdrop-blur-md hover:bg-white/20 hover:text-white"
          >
            <Play className="h-4 w-4 fill-current" />
            Trailer
          </Button>}
          {canPlayMovie && <Button
            onClick={handlePlay}
            className="loom-detail-hero-play relative h-14 shrink-0 overflow-hidden rounded-lg bg-[var(--loom-accent)] px-6 text-base font-semibold text-[var(--loom-accent-foreground)] shadow-[0_16px_38px_rgba(0,0,0,0.38)] hover:bg-[var(--loom-accent-hover)] gap-3"
          >
            {hasResumeProgress && progressPercent > 0 && (
              <span
                className="pointer-events-none absolute inset-y-0 left-0 bg-black/20"
                style={{ width: `${progressPercent}%` }}
              />
            )}
            <span className="relative z-10 flex items-center gap-3">
              <Play className="h-7 w-7 fill-current" />
              <span className="flex min-w-28 flex-col items-start leading-tight">
                <span>{hasResumeProgress ? 'Resume' : 'Play'}</span>
                {hasResumeProgress && progressCopy && (
                  <span className="text-[11px] font-medium text-[var(--loom-accent-foreground-muted)]">{progressCopy}</span>
                )}
              </span>
            </span>
          </Button>}
            <div className="loom-detail-hero-actions flex shrink-0 gap-2">
              {!isRemoteContent && (
              <button
                type="button"
                aria-pressed={inMyList}
                onClick={() => void (async () => {
                  await setListEntry(movie.id, 'watchlist', !inMyList);
                  if (inMyList) await setListEntry(movie.id, 'favorite', false);
                })()}
                className="loom-detail-bookmark grid h-14 w-14 place-items-center rounded-full bg-white/10 text-white backdrop-blur-[12px] transition-colors hover:bg-[var(--loom-active-bg)]"
                title={inMyList ? 'Remove from My List' : 'Add to My List'}
              >
                <Bookmark className="h-5 w-5" fill={inMyList ? 'currentColor' : 'none'} />
              </button>
              )}
              <WatchedToggle
                watched={isWatched}
                onToggle={() => {
                  if (routeCatalogItem) cacheWatchedDiscoverItem(routeCatalogItem);
                  const present = !isWatched;
                  if (!present && watchedByProgress) void resetProgress(localProgressPathsForItem(movie));
                  void setWatched(watchedKey, present);
                }}
                className={`h-14 w-14 bg-white/10 text-white/80 ${isWatched ? 'hover:bg-white/10' : 'hover:bg-[var(--loom-active-bg)]'}`}
                label={isWatched ? 'Mark as unwatched' : 'Mark as watched'}
              />
            </div>
          </div>
          </div>
        </div>
      </div>

      <div className="loom-detail-body loom-frame">
      <div className="page-bottom-safe-lg p-8">
        {movie.summary && (
          <section className="loom-detail-summary mb-8">
            <h3 className="text-lg font-semibold text-white mb-3">Summary</h3>
            <p className="whitespace-pre-line text-[var(--loom-muted)] leading-relaxed">{movie.summary}</p>
          </section>
        )}

        {movie.localMetadata && (
          <section className="mb-8">
            <h3 className="text-lg font-semibold text-white mb-3">Local Media Info</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {movie.localMetadata.width && movie.localMetadata.height && (
                <div className="rounded-lg bg-[var(--loom-panel)] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Resolution</p>
                  <p className="text-white text-sm mt-1">{movie.localMetadata.width}x{movie.localMetadata.height}</p>
                </div>
              )}
              {movie.localMetadata.durationSeconds && (
                <div className="rounded-lg bg-[var(--loom-panel)] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Duration</p>
                  <p className="text-white text-sm mt-1">{formatDuration(movie.localMetadata.durationSeconds)}</p>
                </div>
              )}
              {movie.localMetadata.videoCodec && (
                <div className="rounded-lg bg-[var(--loom-panel)] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Video</p>
                  <p className="text-white text-sm mt-1">{movie.localMetadata.videoCodec}</p>
                </div>
              )}
              {movie.localMetadata.audioCodec && (
                <div className="rounded-lg bg-[var(--loom-panel)] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Audio</p>
                  <p className="text-white text-sm mt-1">
                    {movie.localMetadata.audioCodec}
                    {movie.localMetadata.audioTracks ? ` · ${movie.localMetadata.audioTracks} tracks` : ''}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {detailsReady && movie.cast.length > 0 && (
          <section>
            <h3 className="text-lg font-semibold text-white mb-3">Cast</h3>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {movie.cast.slice(0, 8).map((actor) => (
                <div key={actor.name} className="flex-shrink-0 w-20 text-center">
                  <Avatar className="w-16 h-16 mx-auto mb-2">
                    {actor.image ? (
                      <AvatarImage src={actor.image} alt={actor.name} />
                    ) : (
                      <AvatarFallback className="bg-[var(--loom-surface-3)] text-white text-xs">
                        {actor.name.charAt(0)}
                      </AvatarFallback>
                    )}
                  </Avatar>
                  <p className="text-xs text-white truncate">{actor.name}</p>
                  <p className="text-xs text-[var(--loom-muted)] truncate">{actor.character}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      </div>
      <TrailerDialog
        open={trailerOpen}
        title={movie.title}
        trailerUrl={movie.trailerUrl}
        onClose={() => setTrailerOpen(false)}
      />
    </div>
  );
}
