import React, { useState, useCallback } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { LibraryProvider } from './contexts/LibraryContext';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './contexts/LibraryContext';
import Home from './pages/Home';
import Movies from './pages/Movies';
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
  subtitles?: MediaItem['subtitles'];
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
  currentSeason?: number;
  currentEpisode?: number;
}

export default function App() {
  return (
    <LibraryProvider>
      <ThemeProvider>
        <ToastProvider>
          <HashRouter>
            <AppShell />
          </HashRouter>
        </ToastProvider>
      </ThemeProvider>
    </LibraryProvider>
  );
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
  ) => {
    setNowPlaying({ mediaId, filePath, title, subtitles, episodes, episodeFiles, currentSeason, currentEpisode });
  }, []);

  /** Called when the user picks a different episode from the panel. */
  const handleEpisodeSelect = useCallback((filePath: string, season: number, episode: number) => {
    setNowPlaying((prev) =>
      prev ? { ...prev, filePath, currentSeason: season, currentEpisode: episode } : null,
    );
  }, []);

  const handleClose = useCallback(() => {
    setNowPlaying(null);
  }, []);

  return (
    <div className="loom-app-shell flex h-screen text-[var(--loom-text)]">
      <Sidebar />
      <main
        className="flex-1 overflow-hidden"
        style={{ '--loom-page-bottom-safe': reserveContinueBarSpace ? '8rem' : '0px' } as React.CSSProperties}
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/movies" element={<Movies />} />
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
          mediaId={nowPlaying.mediaId}
          filePath={nowPlaying.filePath}
          title={nowPlaying.title}
          subtitles={nowPlaying.subtitles}
          episodes={nowPlaying.episodes}
          episodeFiles={nowPlaying.episodeFiles}
          currentSeason={nowPlaying.currentSeason}
          currentEpisode={nowPlaying.currentEpisode}
          onEpisodeChange={handleEpisodeSelect}
          onClose={handleClose}
        />
      )}
      <ContinueWatchingBar isHidden={hideContinueBar} onPlay={handlePlayMedia} />
    </div>
  );
}
