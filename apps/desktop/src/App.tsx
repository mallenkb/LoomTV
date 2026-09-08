import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createRootRoute, createRoute, createRouter, createHashHistory, lazyRouteComponent, RouterProvider, Outlet, Navigate } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { useLocation, parseDesktopSearch, stringifyDesktopSearch } from './lib/navigation';
import { MotionConfig, motion, useReducedMotion } from 'motion/react';
import { LibraryProvider, useLibrary } from './contexts/LibraryContext';
import type { EpisodeFile, EpisodeMeta, MediaItem } from './contexts/LibraryContext';
import { ProfileProvider, useProfiles } from './contexts/ProfileContext';
import ProfileGate from './components/profiles/ProfileGate';
import Home from './pages/Home';
const MyList = lazyRouteComponent(() => import('./pages/MyList'));
const Movies = lazyRouteComponent(() => import('./pages/Movies'));
const Others = lazyRouteComponent(() => import('./pages/Others'));
const TVShows = lazyRouteComponent(() => import('./pages/TVShows'));
const MovieDetail = lazyRouteComponent(() => import('./pages/MovieDetail'));
const TVDetail = lazyRouteComponent(() => import('./pages/TVDetail'));
const Settings = lazyRouteComponent(() => import('./pages/Settings'));
const PluginDiscover = lazyRouteComponent(() => import('./pages/PluginDiscover'));
const LiveTv = lazyRouteComponent(() => import('./pages/LiveTv'));
const ArchiveOrgAddon = lazyRouteComponent(() => import('./pages/ArchiveOrgAddon'));
import Sidebar from './components/Sidebar';
import VideoPlayer from './components/VideoPlayer/LazyVideoPlayer';
import ContinueWatchingBar from './components/ContinueWatchingBar';
import { ConfirmProvider } from '@/components/ConfirmProvider';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/ToastProvider';
import { ThemeProvider } from './components/ThemeProvider';
import LoomLogo from './components/LoomLogo';
import DesktopOnboarding from './components/DesktopOnboarding';
import {
  isLibraryFilterPath,
  LibraryFilterVisibilityContext,
} from './contexts/LibraryFilterVisibilityContext';
import { desktopApi, hasBrowserLocalSession, isBrowserLocalApp } from './lib/desktopApi';
import {
  clearDesktopLibraryMode,
  clearRemoteDesktopSession,
  getDesktopLibraryMode,
  getRemoteDesktopSession,
  purgeRemoteDesktopSecrets,
  type DesktopLibraryMode,
} from './lib/remoteDesktop';
import { isMediaProtocolUrl } from './shared/mediaProtocol.ts';
import { isIptvPlaybackReference } from './shared/iptvPlayback.ts';
import { buildExternalPlaybackReference } from './shared/externalPlayback.ts';

interface NowPlaying {
  playbackRequestId: string;
  playRequestedAtMs: number;
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
  isLiveStream?: boolean;
}

function isRemotePlaybackSource(filePath: string): boolean {
  return /^(?:https?|plexserver):\/\//i.test(filePath)
    || isMediaProtocolUrl(filePath)
    || isIptvPlaybackReference(filePath);
}
const StartupReadyContext = createContext<() => void>(() => undefined);
const StartupVisibilityContext = createContext(false);

function StartupSplash({ message = 'Preparing your library' }: { message?: string }) {
  return (
    <div
      className="fixed inset-0 z-[10000] grid select-none place-items-center bg-black text-white"
      role="status"
      aria-live="polite"
      aria-label={`LoomTV startup: ${message}`}
    >
      <div className="grid justify-items-center gap-7">
        <div style={{ '--loom-logo-word': '#f5f5f5' } as React.CSSProperties}>
          <LoomLogo className="h-auto w-64" accent="#1680ff" />
        </div>
        <p className="max-w-md text-center text-sm tracking-wide text-[#999]">{message}</p>
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

    const signalReady = () => {
      if (cancelled || signalledRef.current) return;
      signalledRef.current = true;
      markReady();
    };
    // `ready` already gates the page's required data. Let that layout paint,
    // then reveal it without waiting for network artwork or font downloads.
    // Keep a deadline for windows whose animation frames are throttled.
    const readinessDeadline = window.setTimeout(signalReady, 3_000);
    let readyFrame = window.requestAnimationFrame(() => {
      readyFrame = window.requestAnimationFrame(signalReady);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(readinessDeadline);
      window.cancelAnimationFrame(readyFrame);
    };
  }, [markReady, ready]);
  return null;
}

