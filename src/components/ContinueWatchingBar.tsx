import { useEffect, useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import { useLibrary, EpisodeFile, EpisodeMeta, MediaItem, TVShow } from '@/contexts/LibraryContext';
import { desktopApi } from '@/lib/desktopApi';
import type { StoredProgress } from '@/lib/desktopApi';
import { hydrateProgressFromDatabase, loadProgress } from '@/lib/progress';
import {
  cleanEpisodeTitleForDisplay,
  episodeCode as formatEpisodeCode,
  looksLikeGenericEpisodeTitle,
} from '@/lib/episodeTitles';
import { logoSources, uniqueArtworkSources } from '@/lib/artwork';

const WATCHED_THRESHOLD = 0.9;

type ContinueCandidate = {
  key: string;
  filePath: string;
  title: string;
  subtitle: string;
  position: number;
  duration: number;
  fraction: number;
  updatedAt: number;
  onPlayArgs: [
    filePath: string,
    title: string,
    subtitles?: MediaItem['subtitles'],
    episodes?: EpisodeMeta[],
    episodeFiles?: EpisodeFile[],
    currentSeason?: number,
    currentEpisode?: number,
    mediaId?: string,
    artwork?: {
      logo?: string;
      logoCandidates?: string[];
      poster?: string;
      posterCandidates?: string[];
      backdrop?: string;
      backdropCandidates?: string[];
    },
  ];
};

interface ContinueWatchingBarProps {
  isHidden?: boolean;
  onPlay: (
    filePath: string,
    title: string,
    subtitles?: MediaItem['subtitles'],
    episodes?: EpisodeMeta[],
    episodeFiles?: EpisodeFile[],
    currentSeason?: number,
    currentEpisode?: number,
    mediaId?: string,
    artwork?: ContinueCandidate['onPlayArgs'][8],
  ) => void;
}

function progressDetails(filePath: string, durationHint = 0, progress: Record<string, StoredProgress>) {
  const stored = progress[filePath];
  const position = stored?.position ?? 0;
  const storedDuration = stored?.duration ?? 0;
  const duration = durationHint > 0 ? durationHint : storedDuration;
  const fraction = position > 0 && duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const updatedAt = stored?.updatedAt || 0;
  return {
    position,
    duration,
    fraction,
    updatedAt,
    inProgress: position > 10 && duration > 0 && fraction < WATCHED_THRESHOLD,
  };
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatThumbnailTime(position: number, duration: number): string {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const upperBound = safeDuration > 10 ? safeDuration - 5 : safeDuration;
  const safePosition = Number.isFinite(position) && position > 0 ? position : 180;
  const seconds = Math.floor(Math.max(1, upperBound > 0 ? Math.min(safePosition, upperBound) : safePosition));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function episodeCode(season: number, episode: number): string {
  return formatEpisodeCode(season, episode);
}

function cleanEpisodeTitle(filePath: string, season: number, episode: number): string {
  const name = filePath.split(/[\\/]/).pop() || `Episode ${episode}`;
  return name
    .replace(/\.[^.]+$/, '')
    .replace(new RegExp(`[Ss]0*${season}[._ -]*[Ee]0*${episode}`, 'i'), '')
    .replace(new RegExp(`^(episode|ep|e)?\\s*0*${episode}\\b`, 'i'), '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || `Episode ${episode}`;
}

function playerEpisodesFor(show: TVShow): EpisodeMeta[] {
  const byKey = new Map<string, EpisodeMeta>();

  (show.episodes || []).forEach((episode) => {
    byKey.set(`${episode.season}:${episode.number}`, episode);
  });

  (show.episodeFiles || []).forEach((file) => {
    const key = `${file.season}:${file.episode}`;
    if (byKey.has(key)) return;
    const fileTitle = !looksLikeGenericEpisodeTitle(file.title, show.title, file.episode) ? file.title : '';
    byKey.set(key, {
      season: file.season,
      number: file.episode,
      title: fileTitle || cleanEpisodeTitle(file.filePath, file.season, file.episode),
      summary: '',
      still: '',
      rating: 0,
      airDate: '',
      localMetadata: file.localMetadata,
    });
  });

  return Array.from(byKey.values()).sort((a, b) => a.season - b.season || a.number - b.number);
}

function findLatestCandidate(
  movies: MediaItem[],
  shows: TVShow[],
  progress: Record<string, StoredProgress>,
): ContinueCandidate | null {
  const candidates: ContinueCandidate[] = [];

  movies.forEach((movie) => {
    const details = progressDetails(movie.filePath, movie.localMetadata?.durationSeconds, progress);
    if (!details.inProgress) return;
    candidates.push({
      key: `movie:${movie.id}`,
      filePath: movie.filePath,
      title: movie.title,
      subtitle: `${formatTime(details.position)} / ${formatTime(details.duration)}`,
      position: details.position,
      duration: details.duration,
      fraction: details.fraction,
      updatedAt: details.updatedAt || movie.lastPlayed || 0,
      onPlayArgs: [
        movie.filePath,
        movie.title,
        movie.subtitles,
        undefined,
        undefined,
        undefined,
        undefined,
        movie.id,
        {
          logo: logoSources(movie)[0] || '',
          logoCandidates: logoSources(movie),
          poster: movie.poster,
          posterCandidates: uniqueArtworkSources(movie.posterCandidates, movie.poster),
          backdrop: movie.backdrop,
          backdropCandidates: uniqueArtworkSources(movie.backdropCandidates, movie.backdrop),
        },
      ],
    });
  });

  shows.forEach((show) => {
    const playerEpisodes = playerEpisodesFor(show);
    (show.episodeFiles || []).forEach((episodeFile) => {
      const details = progressDetails(episodeFile.filePath, episodeFile.localMetadata?.durationSeconds, progress);
      if (!details.inProgress) return;
      const episode = playerEpisodes.find((item) => item.season === episodeFile.season && item.number === episodeFile.episode);
      const episodeTitle = cleanEpisodeTitleForDisplay(episode?.title, show.title, episodeFile.season, episodeFile.episode);
      candidates.push({
        key: `${show.type}:${show.id}:${episodeFile.season}:${episodeFile.episode}`,
        filePath: episodeFile.filePath,
        title: show.title,
        subtitle: `${episodeCode(episodeFile.season, episodeFile.episode)}${episodeTitle ? ` - ${episodeTitle}` : ''} · ${formatTime(details.position)} / ${formatTime(details.duration)}`,
        position: details.position,
        duration: details.duration,
        fraction: details.fraction,
        updatedAt: details.updatedAt || show.lastPlayed || 0,
        onPlayArgs: [
          episodeFile.filePath,
          show.title,
          show.subtitles,
          playerEpisodes,
          show.episodeFiles,
          episodeFile.season,
          episodeFile.episode,
          show.id,
          {
            logo: logoSources(show)[0] || '',
            logoCandidates: logoSources(show),
            poster: show.poster,
            posterCandidates: uniqueArtworkSources(show.posterCandidates, show.poster),
            backdrop: show.backdrop,
            backdropCandidates: uniqueArtworkSources(show.backdropCandidates, show.backdrop),
          },
        ],
      });
    });
  });

  return candidates.sort((a, b) => b.updatedAt - a.updatedAt || b.position - a.position)[0] || null;
}

export default function ContinueWatchingBar({ isHidden = false, onPlay }: ContinueWatchingBarProps) {
  const { state } = useLibrary();
  const [progress, setProgress] = useState<Record<string, StoredProgress>>(() => loadProgress());
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [thumbnailFallbackUrl, setThumbnailFallbackUrl] = useState('');
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  useEffect(() => {
    const refresh = () => setProgress(loadProgress());
    void hydrateProgressFromDatabase().then(refresh);
    const interval = window.setInterval(refresh, 2000);
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener('loomtv-progress', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('loomtv-progress', refresh);
    };
  }, []);

  const candidate = useMemo(
    () => findLatestCandidate(
      state.movies,
      [...state.tvShows, ...state.animeShows],
      progress,
    ),
    [progress, state.animeShows, state.movies, state.tvShows],
  );

  useEffect(() => {
    if (candidate?.key !== dismissedKey) return;
    if (candidate.fraction <= 0 || candidate.fraction >= WATCHED_THRESHOLD) {
      setDismissedKey(null);
    }
  }, [candidate, dismissedKey]);

  useEffect(() => {
    let cancelled = false;
    setThumbnailUrl('');
    setThumbnailFallbackUrl('');
    setThumbnailFailed(false);

    if (!candidate) return () => {
      cancelled = true;
    };

    void desktopApi.getThumbnail(candidate.filePath, formatThumbnailTime(candidate.position, candidate.duration))
      .then(({ url }) => {
        if (!cancelled) setThumbnailUrl(url);
      })
      .catch(() => {
        if (!cancelled) setThumbnailUrl('');
      });

    void desktopApi.getThumbnail(candidate.filePath, '00:03:00')
      .then(({ url }) => {
        if (!cancelled) setThumbnailFallbackUrl(url);
      })
      .catch(() => {
        if (!cancelled) setThumbnailFallbackUrl('');
      });

    return () => {
      cancelled = true;
    };
  }, [candidate]);

  if (isHidden || !candidate || dismissedKey === candidate.key) return null;

  const playCandidate = () => onPlay(...candidate.onPlayArgs);
  const thumbnailSrc = thumbnailFailed ? thumbnailFallbackUrl : thumbnailUrl;

  return (
    <div className="pointer-events-none fixed bottom-0 left-48 right-0 z-40 px-5 pb-4">
      <div className="pointer-events-auto mx-auto max-w-[1440px] overflow-hidden rounded-lg border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] shadow-[0_14px_42px_rgba(0,0,0,0.42)] ring-1 ring-[var(--loom-accent)]/15 backdrop-blur-md">
        <button
          type="button"
          onClick={playCandidate}
          className="relative flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-white/[0.035]"
        >
          <span
            className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-[var(--loom-accent)]"
            style={{ width: `${Math.min(100, Math.max(0, candidate.fraction * 100))}%` }}
          />
          <span className="h-16 w-28 shrink-0 overflow-hidden rounded-md bg-black shadow-md">
            {thumbnailSrc ? (
              <img
                src={thumbnailSrc}
                alt=""
                className="h-full w-full object-cover"
                onError={() => setThumbnailFailed(true)}
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[10px] text-white/40">LoomTV</span>
            )}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[20px] font-semibold text-white">{candidate.title}</span>
            <span className="mt-1 block truncate text-sm text-[var(--loom-muted)]">{candidate.subtitle}</span>
          </span>
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)] shadow-[0_0_0_5px_rgba(251,197,0,0.12),0_12px_24px_rgba(0,0,0,0.30)]">
            <Play className="h-5 w-5 fill-current" />
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              setDismissedKey(candidate.key);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              setDismissedKey(candidate.key);
            }}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/50 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Hide continue watching"
          >
            <X className="h-4 w-4" />
          </span>
        </button>
      </div>
    </div>
  );
}
