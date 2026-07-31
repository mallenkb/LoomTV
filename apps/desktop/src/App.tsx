import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import { LibraryProvider, useLibrary } from './contexts/LibraryContext';
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
import VideoPlayer from './components/VideoPlayer/LazyVideoPlayer';
import ContinueWatchingBar from './components/ContinueWatchingBar';
import { ConfirmProvider } from './components/ConfirmProvider';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/ToastProvider';
import { ThemeProvider } from './components/ThemeProvider';
import LoomLogo from './components/LoomLogo';
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

const StartupReadyContext = createContext<() => void>(() => undefined);
const StartupVisibilityContext = createContext(false);

function StartupSplash() {
  return (
    <div
      className="fixed inset-0 z-[10000] grid select-none place-items-center bg-black text-white"
      role="status"
      aria-live="polite"
      aria-label="LoomTV is preparing your library"
    >
      <div className="grid justify-items-center gap-7">
        <div style={{ '--loom-logo-word': '#f5f5f5' } as React.CSSProperties}>
          <LoomLogo className="h-auto w-64" accent="#1680ff" />
        </div>
        <p className="text-sm tracking-wide text-[#999]">Preparing your library</p>
        <div className="flex h-2 gap-2" aria-hidden="true">
          {[0, 160, 320].map((delay) => (
            <span
              key={delay}
              className="h-2 w-2 animate-pulse rounded-full bg-[#1680ff] motion-reduce:animate-none"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function StartupReadySignal({
  ready = true,
  onReady,
}: {
  ready?: boolean;
  onReady?: () => void;
}) {
  const markAppReady = useContext(StartupReadyContext);
  const markReady = onReady || markAppReady;
  const signalledRef = useRef(false);
  useEffect(() => {
    if (!ready || signalledRef.current) return undefined;
    let cancelled = false;

    const nextPaint = () => new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
    const settleInitialAssets = async () => {
      await nextPaint();
      await nextPaint();
      await document.fonts?.ready.catch(() => undefined);

      // Artwork can advance through several fallback candidates. Re-sample the
      // priority hero after each decode pass so a failed first URL cannot make
      // the splash disappear while its replacement is still loading. Rail
      // artwork is deliberately lazy and must never extend startup.
      for (let pass = 0; pass < 4; pass += 1) {
        const priorityImages = [...document.querySelectorAll<HTMLImageElement>('img[fetchpriority="high"]')];
        const sourcesBeforeDecode = priorityImages.map((image) => image.currentSrc || image.src);
        await Promise.all(priorityImages.map(async (image) => {
          try {
            await image.decode();
          } catch {
            // The artwork component advances to its next candidate on error.
          }
        }));
        await nextPaint();
        const sourceChanged = priorityImages.some(
          (image, index) => (image.currentSrc || image.src) !== sourcesBeforeDecode[index],
        );
        if (!sourceChanged) break;
      }
      await nextPaint();

      if (!cancelled && !signalledRef.current) {
        signalledRef.current = true;
        markReady();
      }
    };
    void settleInitialAssets();
    return () => { cancelled = true; };
  }, [markReady, ready]);
  return null;
}

export default function App() {
  const [startupReady, setStartupReady] = useState(false);
  const markStartupReady = useCallback(() => setStartupReady(true), []);

  return (
    <StartupReadyContext.Provider value={markStartupReady}>
      <StartupVisibilityContext.Provider value={startupReady}>
        {/* `reducedMotion="user"` makes every motion/react component in the app drop
            transform and layout animations when the OS asks for reduced motion,
            keeping only opacity. CSS transitions are handled separately in index.css. */}
        <MotionConfig reducedMotion="user">
          <HashRouter>
            <DesktopBootstrap />
          </HashRouter>
        </MotionConfig>
        {!startupReady && <StartupSplash />}
      </StartupVisibilityContext.Provider>
    </StartupReadyContext.Provider>
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
      <>
        <StartupReadySignal />
        <DesktopOnboarding
          onHostReady={() => undefined}
          onRemoteReady={() => undefined}
          initialStep="connect"
        />
      </>
    );
  }

  if (mode === 'loading') return <div className="h-screen bg-[var(--loom-bg)]" />;
  if (!mode) {
    return (
      <>
        <StartupReadySignal />
        <DesktopOnboarding
          onHostReady={() => { setInitialSetup('host'); setMode('host'); }}
          onRemoteReady={() => { setInitialSetup('remote'); setMode('remote'); }}
          initialMessage={setupMessage}
        />
      </>
    );
  }

  return (
    <ErrorBoundary
      title="LoomTV could not start this session"
      description="Reloading keeps your library, profiles, and saved positions intact."
      actionLabel="Reload LoomTV"
      containerClassName="h-screen w-screen"
      onReset={() => window.location.reload()}
    >
      {/* Above ProfileProvider so profile switching can await a confirmation. */}
      <ConfirmProvider>
        <ProfileProvider key={mode}>
          <ThemeProvider>
            <ToastProvider>
              <ProfileGateOrShell initialSetup={initialSetup} />
            </ToastProvider>
          </ThemeProvider>
        </ProfileProvider>
      </ConfirmProvider>
    </ErrorBoundary>
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
  if (!activeProfile) {
    return <><StartupReadySignal /><ProfileGate initialSetup={initialSetup} /></>;
  }
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
  const { state: libraryState } = useLibrary();
  const markAppReady = useContext(StartupReadyContext);
  const appStartupReady = useContext(StartupVisibilityContext);
  const [homeReady, setHomeReady] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const location = useLocation();
  const isSettingsRoute =
    location.pathname === '/settings'
    || location.pathname.startsWith('/settings/')
    || location.hash.includes('/settings');
  const hideContinueBar = Boolean(nowPlaying) || isSettingsRoute;
  const reserveContinueBarSpace = !hideContinueBar;
  const markHomeReady = useCallback(() => {
    setHomeReady(true);
    markAppReady();
  }, [markAppReady]);

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
      <StartupReadySignal ready={libraryState.isStartupPrepared} onReady={markHomeReady} />
      {appStartupReady && !homeReady && <StartupSplash />}
      <div className="loom-app-underlay contents">
      <Sidebar />
      <div
        className={`loom-main-drag-region${isSettingsRoute ? ' loom-main-drag-region-settings' : ''}`}
        aria-hidden="true"
      />
      <main
        className="flex-1 overflow-hidden"
        style={{ '--loom-page-bottom-safe': reserveContinueBarSpace ? '8rem' : '0px' } as React.CSSProperties}
      >
        {/* Keyed on the route so navigating with the sidebar clears a failed
            page instead of stranding the user on the error panel. */}
        <ErrorBoundary
          key={location.pathname}
          title="This page ran into a problem"
          description="The rest of LoomTV is still running. Retry, or pick another section from the sidebar."
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
        </ErrorBoundary>
      </main>
      </div>
      {nowPlaying && (
        <ErrorBoundary
          title="Playback stopped unexpectedly"
          description="Your position was saved. Closing the player returns you to the library."
          actionLabel="Close player"
          containerClassName="fixed inset-0 z-50"
          onReset={handleClose}
        >
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
        </ErrorBoundary>
      )}
      <div className="loom-app-underlay contents">
        <ContinueWatchingBar isHidden={hideContinueBar} onPlay={handlePlayMedia} />
      </div>
    </div>
  );
}