export default function App() {
  const hasDesktopLibVlcBridge = Boolean(window.desktopApi?.libvlc?.refreshAvailability);
  const [contentReady, setContentReady] = useState(false);
  const startupReady = contentReady;
  const markStartupReady = useCallback(() => setContentReady(true), []);

  useEffect(() => {
    if (!hasDesktopLibVlcBridge || !startupReady) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void desktopApi.libvlc.refreshAvailability()
        .then((availability) => {
          if (!cancelled && availability.available) {
            console.info('[startup] LibVLC is available.', {
              version: availability.version,
              libraryPath: availability.libraryPath,
            });
          }
        })
        .catch((error) => {
          if (!cancelled) console.warn('[startup] LibVLC background probe failed:', error);
        });
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasDesktopLibVlcBridge, startupReady]);

  useEffect(() => {
    if (!startupReady || !window.desktopApi) return undefined;
    const preload = () => {
      void Promise.allSettled([
        MyList, Movies, Others, TVShows, MovieDetail, TVDetail, Settings,
        PluginDiscover, LiveTv, ArchiveOrgAddon,
      ].map((component) => component.preload?.()));
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(preload, { timeout: 2_000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preload, 500);
    return () => window.clearTimeout(id);
  }, [startupReady]);

  return (
    <StartupReadyContext.Provider value={markStartupReady}>
      <StartupVisibilityContext.Provider value={startupReady}>
        {/* `reducedMotion="user"` makes every motion/react component in the app drop
            transform and layout animations when the OS asks for reduced motion,
            keeping only opacity. CSS transitions are handled separately in index.css. */}
        <MotionConfig reducedMotion="user">
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
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
      const browserLocalSession = hasBrowserLocalSession();
      const browserLocalApp = isBrowserLocalApp();
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
        // The local host mode is backed by Electron IPC unless this is the
        // loopback web renderer (with or without the tray handoff token). A
        // development browser can also be the renderer, so let it prove the
        // running local catalog below before discarding the remembered mode.
        if (savedMode === 'host' && !window.desktopApi && !browserLocalSession && !browserLocalApp) {
          // Fall through to the authenticated local catalog probe.
        } else {
          if (!cancelled) setMode(savedMode);
          return;
        }
      }
      try {
        const unified = await desktopApi.getUnifiedDesktopServerState();
        if (unified.enabled && unified.ready && unified.ownerConfigured) {
          desktopApi.useThisComputerAsHost();
          if (!cancelled) setMode('host');
          return;
        }
      } catch {
        // The legacy desktop remains usable when the optional unified host is unavailable.
      }
      try {
        const index = await desktopApi.getLibraryIndex();
        const library = index || await desktopApi.getLibrary();
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
      if (savedMode === 'host') clearDesktopLibraryMode();
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
  const shouldReduceMotion = useReducedMotion();
  const { state: libraryState } = useLibrary();
  const { activeProfile, gateOpen, openGate } = useProfiles();
  const markAppReady = useContext(StartupReadyContext);
  const appStartupReady = useContext(StartupVisibilityContext);
  const [homeReady, setHomeReady] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  // A renderer reload can preserve the document element while the player
  // component is being replaced. Never leave the native-player transparency
  // mode latched over the normal library shell after playback has closed.
  useEffect(() => {
    if (!nowPlaying) document.documentElement.classList.remove('loom-native-active');
  }, [nowPlaying]);
  const location = useLocation();
  const isSettingsRoute =
    location.pathname === '/settings'
    || location.pathname.startsWith('/settings/')
    || location.hash.includes('/settings');
  const showContinueBarOnRoute = ['/', '/anime', '/tv', '/movies'].includes(location.pathname);
  const showLibraryFilter = !nowPlaying && !gateOpen && isLibraryFilterPath(location.pathname);
  const hideContinueBar = Boolean(nowPlaying) || !showContinueBarOnRoute;
  const reserveContinueBarSpace = showContinueBarOnRoute && !nowPlaying;
  const appUnderlayHidden = Boolean(nowPlaying || gateOpen);
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
    options?: { isLiveStream?: boolean },
  ) => {
    const openPlayer = async () => {
      // The profile gate and the media IPC handler read the same persisted
      // selection, but a profile can be locked or revoked while a catalog
      // card is still on screen. Recheck at the playback boundary so the
      // player never opens into a request that the main process must reject.
      const activeProfileState = await desktopApi.getActiveProfileState();
      if (!activeProfileState.profileId || !activeProfile) {
        openGate();
        return;
      }
      const playbackRequestId = crypto.randomUUID();
      const playRequestedAtMs = performance.now();
      console.info('[playback-timing]', JSON.stringify({
        event: 'play_requested',
        requestId: playbackRequestId,
        source: isRemotePlaybackSource(filePath) ? 'remote' : 'local',
      }));
      // Every playback surface already passes the selected file, episode list,
      // subtitles, artwork, and resume point. Opening that prepared snapshot
      // immediately keeps catalog hydration and file inspection out of the
      // click-to-first-frame path.
      setNowPlaying({
        playbackRequestId,
        playRequestedAtMs,
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
        isLiveStream: options?.isLiveStream === true,
      });
    };
    void openPlayer();
  }, [activeProfile, openGate]);

  /**
   * A live channel has no episode list or resume point. Its name and logo are
   * carried into the pause surface, and the player avoids recording progress.
   */
  const handlePlayLiveChannel = useCallback((streamUrl: string, channelName: string, channelLogoUrl?: string) => {
    handlePlayMedia(
      streamUrl,
      channelName,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      channelLogoUrl ? { logo: channelLogoUrl } : undefined,
      undefined,
      { isLiveStream: true },
    );
  }, [handlePlayMedia]);

  const handlePlayArchiveMovie = useCallback((streamUrl: string, title: string, posterUrl: string) => {
    handlePlayMedia(
      buildExternalPlaybackReference(streamUrl),
      title,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { poster: posterUrl, backdrop: posterUrl },
    );
  }, [handlePlayMedia]);

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
        playbackRequestId: crypto.randomUUID(),
        playRequestedAtMs: performance.now(),
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
    <LibraryFilterVisibilityContext.Provider value={showLibraryFilter}>
    <div className="loom-app-shell flex h-screen text-[var(--loom-text)]">
      <StartupReadySignal ready={libraryState.isStartupPrepared} onReady={markHomeReady} />
      {appStartupReady && !homeReady && <StartupSplash />}
      <div className="loom-app-underlay contents" aria-hidden={appUnderlayHidden ? 'true' : undefined}>
      <Sidebar />
      <div
        className={`loom-main-drag-region${isSettingsRoute ? ' loom-main-drag-region-settings' : ''}`}
        aria-hidden="true"
      />
      <main
        className="flex-1 overflow-hidden"
        // The now-playing bar is 93px tall before its shell padding. Keep a
        // full breathing band below every library grid so its final row can be
        // scrolled clear of the fixed bar.
        style={{ '--loom-page-bottom-safe': reserveContinueBarSpace ? '11rem' : '0px' } as React.CSSProperties}
      >
        <motion.div
          key={location.pathname}
          className="loom-route-transition-frame"
          initial={shouldReduceMotion ? false : { opacity: 0.82 }}
          animate={{ opacity: 1 }}
          transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Keyed on the route so navigating with the sidebar clears a failed
              page instead of stranding the user on the error panel. */}
          <ErrorBoundary
            key={location.pathname}
            title="This page ran into a problem"
            description="The rest of LoomTV is still running. Retry, or pick another section from the sidebar."
          >
            <PlaybackActionsContext.Provider value={{ handlePlayMedia, handlePlayLiveChannel, handlePlayArchiveMovie }}>
              <Outlet />
            </PlaybackActionsContext.Provider>
          </ErrorBoundary>
        </motion.div>
      </main>
      </div>
      {nowPlaying && (
        <ErrorBoundary
          title="Playback stopped unexpectedly"
          description="Your position was saved. Closing the player returns you to the library."
          actionLabel="Close player"
          containerClassName="fixed inset-0 z-[90]"
          onReset={handleClose}
        >
          <VideoPlayer
            key={nowPlaying.mediaId ? `media:${nowPlaying.mediaId}` : `file:${nowPlaying.filePath}`}
            mediaId={nowPlaying.mediaId}
            playbackRequestId={nowPlaying.playbackRequestId}
            playRequestedAtMs={nowPlaying.playRequestedAtMs}
            filePath={nowPlaying.filePath}
            title={nowPlaying.title}
            artwork={nowPlaying.artwork}
            subtitles={nowPlaying.subtitles}
            episodes={nowPlaying.episodes}
            episodeFiles={nowPlaying.episodeFiles}
            currentSeason={nowPlaying.currentSeason}
            currentEpisode={nowPlaying.currentEpisode}
            startPosition={nowPlaying.startPosition}
            isLiveStream={nowPlaying.isLiveStream}
            onEpisodeChange={handleEpisodeSelect}
            onClose={handleClose}
          />
        </ErrorBoundary>
      )}
      <div className="loom-app-underlay contents" aria-hidden={appUnderlayHidden ? 'true' : undefined}>
        <ContinueWatchingBar isHidden={hideContinueBar} onPlay={handlePlayMedia} />
      </div>
    </div>
    </LibraryFilterVisibilityContext.Provider>
  );
}


