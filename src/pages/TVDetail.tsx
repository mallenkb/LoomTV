import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle, Play, Star, ChevronRight, ChevronDown } from 'lucide-react';
import { motion } from 'motion/react';
import { useLibrary, TVShow, EpisodeMeta, EpisodeFile } from '@/contexts/LibraryContext';
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
import { cleanEpisodeTitleForDisplay, episodeCode } from '@/lib/episodeTitles';

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
    mediaId?: string,
    artwork?: Pick<RouteArtworkState, 'logo' | 'logoCandidates' | 'poster' | 'posterCandidates' | 'backdrop' | 'backdropCandidates'>,
  ) => void;
}

function epCode(season: number, episode: number): string {
  return episodeCode(season, episode);
}

function episodeTitleDisplay(title: string | undefined, seriesTitle: string, season: number, episode: number): string {
  return cleanEpisodeTitleForDisplay(title, seriesTitle, season, episode);
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

const CUSTOM_ARTWORK_KEY = 'loomtvCustomShowArtwork';

export default function TVDetail({ kind = 'series', onPlay }: TVDetailProps) {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { state, refreshLibrary } = useLibrary();
  const [show, setShow] = useState<TVShow | null>(null);
  const [expandedSeason, setExpandedSeason] = useState<number | null>(null);
  const [progressTick, setProgressTick] = useState(0);
  const [fallbackThumbnails, setFallbackThumbnails] = useState<string[]>([]);
  const [customArtwork, setCustomArtwork] = useState<CustomArtworkState>({});

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
    setCustomArtwork({});
    if (show?.id) {
      void loadCustomArtwork(show.id, CUSTOM_ARTWORK_KEY)
        .then((artwork) => setCustomArtwork(artwork as CustomArtworkState));
    }

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

  if (!show) {
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
    ?.find((episode) => Boolean(episode.still))?.still || '';
  const sourceArtwork = (location.state as { artwork?: RouteArtworkState } | null)?.artwork;
  const generatedArtwork = uniqueArtworkSources(firstEpisodeStill, fallbackThumbnails);
  const heroArtwork = uniqueArtworkSources(
    customArtwork.cover || '',
    sourceArtwork?.backdropCandidates,
    sourceArtwork?.backdrop,
    show.backdropCandidates,
    show.backdrop,
    generatedArtwork,
  );
  const posterArtwork = uniqueArtworkSources(
    customArtwork.thumbnail || customArtwork.poster || '',
    sourceArtwork?.posterCandidates,
    sourceArtwork?.poster,
    show.posterCandidates,
    show.poster,
    generatedArtwork,
  );
  const officialPosterArtwork = uniqueArtworkSources(
    show.posterCandidates,
    show.poster,
    sourceArtwork?.posterCandidates,
    sourceArtwork?.poster,
  );
  const officialCoverArtwork = uniqueArtworkSources(
    show.backdropCandidates,
    show.backdrop,
    sourceArtwork?.backdropCandidates,
    sourceArtwork?.backdrop,
  );
  const playerArtwork = {
    logo: logoSources(show, sourceArtwork)[0] || '',
    logoCandidates: logoSources(show, sourceArtwork),
    poster: posterArtwork[0] || show.poster,
    posterCandidates: posterArtwork,
    backdrop: heroArtwork[0] || show.backdrop,
    backdropCandidates: heroArtwork,
    rating: show.rating,
  };

  const handlePlayEpisode = (season: number, episode: number) => {
    const filePath = findEpisodeFile(season, episode);
    if (!filePath || !onPlay) return;
    onPlay(filePath, show.title, show.subtitles, playerEpisodes, show.episodeFiles, season, episode, show.id, playerArtwork);
  };

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
      show.id,
      playerArtwork,
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
      show.id,
      playerArtwork,
    );
  };

  const sourceRoute = (location.state as { from?: string } | null)?.from;
  const fallbackRoute = kind === 'anime' ? '/anime' : '/tv';
  const backTarget = sourceRoute && !sourceRoute.startsWith('/anime/') && !sourceRoute.startsWith('/tv/')
    ? sourceRoute
    : fallbackRoute;
  const handleBack = () => navigate(backTarget);

  return (
    <div className="loom-page h-full overflow-y-auto">
      <div className="mx-auto max-w-[1440px]">
      {/* Hero backdrop */}
      <div className="relative h-[45vh] w-full">
        <SafeArtwork
          src={heroArtwork}
          alt={show.title}
          className="h-full w-full"
          imgClassName="object-cover"
          loading="eager"
          fallback={<div className="h-full w-full" />}
        />
        <div className="loom-detail-hero-fade absolute inset-0" />
        <div className="loom-detail-side-fade-left pointer-events-none absolute inset-y-0 left-0 w-40" />
        <div className="loom-detail-side-fade-right pointer-events-none absolute inset-y-0 right-0 w-40" />
        <ArtworkEditorControls
          mediaId={show.id}
          legacyStorageKey={CUSTOM_ARTWORK_KEY}
          onCustomArtworkChange={setCustomArtwork}
          onSaved={refreshLibrary}
          officialThumbnailSources={officialPosterArtwork}
          officialCoverSources={officialCoverArtwork}
          fallbackFrameSource={generatedArtwork[0] || ''}
          onFetchOfficialArtwork={() => desktopApi.refreshOfficialArtwork(show.id)}
          onFetchOfficialArtworkCandidates={() => desktopApi.getOfficialMetadataCandidates(show.id)}
          onApplyOfficialArtworkCandidate={(candidate) => desktopApi.applyOfficialMetadata(show.id, candidate)}
        />
        <button
          type="button"
          onClick={handleBack}
          className="fixed left-[max(calc(12rem+1rem),calc(12rem+((100vw-12rem-1440px)/2)+1rem))] top-4 z-50 flex h-10 items-center gap-2 rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] px-3 text-sm text-white shadow-lg backdrop-blur-md transition-colors hover:border-[var(--loom-accent)]/45 hover:text-[var(--loom-accent)]"
        >
          <ChevronRight className="w-5 h-5 rotate-180" />
          Back
        </button>

        <div className="absolute bottom-0 left-0 right-0 z-30 flex items-end gap-6 p-8">
          <SafeArtwork
            src={posterArtwork}
            alt={show.title}
            className="loom-poster-frame hidden aspect-[2/3] w-28 shrink-0 rounded-lg shadow-xl md:block"
            imgClassName="object-cover"
            loading="eager"
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
            <div className="flex flex-wrap items-center gap-4 text-[var(--loom-muted)] text-sm mb-3">
              <span className="loom-rating flex items-center gap-1">
                <Star className="w-4 h-4" fill="currentColor" />
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
              className="relative h-16 shrink-0 overflow-hidden rounded-lg bg-[var(--loom-accent)] px-6 text-base font-semibold text-[var(--loom-accent-foreground)] shadow-[0_16px_38px_rgba(0,0,0,0.38),0_0_0_1px_rgba(251,197,0,0.26)] hover:bg-[var(--loom-accent-hover)] gap-3"
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
                  <span className="text-[11px] font-medium text-[var(--loom-accent-foreground-muted)]">
                    {heroIsResume && heroProgressCopy ? `${heroEpisodeLabel} · ${heroProgressCopy}` : heroEpisodeLabel}
                  </span>
                </span>
              </span>
            </Button>
          )}
        </div>
      </div>

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
            <p className="text-[var(--loom-muted)]">No season information available. Try scanning the library.</p>
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
                  <div key={season.number} className="overflow-hidden rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)]">
                    {/* Season header - click anywhere to expand/collapse */}
                    <div 
                      onClick={() => setExpandedSeason(isExpanded ? null : season.number)}
                      className="flex cursor-pointer items-center justify-between bg-[var(--loom-panel)] p-4 transition-colors hover:bg-[var(--loom-surface-3)]"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-white">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-[var(--loom-muted)]" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-[var(--loom-muted)]" />
                          )}
                        </span>
                        <span className="font-medium text-white">{season.title}</span>
                        <span className="text-[var(--loom-muted)] text-sm">
                          {seasonEps.length > 0 ? `${seasonEps.length} episodes` : `${season.episodeCount || fileCount} episodes`}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        {hasFiles && (
                          <Button
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); handlePlaySeason(season.number); }}
                            className="relative h-7 overflow-hidden rounded-lg bg-[var(--loom-accent)] px-3 text-xs text-[var(--loom-accent-foreground)] hover:bg-[var(--loom-accent-hover)] gap-1"
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
                      <div className="divide-y divide-[var(--loom-panel-border)] bg-[var(--loom-surface-2)]">
                        {seasonEps.length > 0 ? (
                          seasonEps.map((ep) => {
                            const filePath = findEpisodeFile(season.number, ep.number);
                            return (
                              <EpisodeRow
                                key={ep.number}
                                ep={ep}
                                seriesTitle={show.title}
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
                                seriesTitle={show.title}
                                filePath={ef.filePath}
                                seasonNum={season.number}
                                progressTick={progressTick}
                                durationHint={ef.localMetadata?.durationSeconds}
                                onPlay={() => onPlay && onPlay(ef.filePath, show.title, show.subtitles, playerEpisodes, show.episodeFiles, season.number, ef.episode, show.id, playerArtwork)}
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

function EpisodeRow({
  ep,
  seriesTitle,
  filePath,
  onPlay,
  seasonNum = 1,
  durationHint = 0,
  progressTick,
}: {
  ep: EpisodeMeta;
  seriesTitle: string;
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
  const displayTitle = episodeTitleDisplay(ep.title, seriesTitle, seasonNum, ep.number);
  const episodeRating = Number.isFinite(ep.rating) && ep.rating > 0 ? ep.rating : 0;
  const progress = getProgressState(filePath, durationHint);
  void progressTick;

  return (
    <div className="relative flex cursor-pointer items-center gap-4 p-4 transition-colors group hover:bg-white/5" onClick={onPlay}>
      {(progress.inProgress || progress.watched) && progress.fraction > 0 && (
        <span
          className={`pointer-events-none absolute bottom-0 left-0 h-0.5 ${progress.watched ? 'bg-green-500' : 'bg-[var(--loom-accent)]'}`}
          style={{ width: `${Math.min(100, progress.fraction * 100)}%` }}
        />
      )}
      {/* Thumbnail */}
      <div className="shrink-0 w-28 h-16 rounded overflow-hidden bg-[var(--loom-surface-3)] relative">
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
          <button onClick={handlePlay} className="w-8 h-8 rounded-full bg-[var(--loom-accent)] flex items-center justify-center">
            <Play className="w-4 h-4 text-[var(--loom-accent-foreground)]" />
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <p className="text-sm font-medium text-white">{epLabel} - {displayTitle}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {ep.airDate && <p className="text-[#555] text-xs">{ep.airDate}</p>}
          {episodeRating > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#f5c451]/15 px-2 py-0.5 text-[11px] font-semibold text-[#f5c451]">
              <Star className="h-3 w-3 fill-current" />
              {episodeRating.toFixed(1)}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {progress.inProgress && <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--loom-accent)]">resume</span>}
        {progress.watched && <CheckCircle className="h-4 w-4 text-green-500" />}
      </div>
    </div>
  );
}
