import { useEffect, useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import { useLibrary, EpisodeFile, EpisodeMeta, MediaItem, TVShow } from '@/contexts/LibraryContext';
import { desktopApi } from '@/lib/desktopApi';
import type { StoredProgress } from '@/lib/desktopApi';
import { useProgressSnapshot } from '@/lib/progress';
import { useProfiles } from '@/contexts/ProfileContext';
import {
  cleanEpisodeTitleForDisplay,
  episodeCode as formatEpisodeCode,
  looksLikeGenericEpisodeTitle,
} from '@/lib/episodeTitles';
import { logoSources, uniqueArtworkSources } from '@/lib/artwork';

const WATCHED_THRESHOLD = 0.9;
const DISMISSED_CONTINUE_WATCHING_STORAGE_KEY = 'loomtv.dismissedContinueWatching.v1';

type DismissedCandidate = {
  position: number;
  updatedAt: number;
};

type DismissedCandidates = Record<string, DismissedCandidate>;

function dismissedCandidatesStorageKey(profileId: string | null | undefined): string {
  return `${DISMISSED_CONTINUE_WATCHING_STORAGE_KEY}:${profileId || 'default'}`;
}

function readDismissedCandidates(profileId: string | null | undefined): DismissedCandidates {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(dismissedCandidatesStorageKey(profileId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<DismissedCandidate>>;
    return Object.fromEntries(Object.entries(parsed)
      .filter(([, candidate]) => Number.isFinite(candidate.position) && Number.isFinite(candidate.updatedAt))
      .map(([key, candidate]) => [key, {
        position: Number(candidate.position),
        updatedAt: Number(candidate.updatedAt),
      }]));
  } catch {
    return {};
  }
}

function writeDismissedCandidates(profileId: string | null | undefined, candidates: DismissedCandidates): void {
  if (typeof window === 'undefined') return;
  try {
    const storageKey = dismissedCandidatesStorageKey(profileId);
    if (Object.keys(candidates).length === 0) {
      localStorage.removeItem(storageKey);
      return;
    }
    localStorage.setItem(storageKey, JSON.stringify(candidates));
  } catch {
    // A persistence failure should never prevent playback controls from working.
  }
}

type ContinueCandidate = {
  key: string;
  filePath: string;
  title: string;
  subtitle: string;
  label: string;
  position: number;
  duration: number;
  fraction: number;
  updatedAt: number;
  priority: number;
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
      rating?: number;
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
    startPosition?: number,
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
    watched: Boolean(stored?.watched) || fraction >= WATCHED_THRESHOLD,
  };
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
    const movieLogoSources = logoSources(movie);
    candidates.push({
      key: `movie:${movie.id}`,
      filePath: movie.filePath,
      title: movie.title,
      label: 'Continue watching',
      subtitle: '',
      position: details.position,
      duration: details.duration,
      fraction: details.fraction,
      updatedAt: details.updatedAt || 0,
      priority: 2,
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
          logo: movieLogoSources[0] || '',
          logoCandidates: movieLogoSources,
          poster: movie.poster,
          posterCandidates: uniqueArtworkSources(movie.posterCandidates, movie.poster),
          backdrop: movie.backdrop,
          backdropCandidates: uniqueArtworkSources(movie.backdropCandidates, movie.backdrop),
          rating: movie.rating,
        },
      ],
    });
  });

  shows.forEach((show) => {
    const playerEpisodes = playerEpisodesFor(show);
    const playerEpisodesByKey = new Map(
      playerEpisodes.map((episode) => [`${episode.season}:${episode.number}`, episode]),
    );
    const showLogoSources = logoSources(show);
    const showArtwork = {
      logo: showLogoSources[0] || '',
      logoCandidates: showLogoSources,
      poster: show.poster,
      posterCandidates: uniqueArtworkSources(show.posterCandidates, show.poster),
      backdrop: show.backdrop,
      backdropCandidates: uniqueArtworkSources(show.backdropCandidates, show.backdrop),
      rating: show.rating,
    };
    const sortedFiles = (show.episodeFiles || [])
      .slice()
      .sort((a, b) => a.season - b.season || a.episode - b.episode);
    const episodeDetails = sortedFiles.map((episodeFile) => ({
      episodeFile,
      details: progressDetails(episodeFile.filePath, episodeFile.localMetadata?.durationSeconds, progress),
    }));

    episodeDetails.forEach(({ episodeFile, details }) => {
      if (!details.inProgress) return;
      const episode = playerEpisodesByKey.get(`${episodeFile.season}:${episodeFile.episode}`);
      const episodeTitle = cleanEpisodeTitleForDisplay(episode?.title, show.title, episodeFile.season, episodeFile.episode);
      candidates.push({
        key: `${show.type}:${show.id}:${episodeFile.season}:${episodeFile.episode}`,
        filePath: episodeFile.filePath,
        title: show.title,
        label: 'Continue watching',
        subtitle: `${episodeCode(episodeFile.season, episodeFile.episode)}${episodeTitle ? ` · ${episodeTitle}` : ''}`,
        position: details.position,
        duration: details.duration,
        fraction: details.fraction,
        updatedAt: details.updatedAt || 0,
        priority: 2,
        onPlayArgs: [
          episodeFile.filePath,
          show.title,
          episodeFile.subtitles || show.subtitles,
          playerEpisodes,
          show.episodeFiles,
          episodeFile.season,
          episodeFile.episode,
          show.id,
          showArtwork,
        ],
      });
    });

    if (episodeDetails.some(({ details }) => details.inProgress)) return;

    const lastWatched = episodeDetails
      .filter(({ details }) => details.watched)
      .sort((a, b) => b.details.updatedAt - a.details.updatedAt)[0];
    if (!lastWatched) return;

    const nextEpisode = episodeDetails.find(({ details }) => !details.watched);
    if (!nextEpisode) return;

    const { episodeFile } = nextEpisode;
    const episode = playerEpisodesByKey.get(`${episodeFile.season}:${episodeFile.episode}`);
    const episodeTitle = cleanEpisodeTitleForDisplay(episode?.title, show.title, episodeFile.season, episodeFile.episode);
    candidates.push({
      key: `${show.type}:${show.id}:next:${episodeFile.season}:${episodeFile.episode}`,
      filePath: episodeFile.filePath,
      title: show.title,
      label: 'Up next',
      subtitle: `${episodeCode(episodeFile.season, episodeFile.episode)}${episodeTitle ? ` · ${episodeTitle}` : ''}`,
      position: 0,
      duration: episodeFile.localMetadata?.durationSeconds || 0,
      fraction: 0,
      updatedAt: lastWatched.details.updatedAt || 0,
      priority: 1,
      onPlayArgs: [
        episodeFile.filePath,
        show.title,
        episodeFile.subtitles || show.subtitles,
        playerEpisodes,
        show.episodeFiles,
        episodeFile.season,
        episodeFile.episode,
        show.id,
        showArtwork,
      ],
    });
  });

  return candidates.sort((a, b) =>
    b.priority - a.priority
    || b.updatedAt - a.updatedAt
    || b.position - a.position)[0] || null;
}

