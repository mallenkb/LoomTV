import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { useLibrary } from '@/contexts/LibraryContext';
import { APP_VERSION, desktopApi, MetadataKeyTestResult, UpdateState } from '@/lib/desktopApi';
import { useTheme } from '@/components/ThemeProvider';
import { nextSettingsSection, remoteLibraryRefreshIdentity } from '@/lib/settingsTabs';
import {
  DEFAULT_SIDEBAR_NAV_ORDER,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_STORAGE_KEY,
  getCompactUpdateStatus,
  getUpdateButtonLabel,
  isSettingsSection,
  normalizeProviderId,
  normalizeSidebarNavOrder,
  type SettingsSection,
  type SidebarNavItemId,
} from './Settings.helpers';
import AboutSettingsSection from './AboutSettingsSection';
import LibrarySettingsSection from './LibrarySettingsSection';
import MetadataSettingsSection from './MetadataSettingsSection';
import NetworkSettingsSection from './NetworkSettingsSection';
import PlaybackSettingsSection from './PlaybackSettingsSection';
import SettingsTabs from './SettingsTabs';
import ThemeSettingsSection from './ThemeSettingsSection';
import type {
  LocalNetworkPeer,
  LocalNetworkStatus,
  MetadataProvider,
  SharedLibrarySnapshot,
} from './Settings.types';

function makeMetadataProviders(openExternal: (url: string) => void): MetadataProvider[] {
  return [
    {
      id: 'tmdb',
      label: 'TMDB Access Token or API Key',
      required: true,
      badge: 'Recommended',
      placeholder: 'Paste your TMDB read access token or v3 API key',
      description: (
        <>
          Used for high-quality movie and TV posters, backdrops, cast info, and ratings.
          Paste either your TMDB API Read Access Token or your v3 API Key from{' '}
          <button
            type="button"
            onClick={() => openExternal('https://www.themoviedb.org/settings/api')}
            className="text-[var(--loom-accent)] hover:underline inline-flex items-center gap-0.5"
          >
            themoviedb.org <ExternalLink className="w-3 h-3" />
          </button>
        </>
      ),
    },
    {
      id: 'omdb',
      label: 'OMDb API Key',
      badge: 'Optional fallback',
      placeholder: 'Enter your OMDb API key',
      description: (
        <>
          Used as a fallback when TMDB has no result. Free key at{' '}
          <button
            type="button"
            onClick={() => openExternal('https://www.omdbapi.com/apikey.aspx')}
            className="text-[var(--loom-accent)] hover:underline inline-flex items-center gap-0.5"
          >
            omdbapi.com <ExternalLink className="w-3 h-3" />
          </button>
          .
        </>
      ),
    },
    {
      id: 'fanart',
      label: 'Fanart.tv API Key',
      badge: 'Clearlogos',
      placeholder: 'Paste your Fanart.tv personal API key',
      description: (
        <>
          Used for playback pause/start clearlogos. Create or sign in to Fanart.tv, open the API key page,
          and copy the <span className="font-semibold text-white">Personal API Key</span>. That is the key Loom Media Server needs.{' '}
          <button
            type="button"
            onClick={() => openExternal('https://fanart.tv/get-an-api-key/#personal')}
            className="text-[var(--loom-accent)] hover:underline inline-flex items-center gap-0.5"
          >
            Open Fanart.tv personal API key page <ExternalLink className="w-3 h-3" />
          </button>
          .
        </>
      ),
    },
    {
      id: 'opensubtitles',
      label: 'OpenSubtitles API Key',
      badge: 'Subtitles',
      placeholder: 'Paste your OpenSubtitles API consumer key',
      description: (
        <>
          Used to download missing sidecar subtitles during library scans. Create an API consumer key from your{' '}
          <button
            type="button"
            onClick={() => openExternal('https://www.opensubtitles.com/en/users/consumers')}
            className="text-[var(--loom-accent)] hover:underline inline-flex items-center gap-0.5"
          >
            OpenSubtitles account <ExternalLink className="w-3 h-3" />
          </button>
          .
        </>
      ),
    },
  ];
}

