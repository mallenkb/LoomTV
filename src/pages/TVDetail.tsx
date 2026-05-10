import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle, Play, Star, ChevronRight, ChevronDown, Image, MoreHorizontal } from 'lucide-react';
import { motion } from 'motion/react';
import { useLibrary, TVShow, EpisodeMeta, EpisodeFile } from '@/contexts/LibraryContext';
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

interface TVDetailProps {
  kind?: 'series' | 'anime';
  onPlay?: (
    filePath: string,
    title: string,
    subtitles?: TVShow['subtitles'],
    episodes?: EpisodeMeta[],
    episodeFiles?: EpisodeFile[],
    currentSeason?: number,
    currentEpisode?: number,
  ) => void;
}

function epCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
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

type ArtworkTarget = 'cover' | 'thumbnail';
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
const CUSTOM_ARTWORK_KEY = 'loomtvCustomShowArtwork';
const ARTWORK_TARGETS: Record<ArtworkTarget, { label: string; aspectClass: string; outputWidth: number; outputHeight: number }> = {
  cover: {
    label: 'Cover photo',
    aspectClass: 'aspect-[16/6] w-full',
    outputWidth: 1600,
    outputHeight: 600,
  },
  thumbnail: {
    label: 'Thumbnail',
    aspectClass: 'mx-auto aspect-[2/3] w-56',
    outputWidth: 800,
    outputHeight: 1200,
  },
};

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

