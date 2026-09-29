import { StatusBar } from 'expo-status-bar';
import * as Device from 'expo-device';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  BackHandler,
  Easing,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as SecureStore from 'expo-secure-store';
import { type PlayerError, type VideoPlayerStatus } from 'expo-video';
import type { LanPairApprovalRequest } from '@loom-media-server/lan-protocol';
import { FilterIcon, LoomLogo, SearchIcon } from './components/LoomIcons';
import { MobileErrorBoundary } from './components/MobileErrorBoundary';
import { reportNonFatal } from './mobileDiagnostics';
import {
  playbackFailureFromResponse,
  playbackFailureFromUnknown,
  playbackLoadFailure,
  restorePortraitWithRetry,
} from './playbackRecovery';
import { useMobileConnectionSessionController, type MobileProfilePickerMode } from './useMobileConnectionSessionController';
import { useMobileNavigationController } from './useMobileNavigationController';
import { useMobilePlaybackController } from './useMobilePlaybackController';
import { createStyles, type MobileThemeColors } from './mobileStyles';
import { isHlsPlaybackUrl, videoSourceFor, playbackUrlWithAnchor, hasStreamOptions } from './mobilePlaybackPresentation';
import { fetchMobileCatalog, synchronizeMobileCatalog } from './mobileCatalog';
import { captureMobileFocus, clearCapturedMobileFocus, topMobileModalLayer } from './mobileModalStack';
import { replaceMobilePlayerSource } from './mobileLifecycle';
import { validatePairIdentity } from './mobileHostIdentity';
import { connectionErrorFor, normalizeBaseUrl } from './mobileConnection';
import {
  configureSecureLanTransport,
  probeLanCertificate,
  stopSecureLanTransport,
} from './mobileSecureTransport';
import {
  mobileDetailCacheKey,
  mobileCatalogIdentity,
  mobileReconnectDelayMs,
  normalizeCertFingerprint,
  rememberMobileDetailItem,
} from './mobileDomain';
import {
  automaticDiscoveredHost,
  automaticHostAttemptDelay,
  automaticHostAttemptKey,
} from './mobileDiscoveryExperience';
import { MobileThemeProvider } from './mobileThemeContext';
import { reconcileSavedHost } from './mobileHostIdentity';
import {
  canRestoreMobileOfflineSnapshot,
  clearMobileOfflineSnapshot,
  loadMobileOfflineSnapshot,
} from './mobileOfflineCache';
import { mediaIdForPlayTarget, useMobileDownloadsController } from './useMobileDownloadsController';
import { MobileReducedMotionProvider } from './mobileReducedMotion';
import {
  MOBILE_THEME_COLOR_OPTIONS,
  mobileThemeFromSettings,
  type MobileThemeColor,
  type MobileThemeMode,
  type ResolvedMobileThemeMode,
} from './mobileTheme';
import {
  allItems,
  coreItems,
  collections,
  episodePlayTarget,
  filePathFromUrl,
  libraryWithPlayedItem,
  matchesMobileLibraryFilter,
  matchesMobileSearchScope,
  matchesQuery,
  playTargetForItem,
  sortedEpisodes,
  streamPathFor,
} from './mobileLibrary';
import type {
  Connection,
  DiscoveredHost,
  LibraryKind,
  LibraryPayload,
  MediaItem,
  MobileActiveProfile,
  MobileProfile,
  OfficialMetadataCandidate,
  PosterCandidateSheetState,
  SavedConnection,
  StreamOptions,
} from './mobileDomain';
import {
  hlsSessionResultSchema,
  mobileActiveProfileSchema,
  mobileLibraryItemDetailsSchema,
  mobileLibrarySchema,
  mobilePairApprovalRequestSchema,
  mobilePairResponseSchema,
  mobileProfileListSchema,
  mobileProfilePreferencesSchema,
  mobileProfilesPayloadSchema,
  mobileProfileSelectionSchema,
  mobileProgressMapSchema,
  mobileStoredProgressSchema,
  officialArtworkResponseSchema,
  officialMetadataCandidatesSchema,
  readErrorResponse,
  readJsonResponse,
  refreshedCredentialsSchema,
  savedConnectionSchema,
} from './mobileDecoders';
import { mobileLanClient } from './mobileLanClientInstance';
import { imageUrlsFor } from './components/SharedUi';
import { OfflineNotice, PairingScreen, formatOfflineSnapshotTime } from './components/PairingScreen';
import { MobileProfilePicker } from './components/MobileProfilePicker';
import { SettingsDetailHeader, SettingsScreen, settingsSections } from './components/SettingsScreen';
import { HomeSections, LibraryList } from './components/HomeSections';
import { BottomNav, Header, LibraryFilters, MiniPlayerStrip } from './components/Navigation';
import { DetailModal, PosterCandidateSheet } from './components/DetailModal';
import { PlayerModal } from './components/PlayerModal';

const SAVED_CONNECTION_KEY = 'loomtv.saved-connection.v2';
const MOBILE_ONBOARDING_OFFLINE_MESSAGE = 'Server unavailable right now. Choose a LoomTV server to reconnect.';
const MOBILE_REPAIR_MESSAGE = 'This device needs approval again. Select the server, then approve this device in LoomTV administration.';
const MOBILE_THEME_MODE_KEY = 'loomtv.mobile-theme-mode.v1';
const MOBILE_THEME_COLOR_KEY = 'loomtv.mobile-theme-color.v1';

class MobileCredentialRefreshError extends Error {
  constructor(readonly status: number) {
    super(`Credential refresh failed (${status}).`);
    this.name = 'MobileCredentialRefreshError';
  }
}

function isCredentialAuthorizationFailure(error: unknown): boolean {
  return error instanceof MobileCredentialRefreshError
    && (error.status === 400 || error.status === 401 || error.status === 403);
}

function mobileDeviceName(): string {
  return Device.deviceName?.trim()
    || Device.modelName?.trim()
    || (Platform.OS === 'android' ? 'LoomTV Android' : 'LoomTV iOS');
}

// Stable empty list so the library feed keeps the same `data` reference in rails
// mode (rails render in the header; the grid data is intentionally empty).
const EMPTY_ITEMS: MediaItem[] = [];
const LIBRARY_SECTION_APPLY_DELAY_MS = 45;