type PlaybackActions = {
  handlePlayMedia: NonNullable<React.ComponentProps<typeof TVDetail>['onPlay']>;
  handlePlayLiveChannel: NonNullable<React.ComponentProps<typeof LiveTv>['onPlay']>;
  handlePlayArchiveMovie: NonNullable<React.ComponentProps<typeof ArchiveOrgAddon>['onPlay']>;
};
const PlaybackActionsContext = createContext<PlaybackActions | null>(null);
function usePlaybackActions() {
  const actions = useContext(PlaybackActionsContext);
  if (!actions) throw new Error('Playback actions are unavailable.');
  return actions;
}
function MovieRoute() { return <MovieDetail onPlay={usePlaybackActions().handlePlayMedia} />; }
function SeriesRoute() { return <TVDetail kind="series" onPlay={usePlaybackActions().handlePlayMedia} />; }
function AnimeRoute() { return <TVDetail kind="anime" onPlay={usePlaybackActions().handlePlayMedia} />; }
function OthersRoute() { return <Others onPlay={usePlaybackActions().handlePlayMedia} />; }
function LiveRoute() { return <LiveTv onPlay={usePlaybackActions().handlePlayLiveChannel} />; }
function AddonRoute() { return <ArchiveOrgAddon onPlay={usePlaybackActions().handlePlayArchiveMovie} />; }