export default function Settings() {
  const { state, addLibraryFolder, scanLibrary, fullRescanLibrary, refreshMetadata, refreshLibrary, clearAppData, removeLibraryFolder, setAutoSyncIntervalHours } = useLibrary();
  const { libraryFolderGroups, libraryFolderStatuses, isScanning, scanProgress, movies, tvShows, animeShows, autoSyncIntervalHours } = state;

  const [metadataKeys, setMetadataKeys] = useState<Record<string, string>>({});
  const [openSubtitlesUsername, setOpenSubtitlesUsername] = useState('');
  const [openSubtitlesPassword, setOpenSubtitlesPassword] = useState('');
  const [openSubtitlesLanguages, setOpenSubtitlesLanguages] = useState('en');
  const [openSubtitlesAutoDownload, setOpenSubtitlesAutoDownload] = useState(false);
  const [editingKeys, setEditingKeys] = useState<Record<string, boolean>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderKey, setNewProviderKey] = useState('');
  const [savedKey, setSavedKey] = useState(false);
  const [isTestingKeys, setIsTestingKeys] = useState(false);
  const [metadataKeyTestResults, setMetadataKeyTestResults] = useState<MetadataKeyTestResult[]>([]);
  const [ffmpegStatus, setFfmpegStatus] = useState<{ available: boolean; path: string | null } | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>(() => {
    const savedSection = localStorage.getItem(SETTINGS_SECTION_STORAGE_KEY);
    return isSettingsSection(savedSection) ? savedSection : 'library';
  });
  const [isMobileSettingsMenuOpen, setIsMobileSettingsMenuOpen] = useState(true);
  const [sidebarNavOrder, setSidebarNavOrder] = useState<SidebarNavItemId[]>(DEFAULT_SIDEBAR_NAV_ORDER);
  const [playbackSkipBackSeconds, setPlaybackSkipBackSeconds] = useState(10);
  const [playbackSkipForwardSeconds, setPlaybackSkipForwardSeconds] = useState(15);
  const [draggedSidebarItem, setDraggedSidebarItem] = useState<SidebarNavItemId | null>(null);
  const [backupStatus, setBackupStatus] = useState('');
  const [clearDataStatus, setClearDataStatus] = useState('');
  const [isClearingData, setIsClearingData] = useState(false);
  const [localNetworkStatus, setLocalNetworkStatus] = useState<LocalNetworkStatus | null>(null);
  const [networkStatusMessage, setNetworkStatusMessage] = useState('');
  const [isTogglingNetworkSharing, setIsTogglingNetworkSharing] = useState(false);
  const [remoteLibraryAddress, setRemoteLibraryAddress] = useState('');
  const [remoteShareCode, setRemoteShareCode] = useState('');
  const [isConnectingRemoteLibrary, setIsConnectingRemoteLibrary] = useState(false);
  const [remoteLibraryStatus, setRemoteLibraryStatus] = useState('');
  const [showManualNetworkAddress, setShowManualNetworkAddress] = useState(false);
  const [sharedLibrarySnapshot, setSharedLibrarySnapshot] = useState<SharedLibrarySnapshot | null>(null);
  const [discoveredPeers, setDiscoveredPeers] = useState<LocalNetworkPeer[]>([]);
  const [isScanningPeers, setIsScanningPeers] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [isCheckingUpdateServer, setIsCheckingUpdateServer] = useState(false);
  const peerScanInFlightRef = useRef(false);
  const sharedLibrarySnapshotRef = useRef<SharedLibrarySnapshot | null>(null);
  const { theme, setTheme } = useTheme();
  const openExternal = useCallback((url: string) => {
    void desktopApi.openExternal(url);
  }, []);
  const METADATA_PROVIDERS = useMemo(() => makeMetadataProviders(openExternal), [openExternal]);
  const remoteLibraryRefreshKey = useMemo(
    () => remoteLibraryRefreshIdentity(sharedLibrarySnapshot),
    [sharedLibrarySnapshot],
  );

  const refreshLocalNetworkStatus = useCallback(async () => {
    try {
      setLocalNetworkStatus(await desktopApi.getLocalNetworkStatus());
    } catch (error) {
      console.error('Failed to load local network status:', error);
      setNetworkStatusMessage('Could not read local network status.');
    }
  }, []);

  useEffect(() => {
    desktopApi.getSettings().then((s) => {
      const loadedKeys = {
        ...(s.metadataApiKeys || {}),
        tmdb: s.metadataApiKeys?.tmdb || s.tmdbApiKey || '',
        omdb: s.metadataApiKeys?.omdb || s.omdbApiKey || '',
        fanart: s.metadataApiKeys?.fanart || '',
        opensubtitles: s.metadataApiKeys?.opensubtitles || '',
      };
      setMetadataKeys(loadedKeys);
      setOpenSubtitlesUsername(s.openSubtitlesUsername || '');
      setOpenSubtitlesPassword(s.openSubtitlesPassword || '');
      setOpenSubtitlesLanguages(s.openSubtitlesLanguages || 'en');
      setOpenSubtitlesAutoDownload(Boolean(s.openSubtitlesAutoDownload));
      setEditingKeys(
        Object.fromEntries(
          Object.entries(loadedKeys).map(([provider, value]) => [provider, !value]),
        ),
      );
      setSidebarNavOrder(normalizeSidebarNavOrder(s.sidebarNavOrder));
      setPlaybackSkipBackSeconds(Number.isFinite(s.playbackSkipBackSeconds) && (s.playbackSkipBackSeconds || 0) > 0 ? (s.playbackSkipBackSeconds || 10) : 10);
      setPlaybackSkipForwardSeconds(Number.isFinite(s.playbackSkipForwardSeconds) && (s.playbackSkipForwardSeconds || 0) > 0 ? (s.playbackSkipForwardSeconds || 15) : 15);
    });
    try {
      const savedRemoteLibrary = JSON.parse(localStorage.getItem('loomtv:last-remote-library') || 'null') as { baseUrl?: string } | null;
      if (savedRemoteLibrary?.baseUrl) setRemoteLibraryAddress(savedRemoteLibrary.baseUrl);
      const savedSharedLibrary = JSON.parse(localStorage.getItem('loomtv:shared-library') || 'null') as SharedLibrarySnapshot | null;
      if (savedSharedLibrary?.library && savedSharedLibrary?.deviceToken) setSharedLibrarySnapshot(savedSharedLibrary);
    } catch {
      // Ignore invalid saved pairing data.
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_SECTION_STORAGE_KEY, activeSection);
  }, [activeSection]);

  useEffect(() => {
    sharedLibrarySnapshotRef.current = sharedLibrarySnapshot;
  }, [sharedLibrarySnapshot]);

  const setMetadataKey = (providerId: string, value: string) => {
    setMetadataKeys((current) => ({ ...current, [providerId]: value }));
  };

  const setProviderEditing = (providerId: string, isEditing: boolean) => {
    setEditingKeys((current) => ({ ...current, [providerId]: isEditing }));
  };

  const toggleProviderVisibility = (providerId: string) => {
    setVisibleKeys((current) => ({ ...current, [providerId]: !current[providerId] }));
  };

  const handleDeleteMetadataKey = (providerId: string) => {
    setMetadataKeys((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    setEditingKeys((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    setVisibleKeys((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
  };

  const handleAddMetadataKey = () => {
    const providerId = normalizeProviderId(newProviderName);
    if (!providerId || !newProviderKey.trim()) return;

    setMetadataKey(providerId, newProviderKey);
    setProviderEditing(providerId, false);
    setVisibleKeys((current) => ({ ...current, [providerId]: false }));
    setNewProviderName('');
    setNewProviderKey('');
  };

  const handleSaveApiKeys = async () => {
    const cleanedKeys = Object.fromEntries(
      Object.entries(metadataKeys)
        .map(([provider, value]) => [normalizeProviderId(provider), value.trim()])
        .filter(([provider, value]) => provider && value),
    ) as Record<string, string>;

    await desktopApi.saveSettings({
      metadataApiKeys: cleanedKeys,
      omdbApiKey: cleanedKeys.omdb || '',
      tmdbApiKey: cleanedKeys.tmdb || '',
      openSubtitlesUsername: openSubtitlesUsername.trim(),
      openSubtitlesPassword: openSubtitlesPassword.trim(),
      openSubtitlesLanguages: openSubtitlesLanguages.trim() || 'en',
      openSubtitlesAutoDownload,
    });
    setMetadataKeys(cleanedKeys);
    setEditingKeys(
      Object.fromEntries(Object.keys(cleanedKeys).map((provider) => [provider, false])),
    );
    setSavedKey(true);
    setTimeout(() => setSavedKey(false), 2000);
  };

  const cleanedMetadataKeys = () => Object.fromEntries(
    Object.entries(metadataKeys)
      .map(([provider, value]) => [normalizeProviderId(provider), value.trim()])
      .filter(([provider, value]) => provider && value),
  ) as Record<string, string>;

  const handleTestApiKeys = async () => {
    const cleanedKeys = cleanedMetadataKeys();
    setIsTestingKeys(true);
    setMetadataKeyTestResults([]);
    try {
      setMetadataKeyTestResults(await desktopApi.testMetadataKeys(cleanedKeys));
    } catch (error) {
      setMetadataKeyTestResults([{
        provider: 'metadata',
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to test API keys.',
      }]);
    } finally {
      setIsTestingKeys(false);
    }
  };

  const handleSavePlaybackSettings = async () => {
    const normalizedBack = Math.max(1, Math.round(Number(playbackSkipBackSeconds) || 0));
    const normalizedForward = Math.max(1, Math.round(Number(playbackSkipForwardSeconds) || 0));
    setPlaybackSkipBackSeconds(normalizedBack);
    setPlaybackSkipForwardSeconds(normalizedForward);
    await desktopApi.saveSettings({
      playbackSkipBackSeconds: normalizedBack,
      playbackSkipForwardSeconds: normalizedForward,
    });
  };

  const saveSidebarNavOrder = async (nextOrder: SidebarNavItemId[]) => {
    setSidebarNavOrder(nextOrder);
    await desktopApi.saveSettings({ sidebarNavOrder: nextOrder });
    window.dispatchEvent(new CustomEvent('loomtv:sidebar-order-changed', { detail: nextOrder }));
  };

  const handleSidebarOrderDrop = (targetId: SidebarNavItemId) => {
    if (!draggedSidebarItem || draggedSidebarItem === targetId) {
      setDraggedSidebarItem(null);
      return;
    }

    const currentOrder = sidebarNavOrder.filter((item) => item !== draggedSidebarItem);
    const targetIndex = currentOrder.indexOf(targetId);
    const nextOrder = [
      ...currentOrder.slice(0, targetIndex),
      draggedSidebarItem,
      ...currentOrder.slice(targetIndex),
    ];

    setDraggedSidebarItem(null);
    void saveSidebarNavOrder(nextOrder);
  };

  const moveSidebarItem = (itemId: SidebarNavItemId, direction: -1 | 1) => {
    const index = sidebarNavOrder.indexOf(itemId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= sidebarNavOrder.length) return;

    const nextOrder = [...sidebarNavOrder];
    [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]];
    void saveSidebarNavOrder(nextOrder);
  };

  const handleBackupDatabase = async () => {
    setBackupStatus('');
    const result = await desktopApi.backupDatabase();
    if (result.ok && result.path) {
      setBackupStatus(`Saved to ${result.path}`);
    } else if (result.error !== 'cancelled') {
      setBackupStatus('Backup failed. Try another location.');
    }
  };

  const handleClearAppData = async () => {
    const confirmed = window.confirm(
      'Clear all Loom Media Server library folders, metadata, artwork, watch progress, and settings from this device?',
    );
    if (!confirmed) return;

    setIsClearingData(true);
    setClearDataStatus('');
    try {
      await clearAppData();
      setClearDataStatus('App data cleared. Add a library folder to start fresh.');
    } catch (error) {
      console.error('Failed to clear app data:', error);
      setClearDataStatus('Clear failed. Close playback and try again.');
    } finally {
      setIsClearingData(false);
    }
  };

  const setLocalNetworkSharing = async (enabled: boolean) => {
    setNetworkStatusMessage('');
    setIsTogglingNetworkSharing(true);
    try {
      await desktopApi.saveSettings({ localNetworkSharingEnabled: enabled });
      await refreshLocalNetworkStatus();
    } catch (error) {
      console.error('Failed to update local network sharing:', error);
      setNetworkStatusMessage('Could not update local network sharing.');
    } finally {
      setIsTogglingNetworkSharing(false);
    }
  };

  const copyNetworkValue = async (value?: string | null) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setNetworkStatusMessage('Copied.');
    setTimeout(() => setNetworkStatusMessage(''), 1600);
  };

  const connectRemoteLibrary = async () => {
    setIsConnectingRemoteLibrary(true);
    setRemoteLibraryStatus('');
    try {
      const connection = await desktopApi.connectToLocalNetworkLibrary(showManualNetworkAddress ? remoteLibraryAddress : '', remoteShareCode);
      const itemCount = (connection.library.movies?.length || 0)
        + (connection.library.tvShows?.length || 0)
        + (connection.library.animeShows?.length || 0);
      localStorage.setItem('loomtv:last-remote-library', JSON.stringify({
        baseUrl: connection.baseUrl,
        connectedAt: Date.now(),
      }));
      const snapshot: SharedLibrarySnapshot = {
        baseUrl: connection.baseUrl,
        deviceId: connection.deviceId,
        deviceToken: connection.deviceToken,
        hostDeviceId: connection.hostDeviceId,
        hostDeviceName: connection.hostDeviceName,
        connectedAt: Date.now(),
        libraryEtag: connection.libraryEtag,
        library: connection.library,
      };
      localStorage.setItem('loomtv:shared-library', JSON.stringify(snapshot));
      sharedLibrarySnapshotRef.current = snapshot;
      setSharedLibrarySnapshot(snapshot);
      setRemoteLibraryAddress(connection.baseUrl);
      setRemoteShareCode('');
      setRemoteLibraryStatus(`Connected to ${connection.hostDeviceName || 'shared device'}. Found ${itemCount} shared item${itemCount === 1 ? '' : 's'}.`);
    } catch (error) {
      setRemoteLibraryStatus(error instanceof Error ? error.message : 'Could not connect to that shared library.');
    } finally {
      setIsConnectingRemoteLibrary(false);
    }
  };

  const refreshRemoteLibrarySnapshot = useCallback(async () => {
    const snapshot = sharedLibrarySnapshotRef.current;
    if (!snapshot) return;
    try {
      const refreshed = await desktopApi.refreshRemoteLibrary(
        snapshot.baseUrl,
        snapshot.deviceToken,
        snapshot.libraryEtag,
      );
      if (!refreshed) return; // 304 — no change.
      const next: SharedLibrarySnapshot = {
        ...snapshot,
        library: refreshed.library,
        libraryEtag: refreshed.etag,
      };
      localStorage.setItem('loomtv:shared-library', JSON.stringify(next));
      sharedLibrarySnapshotRef.current = next;
      setSharedLibrarySnapshot(next);
    } catch (error) {
      console.warn('Remote library refresh failed:', error);
    }
  }, []);

  const disconnectRemoteLibrary = async () => {
    if (!sharedLibrarySnapshot) return;
    await desktopApi.unpairFromRemoteLibrary(
      sharedLibrarySnapshot.baseUrl,
      sharedLibrarySnapshot.deviceToken,
      sharedLibrarySnapshot.deviceId,
    );
    localStorage.removeItem('loomtv:shared-library');
    localStorage.removeItem('loomtv:last-remote-library');
    sharedLibrarySnapshotRef.current = null;
    setSharedLibrarySnapshot(null);
    setRemoteLibraryStatus('Disconnected from shared library.');
  };

  const scanForPeers = useCallback(async () => {
    if (peerScanInFlightRef.current) return;
    peerScanInFlightRef.current = true;
    setIsScanningPeers(true);
    try {
      const peers = await desktopApi.discoverLocalNetworkPeers(2500);
      setDiscoveredPeers(peers);
    } catch (error) {
      console.warn('Peer scan failed:', error);
      setDiscoveredPeers([]);
    } finally {
      peerScanInFlightRef.current = false;
      setIsScanningPeers(false);
    }
  }, []);

  const revokePairedDevice = async (deviceId: string) => {
    const remaining = await desktopApi.revokePairedDevice(deviceId);
    setLocalNetworkStatus((current) => current ? { ...current, pairedDevices: remaining } : current);
  };

  useEffect(() => {
    if (activeSection !== 'network') return;
    void refreshLocalNetworkStatus();
    void scanForPeers();
    const id = setInterval(() => void scanForPeers(), 8000);
    return () => clearInterval(id);
  }, [activeSection, refreshLocalNetworkStatus, scanForPeers]);

  useEffect(() => {
    if (activeSection !== 'about') return undefined;

    let cancelled = false;
    if (!ffmpegStatus) {
      desktopApi.checkFFmpeg()
        .then((status) => {
          if (!cancelled) setFfmpegStatus(status);
        })
        .catch((error) => {
          console.error('Failed to check FFmpeg:', error);
          if (!cancelled) setFfmpegStatus({ available: false, path: null });
        });
    }

    desktopApi.getUpdateState()
      .then((state) => {
        if (!cancelled) setUpdateState(state);
      })
      .catch((error) => {
        console.error('Failed to read update state:', error);
      });
    const unsubscribeUpdates = desktopApi.onUpdateState((state) => {
      if (!cancelled) setUpdateState(state);
    });

    return () => {
      cancelled = true;
      unsubscribeUpdates();
    };
  }, [activeSection, ffmpegStatus]);

  useEffect(() => {
    if (!remoteLibraryRefreshKey) return;
    const id = setInterval(() => void refreshRemoteLibrarySnapshot(), 30000);
    return () => clearInterval(id);
  }, [refreshRemoteLibrarySnapshot, remoteLibraryRefreshKey]);

  const customProviders = Object.keys(metadataKeys)
    .filter((providerId) => !METADATA_PROVIDERS.some((provider) => provider.id === providerId))
    .sort();

  const folderSections = [
    {
      key: 'movies' as const,
      title: 'Movies',
      description: 'Folders added here always scan into Movies.',
      folders: libraryFolderGroups.movies || [],
    },
    {
      key: 'tvShows' as const,
      title: 'TV Shows',
      description: 'Folders added here always scan into TV Shows.',
      folders: libraryFolderGroups.tvShows || [],
    },
    {
      key: 'anime' as const,
      title: 'Anime / Animations',
      description: 'Folders added here always scan into Anime.',
      folders: libraryFolderGroups.anime || [],
    },
    {
      key: 'others' as const,
      title: 'Others',
      description: 'Folders added here are scanned with automatic type detection.',
      folders: libraryFolderGroups.others || [],
    },
  ];

  const sharedLibrarySections = sharedLibrarySnapshot ? [
    { title: 'Movies', items: sharedLibrarySnapshot.library.movies || [] },
    { title: 'TV Shows', items: sharedLibrarySnapshot.library.tvShows || [] },
    { title: 'Anime', items: sharedLibrarySnapshot.library.animeShows || [] },
  ] : [];
  const isNetworkSharingOn = Boolean(localNetworkStatus?.sharingEnabled);
  const currentNetworkName = localNetworkStatus?.networkName || 'Connected locally';
  const isUpdateChecking = isCheckingUpdateServer || updateState?.status === 'checking';
  const isUpdateBusy = isUpdateChecking || updateState?.status === 'downloading' || updateState?.status === 'installing';
  const isUpdateDownloading = updateState?.status === 'downloading';
  const updateDownloadPercent = isUpdateDownloading
    ? Math.max(0, Math.min(100, Math.round(updateState.downloadPercent || 0)))
    : 0;
  const updateButtonLabel = isUpdateChecking ? 'Checking...' : getUpdateButtonLabel(updateState);
  const updateStatusCopy = isUpdateBusy ? '' : getCompactUpdateStatus(updateState);
  const updateButtonStyle: React.CSSProperties | undefined = isUpdateDownloading
    ? {
        background: `linear-gradient(to right, color-mix(in srgb, var(--loom-accent) 72%, black) ${updateDownloadPercent}%, color-mix(in srgb, var(--loom-accent) 38%, black) ${updateDownloadPercent}%)`,
      }
    : isUpdateBusy
      ? { backgroundColor: 'color-mix(in srgb, var(--loom-accent) 58%, black)' }
      : undefined;

  const handleUpdateAction = async () => {
    if (isUpdateBusy) return;

    if (updateState?.status === 'downloaded') {
      setUpdateState((current) => ({
        ...(current || {
          currentVersion: APP_VERSION,
          platform: 'browser' as NodeJS.Platform,
          arch: 'unknown',
          supported: false,
        }),
        status: 'installing',
        message: 'Preparing update restart...',
      }));
      const nextState = await desktopApi.installUpdate();
      setUpdateState(nextState);
      return;
    }

    setIsCheckingUpdateServer(true);
    setUpdateState((current) => ({
      ...(current || {
        currentVersion: APP_VERSION,
        platform: 'browser' as NodeJS.Platform,
        arch: 'unknown',
        supported: false,
      }),
      status: 'checking',
      downloadPercent: undefined,
      message: 'Checking for updates...',
    }));
    try {
      const [nextState] = await Promise.all([
        desktopApi.checkForUpdates(),
        new Promise((resolve) => setTimeout(resolve, 650)),
      ]);
      setUpdateState(nextState);
    } finally {
      setIsCheckingUpdateServer(false);
    }
  };

  const handleSectionSelect = useCallback((sectionId: SettingsSection) => {
    setActiveSection((current) => nextSettingsSection(current, sectionId));
    setIsMobileSettingsMenuOpen(false);
  }, []);

  const activeSectionLabel = SETTINGS_SECTIONS.find((section) => section.id === activeSection)?.label || 'Settings';

  return (
    <div className={`loom-page h-full overflow-y-auto ${isMobileSettingsMenuOpen ? 'loom-settings-menu-open' : 'loom-settings-detail-open'}`}>
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6">
        <div className="loom-settings-content mx-auto max-w-5xl pt-16">
          <SettingsTabs activeSection={activeSection} onSelect={handleSectionSelect} />

          <div className="loom-settings-mobile-menu">
            <div className="loom-settings-mobile-profile">
              <div className="loom-settings-mobile-logo">LT</div>
              <h1>Loom Media Server</h1>
              <p>Manage your library, playback, network, metadata, theme, and app details.</p>
            </div>
            <div className="loom-settings-mobile-list">
              {SETTINGS_SECTIONS.map((section) => (
                <button key={section.id} type="button" onClick={() => handleSectionSelect(section.id)}>
                  <span>{section.label}</span>
                  <ChevronRight className="h-5 w-5" />
                </button>
              ))}
            </div>
          </div>

          <div className="loom-settings-mobile-detail-bar">
            <button type="button" onClick={() => setIsMobileSettingsMenuOpen(true)} aria-label="Back to settings">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <h1>{activeSectionLabel}</h1>
          </div>

          <div className="loom-settings-sections space-y-6">
              {activeSection === 'playback' && (
                <PlaybackSettingsSection
                  skipBackSeconds={playbackSkipBackSeconds}
                  skipForwardSeconds={playbackSkipForwardSeconds}
                  onSkipBackChange={setPlaybackSkipBackSeconds}
                  onSkipForwardChange={setPlaybackSkipForwardSeconds}
                  onSave={() => void handleSavePlaybackSettings()}
                />
              )}

        {activeSection === 'library' && (
          <LibrarySettingsSection
            folderSections={folderSections}
            folderStatuses={libraryFolderStatuses}
            addLibraryFolder={addLibraryFolder}
            removeLibraryFolder={removeLibraryFolder}
            sidebarNavOrder={sidebarNavOrder}
            draggedSidebarItem={draggedSidebarItem}
            setDraggedSidebarItem={setDraggedSidebarItem}
            onSidebarOrderDrop={handleSidebarOrderDrop}
            moveSidebarItem={moveSidebarItem}
            isScanning={isScanning}
            scanProgress={scanProgress}
            movieCount={movies.length}
            tvShowCount={tvShows.length}
            animeCount={animeShows.length}
            scanLibrary={scanLibrary}
            refreshMetadata={refreshMetadata}
            fullRescanLibrary={fullRescanLibrary}
            refreshLibrary={refreshLibrary}
            autoSyncIntervalHours={autoSyncIntervalHours}
            setAutoSyncIntervalHours={setAutoSyncIntervalHours}
            backupStatus={backupStatus}
            clearDataStatus={clearDataStatus}
            isClearingData={isClearingData}
            onBackupDatabase={() => void handleBackupDatabase()}
            onClearAppData={() => void handleClearAppData()}
          />
        )}

        {activeSection === 'network' && (
          <NetworkSettingsSection
            localNetworkStatus={localNetworkStatus}
            isNetworkSharingOn={isNetworkSharingOn}
            isTogglingNetworkSharing={isTogglingNetworkSharing}
            currentNetworkName={currentNetworkName}
            networkStatusMessage={networkStatusMessage}
            setLocalNetworkSharing={(enabled) => void setLocalNetworkSharing(enabled)}
            copyNetworkValue={(value) => void copyNetworkValue(value)}
            revokePairedDevice={(deviceId) => void revokePairedDevice(deviceId)}
            discoveredPeers={discoveredPeers}
            isScanningPeers={isScanningPeers}
            scanForPeers={() => void scanForPeers()}
            remoteLibraryAddress={remoteLibraryAddress}
            setRemoteLibraryAddress={setRemoteLibraryAddress}
            remoteShareCode={remoteShareCode}
            setRemoteShareCode={setRemoteShareCode}
            showManualNetworkAddress={showManualNetworkAddress}
            setShowManualNetworkAddress={setShowManualNetworkAddress}
            connectRemoteLibrary={() => void connectRemoteLibrary()}
            isConnectingRemoteLibrary={isConnectingRemoteLibrary}
            remoteLibraryStatus={remoteLibraryStatus}
            sharedLibrarySnapshot={sharedLibrarySnapshot}
            sharedLibrarySections={sharedLibrarySections}
            disconnectRemoteLibrary={() => void disconnectRemoteLibrary()}
          />
        )}
        {activeSection === 'metadata' && (
          <MetadataSettingsSection
            providers={METADATA_PROVIDERS}
            metadataKeys={metadataKeys}
            editingKeys={editingKeys}
            visibleKeys={visibleKeys}
            customProviders={customProviders}
            openSubtitlesUsername={openSubtitlesUsername}
            openSubtitlesPassword={openSubtitlesPassword}
            openSubtitlesLanguages={openSubtitlesLanguages}
            openSubtitlesAutoDownload={openSubtitlesAutoDownload}
            newProviderName={newProviderName}
            newProviderKey={newProviderKey}
            savedKey={savedKey}
            isTestingKeys={isTestingKeys}
            metadataKeyTestResults={metadataKeyTestResults}
            hasMetadataKeysToTest={Object.keys(cleanedMetadataKeys()).length > 0}
            setMetadataKey={setMetadataKey}
            setProviderEditing={setProviderEditing}
            toggleProviderVisibility={toggleProviderVisibility}
            deleteMetadataKey={handleDeleteMetadataKey}
            setOpenSubtitlesUsername={setOpenSubtitlesUsername}
            setOpenSubtitlesPassword={setOpenSubtitlesPassword}
            setOpenSubtitlesLanguages={setOpenSubtitlesLanguages}
            setOpenSubtitlesAutoDownload={setOpenSubtitlesAutoDownload}
            setNewProviderName={setNewProviderName}
            setNewProviderKey={setNewProviderKey}
            addMetadataKey={handleAddMetadataKey}
            saveApiKeys={() => void handleSaveApiKeys()}
            testApiKeys={() => void handleTestApiKeys()}
          />
        )}

        {activeSection === 'theme' && <ThemeSettingsSection theme={theme} setTheme={setTheme} />}

        {activeSection === 'about' && (
          <AboutSettingsSection
            ffmpegStatus={ffmpegStatus}
            updateState={updateState}
            theme={theme}
            isUpdateBusy={isUpdateBusy}
            isUpdateChecking={isUpdateChecking}
            isUpdateDownloading={isUpdateDownloading}
            updateButtonStyle={updateButtonStyle}
            updateButtonLabel={updateButtonLabel}
            updateStatusCopy={updateStatusCopy}
            onUpdateAction={() => void handleUpdateAction()}
          />
        )}

          </div>
        </div>
      </div>
    </div>
  );
}