export default function TVDetail({ kind = 'series', onPlay }: TVDetailProps) {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { state, refreshLibrary } = useLibrary();
  const [show, setShow] = useState<TVShow | null>(null);
  const [expandedSeason, setExpandedSeason] = useState<number | null>(null);
  const [progressTick, setProgressTick] = useState(0);
  const [fallbackThumbnails, setFallbackThumbnails] = useState<string[]>([]);
  const [artworkMenuOpen, setArtworkMenuOpen] = useState(false);
  const [customArtwork, setCustomArtwork] = useState<Partial<Record<ArtworkTarget, string>>>({});
  const [artworkPreview, setArtworkPreview] = useState<ArtworkPreview | null>(null);
  const [isSavingArtwork, setIsSavingArtwork] = useState(false);
  const [artworkSaveError, setArtworkSaveError] = useState('');
  const artworkMenuRef = useRef<HTMLDivElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const thumbnailInputRef = useRef<HTMLInputElement | null>(null);
  const createdArtworkUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    const collection = kind === 'anime' ? state.animeShows : state.tvShows;
    const found = collection.find((s) => s.id === id);
    setShow(found || null);
    if (found) {
      const firstVisibleSeason = (found.seasons || []).find((season) =>
        (found.episodeFiles?.some((ef) => ef.season === season.number) || false)
        || (found.episodes?.some((ep) => ep.season === season.number) || false),
      );
      setExpandedSeason(firstVisibleSeason?.number ?? null);
    }
  }, [id, kind, state.animeShows, state.tvShows]);

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
    setFallbackThumbnails([]);
    setArtworkMenuOpen(false);
    setCustomArtwork({});
    if (show?.id) {
      void loadCustomArtwork(show.id, CUSTOM_ARTWORK_KEY)
        .then((artwork) => setCustomArtwork(artwork as Partial<Record<ArtworkTarget, string>>));
    }
    setArtworkPreview(null);
    setArtworkSaveError('');
    setIsSavingArtwork(false);
    createdArtworkUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    createdArtworkUrlsRef.current = [];

    const episodeFiles = show?.episodeFiles
      ?.slice()
      .sort((a, b) => a.season - b.season || a.episode - b.episode) || [];
    const thumbnailEpisode = episodeFiles.find((file) =>
      getProgressState(file.filePath, file.localMetadata?.durationSeconds).inProgress,
    ) || episodeFiles[0];
    if (!thumbnailEpisode?.filePath) return;

    let cancelled = false;
    const progress = getProgressState(thumbnailEpisode.filePath, thumbnailEpisode.localMetadata?.durationSeconds);
    const times = Array.from(new Set([
      progress.position > 10 ? formatThumbnailTime(progress.position, progress.duration) : '',
      '00:03:00',
      '00:01:00',
      '00:00:10',
    ].filter(Boolean)));

    void Promise.all(times.map((time) =>
      desktopApi.getThumbnail(thumbnailEpisode.filePath, time)
        .then(({ url }) => url)
        .catch(() => ''),
    )).then((urls) => {
      if (!cancelled) setFallbackThumbnails(urls.filter(Boolean));
    });

    return () => {
      cancelled = true;
    };
  }, [show?.id, show?.episodeFiles]);

  useEffect(() => {
    return () => {
      createdArtworkUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
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
    setArtworkMenuOpen(false);
    const input = target === 'cover' ? coverInputRef.current : thumbnailInputRef.current;
    input?.click();
  };

  const handleArtworkFileChange = (target: ArtworkTarget, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;

    const url = URL.createObjectURL(file);
    createdArtworkUrlsRef.current.push(url);
    const image = new window.Image();
    image.onload = () => {
      setArtworkPreview({
        target,
        url,
        name: file.name,
        width: image.naturalWidth,
        height: image.naturalHeight,
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      createdArtworkUrlsRef.current = createdArtworkUrlsRef.current.filter((createdUrl) => createdUrl !== url);
    };
    image.src = url;
  };

  const closeArtworkPreview = () => {
    if (artworkPreview?.url) {
      URL.revokeObjectURL(artworkPreview.url);
      createdArtworkUrlsRef.current = createdArtworkUrlsRef.current.filter((url) => url !== artworkPreview.url);
    }
    setArtworkPreview(null);
    setArtworkSaveError('');
    setIsSavingArtwork(false);
  };

  const updateArtworkPreview = (updates: Partial<Pick<ArtworkPreview, 'zoom' | 'offsetX' | 'offsetY'>>) => {
    setArtworkPreview((current) => current ? { ...current, ...updates } : current);
  };

  const applyArtworkPreview = async () => {
    if (!artworkPreview || !show?.id) return;
    setIsSavingArtwork(true);
    setArtworkSaveError('');
    try {
      const { target } = artworkPreview;
      const croppedArtwork = await cropArtworkToDataUrl(artworkPreview);
      await saveCustomArtwork(show.id, target, croppedArtwork, CUSTOM_ARTWORK_KEY);
      setCustomArtwork((current) => ({ ...current, [target]: croppedArtwork }));
      void refreshLibrary();
      closeArtworkPreview();
    } catch (error) {
      setArtworkSaveError(error instanceof Error ? error.message : 'Unable to save artwork.');
      setIsSavingArtwork(false);
    }
  };

  if (!show) {
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

  const episodesForSeason = (seasonNum: number): EpisodeMeta[] =>
    (show.episodes || [])
      .filter((e) => e.season === seasonNum)
      .sort((a, b) => a.number - b.number);

  const findEpisodeFile = (season: number, episode: number): string | null =>
    show.episodeFiles?.find((ef) => ef.season === season && ef.episode === episode)?.filePath || null;

  const cleanEpisodeTitle = (filePath: string, season: number, episode: number): string => {
    const name = filePath.split(/[\\/]/).pop() || `Episode ${episode}`;
    return name
      .replace(/\.[^.]+$/, '')
      .replace(new RegExp(`[Ss]0*${season}[._ -]*[Ee]0*${episode}`, 'i'), '')
      .replace(new RegExp(`^(episode|ep|e)?\\s*0*${episode}\\b`, 'i'), '')
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `Episode ${episode}`;
  };

  const episodesWithFilesForSeason = (seasonNum: number): EpisodeMeta[] => {
    const byNumber = new Map<number, EpisodeMeta>();

    episodesForSeason(seasonNum).forEach((ep) => byNumber.set(ep.number, ep));

    (show.episodeFiles || [])
      .filter((file) => file.season === seasonNum)
      .forEach((file) => {
        const existing = byNumber.get(file.episode);
        if (!existing) {
          byNumber.set(file.episode, {
            season: seasonNum,
            number: file.episode,
            title: cleanEpisodeTitle(file.filePath, seasonNum, file.episode),
            summary: '',
            still: '',
            rating: 0,
            airDate: '',
          });
        } else if (!existing.title) {
          byNumber.set(file.episode, {
            ...existing,
            title: cleanEpisodeTitle(file.filePath, seasonNum, file.episode),
          });
        }
      });

    return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
  };

  const visibleSeasons = (show.seasons || []).filter((season) => {
    const localFileCount = show.episodeFiles?.filter((ef) => ef.season === season.number).length || 0;
    const mergedEpisodeCount = episodesWithFilesForSeason(season.number).length;
    return localFileCount > 0 || mergedEpisodeCount > 0;
  });

  const playerEpisodes = visibleSeasons.flatMap((season) => episodesWithFilesForSeason(season.number));

  const handlePlayEpisode = (season: number, episode: number) => {
    const filePath = findEpisodeFile(season, episode);
    if (!filePath) return;
    if (onPlay) {
      onPlay(filePath, show.title, show.subtitles, playerEpisodes, show.episodeFiles, season, episode);
    }
  };

  const firstPlayableEpisode = show.episodeFiles
    ?.slice()
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .find((file) => Boolean(file.filePath));

  const resumeEpisode = show.episodeFiles
    ?.slice()
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .find((file) => getProgressState(file.filePath, file.localMetadata?.durationSeconds).inProgress);

  const nextEpisode = show.episodeFiles
    ?.slice()
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .find((file) => !getProgressState(file.filePath, file.localMetadata?.durationSeconds).watched);

  const heroEpisode = resumeEpisode || nextEpisode || firstPlayableEpisode || null;
  const heroIsResume = Boolean(resumeEpisode);
  const heroProgress = heroEpisode
    ? getProgressState(heroEpisode.filePath, heroEpisode.localMetadata?.durationSeconds)
    : { position: 0, duration: 0, fraction: 0, watched: false, inProgress: false };
  const heroProgressPercent = Math.min(100, Math.max(0, heroProgress.fraction * 100));
  const heroEpisodeLabel = heroEpisode ? epCode(heroEpisode.season, heroEpisode.episode) : '';
  const heroProgressCopy = heroProgress.duration > 0
    ? `${formatShortMinutes(heroProgress.position)} of ${formatShortMinutes(heroProgress.duration)}`
    : '';
  const firstEpisodeStill = show.episodes
    ?.flatMap((season) => season.episodes || [])
    .find((episode) => Boolean(episode.still))?.still || '';
  const sourceArtwork = (location.state as { artwork?: RouteArtworkState } | null)?.artwork;
  const generatedArtwork = uniqueArtworkSources(firstEpisodeStill, fallbackThumbnails);
  const heroArtwork = uniqueArtworkSources(
    customArtwork.cover || '',
    backdropSources(show, sourceArtwork, generatedArtwork),
  );
  const posterArtwork = uniqueArtworkSources(
    customArtwork.thumbnail || '',
    posterSources(show, sourceArtwork, generatedArtwork),
  );
  const previewConfig = artworkPreview ? ARTWORK_TARGETS[artworkPreview.target] : null;
  const previewLabel = previewConfig?.label || 'Artwork';

  const handlePlayShow = () => {
    if (!heroEpisode || !onPlay) return;
    onPlay(
      heroEpisode.filePath,
      show.title,
      show.subtitles,
      playerEpisodes,
      show.episodeFiles,
      heroEpisode.season,
      heroEpisode.episode,
    );
  };

  const sortedEpisodeFilesForSeason = (seasonNum: number) => (show.episodeFiles || [])
    .filter((file) => file.season === seasonNum && Boolean(file.filePath))
    .sort((a, b) => a.episode - b.episode);

  const getSeasonPlaybackEpisode = (seasonNum: number) => {
    const seasonFiles = sortedEpisodeFilesForSeason(seasonNum);
    return seasonFiles.find((file) =>
      getProgressState(file.filePath, file.localMetadata?.durationSeconds).inProgress,
    )
      || seasonFiles.find((file) =>
        !getProgressState(file.filePath, file.localMetadata?.durationSeconds).watched,
      )
      || seasonFiles[0]
      || null;
  };

  const handlePlaySeason = (seasonNum: number) => {
    const targetEpisode = getSeasonPlaybackEpisode(seasonNum);
    if (!targetEpisode || !onPlay) return;
    onPlay(
      targetEpisode.filePath,
      show.title,
      show.subtitles,
      playerEpisodes,
      show.episodeFiles,
      seasonNum,
      targetEpisode.episode,
    );
  };

  const sourceRoute = (location.state as { from?: string } | null)?.from;
  const fallbackRoute = kind === 'anime' ? '/anime' : '/tv';
  const backTarget = sourceRoute && !sourceRoute.startsWith('/anime/') && !sourceRoute.startsWith('/tv/')
    ? sourceRoute
    : fallbackRoute;
  const handleBack = () => navigate(backTarget);

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a]">
      <div className="mx-auto max-w-[1440px]">
      {/* Hero backdrop */}
      <div className="relative h-[45vh] w-full">
        <SafeArtwork
          src={heroArtwork}
          alt={show.title}
          className="h-full w-full"
          imgClassName="object-cover"
          fallback={<div className="h-full w-full" />}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#1a1a1a] via-[#1a1a1a]/40 to-transparent" />
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
                onClick={() => openArtworkPicker('cover')}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 hover:text-[#eba865]"
              >
                <Image className="h-4 w-4" />
                Edit cover photo
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => openArtworkPicker('thumbnail')}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 hover:text-[#eba865]"
              >
                <Image className="h-4 w-4" />
                Edit thumbnail
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
            ref={thumbnailInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => handleArtworkFileChange('thumbnail', event)}
          />
        </div>
        <button
          type="button"
          onClick={handleBack}
          className="fixed left-[max(calc(12rem+1rem),calc(12rem+((100vw-12rem-1440px)/2)+1rem))] top-4 z-50 flex h-9 items-center gap-1 rounded-lg border border-white/20 bg-black/55 px-3 text-sm text-white shadow-lg backdrop-blur-md transition-colors hover:text-[#eba865]"
        >
          <ChevronRight className="w-5 h-5 rotate-180" />
          Back
        </button>

        <div className="absolute bottom-0 left-0 right-0 p-8 flex gap-6 items-end">
          <SafeArtwork
            src={posterArtwork}
            alt={show.title}
            className="hidden aspect-[2/3] w-28 shrink-0 rounded-lg border border-white/10 shadow-xl md:block"
            imgClassName="object-cover"
            fallback={
              <div className="flex h-full w-full items-center justify-center p-2">
                <span className="line-clamp-4 text-center text-[10px] font-medium leading-tight text-white/60">
                  {show.title}
                </span>
              </div>
            }
          />
          <div className="flex-1 min-w-0">
            <h1 className="text-4xl font-bold text-white mb-2">{show.title}</h1>
            <div className="flex flex-wrap items-center gap-4 text-[#a8a8a8] text-sm mb-3">
              <span className="flex items-center gap-1">
                <Star className="w-4 h-4 text-[#eba865]" fill="currentColor" />
                {show.rating ? show.rating.toFixed(1) : 'N/A'}
              </span>
              {show.year > 0 && <span>{show.year}</span>}
              {visibleSeasons.length > 0 && (
                <span>{visibleSeasons.length} {visibleSeasons.length === 1 ? 'Season' : 'Seasons'}</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {show.genres.map((genre) => (
                <Badge key={genre} variant="outline" className="text-white border-white/30 text-xs">
                  {genre}
                </Badge>
              ))}
            </div>
          </div>
          {heroEpisode && (
            <Button
              onClick={handlePlayShow}
              className="relative h-16 shrink-0 overflow-hidden rounded-lg bg-[#eba865] px-6 text-base font-semibold text-black shadow-xl hover:bg-[#d4964f] gap-3"
            >
              {heroProgressPercent > 0 && (
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 bg-black/20"
                  style={{ width: `${heroProgressPercent}%` }}
                />
              )}
              <span className="relative z-10 flex items-center gap-3">
                <Play className="h-7 w-7" />
                <span className="flex min-w-28 flex-col items-start leading-tight">
                  <span>{heroIsResume ? 'Resume' : 'Play'}</span>
                  <span className="text-[11px] font-medium text-black/65">
                    {heroIsResume && heroProgressCopy ? `${heroEpisodeLabel} · ${heroProgressCopy}` : heroEpisodeLabel}
                  </span>
                </span>
              </span>
            </Button>
          )}
        </div>
      </div>

      <Dialog open={Boolean(artworkPreview)} onOpenChange={(open) => { if (!open) closeArtworkPreview(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{previewLabel}</DialogTitle>
          </DialogHeader>
          {artworkPreview && (
            <div className="mt-5 space-y-5">
              <div
                className={`${previewConfig?.aspectClass || ''} overflow-hidden rounded-lg border border-white/10 bg-black`}
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
                  disabled={isSavingArtwork}
                  className="bg-[#eba865] text-black hover:bg-[#d4964f]"
                >
                  {isSavingArtwork ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <div className="page-bottom-safe-lg p-8">
        {show.summary && (
          <section className="mb-8">
            <h3 className="text-lg font-semibold text-white mb-3">Summary</h3>
            <ExpandableSummary summary={show.summary} />
          </section>
        )}

        {/* Seasons & Episodes */}
        <section className="mb-8">
          <h3 className="text-lg font-semibold text-white mb-3">Seasons & Episodes</h3>
          {visibleSeasons.length === 0 ? (
            <p className="text-[#a8a8a8]">No season information available. Try scanning the library.</p>
          ) : (
            <div className="space-y-2">
              {visibleSeasons.map((season) => {
                const seasonEps = episodesWithFilesForSeason(season.number);
                const fileCount = show.episodeFiles?.filter((ef) => ef.season === season.number).length || 0;
                const hasFiles = fileCount > 0;
                const isExpanded = expandedSeason === season.number;
                const seasonPlaybackEpisode = getSeasonPlaybackEpisode(season.number);
                const seasonProgress = seasonPlaybackEpisode
                  ? getProgressState(seasonPlaybackEpisode.filePath, seasonPlaybackEpisode.localMetadata?.durationSeconds)
                  : null;
                const seasonIsResume = Boolean(seasonProgress?.inProgress);
                const seasonProgressPercent = seasonProgress
                  ? Math.min(100, Math.max(0, seasonProgress.fraction * 100))
                  : 0;

                return (
                  <div key={season.number} className="rounded-lg overflow-hidden border border-white/5">
                    {/* Season header - click anywhere to expand/collapse */}
                    <div 
                      onClick={() => setExpandedSeason(isExpanded ? null : season.number)}
                      className="flex items-center justify-between p-4 bg-[#232323] cursor-pointer hover:bg-[#2a2a2a] transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-white">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-[#a8a8a8]" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-[#a8a8a8]" />
                          )}
                        </span>
                        <span className="font-medium text-white">{season.title}</span>
                        <span className="text-[#a8a8a8] text-sm">
                          {seasonEps.length > 0 ? `${seasonEps.length} episodes` : `${season.episodeCount || fileCount} episodes`}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        {hasFiles && (
                          <Button
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); handlePlaySeason(season.number); }}
                            className="relative h-7 overflow-hidden rounded-lg bg-[#eba865] px-3 text-xs text-black hover:bg-[#d4964f] gap-1"
                          >
                            {seasonIsResume && seasonProgressPercent > 0 && (
                              <span
                                className="pointer-events-none absolute inset-y-0 left-0 bg-black/20"
                                style={{ width: `${seasonProgressPercent}%` }}
                              />
                            )}
                            <span className="relative z-10 flex items-center gap-1">
                              <Play className="w-3 h-3" />
                              {seasonIsResume ? 'Resume' : 'Play'}
                            </span>
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Episode list */}
                    {isExpanded && (
                      <div className="bg-[#1e1e1e] divide-y divide-white/5">
                        {seasonEps.length > 0 ? (
                          seasonEps.map((ep) => {
                            const filePath = findEpisodeFile(season.number, ep.number);
                            return (
                              <EpisodeRow
                                key={ep.number}
                                ep={ep}
                                filePath={filePath}
                                seasonNum={season.number}
                                progressTick={progressTick}
                                durationHint={show.episodeFiles?.find((ef) => ef.season === season.number && ef.episode === ep.number)?.localMetadata?.durationSeconds}
                                onPlay={() => handlePlayEpisode(season.number, ep.number)}
                              />
                            );
                          })
                        ) : (
                          // No TVmaze episode data — show episode files directly
                          show.episodeFiles
                            ?.filter((ef) => ef.season === season.number)
                            .sort((a, b) => a.episode - b.episode)
                            .map((ef) => (
                              <EpisodeRow
                                key={ef.episode}
                                ep={{
                                  season: season.number,
                                  number: ef.episode,
                                  title: cleanEpisodeTitle(ef.filePath, season.number, ef.episode),
                                  summary: '',
                                  still: '',
                                  rating: 0,
                                  airDate: '',
                                }}
                                filePath={ef.filePath}
                                seasonNum={season.number}
                                progressTick={progressTick}
                                durationHint={ef.localMetadata?.durationSeconds}
                                onPlay={() => onPlay && onPlay(ef.filePath, show.title, show.subtitles, playerEpisodes, show.episodeFiles, season.number, ef.episode)}
                              />
                            ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Cast */}
        {show.cast.length > 0 && (
          <section>
            <h3 className="text-lg font-semibold text-white mb-3">Cast</h3>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {show.cast.slice(0, 8).map((actor) => (
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

function EpisodeRow({
  ep,
  filePath,
  onPlay,
  seasonNum = 1,
  durationHint = 0,
  progressTick,
}: {
  ep: EpisodeMeta;
  filePath: string | null;
  onPlay: () => void;
  seasonNum?: number;
  durationHint?: number;
  progressTick: number;
}) {
  const [imgError, setImgError] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImgError(false);
    setThumbnailUrl(null);

    if (!filePath) return () => {
      cancelled = true;
    };

    void desktopApi.getThumbnail(filePath, '00:03:00')
      .then(({ url }) => {
        if (!cancelled) setThumbnailUrl(url);
      })
      .catch(() => {
        if (!cancelled) setThumbnailUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    onPlay();
  };

  const epLabel = `S${String(seasonNum).padStart(2, '0')}E${String(ep.number).padStart(2, '0')}`;
  const progress = getProgressState(filePath, durationHint);
  void progressTick;

  return (
    <div className={`relative flex items-start gap-4 p-4 transition-colors group cursor-pointer ${progress.watched ? 'opacity-55' : 'hover:bg-white/5'}`} onClick={onPlay}>
      {(progress.inProgress || progress.watched) && progress.fraction > 0 && (
        <span
          className={`pointer-events-none absolute bottom-0 left-0 h-0.5 ${progress.watched ? 'bg-green-500' : 'bg-[#eba865]'}`}
          style={{ width: `${Math.min(100, progress.fraction * 100)}%` }}
        />
      )}
      {/* Thumbnail */}
      <div className="shrink-0 w-28 h-16 rounded overflow-hidden bg-[#2d2d2d] relative">
        {(thumbnailUrl || ep.still) && !imgError ? (
          <img
            src={thumbnailUrl || ep.still}
            alt={ep.title || epLabel}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-[#555] text-xs font-mono">{epLabel}</span>
          </div>
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100">
          <button onClick={handlePlay} className="w-8 h-8 rounded-full bg-[#eba865] flex items-center justify-center">
            <Play className="w-4 h-4 text-black" />
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${progress.watched ? 'text-[#777]' : 'text-white'}`}>{epLabel} - {ep.title || `Episode ${ep.number}`}</p>
        {ep.airDate && <p className="text-[#555] text-xs">{ep.airDate}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {progress.inProgress && <span className="text-[10px] font-medium uppercase tracking-wide text-[#eba865]">resume</span>}
        {progress.watched && <CheckCircle className="h-4 w-4 text-green-500" />}
      </div>
    </div>
  );
}