let preloadingDetails = false;
function warmDetails(id: string, preload: boolean, state: unknown) {
  const routeState = state as { fromDiscover?: boolean; stremioCatalogItem?: unknown; from?: string } | undefined;
  if (!preload || preloadingDetails || routeState?.fromDiscover || routeState?.stremioCatalogItem || routeState?.from?.startsWith('/discover')) return;
  preloadingDetails = true;
  void desktopApi.getLibraryItem(id).catch(() => undefined).finally(() => { preloadingDetails = false; });
}

function isRouteModuleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /importing a module script failed|failed to fetch dynamically imported module|loading chunk .+ failed|chunkloaderror/i.test(message);
}

function RouteErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  const moduleError = isRouteModuleError(error);
  useEffect(() => {
    if (!moduleError) return;
    const key = 'loomtv:last-route-module-reload';
    const previous = Number(window.sessionStorage.getItem(key) || 0);
    if (Date.now() - previous < 15_000) return;
    window.sessionStorage.setItem(key, String(Date.now()));
    window.location.reload();
  }, [moduleError]);
  return (
    <div role="alert" className="p-8">
      <p>{moduleError ? 'Reloading this page…' : error.message || 'This page could not load.'}</p>
      <button type="button" onClick={moduleError ? () => window.location.reload() : reset}>
        {moduleError ? 'Reload now' : 'Retry'}
      </button>
    </div>
  );
}

