import React, { useState, useCallback, useEffect } from 'react';
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
import DesktopOnboarding from './components/DesktopOnboarding';
import { desktopApi } from './lib/desktopApi';
import {
  clearDesktopLibraryMode,
  clearRemoteDesktopSession,
  getDesktopLibraryMode,
  getRemoteDesktopSession,
  purgeRemoteDesktopSecrets,
  type DesktopLibraryMode,
} from './lib/remoteDesktop';

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
    <HashRouter>
      <DesktopBootstrap />
    </HashRouter>
  );
}

function DesktopBootstrap() {
  const onboardingPreview = new URLSearchParams(window.location.search).get('onboarding') === 'connect';
  const [mode, setMode] = useState<DesktopLibraryMode | null | 'loading'>(onboardingPreview ? null : 'loading');
  const [setupMessage, setSetupMessage] = useState('');
  // Set only when this session just went through onboarding, so the profile
  // gate can route a first-run host into setting up its first profile rather
  // than showing a bare "Who's watching?" tile.
  const [initialSetup, setInitialSetup] = useState<DesktopLibraryMode | null>(null);

  useEffect(() => {
    if (onboardingPreview) return;
    let cancelled = false;
    const resolveMode = async () => {
      purgeRemoteDesktopSecrets();
      const savedMode = getDesktopLibraryMode();
      if (savedMode === 'remote') {
        const cachedSession = getRemoteDesktopSession();
        let persistedSession = null;
        try {
          persistedSession = await desktopApi.getPersistedRemoteLibrary();
        } catch (error) {
          setSetupMessage(error instanceof Error ? error.message : 'The saved pairing could not be restored. Pair this laptop again.');
        }
        if (!persistedSession) {
          clearRemoteDesktopSession();
          clearDesktopLibraryMode();
          if (!cancelled) setMode(null);
          return;
        }
        desktopApi.activateRemoteLibrary({
          ...persistedSession,
          library: cachedSession?.library || persistedSession.library,
          libraryEtag: cachedSession?.libraryEtag || persistedSession.libraryEtag,
        });
        if (!cancelled) setMode('remote');
        return;
      }
      if (savedMode) {
        if (!cancelled) setMode(savedMode);
        return;
      }
      let remoteSession = null;
      try {
        remoteSession = await desktopApi.getPersistedRemoteLibrary();
      } catch (error) {
        setSetupMessage(error instanceof Error ? error.message : 'The saved pairing could not be restored. Pair this laptop again.');
      }
      if (remoteSession) {
        desktopApi.activateRemoteLibrary(remoteSession);
        if (!cancelled) setMode('remote');
        return;
      }
      try {
        const library = await desktopApi.getLibrary();
        const hasExistingSetup = Boolean(
          library.movies?.length
          || library.tvShows?.length
          || library.animeShows?.length
          || library.libraryFolders?.length
          || library.libraryFolderGroups?.movies?.length
          || library.libraryFolderGroups?.tvShows?.length
          || library.libraryFolderGroups?.anime?.length
          || library.libraryFolderGroups?.others?.length,
        );
        if (hasExistingSetup) {
          desktopApi.useThisComputerAsHost();
          if (!cancelled) setMode('host');
          return;
        }
      } catch {
        // A new installation can continue to the explicit setup choice.
      }
      if (!cancelled) setMode(null);
    };
    void resolveMode();

    const handleModeChanged = (event: Event) => {
      const next = (event as CustomEvent<DesktopLibraryMode>).detail;
      if (next === 'host' || next === 'remote') setMode(next);
    };
    window.addEventListener('loomtv:desktop-library-mode-changed', handleModeChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('loomtv:desktop-library-mode-changed', handleModeChanged);
    };
  }, [onboardingPreview]);

  if (onboardingPreview) {
    return (
      <DesktopOnboarding
        onHostReady={() => undefined}
        onRemoteReady={() => undefined}
        initialStep="connect"
      />
    );
  }

  if (mode === 'loading') return <div className="h-screen bg-[var(--loom-bg)]" />;
  if (!mode) {
    return (
      <DesktopOnboarding
        onHostReady={() => { setInitialSetup('host'); setMode('host'); }}
        onRemoteReady={() => { setInitialSetup('remote'); setMode('remote'); }}
        initialMessage={setupMessage}
      />
    );
  }

  return (
    <ProfileProvider key={mode}>
      <ThemeProvider>
        <ToastProvider>
          <ProfileGateOrShell initialSetup={initialSetup} />
        </ToastProvider>
      </ThemeProvider>
    </ProfileProvider>
  );
}

/**
 * With several profiles the Who's Watching gate is the app's front door; the
 * shell (and every progress consumer inside it) mounts only after a profile
 * has been chosen for this session.
 */
function ProfileGateOrShell({ initialSetup }: { initialSetup: DesktopLibraryMode | null }) {
  const { activeProfile, gateOpen, generation, isLoading } = useProfiles();
  if (isLoading) return <div className="h-screen bg-[var(--loom-bg)]" />;
  if (!activeProfile) return <ProfileGate initialSetup={initialSetup} />;
  return (
    <>
      <LibraryProvider key={generation}>
        <AppShell />
      </LibraryProvider>
      {gateOpen && <ProfileGate />}
    </>
  );
}

function AppShell() {
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const location = useLocation();
  const isSettingsRoute =
    location.pathname === '/settings'
    || location.pathname.startsWith('/settings/')
    || location.hash.includes('/settings');
  const hideContinueBar = Boolean(nowPlaying) || isSettingsRoute;
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
      <div
        className={`loom-main-drag-region${isSettingsRoute ? ' loom-main-drag-region-settings' : ''}`}
        aria-hidden="true"
      />
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
          key={`${nowPlaying.mediaId ? `media:${nowPlaying.mediaId}` : 'file'}:${nowPlaying.filePath}`}
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
