import React, { useState, useCallback } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { LibraryProvider } from './contexts/LibraryContext';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './contexts/LibraryContext';
import { ProfileProvider, useProfiles } from './contexts/ProfileContext';
import ProfileGate from './components/profiles/ProfileGate';
import Home from './pages/Home';
import Movies from './pages/Movies';
import Others from './pages/Others';
import TVShows from './pages/TVShows';
import MovieDetail from './pages/MovieDetail';
import TVDetail from './pages/TVDetail';
import Settings from './pages/Settings';
import Sidebar from './components/Sidebar';
import VideoPlayer from './components/VideoPlayer';
import ContinueWatchingBar from './components/ContinueWatchingBar';
import { ToastProvider } from './components/ToastProvider';
import { ThemeProvider } from './components/ThemeProvider';

interface NowPlaying {
  mediaId?: string;
  filePath: string;
  title: string;
  artwork?: {
    logo?: string;
    logoCandidates?: string[];
    poster?: string;
    posterCandidates?: string[];
    backdrop?: string;
    backdropCandidates?: string[];
    rating?: number;
  };
  subtitles?: MediaItem['subtitles'];
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
  currentSeason?: number;
  currentEpisode?: number;
  startPosition?: number;
}

export default function App() {
  return (
    <LibraryProvider>
      <ThemeProvider>
        <ToastProvider>
          <ProfileProvider>
            <HashRouter>
              <ProfileGateOrShell />
            </HashRouter>
          </ProfileProvider>
        </ToastProvider>
      </ThemeProvider>
    </LibraryProvider>
  );
}

/**
 * With several profiles the Who's Watching gate is the app's front door; the
 * shell (and every progress consumer inside it) mounts only after a profile
 * has been chosen for this session.
 */
function ProfileGateOrShell() {
  const { gateOpen, isLoading } = useProfiles();
  if (isLoading) return <div className="h-screen bg-[var(--loom-bg)]" />;
  if (gateOpen) return <ProfileGate />;
  return <AppShell />;
}

function AppShell() {
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const location = useLocation();
  const hideContinueBar = Boolean(nowPlaying) || location.pathname === '/settings';
  const reserveContinueBarSpace = !hideContinueBar;

  const handlePlayMedia = useCallback((
    filePath: string,
    title: string,
    subtitles?: MediaItem['subtitles'],
    episodes?: EpisodeMeta[],
    episodeFiles?: EpisodeFile[],
    currentSeason?: number,
    currentEpisode?: number,
    mediaId?: string,
    artwork?: NowPlaying['artwork'],
    startPosition?: number,
  ) => {
    setNowPlaying({
      mediaId,
      filePath,
      title,
      artwork,
      subtitles,
      episodes,
      episodeFiles,
      currentSeason,
      currentEpisode,
      startPosition,
    });
  }, []);

  /** Called when the user picks a different episode from the panel. */
  const handleEpisodeSelect = useCallback((filePath: string, season: number, episode: number) => {
    setNowPlaying((prev) => {
      if (!prev) return null;
      const belongsToCurrentSeries = prev.episodeFiles?.some((item) =>
        item.filePath === filePath && item.season === season && item.episode === episode,
      );
      if (!belongsToCurrentSeries) return prev;
      const episodeSubtitles = prev.episodeFiles?.find((item) =>
        item.filePath === filePath && item.season === season && item.episode === episode,
      )?.subtitles;
      return {
        ...prev,
        filePath,
        subtitles: episodeSubtitles || [],
        currentSeason: season,
        currentEpisode: episode,
        startPosition: undefined,
      };
    });
  }, []);

  const handleClose = useCallback(() => {
    setNowPlaying(null);
  }, []);

  return (
    <div className="loom-app-shell flex h-screen text-[var(--loom-text)]">
      <Sidebar />
      <div className="loom-main-drag-region" aria-hidden="true" />
      <main
        className="flex-1 overflow-hidden"
        style={{ '--loom-page-bottom-safe': reserveContinueBarSpace ? '8rem' : '0px' } as React.CSSProperties}
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/movies" element={<Movies />} />
          <Route path="/others" element={<Others />} />
          <Route path="/tv" element={<TVShows kind="series" />} />
          <Route path="/anime" element={<TVShows kind="anime" />} />
          <Route path="/movie/:id" element={<MovieDetail onPlay={handlePlayMedia} />} />
          <Route path="/tv/:id" element={<TVDetail kind="series" onPlay={handlePlayMedia} />} />
          <Route path="/anime/:id" element={<TVDetail kind="anime" onPlay={handlePlayMedia} />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {nowPlaying && (
        <VideoPlayer
          key={nowPlaying.mediaId ? `media:${nowPlaying.mediaId}` : `file:${nowPlaying.filePath}`}
          mediaId={nowPlaying.mediaId}
          filePath={nowPlaying.filePath}
          title={nowPlaying.title}
          artwork={nowPlaying.artwork}
          subtitles={nowPlaying.subtitles}
          episodes={nowPlaying.episodes}
          episodeFiles={nowPlaying.episodeFiles}
          currentSeason={nowPlaying.currentSeason}
          currentEpisode={nowPlaying.currentEpisode}
          startPosition={nowPlaying.startPosition}
          onEpisodeChange={handleEpisodeSelect}
          onClose={handleClose}
        />
      )}
      <ContinueWatchingBar isHidden={hideContinueBar} onPlay={handlePlayMedia} />
    </div>
  );
}