// After applying a poster choice, pin the chosen candidate's own artwork onto the
// item. The device already rendered these exact provider URLs in the picker, so
// they are known to load — whereas the desktop's freshly re-proxied/cached copy
// can lag or fail on that first fetch, which is what leaves the detail view stuck
// on the placeholder. Keeping the candidate art first (with the server copy as a
// fallback) makes the applied poster show reliably.
function mergeCandidateArtwork(item: MediaItem, candidate: OfficialMetadataCandidate): MediaItem {
  const dedupe = (values: Array<string | undefined>): string[] =>
    Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
  return {
    ...item,
    poster: candidate.thumbnail || candidate.posterCandidates?.[0] || item.poster,
    backdrop: candidate.cover || candidate.backdropCandidates?.[0] || item.backdrop,
    posterCandidates: dedupe([
      candidate.thumbnail,
      ...(candidate.posterCandidates || []),
      candidate.cover,
      item.poster,
      ...(item.posterCandidates || []),
    ]),
    backdropCandidates: dedupe([
      candidate.cover,
      ...(candidate.backdropCandidates || []),
      candidate.thumbnail,
      item.backdrop,
      ...(item.backdropCandidates || []),
    ]),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPairingApproval(
  baseUrl: string,
  request: LanPairApprovalRequest,
): Promise<Response> {
  if (
    !request.requestId
    || !request.requestSecret
    || !Number.isFinite(request.expiresAt)
    || request.expiresAt <= Date.now()
  ) {
    throw new Error('The server returned an invalid approval request. Start pairing again.');
  }

  const deadline = Math.min(request.expiresAt, Date.now() + 65_000);
  while (Date.now() < deadline) {
    await wait(750);
    const response = await mobileLanClient.pairingApprovalStatus(baseUrl, {
      requestId: request.requestId,
      requestSecret: request.requestSecret,
    });
    if (response.status !== 202) return response;
  }
  throw new Error('The server approval request expired. Tap Connect to try again.');
}

const mobileSplashStyles = StyleSheet.create({
  screen: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    backgroundColor: '#0b0b0b',
    justifyContent: 'center',
    zIndex: 100,
  },
  accentLine: {
    backgroundColor: '#fc9c03',
    borderRadius: 2,
    height: 3,
    marginTop: 18,
    width: 28,
  },
});

export default function App() {
  return (
    <SafeAreaProvider>
      <MobileReducedMotionProvider>
        <MobileErrorBoundary
          scope="app-root.render"
          title="LoomTV needs to recover"
          message="Your saved library and progress are safe. Retry to reopen the app."
        >
          <AppRoot />
        </MobileErrorBoundary>
      </MobileReducedMotionProvider>
    </SafeAreaProvider>
  );
}

function AppRoot() {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const systemColorScheme = useColorScheme();
  const isTablet = Math.min(width, height) >= 760;
  const [showStartupSplash, setShowStartupSplash] = useState(true);
  const splashOpacity = useRef(new Animated.Value(1)).current;
  const splashScale = useRef(new Animated.Value(0.96)).current;

  useEffect(() => {
    let animation: ReturnType<typeof Animated.parallel> | null = null;
    const timer = setTimeout(() => {
      animation = Animated.parallel([
        Animated.timing(splashOpacity, {
          toValue: 0,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(splashScale, {
          toValue: 1.03,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]);
      animation.start(({ finished }) => {
        if (finished) setShowStartupSplash(false);
      });
    }, 380);
    return () => {
      clearTimeout(timer);
      animation?.stop();
    };
  }, [splashOpacity, splashScale]);

  const {
    sessionGenerationRef,
    captureSession,
    activeProfile,
    appState,
    appStateRef,
    automaticProfileSignIn,
    automaticHostAttemptRef,
    baseUrl,
    checkDesktopConnectionHandlerRef,
    connection,
    connectionHealthCheckRef,
    connectionLifecycleAction,
    credentialRefreshKeyRef,
    credentialRefreshPromiseRef,
    discoveredHosts,
    discoveryError,
    error,
    isCheckingConnection,
    isDiscoveringHosts,
    isOnboarding,
    isPairing,
    isRestoringConnection,
    isServerOffline,
    offlineSnapshotSavedAt,
    pairWithDesktopHandlerRef,
    profileError,
    profileHydrationGenerationRef,
    profileLists,
    profilePickerMode,
    profilePin,
    profilePinTarget,
    profiles,
    progress,
    reconnectingSavedConnectionRef,
    reconnectSavedConnectionHandlerRef,
    refreshDiscovery,
    requestedHostRepairRef,
    savedReconnectCompletionRef,
    savedConnection,
    setActiveProfile,
    setAutomaticProfileSignIn,
    setBaseUrl,
    setConnection,
    setError,
    setIsCheckingConnection,
    setIsOnboarding,
    setIsPairing,
    setIsRestoringConnection,
    setIsServerOffline,
    setOfflineSnapshotSavedAt,
    setProfileError,
    setProfileLists,
    setProfilePickerMode,
    setProfilePin,
    setProfilePinTarget,
    setProfiles,
    setProgress,
    setSavedConnection,
    setShareCode,
    showProfilePicker,
  } = useMobileConnectionSessionController({
    cancelActiveRequests: mobileLanClient.cancelActiveRequests,
    stopSecureTransport: stopSecureLanTransport,
  });
  const {
    activeKind,
    detailItem,
    filterOpen,
    homeHeaderPinned,
    homeHeaderOpacity,
    homeHeaderScale,
    homeHeaderTranslateY,
    lastDetailByKindRef,
    libraryFilter,
    libraryListRef,
    navigateToKind,
    query,
    rememberMainScroll,
    searchOpen,
    searchScope,
    settingsScrollRef,
    settingsSection,
    setActiveKind,
    setDetailItem,
    setFilterOpen,
    setLibraryFilter,
    setQuery,
    setSearchOpen,
    setSearchScope,
    setSettingsSection,
  } = useMobileNavigationController();
  const {
    appliedOrientationLockRef,
    autoAdvancedEpisodeRef,
    closingPlayerRef,
    desiredOrientationLockRef,
    isPreparingStream,
    mandatoryPlayerTeardownRef,
    miniPlayerTarget,
    orientationLockQueueRef,
    pendingSeekRef,
    playbackFailure,
    playbackUrl,
    player,
    playerReturnItemRef,
    playTarget,
    setIsPreparingStream,
    setMiniPlayerTarget,
    setPlaybackFailure,
    setPlaybackUrl,
    setPlayTarget,
    setStreamOptions,
    setStreamRetryNonce,
    shouldAutoplayRef,
    streamOptions,
    streamRetryNonce,
    userPausedRef,
    windowSizeRef,
  } = useMobilePlaybackController({ appState, height, width });
  const detailItemCacheRef = useRef(new Map<string, MediaItem>());
  const detailItemRequestsRef = useRef(new Map<string, Promise<MediaItem>>());
  const activeCatalogIdentityRef = useRef('profile:none:-1');
  const legacyCatalogFallbackCountRef = useRef(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshingArtworkId, setRefreshingArtworkId] = useState('');
  const [artworkRefreshError, setArtworkRefreshError] = useState('');
  const [artworkCacheBusters, setArtworkCacheBusters] = useState<Record<string, string>>({});
  const [posterCandidateSheet, setPosterCandidateSheet] = useState<PosterCandidateSheetState | null>(null);
  const [applyingPosterCandidateId, setApplyingPosterCandidateId] = useState('');
  const {
    clearHostDownloads,
    downloads: mobileDownloads,
    downloadingMediaId,
    downloadPlayTarget,
    removeDownloadedTarget,
    targetWithOfflineDownload,
  } = useMobileDownloadsController({
    activeProfile,
    client: mobileLanClient,
    connection,
    isServerOffline,
  });

  const resetMediaSessionForProfileChange = (): void => {
    sessionGenerationRef.current += 1;
    mobileLanClient.cancelActiveRequests();
    clearCapturedMobileFocus();
    mandatoryPlayerTeardownRef.current();
    activeCatalogIdentityRef.current = 'profile:none:-1';
    detailItemCacheRef.current.clear();
    detailItemRequestsRef.current.clear();
    lastDetailByKindRef.current.clear();
    setDetailItem(null);
    setPosterCandidateSheet(null);
    setApplyingPosterCandidateId('');
    setMiniPlayerTarget(null);
    playerReturnItemRef.current = null;
    closingPlayerRef.current = false;
    setPlayTarget(null);
    setPlaybackUrl(null);
    setPlaybackFailure(null);
    setIsPreparingStream(false);
    setStreamOptions({});
    shouldAutoplayRef.current = false;
    userPausedRef.current = false;
    pendingSeekRef.current = 0;
    autoAdvancedEpisodeRef.current = null;
  };

  const enterProfilePicker = (mode: MobileProfilePickerMode, nextConnection?: Connection, selectionRevision?: number): void => {
    profileHydrationGenerationRef.current += 1;
    setProfilePinTarget(null);
    setProfilePin('');
    setProfileError('');
    if (mode !== 'voluntary') {
      resetMediaSessionForProfileChange();
      setActiveProfile(null);
      setAutomaticProfileSignIn(false);
      setProfileLists([]);
      setProgress({});
      setConnection((current) => {
        const base = nextConnection || current;
        return base
          ? { ...base, library: {}, libraryEtag: '', selectionRevision: selectionRevision ?? base.selectionRevision }
          : current;
      });
    }
    setProfilePickerMode(mode);
  };
  const initialResolvedThemeMode: ResolvedMobileThemeMode = 'dark';
  const [mobileTheme, setMobileTheme] = useState<MobileThemeColors>(() => (
    mobileThemeFromSettings(undefined, initialResolvedThemeMode)
  ));
  const [mobileThemeMode, setMobileThemeMode] = useState<MobileThemeMode>('dark');
  const [mobileThemeColor, setMobileThemeColor] = useState<MobileThemeColor>('yellow');
  const resolvedMobileThemeMode: ResolvedMobileThemeMode = mobileThemeMode === 'auto'
    ? (systemColorScheme === 'light' ? 'light' : 'dark')
    : mobileThemeMode;
  reconnectSavedConnectionHandlerRef.current = reconnectSavedConnection;
  pairWithDesktopHandlerRef.current = pairWithDesktop;
  checkDesktopConnectionHandlerRef.current = checkDesktopConnection;
  const themedStyles = useMemo(() => createStyles(mobileTheme), [mobileTheme]);
  const themeContextValue = useMemo(() => ({ colors: mobileTheme, styles: themedStyles }), [mobileTheme, themedStyles]);
  const styles = themedStyles;
  const { accent, panel, text, muted } = mobileTheme;

  const selectMobileTheme = useCallback((next: MobileThemeMode) => {
    setMobileThemeMode(next);
    void SecureStore.setItemAsync(MOBILE_THEME_MODE_KEY, next).catch(() => {});
  }, []);

  const selectMobileThemeColor = useCallback((next: MobileThemeColor) => {
    setMobileThemeColor(next);
    void SecureStore.setItemAsync(MOBILE_THEME_COLOR_KEY, next).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    void SecureStore.getItemAsync(MOBILE_THEME_MODE_KEY)
      .then((mode) => {
        if (!cancelled && (mode === 'auto' || mode === 'light' || mode === 'dark')) setMobileThemeMode(mode);
      })
      .catch(() => {});
    void SecureStore.getItemAsync(MOBILE_THEME_COLOR_KEY)
      .then((color) => {
        if (!cancelled && MOBILE_THEME_COLOR_OPTIONS.some((option) => option.value === color)) {
          setMobileThemeColor(color as MobileThemeColor);
        }
      })
      .catch(() => {});
    void SecureStore.getItemAsync(SAVED_CONNECTION_KEY)
      .then((stored) => {
        if (cancelled || !stored) return;
        const parsed = savedConnectionSchema.safeParse(JSON.parse(stored));
        if (!parsed.success) return;
        const saved = parsed.data;
        const certFingerprint = normalizeCertFingerprint(saved.certFingerprint);
        if (!certFingerprint || !saved.hostDeviceId) {
          invalidateCredentialRefresh();
          void SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
          if (saved.hostDeviceId) void clearMobileOfflineSnapshot(saved.hostDeviceId);
          setBaseUrl(saved.baseUrl);
          setError('This saved connection predates secure host identity. Select the server and approve pairing again.');
          setIsServerOffline(true);
          return;
        }
        const normalizedSaved = { ...saved, certFingerprint };
        setSavedConnection(normalizedSaved);
        setBaseUrl(normalizedSaved.baseUrl);
        void reconnectSavedConnectionHandlerRef.current(normalizedSaved);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsRestoringConnection(false);
      });
    return () => { cancelled = true; };
    // This runs once to restore the saved session; the callback only uses refs,
    // setters, and the saved value, so it is intentionally not reactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!savedConnection || (connection && !isServerOffline)) return;
    const discoveredSavedHost = discoveredHosts.find((host) => host.deviceId === savedConnection.hostDeviceId);
    if (discoveredSavedHost) {
      const reconciliation = reconcileSavedHost(savedConnection, discoveredSavedHost);
      if (reconciliation.kind === 'identity-mismatch') {
        setIsServerOffline(true);
        setError('Approve the refreshed connection on your LoomTV server.');
        return;
      }
      if (reconciliation.kind === 'unchanged') return;
      const updated = reconciliation.connection;
      invalidateCredentialRefresh();
      setSavedConnection(updated);
      setBaseUrl(updated.baseUrl);
      void SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(updated));
      void reconnectSavedConnectionHandlerRef.current(updated);
    }
    // Keep the reconnect cadence tied to saved-session state, not callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, discoveredHosts, isServerOffline, savedConnection]);

  useEffect(() => {
    if (appState !== 'active' || isPairing || isRestoringConnection || (connection && !isServerOffline)) return;
    const host = automaticDiscoveredHost(discoveredHosts, savedConnection);
    if (!host) return;
    if (savedConnection && reconcileSavedHost(savedConnection, host).kind !== 'identity-mismatch') return;

    const attemptKey = automaticHostAttemptKey(host);
    const delay = automaticHostAttemptDelay(automaticHostAttemptRef.current.get(attemptKey));
    const timer = setTimeout(() => {
      automaticHostAttemptRef.current.set(attemptKey, Date.now());
      setBaseUrl(host.baseUrl);
      setError('');
      void pairWithDesktopHandlerRef.current(host);
    }, delay);
    return () => clearTimeout(timer);
  }, [appState, automaticHostAttemptRef, connection, discoveredHosts, isPairing, isRestoringConnection, isServerOffline, pairWithDesktopHandlerRef, savedConnection, setBaseUrl, setError]);

  useEffect(() => {
    // Keep retrying a saved credential while the onboarding screen is visible.
    // A desktop restart can briefly fail the first request while its HTTPS
    // listener is coming back; onboarding must not turn that transient outage
    // into a new pairing/approval flow.
    if (!savedConnection || connectionLifecycleAction !== 'retry-saved') return;
    let cancelled = false;
    let failedAttempts = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delayMs: number) => {
      retry = setTimeout(() => { void tryReconnect(); }, delayMs);
    };
    const tryReconnect = async () => {
      if (cancelled || appStateRef.current !== 'active') return;
      const connected = await reconnectSavedConnectionHandlerRef.current(savedConnection);
      if (cancelled || connected || appStateRef.current !== 'active') return;
      schedule(mobileReconnectDelayMs(failedAttempts));
      failedAttempts += 1;
    };

    schedule(0);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
    // Keep the retry loop stable while the saved session remains unchanged.
  }, [appState, appStateRef, connectionLifecycleAction, reconnectSavedConnectionHandlerRef, savedConnection]);

  useEffect(() => {
    if (!connection || connectionLifecycleAction !== 'health-check') return;
    const healthCheck = setInterval(() => void checkDesktopConnectionHandlerRef.current(), 5_000);
    return () => clearInterval(healthCheck);
  }, [checkDesktopConnectionHandlerRef, connection, connectionLifecycleAction]);

  useEffect(() => {
    if (!savedConnection || !connection) return undefined;
    const delay = Math.max(0, connection.accessTokenExpiresAt - Date.now() - 60_000);
    const timer = setTimeout(() => {
      void refreshSavedCredentials(savedConnection).catch(async (nextError) => {
        if (isCredentialAuthorizationFailure(nextError)) {
          clearAuthorizedSession(savedConnection.hostDeviceId);
          setError('Your secure session expired. Pair with the LoomTV server again.');
          return;
        }
        setIsServerOffline(true);
        setError(MOBILE_ONBOARDING_OFFLINE_MESSAGE);
      });
    }, delay);
    return () => clearTimeout(timer);
    // The refresh timer is keyed to connection state; refresh helpers are intentionally non-reactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, savedConnection]);

  useEffect(() => {
    setMobileTheme(mobileThemeFromSettings({ appThemeColor: mobileThemeColor }, resolvedMobileThemeMode));
  }, [mobileThemeColor, resolvedMobileThemeMode]);

  const library = useMemo(() => connection?.library || {}, [connection?.library]);
  const grouped = useMemo(() => collections(library), [library]);
  const everything = useMemo(() => coreItems(library), [library]);

  useEffect(() => {
    if (!connection?.baseUrl || isServerOffline) return;
    const media = [...grouped.anime, ...grouped.tv, ...grouped.movies, ...grouped.others];
    const urls = Array.from(new Set(media.flatMap((item) => imageUrlsFor(connection.baseUrl, [
      item.poster,
      ...(item.posterCandidates || []),
      item.backdrop,
      ...(item.backdropCandidates || []),
      ...(item.episodeFiles || []).flatMap((episode) => [episode.still, episode.thumbnail]),
    ])))).slice(0, 240);
    if (urls.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (let index = 0; index < urls.length && !cancelled; index += 24) {
        await ExpoImage.prefetch(urls.slice(index, index + 24), 'disk');
      }
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [connection?.baseUrl, connection?.catalogRevision, grouped, isServerOffline]);
  const itemsById = useMemo(() => new Map(everything.map((item) => [item.id, item])), [everything]);
  const filterSource = useMemo(() => {
    if (activeKind === 'settings') return EMPTY_ITEMS;
    return activeKind === 'home' ? everything : grouped[activeKind === 'others' ? 'others' : activeKind];
  }, [activeKind, everything, grouped]);
  const hasActiveFilters = libraryFilter !== 'all';
  const progressOwnerByPath = useMemo(() => {
    const owners = new Map<string, MediaItem>();
    for (const item of everything) {
      owners.set(streamPathFor(item), item);
      for (const episode of item.episodeFiles || []) owners.set(episode.filePath, item);
    }
    return owners;
  }, [everything]);
  const continueWatching = useMemo(() => {
    const latestByItemId = new Map<string, { item: MediaItem; updatedAt: number }>();
    for (const [filePath, storedProgress] of Object.entries(progress)) {
      const item = progressOwnerByPath.get(filePath);
      const updatedAt = storedProgress?.updatedAt || 0;
      if (!item || updatedAt <= (latestByItemId.get(item.id)?.updatedAt || 0)) continue;
      latestByItemId.set(item.id, { item, updatedAt });
    }
    return [...latestByItemId.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 16)
      .map(({ item }) => item);
  }, [progress, progressOwnerByPath]);
  const mobileMyListItems = useMemo(() => {
    const seen = new Set<string>();
    return profileLists
      .filter((entry) => entry.kind === 'watchlist' || entry.kind === 'favorite')
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((entry) => {
        if (seen.has(entry.mediaId)) return false;
        seen.add(entry.mediaId);
        return true;
      })
      .map((entry) => itemsById.get(entry.mediaId))
      .filter((item): item is MediaItem => Boolean(item));
  }, [itemsById, profileLists]);
  const queryMatchedItems = useMemo(() => {
    if (activeKind === 'settings') return [];
    const source = searchOpen ? everything : filterSource;
    return source.filter((item) => (
      matchesQuery(item, query)
      && (!searchOpen || matchesMobileSearchScope(item, searchScope))
    ));
  }, [activeKind, everything, filterSource, query, searchOpen, searchScope]);
  const visibleItems = useMemo(() => {
    if (searchOpen || libraryFilter === 'all') return queryMatchedItems;
    return queryMatchedItems.filter((item) => matchesMobileLibraryFilter(item, libraryFilter, progress));
  }, [libraryFilter, progress, queryMatchedItems, searchOpen]);

  const activeCatalogIdentity = mobileCatalogIdentity(activeProfile?.id, connection?.catalogRevision);
  activeCatalogIdentityRef.current = activeCatalogIdentity;
  const catalogCacheKeyFor = useCallback((mediaId: string): string => (
    `${activeCatalogIdentity}:${mediaId}`
  ), [activeCatalogIdentity]);

  const resolveMobileDetailItem = useCallback(async (item: MediaItem): Promise<MediaItem> => {
    if (isServerOffline || !connection || item.catalogRevision === undefined || connection.catalogRevision === undefined) return item;
    const key = catalogCacheKeyFor(item.id);
    const cached = detailItemCacheRef.current.get(key);
    if (cached) {
      rememberMobileDetailItem(detailItemCacheRef.current, cached, key);
      return cached;
    }
    const pending = detailItemRequestsRef.current.get(key);
    if (pending) return pending;
    const requestIdentity = activeCatalogIdentityRef.current;

    const request = (async () => {
      const response = await mobileLanClient.getLibraryItem(
        connection.baseUrl,
        connection.deviceToken,
        item.id,
      );
      if (response.ok) {
        const payload = await readJsonResponse(response, mobileLibraryItemDetailsSchema, 'Library item details');
        if (payload.catalogVersion === 1 && payload.revision === connection.catalogRevision) {
          if (activeCatalogIdentityRef.current !== requestIdentity) return item;
          rememberMobileDetailItem(detailItemCacheRef.current, payload.item, key);
          return payload.item;
        }
        return item;
      }
      if (response.status !== 403 && response.status !== 404 && response.status !== 410 && response.status !== 501) {
        throw new Error(`Could not load media details (${response.status}).`);
      }

      legacyCatalogFallbackCountRef.current += 1;
      console.warn(`[catalog] Item details unavailable; using legacy library payload (fallback ${legacyCatalogFallbackCountRef.current}).`);
      const legacyResponse = await mobileLanClient.getLibrary(connection.baseUrl, connection.deviceToken);
      if (!legacyResponse.ok) return item;
      const legacyLibrary = await readJsonResponse(legacyResponse, mobileLibrarySchema, 'Legacy library');
      const detail = allItems(legacyLibrary).find((candidate) => candidate.id === item.id) || item;
      if (activeCatalogIdentityRef.current !== requestIdentity) return item;
      rememberMobileDetailItem(detailItemCacheRef.current, detail, key);
      return detail;
    })().finally(() => detailItemRequestsRef.current.delete(key));
    detailItemRequestsRef.current.set(key, request);
    return request;
  }, [catalogCacheKeyFor, connection, isServerOffline]);

  useEffect(() => {
    const activePrefix = `${activeProfile?.id || 'profile:none'}:${connection?.catalogRevision ?? -1}:`;
    for (const key of detailItemCacheRef.current.keys()) {
      if (!key.startsWith(activePrefix)) detailItemCacheRef.current.delete(key);
    }
    const currentDetails = new Map<LibraryKind, MediaItem>();
    for (const [kind, item] of lastDetailByKindRef.current) {
      const currentItem = itemsById.get(item.id);
      const cached = detailItemCacheRef.current.get(catalogCacheKeyFor(item.id));
      if (cached || currentItem) currentDetails.set(kind, cached || currentItem as MediaItem);
    }
    lastDetailByKindRef.current = currentDetails;
  }, [activeProfile?.id, catalogCacheKeyFor, connection?.catalogRevision, itemsById, lastDetailByKindRef]);

  const openDetailItem = useCallback((item: MediaItem) => {
    const key = catalogCacheKeyFor(item.id);
    const requestIdentity = activeCatalogIdentityRef.current;
    const cached = detailItemCacheRef.current.get(key) || item;
    lastDetailByKindRef.current.set(activeKind, cached);
    setFilterOpen(false);
    setDetailItem(cached);
    if (cached.catalogRevision !== undefined) {
      void resolveMobileDetailItem(cached)
        .then((details) => {
          if (activeCatalogIdentityRef.current !== requestIdentity) return;
          lastDetailByKindRef.current.set(activeKind, details);
          setDetailItem((current) => current?.id === details.id ? details : current);
        })
        .catch((nextError) => setError(nextError instanceof Error ? nextError.message : 'Could not load media details.'));
    }
  }, [activeKind, catalogCacheKeyFor, lastDetailByKindRef, resolveMobileDetailItem, setDetailItem, setError, setFilterOpen]);

  useEffect(() => {
    if (!detailItem || detailItem.catalogRevision === undefined) return;
    let cancelled = false;
    const requestIdentity = activeCatalogIdentityRef.current;
    void resolveMobileDetailItem(detailItem)
      .then((details) => {
        if (cancelled || activeCatalogIdentityRef.current !== requestIdentity) return;
        lastDetailByKindRef.current.set(activeKind, details);
        setDetailItem((current) => current?.id === details.id ? details : current);
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : 'Could not load media details.');
      });
    return () => { cancelled = true; };
  }, [activeKind, detailItem, lastDetailByKindRef, resolveMobileDetailItem, setDetailItem, setError]);

  const closeDetail = useCallback(() => {
    lastDetailByKindRef.current.delete(activeKind);
    setDetailItem(null);
  }, [activeKind, lastDetailByKindRef, setDetailItem]);

  const setMobileProfileListEntry = useCallback(async (
    mediaId: string,
    kind: 'watchlist' | 'favorite',
    present: boolean,
  ) => {
    if (!connection) return;
    if (isServerOffline) throw new Error('Reconnect to the LoomTV server before changing My List.');
    const isCurrent = captureSession();
    let response = await mobileLanClient.setProfileList(
      connection.baseUrl,
      connection.deviceToken,
      mediaId,
      kind,
      present,
      connection.selectionRevision,
    );
    if (!response.ok) throw new Error('The profile list could not be updated.');
    let nextLists = await readJsonResponse(response, mobileProfileListSchema, 'Profile list update');
    if (!isCurrent()) return;
    if (kind === 'watchlist' && !present) {
      response = await mobileLanClient.setProfileList(
        connection.baseUrl,
        connection.deviceToken,
        mediaId,
        'favorite',
        false,
        connection.selectionRevision,
      );
      if (!response.ok) throw new Error('The profile list could not be updated.');
      nextLists = await readJsonResponse(response, mobileProfileListSchema, 'Profile list update');
    }
    if (isCurrent()) setProfileLists(nextLists);
  }, [captureSession, connection, isServerOffline, setProfileLists]);

  const playHomeItem = useCallback((item: MediaItem) => {
    if (isServerOffline) {
      const offlineTarget = targetWithOfflineDownload(playTargetForItem(item, progress));
      if (!offlineTarget) {
        setError('This title is not downloaded. Reconnect to the LoomTV server to play it.');
        return;
      }
      playerReturnItemRef.current = item;
      setDetailItem(null);
      setMiniPlayerTarget(null);
      setStreamOptions({});
      setPlayTarget(offlineTarget);
      return;
    }
    const requestIdentity = activeCatalogIdentityRef.current;
    void resolveMobileDetailItem(item)
      .then((details) => {
        if (activeCatalogIdentityRef.current !== requestIdentity) return;
        playerReturnItemRef.current = details;
        setDetailItem(null);
        setMiniPlayerTarget(null);
        setStreamOptions({});
        setPlayTarget(playTargetForItem(details, progress));
      })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : 'Could not prepare playback.'));
  }, [isServerOffline, playerReturnItemRef, progress, resolveMobileDetailItem, setDetailItem, setError, setMiniPlayerTarget, setPlayTarget, setStreamOptions, targetWithOfflineDownload]);

  const connectionBaseUrl = connection?.baseUrl;
  const connectionDeviceToken = connection?.deviceToken;
  const connectionSelectionRevision = connection?.selectionRevision;
  const syncPlaybackProgress = useCallback(async (target = playTarget) => {
    if (!connectionBaseUrl || !connectionDeviceToken || !target) return;
    let position: number;
    let duration: number;
    try {
      position = Number(player.currentTime || 0);
      duration = Number(player.duration || 0);
    } catch {
      return;
    }
    if (!Number.isFinite(position) || position <= 0) return;

    try {
      const response = await mobileLanClient.saveProgress(connectionBaseUrl, connectionDeviceToken, {
        mediaId: mediaIdForPlayTarget(target),
        position,
        duration: Number.isFinite(duration) ? duration : 0,
        selectionRevision: connectionSelectionRevision,
      });
      if (!response.ok) return;

      const stored = await readJsonResponse(response, mobileStoredProgressSchema, 'Playback progress');
      const playedAt = Date.now();
      setProgress((current) => ({
        ...current,
        [filePathFromUrl(target.streamPath)]: stored,
      }));
      setConnection((current) => current
        ? { ...current, library: libraryWithPlayedItem(current.library, target.streamPath, playedAt) }
        : current);
    } catch (error) {
      // Progress sync should never interrupt playback.
      reportNonFatal('progress.local-sync', error);
    }
  }, [connectionBaseUrl, connectionDeviceToken, connectionSelectionRevision, playTarget, player, setConnection, setProgress]);

  useEffect(() => {
    if (playbackUrl) {
      shouldAutoplayRef.current = true;
      userPausedRef.current = false;
      pendingSeekRef.current = streamOptions.startSeconds ?? playTarget?.startPosition ?? 0;
    } else {
      shouldAutoplayRef.current = false;
      pendingSeekRef.current = 0;
    }
  }, [pendingSeekRef, playbackUrl, playTarget?.startPosition, shouldAutoplayRef, streamOptions.startSeconds, userPausedRef]);

  useEffect(() => {
    const currentFilePath = playTarget ? filePathFromUrl(playTarget.streamPath) : null;
    if (autoAdvancedEpisodeRef.current !== currentFilePath) {
      autoAdvancedEpisodeRef.current = null;
    }
  }, [autoAdvancedEpisodeRef, playTarget]);

  useEffect(() => {
    let cancelled = false;

    async function loadSource() {
      const source = playbackUrl
        ? videoSourceFor(playbackUrl, playTarget, connection?.deviceToken)
        : null;
      const result = await replaceMobilePlayerSource(
        (nextSource) => player.replaceAsync(nextSource),
        source,
        () => !cancelled,
      );
      if (result === 'failed') setPlaybackFailure(playbackLoadFailure());
    }

    void loadSource();
    return () => {
      cancelled = true;
    };
  }, [connection?.deviceToken, playbackUrl, playTarget, player, setPlaybackFailure]);

  useEffect(() => {
    if (!playbackUrl) return;

    const retryWithCompatibleStream = () => {
      if (isHlsPlaybackUrl(playbackUrl) || streamOptions.forceTranscode) return false;

      let resumePosition = 0;
      try {
        resumePosition = Number(player.currentTime || pendingSeekRef.current || 0);
      } catch {
        resumePosition = pendingSeekRef.current || 0;
      }

      shouldAutoplayRef.current = true;
      userPausedRef.current = false;
      setPlaybackUrl(null);
      setPlaybackFailure(null);
      setStreamOptions((current) => ({
        ...current,
        forceTranscode: true,
        ...(resumePosition > 2 ? { startSeconds: resumePosition } : {}),
      }));
      return true;
    };

    const directPlaybackTimeout = !isHlsPlaybackUrl(playbackUrl) && !streamOptions.forceTranscode
      ? setTimeout(() => {
          if (player.status !== 'readyToPlay') retryWithCompatibleStream();
        }, 12000)
      : null;

    const statusSubscription = player.addListener?.('statusChange', (payload: {
      status: VideoPlayerStatus;
      error?: PlayerError;
    }) => {
      if (payload.status === 'error') {
        if (directPlaybackTimeout) clearTimeout(directPlaybackTimeout);
        if (retryWithCompatibleStream()) return;

        shouldAutoplayRef.current = false;
        setPlaybackUrl(null);
        setPlaybackFailure(playbackLoadFailure());
        return;
      }

      if (payload.status === 'readyToPlay' && shouldAutoplayRef.current && !userPausedRef.current) {
        if (directPlaybackTimeout) clearTimeout(directPlaybackTimeout);
        try {
          if (pendingSeekRef.current > 10) {
            player.currentTime = pendingSeekRef.current;
          }
          pendingSeekRef.current = 0;
          player.play();
          shouldAutoplayRef.current = false;
        } catch (error) {
          // Native player readiness can lag behind this callback on some devices.
          reportNonFatal('player.autoplay', error);
        }
      }
    });

    const playingSubscription = player.addListener?.('playingChange', (event: { isPlaying: boolean }) => {
      if (event.isPlaying) {
        userPausedRef.current = false;
      }
    });

    const sourceChangeSubscription = player.addListener?.('sourceChange', () => {
      shouldAutoplayRef.current = true;
      userPausedRef.current = false;
    });

    const endSubscription = player.addListener?.('playToEnd', () => {
      const endedTarget = playTarget;
      const currentFilePath = endedTarget ? filePathFromUrl(endedTarget.streamPath) : '';
      if (currentFilePath && autoAdvancedEpisodeRef.current === currentFilePath) return;

      const currentItem = endedTarget?.mediaId
        ? allItems(connection?.library || {}).find((item) => item.id === endedTarget.mediaId)
        : undefined;
      if (currentItem && currentItem.type !== 'movie' && endedTarget?.season !== undefined && endedTarget.episode !== undefined) {
        const episodeFiles = sortedEpisodes(currentItem);
        const currentIndex = episodeFiles.findIndex((episode) =>
          episode.season === endedTarget.season && episode.episode === endedTarget.episode,
        );
        const nextEpisode = currentIndex >= 0 ? episodeFiles[currentIndex + 1] : undefined;
        if (nextEpisode) {
          void syncPlaybackProgress(endedTarget);
          autoAdvancedEpisodeRef.current = currentFilePath;
          playerReturnItemRef.current = currentItem;
          shouldAutoplayRef.current = true;
          userPausedRef.current = false;
          setPlaybackFailure(null);
          setPlaybackUrl(null);
          setStreamOptions({});
          setPlayTarget(episodePlayTarget(currentItem, nextEpisode, progress));
          return;
        }
      }

      shouldAutoplayRef.current = false;
    });

    return () => {
      if (directPlaybackTimeout) clearTimeout(directPlaybackTimeout);
      statusSubscription?.remove?.();
      playingSubscription?.remove?.();
      sourceChangeSubscription?.remove?.();
      endSubscription?.remove?.();
    };
  }, [autoAdvancedEpisodeRef, connection?.library, pendingSeekRef, playbackUrl, playerReturnItemRef, playTarget, player, progress, setPlayTarget, setPlaybackFailure, setPlaybackUrl, setStreamOptions, shouldAutoplayRef, streamOptions.forceTranscode, syncPlaybackProgress, userPausedRef]);

  useEffect(() => {
    if (!playbackUrl) return;

    if (shouldAutoplayRef.current && !userPausedRef.current) {
      try {
        player.play();
      } catch (error) {
        // player may not be ready yet; the status listener will retry when ready.
        reportNonFatal('player.retry-play', error);
      }
    }
  }, [playbackUrl, player, shouldAutoplayRef, userPausedRef]);

  // Only prepare/transcode a stream when the user actually opens the player —
  // browsing the library no longer kicks off a transcode for every tap.
  useEffect(() => {
    let cancelled = false;
    const requestController = new AbortController();

    async function prepareStream() {
      if (!playTarget) {
        setPlaybackUrl(null);
        return;
      }

      if (playTarget.offlineUri) {
        setPlaybackFailure(null);
        setIsPreparingStream(false);
        setPlaybackUrl(playTarget.offlineUri);
        return;
      }

      if (!connection?.baseUrl || !connection.deviceToken) {
        setPlaybackUrl(null);
        return;
      }

      setPlaybackFailure(null);
      setIsPreparingStream(true);
      try {
        const startSeconds = streamOptions.startSeconds ?? playTarget.startPosition ?? 0;
        const options: StreamOptions = {
          ...streamOptions,
          forceTranscode: playTarget.transcode || hasStreamOptions(streamOptions),
          ...(startSeconds > 2 ? { startSeconds } : {}),
        };
        const response = await mobileLanClient.startHls(
          connection.baseUrl,
          connection.deviceToken,
          mediaIdForPlayTarget(playTarget),
          options,
          connection.selectionRevision,
          requestController.signal,
        );
        const result = await readJsonResponse(response, hlsSessionResultSchema, 'HLS session');
        if (!response.ok || !result.ok || !result.data?.playlistUrl) {
          if (!cancelled) {
            setPlaybackUrl(null);
            setPlaybackFailure(playbackFailureFromResponse(response.status, result));
          }
          return;
        }
        if (!cancelled) setPlaybackUrl(playbackUrlWithAnchor(result.data.playlistUrl, options.startSeconds));
      } catch (nextError) {
        if (!cancelled) {
          setPlaybackUrl(null);
          setPlaybackFailure(playbackFailureFromUnknown(nextError));
        }
      } finally {
        if (!cancelled) setIsPreparingStream(false);
      }
    }

    void prepareStream();
    return () => {
      cancelled = true;
      requestController.abort();
    };
  }, [connection?.baseUrl, connection?.deviceToken, connection?.selectionRevision, playTarget, setIsPreparingStream, setPlaybackFailure, setPlaybackUrl, streamOptions, streamRetryNonce]);

  const retryPlayback = useCallback(() => {
    setPlaybackFailure(null);
    setPlaybackUrl(null);
    setStreamRetryNonce((current) => current + 1);
  }, [setPlaybackFailure, setPlaybackUrl, setStreamRetryNonce]);

  const closePlayer = useCallback(async () => {
    if (closingPlayerRef.current) return;
    closingPlayerRef.current = true;
    const isCurrent = captureSession();

    // Keep the player mounted until Expo confirms the portrait lock. This
    // prevents the library from being revealed in a stale landscape layout.
    let resumePosition = 0;
    try {
      resumePosition = Number(player.currentTime || 0);
      player.pause();
    } catch (error) {
      // ignore — player may already be torn down
      reportNonFatal('player.close-pause', error);
    }
    const target = playTarget;
    const returnItem = playerReturnItemRef.current;
    const returnItemId = returnItem?.id || target?.mediaId || '';
    void syncPlaybackProgress(playTarget || undefined);

    const portraitLock = ScreenOrientation.OrientationLock.PORTRAIT_UP;
    desiredOrientationLockRef.current = portraitLock;
    await orientationLockQueueRef.current.catch(() => {});
    const portraitRestored = await restorePortraitWithRetry(
      () => ScreenOrientation.lockAsync(portraitLock),
      () => ScreenOrientation.unlockAsync(),
    );
    appliedOrientationLockRef.current = portraitRestored ? portraitLock : null;

    // lockAsync can resolve before React Native publishes the new window frame.
    // Keep the black player overlay mounted until the portrait-sized root has
    // committed so the library never appears with the old landscape height.
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (windowSizeRef.current.height >= windowSizeRef.current.width) break;
    }

    if (!isCurrent()) return;
    try {
      setPlayTarget(null);
      setPlaybackUrl(null);
      setStreamOptions({});
      setPlaybackFailure(null);
      if (target && !playbackFailure) {
        setMiniPlayerTarget({
          ...target,
          startPosition: Number.isFinite(resumePosition) && resumePosition > 0
            ? resumePosition
            : target.startPosition,
        });
      }
      playerReturnItemRef.current = null;
      if (returnItemId && detailItem?.id !== returnItemId) {
        const cachedReturnItem = returnItem
          || detailItemCacheRef.current.get(catalogCacheKeyFor(returnItemId))
          || itemsById.get(returnItemId);
        if (cachedReturnItem) {
          lastDetailByKindRef.current.set(activeKind, cachedReturnItem);
          setDetailItem(cachedReturnItem);
        }
      }
    } finally {
      closingPlayerRef.current = false;
    }
  }, [captureSession, activeKind, appliedOrientationLockRef, catalogCacheKeyFor, closingPlayerRef, desiredOrientationLockRef, detailItem?.id, itemsById, lastDetailByKindRef, orientationLockQueueRef, playerReturnItemRef, playTarget, playbackFailure, player, setDetailItem, setMiniPlayerTarget, setPlayTarget, setPlaybackFailure, setPlaybackUrl, setStreamOptions, syncPlaybackProgress, windowSizeRef]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const topModal = topMobileModalLayer();
      if (topModal) {
        topModal.onBack();
        return true;
      }
      if (playTarget) {
        void closePlayer();
        return true;
      }
      if (detailItem) {
        closeDetail();
        return true;
      }
      if (activeKind !== 'home') {
        setActiveKind('home');
        return true;
      }
      return false;
    });

    return () => subscription.remove();
  }, [activeKind, closeDetail, closePlayer, detailItem, playTarget, setActiveKind]);

  useEffect(() => {
    if (!playTarget || !playbackUrl) return undefined;
    const interval = setInterval(() => {
      void syncPlaybackProgress(playTarget);
    }, 15000);
    return () => clearInterval(interval);
  }, [playTarget, playbackUrl, syncPlaybackProgress]);

  function invalidateCredentialRefresh(): void {
    credentialRefreshKeyRef.current = '';
    credentialRefreshPromiseRef.current = null;
  }

  async function hydrateProgress(nextConnection = connection) {
    if (!nextConnection) return;
    try {
      const response = await mobileLanClient.getProgress(nextConnection.baseUrl, nextConnection.deviceToken);
      if (!response.ok) return;
      setProgress(await readJsonResponse(response, mobileProgressMapSchema, 'Playback progress'));
    } catch (error) {
      // Progress is additive UI state; pairing and browsing should still work without it.
      reportNonFatal('progress.remote-load', error);
    }
  }

  async function refreshSavedCredentials(saved: SavedConnection): Promise<SavedConnection> {
    const refreshKey = `${saved.hostDeviceId}:${saved.deviceId}:${saved.baseUrl}:${saved.refreshToken}`;
    if (credentialRefreshPromiseRef.current?.key === refreshKey) {
      return credentialRefreshPromiseRef.current.promise;
    }
    credentialRefreshKeyRef.current = refreshKey;

    const refresh = (async () => {
      const currentDeviceName = mobileDeviceName();
      const response = await mobileLanClient.refreshCredentials(saved.baseUrl, saved.refreshToken, currentDeviceName);
      if (!response.ok) throw new MobileCredentialRefreshError(response.status);
      const payload = await readJsonResponse(response, refreshedCredentialsSchema, 'Credential refresh');
      const updated: SavedConnection = {
        ...saved,
        deviceToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
        refreshToken: payload.refreshToken,
        refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
        clientDeviceName: currentDeviceName,
      };
      if (credentialRefreshKeyRef.current !== refreshKey) {
        throw new Error('Credential refresh was superseded by another connection.');
      }
      await SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(updated));
      setSavedConnection(updated);
      setConnection((current) => current && current.deviceId === updated.deviceId
        ? { ...current, ...updated }
        : current);
      return updated;
    })();
    const tracked = refresh.finally(() => {
      if (credentialRefreshPromiseRef.current?.key === refreshKey) credentialRefreshPromiseRef.current = null;
    });
    credentialRefreshPromiseRef.current = { key: refreshKey, promise: tracked };
    return tracked;
  }

  const requestMobileCatalog = (nextConnection: Connection, etag = '') => fetchMobileCatalog(
    mobileLanClient,
    nextConnection,
    {
      etag,
      onLegacyFallback: () => {
        legacyCatalogFallbackCountRef.current += 1;
        console.warn(`[catalog] Compact index unavailable; using legacy library payload (fallback ${legacyCatalogFallbackCountRef.current}).`);
      },
    },
  );

  async function hydrateSelectedProfile(
    nextConnection: Connection,
    profile: MobileProfile,
    activeState?: MobileActiveProfile,
    selectionGeneration?: number,
  ): Promise<boolean> {
    const generation = selectionGeneration ?? ++profileHydrationGenerationRef.current;
    const [catalog, progressResponse, preferencesResponse, listsResponse] = await Promise.all([
      requestMobileCatalog(nextConnection),
      mobileLanClient.getProgress(nextConnection.baseUrl, nextConnection.deviceToken),
      mobileLanClient.getProfilePreferences(nextConnection.baseUrl, nextConnection.deviceToken),
      mobileLanClient.getProfileLists(nextConnection.baseUrl, nextConnection.deviceToken),
    ]);
    const nextProgress = progressResponse.ok
      ? await readJsonResponse(progressResponse, mobileProgressMapSchema, 'Playback progress')
      : {};
    const nextPreferences = preferencesResponse.ok
      ? await readJsonResponse(preferencesResponse, mobileProfilePreferencesSchema, 'Profile preferences')
      : null;
    const nextLists = listsResponse.ok
      ? await readJsonResponse(listsResponse, mobileProfileListSchema, 'Profile lists')
      : [];
    if (generation !== profileHydrationGenerationRef.current) return false;
    if (catalog.status !== 'ok') {
      if (catalog.status === 'profile-required') {
        enterProfilePicker('profile-required', nextConnection, activeState?.selectionRevision);
        setError('Choose a profile to continue.');
        setIsOnboarding(false);
        setIsServerOffline(false);
        return false;
      }
      throw new Error('Desktop sharing is unavailable.');
    }
    const hydratedConnection = {
      ...nextConnection,
      library: catalog.library,
      libraryEtag: catalog.etag,
      catalogRevision: catalog.revision,
      catalogTransport: catalog.transport,
      selectionRevision: activeState?.selectionRevision ?? nextConnection.selectionRevision,
    };
    setConnection(hydratedConnection);
    setIsOnboarding(false);
    setIsServerOffline(false);
    setOfflineSnapshotSavedAt(null);
    setActiveProfile(profile);
    setAutomaticProfileSignIn(Boolean(activeState?.automaticSignIn));
    setProfilePickerMode(null);
    setProfilePinTarget(null);
    setProfilePin('');
    setProfileError('');
    setProgress(nextProgress);
    if (nextPreferences) {
      const preferences = nextPreferences;
      if (preferences.appThemeMode) setMobileThemeMode(preferences.appThemeMode);
      if (preferences.appThemeColor && MOBILE_THEME_COLOR_OPTIONS.some((option) => option.value === preferences.appThemeColor)) {
        setMobileThemeColor(preferences.appThemeColor as MobileThemeColor);
      }
    }
    setProfileLists(nextLists);
    return true;
  }

  async function selectMobileProfile(nextConnection: Connection, profile: MobileProfile, pin?: string): Promise<void> {
    const selectionGeneration = ++profileHydrationGenerationRef.current;
    setProfileError('');
    const response = await mobileLanClient.selectProfile(nextConnection.baseUrl, nextConnection.deviceToken, {
      profileId: profile.id,
      ...(pin ? { pin } : {}),
    });
    if (!response.ok) {
      const payload = await readErrorResponse(response, 'Profile selection');
      if (payload.error === 'profile_locked') {
        const wait = payload.retryAfterMs ? ` Try again in ${Math.ceil(payload.retryAfterMs / 1000)} seconds.` : '';
        throw new Error(`That PIN could not be accepted.${wait}`);
      }
      throw new Error('That profile could not be selected.');
    }
    const payload = await readJsonResponse(response, mobileProfileSelectionSchema, 'Profile selection');
    if (selectionGeneration !== profileHydrationGenerationRef.current) return;
    enterProfilePicker('profile-required', nextConnection, payload.active.selectionRevision);
    await hydrateSelectedProfile(nextConnection, payload.profile, payload.active, profileHydrationGenerationRef.current);
  }

  async function initializeProfiles(nextConnection: Connection): Promise<boolean> {
    const configResponse = await mobileLanClient.getClientConfig(nextConnection.baseUrl, nextConnection.deviceToken);
    if (!configResponse.ok) return false;
    const profilesResponse = await mobileLanClient.getProfiles(nextConnection.baseUrl, nextConnection.deviceToken);
    if (!profilesResponse.ok) return false;
    const payload = await readJsonResponse(profilesResponse, mobileProfilesPayloadSchema, 'Profiles');
    setProfiles(payload.profiles);
    const activeResponse = await mobileLanClient.getActiveProfile(nextConnection.baseUrl, nextConnection.deviceToken);
    const activeState = activeResponse.ok
      ? await readJsonResponse(activeResponse, mobileActiveProfileSchema, 'Active profile')
      : null;
    const selected = payload.profiles.find((profile) => profile.id === activeState?.profileId);
    if (selected && activeState?.automaticSignIn) {
      await hydrateSelectedProfile(nextConnection, selected, activeState || undefined);
      return true;
    }
    enterProfilePicker('startup', nextConnection, activeState?.selectionRevision);
    return true;
  }

  async function refreshProfiles(nextConnection: Connection): Promise<void> {
    try {
      const response = await mobileLanClient.getProfiles(nextConnection.baseUrl, nextConnection.deviceToken);
      if (!response.ok) return;
      const payload = await readJsonResponse(response, mobileProfilesPayloadSchema, 'Profiles');
      setProfiles(payload.profiles);
      setActiveProfile((current) => current
        ? payload.profiles.find((profile) => profile.id === current.id) || current
        : current);
    } catch (error) {
      // Profile updates are opportunistic; the existing connection check reports real outages.
      reportNonFatal('profile.opportunistic-update', error);
    }
  }

  async function restoreOfflineConnection(saved: SavedConnection): Promise<boolean> {
    if (saved.refreshTokenExpiresAt <= Date.now()) {
      await clearMobileOfflineSnapshot(saved.hostDeviceId);
      return false;
    }
    const snapshot = await loadMobileOfflineSnapshot(saved.hostDeviceId);
    if (!snapshot) return false;
    if (!canRestoreMobileOfflineSnapshot(snapshot)) {
      await clearMobileOfflineSnapshot(saved.hostDeviceId);
      return false;
    }

    setConnection({
      ...saved,
      library: snapshot.library,
      libraryEtag: snapshot.libraryEtag,
      catalogRevision: snapshot.catalogRevision,
      catalogTransport: snapshot.catalogTransport,
      selectionRevision: snapshot.selectionRevision,
    });
    setProfiles(snapshot.profiles);
    setActiveProfile(snapshot.activeProfile);
    setAutomaticProfileSignIn(snapshot.automaticProfileSignIn);
    setProfileLists(snapshot.profileLists);
    setProgress(snapshot.progress);
    setProfilePickerMode(null);
    setIsOnboarding(false);
    setBaseUrl(saved.baseUrl);
    setOfflineSnapshotSavedAt(snapshot.savedAt);
    setIsServerOffline(true);
    setError(`Offline library from ${formatOfflineSnapshotTime(snapshot.savedAt)}. Reconnecting.`);
    return true;
  }

  async function reconnectSavedConnection(saved: SavedConnection): Promise<boolean> {
    if (appStateRef.current !== 'active' || reconnectingSavedConnectionRef.current) return false;
    reconnectingSavedConnectionRef.current = true;
    setIsRestoringConnection(true);
    let finishReconnect: (() => void) | undefined;
    const reconnectCompletion = new Promise<void>((resolve) => { finishReconnect = resolve; });
    savedReconnectCompletionRef.current = reconnectCompletion;
    try {
      const certFingerprint = saved.certFingerprint;
      // The native loopback proxy can be reclaimed while iOS backgrounds the
      // app even though its old URL remains cached in JavaScript. Rebuild it
      // for every offline recovery so retries never stay pinned to a dead port.
      await stopSecureLanTransport();
      await configureSecureLanTransport(saved.baseUrl, certFingerprint);
      let activeSaved = saved.accessTokenExpiresAt <= Date.now() + 60_000
        || saved.clientDeviceName !== mobileDeviceName()
        ? await refreshSavedCredentials(saved)
        : saved;
      let baseConnection: Connection = { ...activeSaved, library: {}, libraryEtag: '' };
      const profileInitialized = await initializeProfiles(baseConnection);
      if (profileInitialized) {
        setBaseUrl(baseConnection.baseUrl);
        setError('');
        setIsOnboarding(false);
        setIsServerOffline(false);
        setOfflineSnapshotSavedAt(null);
        return true;
      }
      let catalog = await requestMobileCatalog(baseConnection);
      if (catalog.status === 'unauthorized') {
        activeSaved = await refreshSavedCredentials(activeSaved);
        baseConnection = { ...activeSaved, library: {}, libraryEtag: '' };
        if (await initializeProfiles(baseConnection)) {
          setBaseUrl(baseConnection.baseUrl);
          setError('');
          setIsOnboarding(false);
          setIsServerOffline(false);
          setOfflineSnapshotSavedAt(null);
          return true;
        }
        catalog = await requestMobileCatalog(baseConnection);
      }
      if (catalog.status === 'unauthorized') {
        clearAuthorizedSession(saved.hostDeviceId);
        setError('This device is no longer authorized. Select the server and approve pairing again.');
        return true;
      }
      if (catalog.status === 'profile-required') {
        enterProfilePicker('profile-required', baseConnection);
        setBaseUrl(baseConnection.baseUrl);
        setError('Choose a profile to continue.');
        setIsOnboarding(false);
        setIsServerOffline(false);
        return true;
      }
      if (catalog.status !== 'ok') throw new Error('Desktop sharing is unavailable.');
      const nextConnection: Connection = {
        ...activeSaved,
        library: catalog.library,
        libraryEtag: catalog.etag,
        catalogRevision: catalog.revision,
        catalogTransport: catalog.transport,
      };
      setConnection(nextConnection);
      setBaseUrl(nextConnection.baseUrl);
      setError('');
      setIsOnboarding(false);
      setIsServerOffline(false);
      setOfflineSnapshotSavedAt(null);
      void hydrateProgress(nextConnection);
      return true;
    } catch (nextError) {
      if (isCredentialAuthorizationFailure(nextError)) {
        clearAuthorizedSession(saved.hostDeviceId);
        setError('Your secure session expired. Select the server and approve pairing again.');
        setIsServerOffline(false);
        return true;
      }
      const connectionError = connectionErrorFor(nextError, 'The paired LoomTV server is unavailable.', 'MOBILE-RESTORE');
      if (connectionError.isCancelled) return false;
      reportNonFatal('connection.restore', nextError);
      if (connectionError.isOffline && await restoreOfflineConnection(saved)) return false;
      returnToOnboarding();
      setIsServerOffline(connectionError.isOffline);
      setError(connectionError.isOffline ? '' : connectionError.message);
      return false;
    } finally {
      reconnectingSavedConnectionRef.current = false;
      finishReconnect?.();
      if (savedReconnectCompletionRef.current === reconnectCompletion) savedReconnectCompletionRef.current = null;
      setIsRestoringConnection(false);
    }
  }

  async function pairWithDesktop(discoveredHost?: DiscoveredHost) {
    const preserveOfflineSnapshot = Boolean(connection && isServerOffline);
    setError('');
    if (!preserveOfflineSnapshot) setIsServerOffline(false);
    setIsPairing(true);
    try {
      const host = discoveredHost && typeof discoveredHost.baseUrl === 'string' ? discoveredHost : undefined;
      const nextBaseUrl = normalizeBaseUrl(host?.baseUrl || baseUrl);
      const observedFingerprint = host?.certFingerprint
        ? host.certFingerprint.replace(/[^0-9a-f]/gi, '').toLowerCase()
        : await probeLanCertificate(nextBaseUrl);
      await configureSecureLanTransport(nextBaseUrl, observedFingerprint);

      let response = await mobileLanClient.pair(nextBaseUrl, {
        approvalRequested: true,
        deviceName: mobileDeviceName(),
      });
      if (response.status === 202) {
        setShareCode('');
        const approval = await readJsonResponse(
          response,
          mobilePairApprovalRequestSchema,
          'Pairing approval',
        );
        response = await waitForPairingApproval(nextBaseUrl, approval);
      }
      if (!response.ok) {
        const failure = await readErrorResponse(response, 'Pairing');
        const failureMessage = failure.message || failure.error;
        if (response.status === 403 && failure.status === 'denied') {
          throw new Error('Connection was not approved.');
        }
        if (response.status === 401) {
          throw new Error(host
            ? 'Update the LoomTV server, or connect manually.'
            : 'The server did not accept this pairing request.');
        }
        if (response.status === 429) {
          if (failureMessage) throw new Error(failureMessage);
          const retryAfterSeconds = Number.parseInt(response.headers.get('Retry-After') || '', 10);
          const waitMinutes = Number.isFinite(retryAfterSeconds) ? Math.max(1, Math.ceil(retryAfterSeconds / 60)) : 5;
          throw new Error(`Too many failed attempts. Wait ${waitMinutes} minutes, then request approval again.`);
        }
        throw new Error(failureMessage || `Could not pair with the LoomTV server (${response.status}).`);
      }

      const payload = await readJsonResponse(response, mobilePairResponseSchema, 'Pairing');
      const discoveredPairHost = host || discoveredHosts.find((candidate) => candidate.baseUrl === nextBaseUrl);
      const certFingerprint = validatePairIdentity(payload, observedFingerprint, discoveredPairHost);
      const nextConnection = {
        baseUrl: nextBaseUrl,
        deviceId: payload.deviceId,
        deviceToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
        refreshToken: payload.refreshToken,
        refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
        certFingerprint,
        hostDeviceId: payload.hostDeviceId || discoveredPairHost?.deviceId || '',
        hostDeviceName: payload.hostDeviceName || 'LoomTV server',
        clientDeviceName: mobileDeviceName(),
        library: payload.library || {},
        libraryEtag: payload.libraryEtag,
      } satisfies Connection;
      const nextSavedConnection = {
        baseUrl: nextConnection.baseUrl,
        deviceId: nextConnection.deviceId,
        deviceToken: nextConnection.deviceToken,
        accessTokenExpiresAt: nextConnection.accessTokenExpiresAt,
        refreshToken: nextConnection.refreshToken,
        refreshTokenExpiresAt: nextConnection.refreshTokenExpiresAt,
        certFingerprint: nextConnection.certFingerprint,
        hostDeviceId: nextConnection.hostDeviceId,
        hostDeviceName: nextConnection.hostDeviceName,
        clientDeviceName: nextConnection.clientDeviceName,
      } satisfies SavedConnection;
      credentialRefreshPromiseRef.current = null;
      credentialRefreshKeyRef.current = `${nextSavedConnection.hostDeviceId}:${nextSavedConnection.deviceId}:${nextSavedConnection.baseUrl}:${nextSavedConnection.refreshToken}`;
      await SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(nextSavedConnection));
      setSavedConnection(nextSavedConnection);
      setShareCode('');
      setIsOnboarding(false);
      setIsServerOffline(false);
      setOfflineSnapshotSavedAt(null);
      if (!await initializeProfiles(nextConnection)) {
        setConnection(nextConnection);
        void hydrateProgress(nextConnection);
      }
    } catch (nextError) {
      const connectionError = connectionErrorFor(nextError, 'Pairing failed.', 'MOBILE-PAIRING');
      if (connectionError.isCancelled) return;
      reportNonFatal('connection.pairing', nextError);
      setError(connectionError.isOffline ? '' : connectionError.message);
      setIsServerOffline(preserveOfflineSnapshot || connectionError.isOffline);
    } finally {
      setIsPairing(false);
    }
  }

  async function applyLibraryInSections(
    nextLibrary: LibraryPayload,
    libraryEtag = '',
    catalogRevision?: number,
    catalogTransport: 'compact' | 'legacy' = 'compact',
  ): Promise<Map<string, MediaItem>> {
    const expectedIdentity = activeCatalogIdentityRef.current;
    const sections: Array<keyof LibraryPayload> = ['movies', 'tvShows', 'animeShows', 'others'];
    for (const section of sections) {
      await wait(LIBRARY_SECTION_APPLY_DELAY_MS);
      if (activeCatalogIdentityRef.current !== expectedIdentity) return new Map();
      setConnection((current) => {
        if (!current) return current;
        return {
          ...current,
          library: {
            ...current.library,
            [section]: nextLibrary[section] || [],
          },
        };
      });
    }
    if (activeCatalogIdentityRef.current !== expectedIdentity) return new Map();
    setConnection((current) => current
      ? {
        ...current,
        library: nextLibrary,
        libraryEtag,
        catalogRevision,
        catalogTransport,
      }
      : current);

    const nextItems = allItems(nextLibrary);
    const nextItemsById = new Map(nextItems.map((item) => [item.id, item]));
    setDetailItem((current) => current ? nextItemsById.get(current.id) || null : null);
    const returnItem = playerReturnItemRef.current;
    if (returnItem && !nextItemsById.has(returnItem.id)) {
      playerReturnItemRef.current = null;
    }
    return nextItemsById;
  }

  async function refreshLibrary() {
    if (!connection) return;
    setError('');
    setIsRefreshing(true);
    try {
      const result = await synchronizeMobileCatalog({
        connection,
        savedConnection,
        isServerOffline,
        refreshCredentials: refreshSavedCredentials,
        initializeProfiles,
        refreshProfiles,
        fetchCatalog: requestMobileCatalog,
      });
      if (result.status === 'profile-initialized') {
        setIsServerOffline(false);
        setOfflineSnapshotSavedAt(null);
        setError('');
        return;
      }
      if (result.status === 'not-modified') {
        setIsServerOffline(false);
        setOfflineSnapshotSavedAt(null);
        return;
      }
      if (result.status === 'unauthorized') {
        clearAuthorizedSession(connection.hostDeviceId);
        setError(MOBILE_REPAIR_MESSAGE);
        return;
      }
      if (result.status === 'profile-required') {
        enterProfilePicker('profile-required', result.connection);
        setError('Choose a profile to continue.');
        setIsServerOffline(false);
        return;
      }
      const { catalog } = result;
      const nextLibrary = catalog.library;
      const libraryEtag = catalog.etag;
      setIsRefreshing(false);
      await applyLibraryInSections(nextLibrary, libraryEtag, catalog.revision, catalog.transport);
      void hydrateProgress({
        ...result.connection,
        library: nextLibrary,
        libraryEtag,
        catalogRevision: catalog.revision,
        catalogTransport: catalog.transport,
      });
      setIsServerOffline(false);
      setOfflineSnapshotSavedAt(null);
    } catch (nextError) {
      if (isCredentialAuthorizationFailure(nextError)) {
        clearAuthorizedSession(connection.hostDeviceId);
        setError(MOBILE_REPAIR_MESSAGE);
        return;
      }
      const connectionError = connectionErrorFor(nextError, 'Refresh failed.', 'MOBILE-REFRESH');
      if (connectionError.isCancelled) return;
      reportNonFatal('connection.refresh', nextError);
      if (connectionError.isOffline && savedConnection && await restoreOfflineConnection(savedConnection)) return;
      if (connectionError.isOffline) returnToOnboarding();
      setError(connectionError.message);
      setIsServerOffline(connectionError.isOffline);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function checkDesktopConnection() {
    if (!connection || connectionHealthCheckRef.current || isRefreshing) return;
    connectionHealthCheckRef.current = true;
    setIsCheckingConnection(true);
    try {
      const result = await synchronizeMobileCatalog({
        connection,
        savedConnection,
        isServerOffline,
        refreshCredentials: refreshSavedCredentials,
        initializeProfiles,
        refreshProfiles,
        fetchCatalog: requestMobileCatalog,
      });
      if (result.status === 'profile-initialized') {
        setIsServerOffline(false);
        setOfflineSnapshotSavedAt(null);
        setError('');
        return;
      }
      if (result.status === 'unauthorized') {
        clearAuthorizedSession(connection.hostDeviceId);
        setError(MOBILE_REPAIR_MESSAGE);
        return;
      }
      if (result.status === 'profile-required') {
        enterProfilePicker('profile-required', result.connection);
        setError('Choose a profile to continue.');
        setIsServerOffline(false);
        return;
      }
      if (result.status === 'not-modified') {
        setIsServerOffline(false);
        setOfflineSnapshotSavedAt(null);
        setError('');
        return;
      }
      const { catalog } = result;
      await applyLibraryInSections(
        catalog.library,
        catalog.etag,
        catalog.revision,
        catalog.transport,
      );
      setIsServerOffline(false);
      setOfflineSnapshotSavedAt(null);
      setError('');
    } catch (nextError) {
      if (isCredentialAuthorizationFailure(nextError)) {
        clearAuthorizedSession(connection.hostDeviceId);
        setError(MOBILE_REPAIR_MESSAGE);
        return;
      }
      const connectionError = connectionErrorFor(nextError, MOBILE_ONBOARDING_OFFLINE_MESSAGE, 'MOBILE-HEALTH');
      if (connectionError.isCancelled) return;
      reportNonFatal('connection.health', nextError);
      if (connectionError.isOffline && savedConnection && await restoreOfflineConnection(savedConnection)) return;
      setIsServerOffline(connectionError.isOffline);
      setError(connectionError.message);
    } finally {
      connectionHealthCheckRef.current = false;
      setIsCheckingConnection(false);
    }
  }

  function requestServerReconnect() {
    // A retry should also restart Bonjour. This covers NAS/desktop hosts whose
    // DHCP address changed while the mobile app was showing its cached library.
    const interruptedReconnect = savedReconnectCompletionRef.current;
    mobileLanClient.cancelActiveRequests();
    if (savedConnection) {
      const discoveredSavedHost = discoveredHosts.find((host) => host.deviceId === savedConnection.hostDeviceId);
      if (discoveredSavedHost && reconcileSavedHost(savedConnection, discoveredSavedHost).kind === 'identity-mismatch') {
        // The desktop's certificate changed, so the old pin cannot be reused.
        // Request a fresh approval from the discovered host; this keeps the
        // security boundary intact while making Reconnect self-healing.
        requestedHostRepairRef.current = null;
        void pairWithDesktop(discoveredSavedHost);
        return;
      }
      requestedHostRepairRef.current = savedConnection.hostDeviceId;
    }
    refreshDiscovery();
    if (savedConnection) {
      setIsRestoringConnection(true);
      void (async () => {
        if (interruptedReconnect) await interruptedReconnect;
        await reconnectSavedConnection(savedConnection);
      })();
      return;
    }
    void checkDesktopConnection();
  }

  async function connectToDiscoveredHost(host?: DiscoveredHost): Promise<void> {
    if (!host || !savedConnection) {
      await pairWithDesktop(host);
      return;
    }

    const reconciliation = reconcileSavedHost(savedConnection, host);
    if (reconciliation.kind === 'identity-mismatch') {
      // A changed certificate is the one case where the saved pin cannot be
      // reused. Pairing through the discovered host requests desktop approval
      // and stores the replacement credential for future reconnects.
      await pairWithDesktop(host);
      return;
    }

    const updated = reconciliation.connection;
    if (updated !== savedConnection) {
      invalidateCredentialRefresh();
      setSavedConnection(updated);
      setBaseUrl(updated.baseUrl);
      await SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(updated));
    }
    setIsRestoringConnection(true);
    await reconnectSavedConnection(updated);
  }

  function returnToOnboarding(): void {
    // Keep the encrypted saved connection and offline snapshot on disk, but
    // remove the stale live connection so onboarding can show the host that
    // Bonjour currently discovers.
    setConnection(null);
    void stopSecureLanTransport();
    setIsOnboarding(true);
    setIsServerOffline(false);
    setOfflineSnapshotSavedAt(null);
    setProfilePickerMode(null);
    setPlayTarget(null);
    setMiniPlayerTarget(null);
    setPlaybackUrl(null);
    setStreamOptions({});
  }

  function clearAuthorizedSession(hostDeviceId: string): void {
    enterProfilePicker('lock');
    invalidateCredentialRefresh();
    setProfiles([]);
    setSavedConnection(null);
    setConnection(null);
    setProfilePickerMode(null);
    setOfflineSnapshotSavedAt(null);
    setIsServerOffline(false);
    void stopSecureLanTransport().catch((error) => reportNonFatal('transport.stop', error));
    void SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY).catch((error) => reportNonFatal('connection.clear', error));
    void clearMobileOfflineSnapshot(hostDeviceId);
    void clearHostDownloads(hostDeviceId).catch((error) => reportNonFatal('downloads.clear', error));
  }
  function disconnectFromDesktop(): void {
    const hostDeviceId = connection?.hostDeviceId || savedConnection?.hostDeviceId || '';
    clearAuthorizedSession(hostDeviceId);
    setBaseUrl('');
    setShareCode('');
    setDetailItem(null);
    detailItemCacheRef.current.clear();
    lastDetailByKindRef.current.clear();
    setPlayTarget(null);
    setMiniPlayerTarget(null);
    playerReturnItemRef.current = null;
    setPlaybackUrl(null);
    setStreamOptions({});
    setProfilePickerMode(null);
    setSearchOpen(false);
    setQuery('');
    setSearchScope('all');
    setActiveKind('home');
    setArtworkCacheBusters({});
    setError('');
    setIsServerOffline(false);
    setOfflineSnapshotSavedAt(null);
  }

  function confirmDisconnectFromDesktop(): void {
    Alert.alert(
      'Disconnect this server?',
      'You will need to pair again to use this server. The saved connection and offline library data will be removed from this device; media files on the server will not be deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: disconnectFromDesktop },
      ],
    );
  }

  async function syncLibraryAfterArtworkChange(itemId: string, appliedCandidate?: OfficialMetadataCandidate): Promise<void> {
    if (!connection) return;
    const requestIdentity = activeCatalogIdentityRef.current;
    const catalog = await requestMobileCatalog({ ...connection, libraryEtag: '' });
    if (catalog.status !== 'ok') throw new Error('Poster updated, but mobile sync failed.');
    if (activeCatalogIdentityRef.current !== requestIdentity) return;
    const nextItemsById = await applyLibraryInSections(
      catalog.library,
      catalog.etag,
      catalog.revision,
      catalog.transport,
    );
    setArtworkCacheBusters((current) => ({ ...current, [itemId]: String(Date.now()) }));
    let refreshedItem = nextItemsById.get(itemId);
    if (refreshedItem && catalog.transport === 'compact' && catalog.revision !== undefined) {
      const detailResponse = await mobileLanClient.getLibraryItem(connection.baseUrl, connection.deviceToken, itemId);
      if (detailResponse.ok) {
        const payload = await readJsonResponse(detailResponse, mobileLibraryItemDetailsSchema, 'Library item details');
        if (activeCatalogIdentityRef.current !== requestIdentity) return;
        if (payload.catalogVersion === 1 && payload.revision === catalog.revision) refreshedItem = payload.item;
      }
    }
    if (refreshedItem) {
      const nextItem = appliedCandidate ? mergeCandidateArtwork(refreshedItem, appliedCandidate) : refreshedItem;
      const key = mobileDetailCacheKey(activeProfile?.id || 'profile:none', catalog.revision ?? -1, itemId);
      rememberMobileDetailItem(detailItemCacheRef.current, nextItem, key);
      setDetailItem(nextItem);
    }
  }

  async function refreshPosterOnHost(item: MediaItem) {
    if (!connection) return;
    if (isServerOffline) {
      setArtworkRefreshError('Reconnect to the LoomTV server before changing artwork.');
      return;
    }
    setArtworkRefreshError('');
    setRefreshingArtworkId(item.id);
    try {
      const response = await mobileLanClient.getOfficialArtworkCandidates(
        connection.baseUrl,
        connection.deviceToken,
        item.id,
        connection.selectionRevision,
      );
      if (!response.ok) {
        const failure = await readErrorResponse(response, 'Poster choices');
        throw new Error(failure.error || failure.message || `Could not load poster choices (${response.status}).`);
      }
      const result = await readJsonResponse(response, officialMetadataCandidatesSchema, 'Poster choices');
      setPosterCandidateSheet({ item, candidates: result });
    } catch (nextError) {
      setArtworkRefreshError(nextError instanceof Error ? nextError.message : 'Poster refresh failed.');
    } finally {
      setRefreshingArtworkId('');
    }
  }

  async function applyPosterCandidate(candidate: OfficialMetadataCandidate, candidateKey: string) {
    if (!connection || !posterCandidateSheet) return;
    if (isServerOffline) {
      setArtworkRefreshError('Reconnect to the LoomTV server before changing artwork.');
      return;
    }
    const itemId = posterCandidateSheet.item.id;
    setArtworkRefreshError('');
    setApplyingPosterCandidateId(candidateKey);
    try {
      const response = await mobileLanClient.applyOfficialArtwork(
        connection.baseUrl,
        connection.deviceToken,
        itemId,
        candidate,
        connection.selectionRevision,
      );
      const result = await readJsonResponse(response, officialArtworkResponseSchema, 'Apply poster');
      if (!response.ok || result.error) {
        throw new Error(result.error || `Could not apply poster (${response.status}).`);
      }
      await syncLibraryAfterArtworkChange(itemId, candidate);
      setPosterCandidateSheet(null);
    } catch (nextError) {
      setArtworkRefreshError(nextError instanceof Error ? nextError.message : 'Poster apply failed.');
    } finally {
      setApplyingPosterCandidateId('');
    }
  }

  const mainContentPadding = [
    styles.scrollContent,
    { paddingBottom: 96 + insets.bottom, paddingTop: insets.top + 12 },
  ];
  const libraryRefreshControl = (
    <RefreshControl
      colors={[accent]}
      progressBackgroundColor={panel}
      progressViewOffset={insets.top + 8}
      refreshing={isRefreshing}
      tintColor={accent}
      titleColor={muted}
      onRefresh={refreshLibrary}
    />
  );
  const showHomeRails = activeKind === 'home' && !query && !searchOpen && !hasActiveFilters;
  const showSearchEmpty = Boolean(query.trim());
  const topMobileSurface: 'detail' | 'poster' | 'player' | null = playTarget
    ? 'player'
    : posterCandidateSheet
      ? 'poster'
      : detailItem
        ? 'detail'
        : null;

  return (
    <MobileThemeProvider value={themeContextValue}>
    <View style={styles.app}>
      <StatusBar style={showStartupSplash || text !== '#000000' ? 'light' : 'dark'} />
      {!connection || isOnboarding ? (
        <PairingScreen
          baseUrl={baseUrl}
          discoveredHosts={discoveredHosts}
          discoveryError={discoveryError}
          error={error}
          isDiscoveringHosts={isDiscoveringHosts}
          isPairing={isPairing}
          isRestoringConnection={isRestoringConnection}
          isServerOffline={isServerOffline}
          onRefreshDiscovery={refreshDiscovery}
          // Returning to onboarding keeps the saved credential in SecureStore,
          // but lets Bonjour present the current host instead of exposing a
          // stale address or a manual-IP form first.
          savedConnection={savedConnection}
          setBaseUrl={(value) => {
            setBaseUrl(value);
            if (error) setError('');
          }}
          setShareCode={(value) => {
            setShareCode(value);
            if (error) setError('');
          }}
          onPair={connectToDiscoveredHost}
        />
      ) : showProfilePicker ? (
        <MobileProfilePicker
          activeProfile={activeProfile}
          error={profileError}
          mode={profilePickerMode || 'startup'}
          onClose={profilePickerMode === 'voluntary' ? () => setProfilePickerMode(null) : undefined}
          pin={profilePin}
          pinTarget={profilePinTarget}
          profiles={profiles}
          setPin={setProfilePin}
          setPinTarget={(profile) => { setProfilePinTarget(profile); setProfilePin(''); setProfileError(''); }}
          onSelect={async (profile, pin) => {
            try {
              await selectMobileProfile(connection, profile, pin);
            } catch (nextError) {
              setProfilePin('');
              setProfileError(nextError instanceof Error ? nextError.message : 'That profile could not be selected.');
            }
          }}
        />
      ) : (
        <View
          accessibilityElementsHidden={topMobileSurface !== null}
          importantForAccessibility={topMobileSurface !== null ? 'no-hide-descendants' : 'auto'}
          style={styles.shell}
        >
          <View style={styles.main}>
            {activeKind === 'settings' ? (
              <ScrollView
                ref={settingsScrollRef}
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={mainContentPadding}
                onScroll={rememberMainScroll}
                refreshControl={libraryRefreshControl}
                scrollEventThrottle={120}
                showsVerticalScrollIndicator={false}
                stickyHeaderIndices={settingsSection ? [0] : undefined}
              >
                {settingsSection ? (
                  <SettingsDetailHeader
                    label={settingsSections.find((section) => section.id === settingsSection)?.label ?? 'Settings'}
                    onBack={() => setSettingsSection(null)}
                    sticky
                  />
                ) : null}
                {isServerOffline ? (
                  <OfflineNotice
                    message={error}
                    onRetry={requestServerReconnect}
                    onOpenSettings={() => {
                      navigateToKind('settings');
                      setSettingsSection('network');
                    }}
                    savedAt={offlineSnapshotSavedAt}
                    isRetrying={isCheckingConnection || isRefreshing}
                  />
                ) : error ? (
                  <View style={styles.errorCard}>
                    <Text selectable style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}
                <SettingsScreen
                  activeProfile={activeProfile}
                  automaticProfileSignIn={automaticProfileSignIn}
                  activeSection={settingsSection}
                  connection={connection}
                  counts={{
                    anime: grouped.anime.length,
                    tv: grouped.tv.length,
                    movies: grouped.movies.length,
                    others: grouped.others.length,
                  }}
                  isTablet={isTablet}
                  isRefreshing={isRefreshing}
                  mobileThemeColor={mobileThemeColor}
                  mobileThemeMode={mobileThemeMode}
                  onLockProfile={() => {
                    void clearMobileOfflineSnapshot(connection.hostDeviceId);
                    enterProfilePicker('lock', connection);
                    void mobileLanClient.lockProfile(connection.baseUrl, connection.deviceToken).catch(() => {});
                  }}
                  onSetAutomaticSignIn={(enabled) => {
                    if (!enabled) {
                      setAutomaticProfileSignIn(false);
                      void clearMobileOfflineSnapshot(connection.hostDeviceId);
                    }
                    void mobileLanClient.setAutomaticSignIn(connection.baseUrl, connection.deviceToken, enabled).then(async (response) => {
                      if (!response.ok) throw new Error('Automatic sign-in update failed.');
                      const state = await readJsonResponse(response, mobileActiveProfileSchema, 'Automatic sign-in');
                      setAutomaticProfileSignIn(state.automaticSignIn);
                      if (!state.automaticSignIn) void clearMobileOfflineSnapshot(connection.hostDeviceId);
                    }).catch(() => {
                      setError('Automatic sign-in could not be updated while the server is offline.');
                    });
                  }}
                  onSwitchProfile={() => enterProfilePicker('voluntary')}
                  onDisconnect={confirmDisconnectFromDesktop}
                  onRefresh={refreshLibrary}
                  onSelectTheme={selectMobileTheme}
                  onSelectThemeColor={selectMobileThemeColor}
                  showDetailHeader={!settingsSection}
                  setActiveSection={setSettingsSection}
                />
              </ScrollView>
            ) : (
              <LibraryList
                  artworkCacheBusters={artworkCacheBusters}
                  baseUrl={connection.baseUrl}
                  contentContainerStyle={mainContentPadding}
                  isTablet={isTablet}
                  items={searchOpen && !query.trim() ? EMPTY_ITEMS : showHomeRails ? EMPTY_ITEMS : visibleItems}
                  listRef={libraryListRef}
                  onScroll={rememberMainScroll}
                  showEmpty={showHomeRails ? false : (searchOpen ? showSearchEmpty : true)}
                  onSelect={activeKind === 'others' ? playHomeItem : openDetailItem}
                  refreshControl={libraryRefreshControl}
                  header={(
                  <View style={{ gap: 12 }}>
                    <Header
                      activeKind={activeKind}
                      filterOpen={filterOpen}
                      hasActiveFilters={hasActiveFilters}
                      searchScope={searchScope}
                      searchOpen={searchOpen}
                      setFilterOpen={setFilterOpen}
                      setSearchScope={setSearchScope}
                      setSearchOpen={(value) => {
                        setSearchOpen(value);
                        setFilterOpen(false);
                        setLibraryFilter('all');
                        setSearchScope('all');
                      }}
                      query={query}
                      setQuery={setQuery}
                    />
                    {filterOpen ? (
                      <LibraryFilters
                        activeFilter={libraryFilter}
                        onChange={setLibraryFilter}
                      />
                    ) : null}
                    {isServerOffline && !offlineSnapshotSavedAt ? (
                      <OfflineNotice
                        message={error}
                        onRetry={requestServerReconnect}
                        onOpenSettings={() => {
                          navigateToKind('settings');
                          setSettingsSection('network');
                        }}
                        savedAt={offlineSnapshotSavedAt}
                        isRetrying={isCheckingConnection || isRefreshing}
                      />
                    ) : error ? (
                      <View style={styles.errorCard}>
                        <Text selectable style={styles.errorText}>{error}</Text>
                      </View>
                    ) : null}
                    {showHomeRails ? (
                      <HomeSections
                        artworkCacheBusters={artworkCacheBusters}
                        baseUrl={connection.baseUrl}
                        continueWatching={continueWatching}
                        grouped={grouped}
                        isTablet={isTablet}
                        myList={mobileMyListItems}
                        onOpenKind={navigateToKind}
                        onResume={playHomeItem}
                        onSelect={openDetailItem}
                      />
                    ) : null}
                  </View>
                  )}
              />
            )}
            {activeKind !== 'settings' && !searchOpen ? (
              <Animated.View
                pointerEvents={homeHeaderPinned ? 'auto' : 'none'}
                style={[
                  styles.homeStickyHeader,
                  {
                    opacity: homeHeaderOpacity,
                    paddingTop: insets.top,
                    transform: [{ translateY: homeHeaderTranslateY }, { scale: homeHeaderScale }],
                  },
                ]}
              >
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.homeStickyBackground,
                    {
                      borderBottomWidth: 0,
                    },
                  ]}
                />
                <LoomLogo
                  width={86}
                  height={24}
                  accent={accent}
                  wordColor={resolvedMobileThemeMode === 'light' ? '#000000' : '#ffffff'}
                />
                <View style={styles.headerActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={filterOpen ? 'Close filters' : 'Open filters'}
                    accessibilityState={{ expanded: filterOpen }}
                    onPress={(event) => {
                      captureMobileFocus(event);
                      const nextOpen = !filterOpen;
                      setFilterOpen(nextOpen);
                      if (nextOpen) libraryListRef.current?.scrollToOffset({ offset: 0, animated: true });
                    }}
                    style={({ pressed }) => [styles.topBarIconButton, filterOpen && styles.filterButtonActive, pressed && styles.pressed]}
                  >
                    <FilterIcon size={20} color={filterOpen || hasActiveFilters ? accent : (resolvedMobileThemeMode === 'light' ? '#000000' : '#ffffff')} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Search"
                    onPress={(event) => {
                      captureMobileFocus(event);
                      setFilterOpen(false);
                      setLibraryFilter('all');
                      setSearchScope('all');
                      setSearchOpen(true);
                    }}
                    style={({ pressed }) => [styles.topBarIconButton, pressed && styles.pressed]}
                  >
                    <SearchIcon size={23} color={resolvedMobileThemeMode === 'light' ? '#000000' : '#ffffff'} />
                  </Pressable>
                </View>
              </Animated.View>
            ) : null}
            {!searchOpen ? (
              <BottomNav
                activeProfile={activeProfile}
                activeKind={activeKind}
                setActiveKind={navigateToKind}
              />
            ) : null}
          </View>
        </View>
      )}

      {!showProfilePicker ? (
      <Fragment>
      <DetailModal
        activeProfile={activeProfile}
        activeKind={activeKind}
        artworkCacheBusters={artworkCacheBusters}
        baseUrl={connection?.baseUrl || ''}
        hasMiniPlayer={Boolean(miniPlayerTarget)}
        accessibilityHidden={topMobileSurface !== 'detail'}
        isTablet={isTablet}
        item={detailItem}
        isWatchlisted={Boolean(detailItem && profileLists.some((entry) => entry.mediaId === detailItem.id && (entry.kind === 'watchlist' || entry.kind === 'favorite')))}
        progress={progress}
        artworkRefreshError={artworkRefreshError}
        isRefreshingArtwork={Boolean(detailItem && refreshingArtworkId === detailItem.id)}
        downloadedMediaIds={new Set(Object.keys(mobileDownloads))}
        downloadingMediaId={downloadingMediaId}
        onClose={closeDetail}
        onOpenKind={navigateToKind}
        onToggleList={async (kind, present) => {
          if (!detailItem) return;
          try {
            await setMobileProfileListEntry(detailItem.id, kind, present);
            setArtworkRefreshError('');
          } catch (nextError) {
            setArtworkRefreshError(nextError instanceof Error ? nextError.message : 'My List could not be updated.');
          }
        }}
        onPlay={(target) => {
          if (!detailItem) return;
          if (isServerOffline) {
            const offlineTarget = targetWithOfflineDownload(target);
            if (!offlineTarget) {
              setError('This title is not downloaded. Reconnect to the LoomTV server to play it.');
              return;
            }
            playerReturnItemRef.current = detailItem;
            setMiniPlayerTarget(null);
            setStreamOptions({});
            setPlayTarget(offlineTarget);
            return;
          }
          const requestIdentity = activeCatalogIdentityRef.current;
          void resolveMobileDetailItem(detailItem)
            .then((details) => {
              if (activeCatalogIdentityRef.current !== requestIdentity) return;
              const episode = typeof target.season === 'number' && typeof target.episode === 'number'
                ? details.episodeFiles?.find((candidate) => (
                    candidate.season === target.season && candidate.episode === target.episode
                  ))
                : undefined;
              playerReturnItemRef.current = details;
              setMiniPlayerTarget(null);
              setStreamOptions({});
              setPlayTarget(episode ? episodePlayTarget(details, episode, progress) : playTargetForItem(details, progress));
            })
            .catch((nextError) => setError(nextError instanceof Error ? nextError.message : 'Could not prepare playback.'));
        }}
        onDownload={async (target) => {
          try {
            await downloadPlayTarget(target);
            setArtworkRefreshError('Downloaded for offline playback.');
          } catch (nextError) {
            setArtworkRefreshError(nextError instanceof Error ? nextError.message : 'The download failed.');
          }
        }}
        onRemoveDownload={async (target) => {
          try {
            await removeDownloadedTarget(target);
            setArtworkRefreshError('Offline copy removed.');
          } catch (nextError) {
            setArtworkRefreshError(nextError instanceof Error ? nextError.message : 'The offline copy could not be removed.');
          }
        }}
        onRefreshArtwork={refreshPosterOnHost}
      />
      <PosterCandidateSheet
        applyingCandidateId={applyingPosterCandidateId}
        accessibilityHidden={topMobileSurface !== 'poster'}
        baseUrl={connection?.baseUrl || ''}
        candidates={posterCandidateSheet?.candidates || []}
        error={artworkRefreshError}
        item={posterCandidateSheet?.item || null}
        onApply={applyPosterCandidate}
        onClose={() => {
          if (applyingPosterCandidateId) return;
          setPosterCandidateSheet(null);
        }}
      />
      {activeKind !== 'settings' ? (
        <MiniPlayerStrip
          accessibilityHidden={topMobileSurface !== null}
          baseUrl={connection?.baseUrl || ''}
          cacheBust={miniPlayerTarget?.mediaId ? artworkCacheBusters[miniPlayerTarget.mediaId] : undefined}
          target={miniPlayerTarget}
          bottomOffset={isTablet || searchOpen ? Math.max(insets.bottom, 12) : Math.max(insets.bottom, 10) + 70}
          onDismiss={() => setMiniPlayerTarget(null)}
          onOpen={() => {
            if (!miniPlayerTarget) return;
            if (isServerOffline) {
              setError('This title is not downloaded. Reconnect to the LoomTV server to play it.');
              return;
            }
            playerReturnItemRef.current = detailItem;
            setStreamOptions({});
            setPlayTarget(miniPlayerTarget);
            setMiniPlayerTarget(null);
            setDetailItem(null);
          }}
        />
      ) : null}
      <MobileErrorBoundary
        scope="player.render"
        title="Playback stopped"
        message="The player could not continue. Close it and retry from the title page."
        resetKey={playTarget?.streamPath || ''}
        onReset={() => { void closePlayer(); }}
      >
      <PlayerModal
        baseUrl={connection?.baseUrl || ''}
        deviceToken={connection?.deviceToken || ''}
        selectionRevision={connection?.selectionRevision}
        isPreparing={isPreparingStream}
        target={playTarget}
        failure={playbackFailure}
        playbackUrl={playbackUrl}
        player={player}
        onClose={() => { void closePlayer(); }}
        onRetry={retryPlayback}
        onStreamOptionsChange={setStreamOptions}
      />
      </MobileErrorBoundary>
      </Fragment>
      ) : null}
      {showStartupSplash && !showProfilePicker ? (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[mobileSplashStyles.screen, { opacity: splashOpacity }]}
        >
          <Animated.View style={{ transform: [{ scale: splashScale }] }}>
            <LoomLogo width={146} height={41} accent="#fc9c03" wordColor="#ffffff" />
          </Animated.View>
          <View style={mobileSplashStyles.accentLine} />
        </Animated.View>
      ) : null}
    </View>
    </MobileThemeProvider>
  );
}
