import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Play, Star, Clock, ArrowLeft, Image, MoreHorizontal } from 'lucide-react';
import { motion } from 'motion/react';
import { useLibrary, MediaItem, LocalMediaDetails } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { desktopApi } from '@/lib/desktopApi';
import SafeArtwork from '@/components/SafeArtwork';
import { backdropSources, posterSources, RouteArtworkState, uniqueArtworkSources } from '@/lib/artwork';
import { getProgressState, hydrateProgressFromDatabase } from '@/lib/progress';
import { loadCustomArtwork, saveCustomArtwork } from '@/lib/customArtwork';

interface MovieDetailProps {
  onPlay?: (filePath: string, title: string, subtitles?: MediaItem['subtitles'], episodes?: undefined, episodeFiles?: undefined, currentSeason?: undefined, currentEpisode?: undefined, mediaId?: string) => void;
}

type ArtworkTarget = 'cover' | 'poster';
type ArtworkPreview = {
  target: ArtworkTarget;
  url: string;
  name: string;
  width: number;
  height: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
};
type ArtworkPrepareState = {
  target: ArtworkTarget;
  name: string;
};
const CUSTOM_MOVIE_ARTWORK_KEY = 'loomtvCustomMovieArtwork';
const ARTWORK_TARGETS: Record<ArtworkTarget, { label: string; aspectClass: string; outputWidth: number; outputHeight: number }> = {
  cover: {
    label: 'Cover photo',
    aspectClass: 'aspect-[16/6] w-full',
    outputWidth: 1600,
    outputHeight: 600,
  },
  poster: {
    label: 'Poster cover',
    aspectClass: 'mx-auto aspect-[2/3] w-56',
    outputWidth: 800,
    outputHeight: 1200,
  },
};

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
  customArtwork: Partial<Record<ArtworkTarget, string>>,
  movie: MediaItem,
  routeArtwork?: RouteArtworkState,
  generated: string[] = [],
): { heroArtwork: string[]; posterArtwork: string[]; heroKey: string; posterKey: string } {
  const effectivePoster = customArtwork.poster || '';
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

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function cropArtworkToDataUrl(preview: ArtworkPreview): Promise<string> {
  const target = ARTWORK_TARGETS[preview.target];
  const targetAspect = target.outputWidth / target.outputHeight;

  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = target.outputWidth;
      canvas.height = target.outputHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Unable to prepare artwork crop.'));
        return;
      }

      const imageAspect = image.naturalWidth / image.naturalHeight;
      const baseCropWidth = imageAspect > targetAspect ? image.naturalHeight * targetAspect : image.naturalWidth;
      const baseCropHeight = imageAspect > targetAspect ? image.naturalHeight : image.naturalWidth / targetAspect;
      const cropWidth = Math.min(image.naturalWidth, baseCropWidth / preview.zoom);
      const cropHeight = Math.min(image.naturalHeight, baseCropHeight / preview.zoom);
      const positionX = clampPercent(50 + preview.offsetX) / 100;
      const positionY = clampPercent(50 + preview.offsetY) / 100;
      const cropX = Math.max(0, Math.min(image.naturalWidth - cropWidth, (image.naturalWidth - cropWidth) * positionX));
      const cropY = Math.max(0, Math.min(image.naturalHeight - cropHeight, (image.naturalHeight - cropHeight) * positionY));

      context.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, target.outputWidth, target.outputHeight);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    image.onerror = () => reject(new Error('Unable to load selected artwork.'));
    image.src = preview.url;
  });
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
  const [artworkMenuOpen, setArtworkMenuOpen] = useState(false);
  const [customArtwork, setCustomArtwork] = useState<Partial<Record<ArtworkTarget, string>>>({});
  const [artworkPreview, setArtworkPreview] = useState<ArtworkPreview | null>(null);
  const [artworkPrepareState, setArtworkPrepareState] = useState<ArtworkPrepareState | null>(null);
  const [isSavingArtwork, setIsSavingArtwork] = useState(false);
  const [artworkSaveError, setArtworkSaveError] = useState('');
  const artworkMenuRef = useRef<HTMLDivElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const posterInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const found = state.movies.find((m) => m.id === id);
    setMovie(found || null);
  }, [id, state.movies]);

  useEffect(() => {
    setArtworkMenuOpen(false);
    setCustomArtwork({});
    if (movie?.id) {
      void loadCustomArtwork(movie.id, CUSTOM_MOVIE_ARTWORK_KEY)
        .then((artwork) => setCustomArtwork(artwork as Partial<Record<ArtworkTarget, string>>));
    }
    setArtworkPreview(null);
    setArtworkPrepareState(null);
    setArtworkSaveError('');
    setIsSavingArtwork(false);
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
  }, [movie?.filePath]);

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

  useEffect(() => {
    if (!artworkMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!artworkMenuRef.current?.contains(event.target as Node)) {
        setArtworkMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setArtworkMenuOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [artworkMenuOpen]);

  const openArtworkPicker = (target: ArtworkTarget) => {
    const input = target === 'cover' ? coverInputRef.current : posterInputRef.current;
    input?.click();
    setArtworkMenuOpen(false);
  };

  const handleArtworkFileChange = (target: ArtworkTarget, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;

    setArtworkPreview(null);
    setArtworkPrepareState({ target, name: file.name });
    setArtworkSaveError('');

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) {
        setArtworkPrepareState(null);
        setArtworkSaveError('Unable to read selected artwork.');
        return;
      }

      const image = new window.Image();
      image.onload = () => {
        setArtworkPreview({
          target,
          url: dataUrl,
          name: file.name,
          width: image.naturalWidth,
          height: image.naturalHeight,
          zoom: 1,
          offsetX: 0,
          offsetY: 0,
        });
        setArtworkPrepareState(null);
      };
      image.onerror = () => {
        setArtworkPrepareState(null);
        setArtworkSaveError('Unable to load selected artwork. Try a JPG, PNG, or WebP image.');
      };
      image.src = dataUrl;
    };
    reader.onerror = () => {
      setArtworkPrepareState(null);
      setArtworkSaveError('Unable to read selected artwork.');
    };
    reader.readAsDataURL(file);
  };

  const closeArtworkPreview = () => {
    setArtworkPreview(null);
    setArtworkPrepareState(null);
    setArtworkSaveError('');
    setIsSavingArtwork(false);
  };

  const updateArtworkPreview = (updates: Partial<Pick<ArtworkPreview, 'zoom' | 'offsetX' | 'offsetY'>>) => {
    setArtworkPreview((current) => current ? { ...current, ...updates } : current);
  };

  const applyArtworkPreview = async () => {
    if (!artworkPreview || !movie?.id) return;
    setIsSavingArtwork(true);
    setArtworkSaveError('');
    try {
      const { target } = artworkPreview;
      const croppedArtwork = await cropArtworkToDataUrl(artworkPreview);
      await saveCustomArtwork(movie.id, target, croppedArtwork, CUSTOM_MOVIE_ARTWORK_KEY);
      setCustomArtwork((current) => {
        const nextArtwork = { ...current, [target]: croppedArtwork };
        return target === 'poster' && !current.cover
          ? { ...nextArtwork, cover: croppedArtwork }
          : nextArtwork;
      });
      void refreshLibrary();
      closeArtworkPreview();
    } catch (error) {
      setArtworkSaveError(error instanceof Error ? error.message : 'Unable to save artwork.');
      setIsSavingArtwork(false);
    }
  };

  if (!movie) {
    return (
      <div className="h-full overflow-y-auto bg-[#1a1a1a]">
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
  const activeArtworkTarget = artworkPreview?.target || artworkPrepareState?.target || 'cover';
  const previewConfig = ARTWORK_TARGETS[activeArtworkTarget];
  const previewLabel = previewConfig.label;
  const artworkDialogOpen = Boolean(artworkPreview || artworkPrepareState || artworkSaveError);
  const progress = getProgressState(movie.filePath, movie.localMetadata?.durationSeconds);
  const hasResumeProgress = progress.inProgress;
  const progressPercent = Math.min(100, Math.max(0, progress.fraction * 100));
  const progressCopy = progress.duration > 0
    ? `${formatShortMinutes(progress.position)} of ${formatShortMinutes(progress.duration)}`
    : null;
  void progressTick;

  const handlePlay = async () => {
    if (onPlay) {
      onPlay(movie.filePath, movie.title, movie.subtitles, undefined, undefined, undefined, undefined, movie.id);
    }
  };

  const sourceRoute = (location.state as { from?: string } | null)?.from;
  const backTarget = sourceRoute && !sourceRoute.startsWith('/movie/') ? sourceRoute : '/movies';
  const handleBack = () => navigate(backTarget);

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a]">
      <div className="mx-auto max-w-[1440px]">
      <div className="relative h-[50vh] w-full">
        <SafeArtwork
          key={heroKey}
          src={heroArtwork}
          alt={movie.title}
          className="h-full w-full"
          imgClassName="object-cover"
          fallback={<div className="h-full w-full" />}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#1a1a1a] via-[#1a1a1a]/50 to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-[#1a1a1a] to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-32 bg-gradient-to-l from-[#1a1a1a] to-transparent" />
        <div
          ref={artworkMenuRef}
          className="fixed right-[max(1rem,calc(((100vw-12rem-1440px)/2)+1rem))] top-4 z-50"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="More artwork options"
            aria-haspopup="menu"
            aria-expanded={artworkMenuOpen}
            onClick={() => setArtworkMenuOpen((open) => !open)}
            className="h-9 w-9 rounded-lg border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md hover:bg-white/10 hover:text-[#eba865]"
          >
            <MoreHorizontal className="h-5 w-5" />
          </Button>
          {artworkMenuOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-52 overflow-hidden rounded-lg border border-white/10 bg-[#232323]/95 py-1 shadow-2xl backdrop-blur-md"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => openArtworkPicker('poster')}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 hover:text-[#eba865]"
              >
                <Image className="h-4 w-4" />
                Edit poster cover
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => openArtworkPicker('cover')}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 hover:text-[#eba865]"
              >
                <Image className="h-4 w-4" />
                Edit cover photo
              </button>
            </div>
          )}
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => handleArtworkFileChange('cover', event)}
          />
          <input
            ref={posterInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => handleArtworkFileChange('poster', event)}
          />
        </div>
        <button
          type="button"
          onClick={handleBack}
          className="fixed left-[max(calc(12rem+1rem),calc(12rem+((100vw-12rem-1440px)/2)+1rem))] top-4 z-50 flex h-9 items-center gap-2 rounded-lg border border-white/20 bg-black/55 px-3 text-sm text-white shadow-lg backdrop-blur-md transition-colors hover:text-[#eba865]"
        >
          <ArrowLeft className="w-5 h-5" />
          Back
        </button>

        <div className="absolute bottom-0 left-0 right-0 flex items-end gap-6 p-8">
          <SafeArtwork
            key={posterKey}
            src={posterArtwork}
            alt={movie.title}
            className="hidden aspect-[2/3] w-28 shrink-0 rounded-lg border border-white/10 shadow-xl md:block"
            imgClassName="object-cover"
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
            <div className="flex items-center gap-4 text-[#a8a8a8] text-sm mb-3">
              <span className="flex items-center gap-1">
                <Star className="w-4 h-4 text-[#eba865]" fill="currentColor" />
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
                  <Badge key={spec} variant="outline" className="text-[#eba865] border-[#eba865]/40 text-xs">
                    {spec}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <Button
            onClick={handlePlay}
            className="relative h-16 min-w-[9rem] shrink-0 overflow-hidden rounded-lg bg-[#eba865] px-6 text-base font-semibold text-black shadow-xl hover:bg-[#d4964f] gap-3"
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
                  <span className="text-[11px] font-medium text-black/65">{progressCopy}</span>
                )}
              </span>
            </span>
          </Button>
        </div>
      </div>

      <Dialog open={artworkDialogOpen} onOpenChange={(open) => { if (!open) closeArtworkPreview(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{previewLabel}</DialogTitle>
          </DialogHeader>
          <div className="mt-5 space-y-5">
            {artworkPreview ? (
              <div
                className={`${previewConfig.aspectClass} overflow-hidden rounded-lg border border-white/10 bg-black`}
              >
                <img
                  src={artworkPreview.url}
                  alt={artworkPreview.name}
                  className="h-full w-full object-cover transition-transform"
                  style={{
                    objectPosition: `${clampPercent(50 + artworkPreview.offsetX)}% ${clampPercent(50 + artworkPreview.offsetY)}%`,
                    transform: `scale(${artworkPreview.zoom})`,
                  }}
                />
              </div>
            ) : (
              <div
                className={`${previewConfig.aspectClass} grid place-items-center overflow-hidden rounded-lg border border-white/10 bg-black/40`}
              >
                <div className="px-6 text-center">
                  <p className="text-sm font-medium text-white">
                    {artworkPrepareState ? 'Preparing crop preview...' : 'Artwork preview unavailable'}
                  </p>
                  {artworkPrepareState && (
                    <p className="mt-1 max-w-md truncate text-xs text-[#a8a8a8]">{artworkPrepareState.name}</p>
                  )}
                </div>
              </div>
            )}
            {artworkPreview && (
              <>
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[#a8a8a8]">
                <span className="min-w-0 truncate">{artworkPreview.name}</span>
                <span>{artworkPreview.width} x {artworkPreview.height}</span>
              </div>
              <div className="grid gap-4 rounded-lg bg-white/[0.06] p-4">
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-wide text-white/65">
                  Zoom
                  <input
                    type="range"
                    min={1}
                    max={3}
                    step={0.01}
                    value={artworkPreview.zoom}
                    onChange={(event) => updateArtworkPreview({ zoom: Number(event.target.value) })}
                    className="w-full accent-[#eba865]"
                  />
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-wide text-white/65">
                    Horizontal
                    <input
                      type="range"
                      min={-50}
                      max={50}
                      step={1}
                      value={artworkPreview.offsetX}
                      onChange={(event) => updateArtworkPreview({ offsetX: Number(event.target.value) })}
                      className="w-full accent-[#eba865]"
                    />
                  </label>
                  <label className="grid gap-2 text-xs font-semibold uppercase tracking-wide text-white/65">
                    Vertical
                    <input
                      type="range"
                      min={-50}
                      max={50}
                      step={1}
                      value={artworkPreview.offsetY}
                      onChange={(event) => updateArtworkPreview({ offsetY: Number(event.target.value) })}
                      className="w-full accent-[#eba865]"
                    />
                  </label>
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => updateArtworkPreview({ zoom: 1, offsetX: 0, offsetY: 0 })}
                    className="h-8 px-3 text-xs text-white/70 hover:bg-white/10 hover:text-white"
                  >
                    Reset Crop
                  </Button>
                </div>
              </div>
              </>
            )}
            {artworkSaveError && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {artworkSaveError}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={closeArtworkPreview}
                disabled={isSavingArtwork}
                className="border-white/15 bg-transparent text-white hover:bg-white/10"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={applyArtworkPreview}
                disabled={!artworkPreview || isSavingArtwork}
                className="bg-[#eba865] text-black hover:bg-[#d4964f]"
              >
                {isSavingArtwork ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
                <div className="rounded-lg bg-[#232323] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Resolution</p>
                  <p className="text-white text-sm mt-1">{movie.localMetadata.width}x{movie.localMetadata.height}</p>
                </div>
              )}
              {movie.localMetadata.durationSeconds && (
                <div className="rounded-lg bg-[#232323] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Duration</p>
                  <p className="text-white text-sm mt-1">{formatDuration(movie.localMetadata.durationSeconds)}</p>
                </div>
              )}
              {movie.localMetadata.videoCodec && (
                <div className="rounded-lg bg-[#232323] p-3">
                  <p className="text-[#555] text-xs uppercase tracking-wide">Video</p>
                  <p className="text-white text-sm mt-1">{movie.localMetadata.videoCodec}</p>
                </div>
              )}
              {movie.localMetadata.audioCodec && (
                <div className="rounded-lg bg-[#232323] p-3">
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
                      <AvatarFallback className="bg-[#2d2d2d] text-white text-xs">
                        {actor.name.charAt(0)}
                      </AvatarFallback>
                    )}
                  </Avatar>
                  <p className="text-xs text-white truncate">{actor.name}</p>
                  <p className="text-xs text-[#a8a8a8] truncate">{actor.character}</p>
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
  const toggleSummary = () => setIsExpanded((expanded) => !expanded);

  return (
    <motion.div
      layout
      onClick={toggleSummary}
      className="group cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eba865]/70"
      whileTap={{ scale: 0.998 }}
    >
      <motion.div
        layout
        className="overflow-hidden"
        transition={{ type: 'spring', stiffness: 360, damping: 34, mass: 0.9 }}
      >
        <motion.p
          key={isExpanded ? 'expanded' : 'collapsed'}
          className={`text-[#a8a8a8] leading-relaxed ${isExpanded ? '' : 'line-clamp-3'}`}
          initial={{ opacity: 0.72, y: isExpanded ? -3 : 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        >
          {summary}
        </motion.p>
      </motion.div>
      <motion.button
        layout
        type="button"
        aria-expanded={isExpanded}
        onClick={(event) => {
          event.stopPropagation();
          toggleSummary();
        }}
        className="mt-2 text-sm font-medium text-[#eba865] transition-colors group-hover:text-[#f0bd86] hover:text-[#f0bd86]"
        whileTap={{ scale: 0.98 }}
      >
        {isExpanded ? 'Show Less' : 'Show More'}
      </motion.button>
    </motion.div>
  );
}