export default function ContinueWatchingBar({ isHidden = false, onPlay }: ContinueWatchingBarProps) {
  const { state } = useLibrary();
  const { activeProfile } = useProfiles();
  const progress = useProgressSnapshot();
  const activeProfileId = activeProfile?.id ?? null;
  const [dismissedCandidates, setDismissedCandidates] = useState<DismissedCandidates>({});
  const [dismissalsLoadedForProfile, setDismissalsLoadedForProfile] = useState<string | null | undefined>(undefined);
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [thumbnailFallbackUrl, setThumbnailFallbackUrl] = useState('');
  const [failedSources, setFailedSources] = useState<string[]>([]);

  const candidate = useMemo(
    () => findLatestCandidate(
      state.movies,
      [...state.tvShows, ...state.animeShows],
      progress,
    ),
    [progress, state.animeShows, state.movies, state.tvShows],
  );

  useEffect(() => {
    setDismissedCandidates(readDismissedCandidates(activeProfileId));
    setDismissalsLoadedForProfile(activeProfileId);
  }, [activeProfileId]);

  const dismissedCandidate = candidate ? dismissedCandidates[candidate.key] : undefined;

  useEffect(() => {
    if (!candidate || !dismissedCandidate) return;
    // Dismissing the bar should remain a dismissal. A metadata/progress sync
    // can update the timestamp without the viewer actually resuming playback.
    const hasNewPlayback = candidate.updatedAt > dismissedCandidate.updatedAt
      && candidate.position > dismissedCandidate.position + 1;
    if (hasNewPlayback || candidate.fraction <= 0 || candidate.fraction >= WATCHED_THRESHOLD) {
      setDismissedCandidates((previous) => {
        const remaining = { ...previous };
        delete remaining[candidate.key];
        writeDismissedCandidates(activeProfileId, remaining);
        return remaining;
      });
    }
  }, [activeProfileId, candidate, dismissedCandidate]);

  useEffect(() => {
    let cancelled = false;
    setThumbnailUrl('');
    setThumbnailFallbackUrl('');
    setFailedSources([]);

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

  if (dismissalsLoadedForProfile !== activeProfileId || isHidden || !candidate || dismissedCandidate) return null;

  const playCandidate = () => onPlay(...candidate.onPlayArgs, candidate.position);
  const artwork = candidate.onPlayArgs[8];
  const thumbnailSources = [thumbnailUrl, thumbnailFallbackUrl, artwork?.backdrop || '', artwork?.poster || '']
    .filter((source) => source && !failedSources.includes(source));
  const thumbnailSrc = thumbnailSources[0] || '';
  const metaLine = candidate.subtitle;
  const fractionPercent = Math.min(100, Math.max(0, candidate.fraction * 100));

  return (
    <div className="loom-continue-watching-shell pointer-events-none fixed bottom-0 left-48 right-0 z-40 px-5 pb-4">
      <div className="loom-continue-watching group pointer-events-auto relative mx-auto max-w-[var(--loom-frame-max-width)] overflow-hidden rounded-xl bg-[var(--loom-panel)] shadow-[0_14px_42px_rgba(0,0,0,0.42)] backdrop-blur-md">
        {artwork?.backdrop ? (
          <img
            src={artwork.backdrop}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full scale-105 object-cover object-[center_25%] opacity-20 blur-[2px]"
          />
        ) : null}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[var(--loom-panel)] via-[var(--loom-panel)]/80 to-[var(--loom-panel)]/40"
        />
        <button
          type="button"
          onClick={playCandidate}
          className="relative flex w-full items-center gap-[19px] pr-[14px] text-left transition-colors hover:bg-[color-mix(in_srgb,var(--loom-text)_4%,transparent)]"
        >
          <span className="relative h-[93px] w-[165px] shrink-0 overflow-hidden bg-[var(--loom-surface-3)]">
            {thumbnailSrc ? (
              <img
                src={thumbnailSrc}
                alt=""
                className="h-full w-full object-cover"
                onError={() => setFailedSources((previous) => [...previous, thumbnailSrc])}
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[10px] text-[var(--loom-faint)]">LoomTV</span>
            )}
            <span className="absolute inset-0 grid place-items-center bg-transparent transition-colors group-hover:bg-black/15">
              <Play className="h-8 w-8 fill-current text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] transition-transform duration-200 group-hover:scale-110" />
            </span>
          </span>
          <span className="min-w-0 flex-1 py-[14px] leading-tight">
            <span className="block truncate text-[21px] font-semibold text-[var(--loom-text)]">{candidate.title}</span>
            {metaLine ? (
              <span className="mt-1.5 block truncate text-base text-[var(--loom-muted)]">{metaLine}</span>
            ) : null}
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              setDismissedCandidates((previous) => {
                const next = {
                  ...previous,
                  [candidate.key]: {
                    position: candidate.position,
                    updatedAt: candidate.updatedAt,
                  },
                };
                writeDismissedCandidates(activeProfileId, next);
                return next;
              });
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              setDismissedCandidates((previous) => {
                const next = {
                  ...previous,
                  [candidate.key]: {
                    position: candidate.position,
                    updatedAt: candidate.updatedAt,
                  },
                };
                writeDismissedCandidates(activeProfileId, next);
                return next;
              });
            }}
            className="grid h-[37px] w-[37px] shrink-0 place-items-center rounded-lg text-[var(--loom-muted)] opacity-70 transition-all hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)] hover:opacity-100"
            aria-label="Hide continue watching"
          >
            <X className="h-[19px] w-[19px]" />
          </span>
        </button>
        {fractionPercent > 0 ? (
          <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[6px] bg-[color-mix(in_srgb,var(--loom-text)_10%,transparent)]">
            <span
              className="block h-full bg-[var(--loom-accent)]/60"
              style={{ width: `${fractionPercent}%` }}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}