const rootRoute = createRootRoute({ component: DesktopBootstrap, validateSearch: (search: Record<string, unknown>) => Object.fromEntries(Object.entries(search).filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')),  notFoundComponent: () => <Navigate to="/" replace /> });
const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home }),
  createRoute({ getParentRoute: () => rootRoute, path: '/my-list', component: MyList }),
  createRoute({ getParentRoute: () => rootRoute, path: '/movies', component: Movies }),
  createRoute({ getParentRoute: () => rootRoute, path: '/others', beforeLoad: () => Others.preload?.(), component: OthersRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: '/tv', beforeLoad: () => TVShows.preload?.(), component: () => <TVShows kind="series" /> }),
  createRoute({ getParentRoute: () => rootRoute, path: '/anime', beforeLoad: () => TVShows.preload?.(), component: () => <TVShows kind="anime" /> }),
  createRoute({ getParentRoute: () => rootRoute, path: '/discover', component: PluginDiscover }),
  createRoute({ getParentRoute: () => rootRoute, path: '/live/$sourceId', beforeLoad: () => LiveTv.preload?.(), component: LiveRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: '/addons/stremio/$addonId', beforeLoad: () => ArchiveOrgAddon.preload?.(), component: AddonRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: '/movie/$id', component: MovieRoute, beforeLoad: () => MovieDetail.preload?.(), loader: ({ params, preload, location }) => warmDetails(params.id, preload, location.state) }),
  createRoute({ getParentRoute: () => rootRoute, path: '/tv/$id', component: SeriesRoute, beforeLoad: () => TVDetail.preload?.(), loader: ({ params, preload, location }) => warmDetails(params.id, preload, location.state) }),
  createRoute({ getParentRoute: () => rootRoute, path: '/anime/$id', component: AnimeRoute, beforeLoad: () => TVDetail.preload?.(), loader: ({ params, preload, location }) => warmDetails(params.id, preload, location.state) }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: Settings }),
] as const;
const router = createRouter({
  routeTree: rootRoute.addChildren(routes), history: createHashHistory(),
  parseSearch: parseDesktopSearch, stringifySearch: stringifyDesktopSearch,
  defaultPreload: 'intent', defaultPreloadDelay: 120,
  defaultPreloadStaleTime: 0, defaultGcTime: 0,
  scrollRestoration: true,
  scrollToTopSelectors: ['main .loom-page', '.loom-modern-home'],
  defaultPendingMs: 150, defaultPendingMinMs: 0,
  defaultPendingComponent: () => <div role="status" className="p-8 text-[var(--loom-muted)]">Loading page…</div>,
  defaultErrorComponent: RouteErrorFallback,
});

router.subscribe('onBeforeNavigate', ({ pathChanged }) => {
  if (!pathChanged) return;
  void queryClient.cancelQueries({ queryKey: ['getThumbnail'], type: 'inactive', fetchStatus: 'fetching' });
});

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
