import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Play, Star, Clock, ArrowLeft } from 'lucide-react';
import { motion } from 'motion/react';
import { useLibrary, MediaItem, LocalMediaDetails } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { desktopApi } from '@/lib/desktopApi';
import SafeArtwork from '@/components/SafeArtwork';
import { logoSources, RouteArtworkState, uniqueArtworkSources } from '@/lib/artwork';
import { getProgressState, hydrateProgressFromDatabase } from '@/lib/progress';
import { loadCustomArtwork } from '@/lib/customArtwork';
import ArtworkEditorControls, { CustomArtworkState } from '@/components/ArtworkEditorControls';

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

function formatLocalSpecs(metadata?: LocalMediaDetails): string[] {
  if (!metadata) return [];
  const specs: string[] = [];
  const duration = formatDuration(metadata.durationSeconds);
  if (duration) specs.push(duration);
  if (metadata.width && metadata.height) specs.push(`${metadata.width}x${metadata.height}`);
  if (metadata.videoCodec) specs.push(metadata.videoCodec.toUpperCase());
  if (metadata.audioCodec) specs.push(metadata.audioCodec.toUpperCase());
  if (metadata.container) specs.push(metadata.container.toUpperCase());
  return specs;
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
    routeArtwork?.backdropCandidates,
    routeArtwork?.backdrop,
    movie.backdropCandidates,
    movie.backdrop,
    generated,
  );
  const posterArtwork = uniqueArtworkSources(
    effectivePoster,
    routeArtwork?.posterCandidates,
    routeArtwork?.poster,
    movie.posterCandidates,
    movie.poster,
    generated,
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

export default function MovieDetail({ onPlay }: MovieDetailProps) {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { state, refreshLibrary } = useLibrary();
  const [movie, setMovie] = useState<MediaItem | null>(null);
  const [fallbackThumbnails, setFallbackThumbnails] = useState<string[]>([]);
  const [progressTick, setProgressTick] = useState(0);
  const [customArtwork, setCustomArtwork] = useState<CustomArtworkState>({});

  useEffect(() => {
    const found = state.movies.find((m) => m.id === id);
    setMovie(found || null);
  }, [id, state.movies]);

  useEffect(() => {
    setCustomArtwork({});
    if (movie?.id) {
      void loadCustomArtwork(movie.id, CUSTOM_MOVIE_ARTWORK_KEY)
        .then((artwork) => setCustomArtwork(artwork as CustomArtworkState));
    }
  }, [movie?.id]);

  useEffect(() => {
    setFallbackThumbnails([]);

    if (!movie?.filePath) return;

    let cancelled = false;
    const progress = getProgressState(movie.filePath, movie.localMetadata?.durationSeconds);
    const times = Array.from(new Set([
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
  }, [movie?.filePath, movie?.localMetadata?.durationSeconds]);

  useEffect(() => {
    const bump = () => setProgressTick((value) => value + 1);
    void hydrateProgressFromDatabase().then(bump);
    const interval = window.setInterval(bump, 2000);
    window.addEventListener('focus', bump);
    window.addEventListener('storage', bump);
    window.addEventListener('loomtv-progress', bump);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', bump);
      window.removeEventListener('storage', bump);
      window.removeEventListener('loomtv-progress', bump);
    };
  }, []);

  if (!movie) {
    return (
      <div className="loom-page h-full overflow-y-auto">
        <div className="page-bottom-safe mx-auto max-w-[1440px] p-6">
          <Skeleton className="h-[400px] w-full rounded-lg" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      </div>
    );
  }

  const localSpecs = formatLocalSpecs(movie.localMetadata);
  const sourceArtwork = (location.state as { artwork?: RouteArtworkState } | null)?.artwork;
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
  const progress = getProgressState(movie.filePath, movie.localMetadata?.durationSeconds);
  const hasResumeProgress = progress.inProgress;
  const progressPercent = Math.min(100, Math.max(0, progress.fraction * 100));
  const progressCopy = progress.duration > 0
    ? `${formatShortMinutes(progress.position)} of ${formatShortMinutes(progress.duration)}`
    : null;
  void progressTick;

  const handlePlay = async () => {
    if (onPlay) {
      onPlay(movie.filePath, movie.title, movie.subtitles, undefined, undefined, undefined, undefined, movie.id, playerArtwork);
    }
  };

  const sourceRoute = (location.state as { from?: string } | null)?.from;
  const backTarget = sourceRoute && !sourceRoute.startsWith('/movie/') ? sourceRoute : '/movies';
  const handleBack = () => navigate(backTarget);

  return (
    <div className="loom-page h-full overflow-y-auto">
      <div className="mx-auto max-w-[1440px]">
      <div className="relative h-[50vh] w-full">
        <SafeArtwork
          key={heroKey}
          src={heroArtwork}
          alt={movie.title}
          className="h-full w-full"
          imgClassName="object-cover"
          loading="eager"
          fallback={<div className="h-full w-full" />}
        />
        <div className="loom-detail-hero-fade absolute inset-0" />
        <div className="loom-detail-side-fade-left pointer-events-none absolute inset-y-0 left-0 w-40" />
        <div className="loom-detail-side-fade-right pointer-events-none absolute inset-y-0 right-0 w-40" />
        <ArtworkEditorControls
          mediaId={movie.id}
          legacyStorageKey={CUSTOM_MOVIE_ARTWORK_KEY}
          onCustomArtworkChange={setCustomArtwork}
          onSaved={refreshLibrary}
          officialThumbnailSources={officialPosterArtwork}
          officialCoverSources={officialCoverArtwork}
          fallbackFrameSource={fallbackThumbnails[0] || ''}
          onFetchOfficialArtwork={() => desktopApi.refreshOfficialArtwork(movie.id)}
          onFetchOfficialArtworkCandidates={() => desktopApi.getOfficialMetadataCandidates(movie.id)}
          onApplyOfficialArtworkCandidate={(candidate) => desktopApi.applyOfficialMetadata(movie.id, candidate)}
        />
        <button
          type="button"
          onClick={handleBack}
          className="fixed left-[max(calc(12rem+1rem),calc(12rem+((100vw-12rem-1440px)/2)+1rem))] top-4 z-50 flex h-10 items-center gap-2 rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] px-3 text-sm text-white shadow-lg backdrop-blur-md transition-colors hover:border-[var(--loom-accent)]/45 hover:text-[var(--loom-accent)]"
        >
          <ArrowLeft className="w-5 h-5" />
          Back
        </button>

        <div className="absolute bottom-0 left-0 right-0 z-30 flex items-end gap-6 p-8">
          <SafeArtwork
            key={posterKey}
            src={posterArtwork}
            alt={movie.title}
            className="loom-poster-frame hidden aspect-[2/3] w-28 shrink-0 rounded-lg shadow-xl md:block"
            imgClassName="object-cover"
            loading="eager"
            fallback={
              <div className="flex h-full w-full items-center justify-center p-2">
                <span className="line-clamp-4 text-center text-[10px] font-medium leading-tight text-white/60">
                  {movie.title}
                </span>
              </div>
            }
          />
          <div className="flex-1 min-w-0">
            <h1 className="text-4xl font-bold text-white mb-2">{movie.title}</h1>
            <div className="flex items-center gap-4 text-[var(--loom-muted)] text-sm mb-3">
              <span className="loom-rating flex items-center gap-1">
                <Star className="w-4 h-4" fill="currentColor" />
                {movie.rating ? movie.rating.toFixed(1) : 'N/A'}
              </span>
              {movie.year > 0 && <span>{movie.year}</span>}
              {movie.fileSize && (
                <span className="flex items-center gap-1">
                  <Clock className="w-4 h-4" />
                  {(movie.fileSize / 1024 / 1024 / 1024).toFixed(1)} GB
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2 mb-5">
              {movie.genres.map((genre) => (
                <Badge key={genre} variant="outline" className="text-white border-white/30 text-xs">
                  {genre}
                </Badge>
              ))}
            </div>
            {localSpecs.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-5">
                {localSpecs.map((spec) => (
                  <Badge key={spec} variant="outline" className="text-[var(--loom-accent)] border-[var(--loom-accent)]/40 text-xs">
                    {spec}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <Button
            onClick={handlePlay}
            className="relative h-16 min-w-[9rem] shrink-0 overflow-hidden rounded-lg bg-[var(--loom-accent)] px-6 text-base font-semibold text-[var(--loom-accent-foreground)] shadow-[0_16px_38px_rgba(0,0,0,0.38),0_0_0_1px_rgba(251,197,0,0.26)] hover:bg-[var(--loom-accent-hover)] gap-3"
          >
            {hasResumeProgress && progressPercent > 0 && (
              <span
                className="pointer-events-none absolute inset-y-0 left-0 bg-black/20"
                style={{ width: `${progressPercent}%` }}
              />
            )}
            <span className="relative z-10 flex items-center gap-3">
              <Play className="h-7 w-7" />
              <span className="flex flex-col items-start leading-tight">
                <span>{hasResumeProgress ? 'Resume' : 'Play'}</span>
                {hasResumeProgress && progressCopy && (
                  <span className="text-[11px] font-medium text-[var(--loom-accent-foreground-muted)]">{progressCopy}</span>
                )}
              </span>
            </span>
          </Button>
        </div>
      </div>

      <div className="page-bottom-safe-lg p-8">
        {movie.summary && (
          <section className="mb-8">
            <h3 className="text-lg font-semibold text-white mb-3">Summary</h3>
            <ExpandableSummary summary={movie.summary} />
          </section>
        )}

        {movie.localMetadata && (
          <section className="mb-8">
            <h3 className="text-lg font-semibold text-white mb-3">Local Media Info</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {movie.localMetadata.width && movie.localMetadata.height && (
                <div className="rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Resolution</p>
                  <p className="text-white text-sm mt-1">{movie.localMetadata.width}x{movie.localMetadata.height}</p>
                </div>
              )}
              {movie.localMetadata.durationSeconds && (
                <div className="rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Duration</p>
                  <p className="text-white text-sm mt-1">{formatDuration(movie.localMetadata.durationSeconds)}</p>
                </div>
              )}
              {movie.localMetadata.videoCodec && (
                <div className="rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Video</p>
                  <p className="text-white text-sm mt-1">{movie.localMetadata.videoCodec}</p>
                </div>
              )}
              {movie.localMetadata.audioCodec && (
                <div className="rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-3">
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

        {movie.cast.length > 0 && (
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
    </div>
  );
}

function ExpandableSummary({ summary }: { summary: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const toggleSummary = () => {
    if (canExpand) setIsExpanded((expanded) => !expanded);
  };

  useEffect(() => {
    setCanExpand(summary.trim().length > 320);
  }, [summary]);

  return (
    <motion.div
      layout
      onClick={toggleSummary}
      className={`group rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]/70 ${canExpand ? 'cursor-pointer' : ''}`}
      whileTap={{ scale: 0.998 }}
    >
      <motion.div
        layout
        className="overflow-hidden"
        transition={{ type: 'spring', stiffness: 360, damping: 34, mass: 0.9 }}
      >
        <motion.p
          key={isExpanded ? 'expanded' : 'collapsed'}
          className={`text-[var(--loom-muted)] leading-relaxed ${isExpanded ? '' : 'line-clamp-3'}`}
          initial={{ opacity: 0.72, y: isExpanded ? -3 : 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        >
          {summary}
        </motion.p>
      </motion.div>
      {canExpand && (
        <motion.button
          layout
          type="button"
          aria-expanded={isExpanded}
          onClick={(event) => {
            event.stopPropagation();
            toggleSummary();
          }}
          className="mt-2 text-sm font-medium text-[var(--loom-accent)] transition-colors group-hover:text-[var(--loom-accent-hover)] hover:text-[var(--loom-accent-hover)]"
          whileTap={{ scale: 0.98 }}
        >
          {isExpanded ? 'Show Less' : 'Show More'}
        </motion.button>
      )}
    </motion.div>
  );
}
