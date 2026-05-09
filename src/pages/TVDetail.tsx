import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Play, Star, ChevronRight, ChevronDown, Calendar, Image } from 'lucide-react';
import { useLibrary, TVShow, EpisodeMeta, EpisodeFile, LocalMediaDetails } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { desktopApi } from '@/lib/desktopApi';

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

function formatEpisodeDuration(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

function formatEpisodeSpecs(metadata?: LocalMediaDetails): string[] {
  if (!metadata) return [];
  const specs: string[] = [];
  if (metadata.width && metadata.height) specs.push(`${metadata.width}x${metadata.height}`);
  if (metadata.videoCodec) specs.push(metadata.videoCodec.toUpperCase());
  if (metadata.audioCodec) specs.push(metadata.audioCodec.toUpperCase());
  const duration = formatEpisodeDuration(metadata.durationSeconds);
  if (duration) specs.push(duration);
  return specs;
}

export default function TVDetail({ kind = 'series', onPlay }: TVDetailProps) {
  const { id } = useParams<{ id: string }>();
  const { state } = useLibrary();
  const [show, setShow] = useState<TVShow | null>(null);
  const [expandedSeason, setExpandedSeason] = useState<number | null>(null);

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

  if (!show) {
    return (
      <div className="h-full overflow-y-auto bg-[#1a1a1a] p-6">
        <Skeleton className="h-[400px] w-full rounded-lg" />
        <div className="mt-4 space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-full" />
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

  const handlePlaySeason = (seasonNum: number) => {
    const seasonEps = episodesForSeason(seasonNum);
    // Play the first available episode of the season
    for (const ep of seasonEps) {
      const filePath = findEpisodeFile(seasonNum, ep.number);
      if (filePath && onPlay) {
        onPlay(filePath, show.title, show.subtitles, playerEpisodes, show.episodeFiles, seasonNum, ep.number);
        return;
      }
    }
    const firstLocalEpisode = show.episodeFiles
      ?.filter((ef) => ef.season === seasonNum)
      .sort((a, b) => a.episode - b.episode)[0];
    if (firstLocalEpisode && onPlay) {
      onPlay(
        firstLocalEpisode.filePath,
        show.title,
        show.subtitles,
        playerEpisodes,
        show.episodeFiles,
        seasonNum,
        firstLocalEpisode.episode,
      );
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a]">
      {/* Hero backdrop */}
      <div className="relative h-[45vh] w-full">
        {(show.backdrop || show.poster) ? (
          <img
            src={show.backdrop || show.poster}
            alt={show.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-[#232323]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#1a1a1a] via-[#1a1a1a]/40 to-transparent" />
        <Link to={kind === 'anime' ? '/anime' : '/tv'} className="absolute top-4 left-4 flex items-center gap-1 text-white hover:text-[#eba865] transition-colors">
          <ChevronRight className="w-5 h-5 rotate-180" />
          Back
        </Link>

        <div className="absolute bottom-0 left-0 right-0 p-8 flex gap-6 items-end">
          {show.poster && (
            <img
              src={show.poster}
              alt={show.title}
              className="hidden md:block w-28 rounded-lg shadow-xl shrink-0 border border-white/10"
            />
          )}
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
        </div>
      </div>

      <div className="p-8">
        {show.summary && (
          <section className="mb-8">
            <h3 className="text-lg font-semibold text-white mb-3">Summary</h3>
            <p className="text-[#a8a8a8] leading-relaxed">{show.summary}</p>
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
                            className="bg-[#eba865] text-black hover:bg-[#d4964f] gap-1 h-7 px-3 text-xs"
                          >
                            <Play className="w-3 h-3" />
                            Play
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
  );
}

function EpisodeRow({ ep, filePath, onPlay, seasonNum = 1 }: { ep: EpisodeMeta; filePath: string | null; onPlay: () => void; seasonNum?: number }) {
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

  return (
    <div className="flex items-start gap-4 p-4 hover:bg-white/5 transition-colors group cursor-pointer" onClick={onPlay}>
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
        <p className="text-white text-sm font-medium">{epLabel} - {ep.title || `Episode ${ep.number}`}</p>
        {ep.airDate && <p className="text-[#555] text-xs">{ep.airDate}</p>}
      </div>
    </div>
  );
}
