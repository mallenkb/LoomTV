import React, { useEffect, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { ArrowDown, ArrowUp, ChevronDown, FolderPlus, RefreshCw, X, Key, CheckCircle, ExternalLink, Pencil, Plus, Save, Trash2, Eye, EyeOff, Clock, GripVertical, Download, Palette, Wifi, Copy } from 'lucide-react';
import { useLibrary } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { desktopApi, UpdateState } from '@/lib/desktopApi';
import { useTheme } from '@/components/ThemeProvider';
import LoomBrandLockup from '@/components/LoomBrandLockup';
import LoomLogo from '@/components/LoomLogo';
import LoomLoader from '@/components/LoomLoader';
import LoomPlayMark from '@/components/LoomPlayMark';
import { AppDarkTheme, AppLoaderStyle, AppThemeColor, DARK_THEMES, THEME_COLORS } from '@/lib/theme';

type MetadataProvider = {
  id: string;
  label: string;
  description: React.ReactNode;
  placeholder: string;
  badge?: string;
  required?: boolean;
};

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
  ];
}

const AUTO_SYNC_OPTIONS = [
  { value: 6, label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every 24 hours' },
  { value: 48, label: 'Every 48 hours' },
  { value: 72, label: 'Every 3 days' },
  { value: 96, label: 'Every 4 days' },
  { value: 120, label: 'Every 5 days' },
  { value: 144, label: 'Every 6 days' },
  { value: 168, label: 'Every 1 week' },
];

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

type SettingsSection = 'library' | 'network' | 'metadata' | 'theme' | 'about';
type SidebarNavItemId = 'anime' | 'tv' | 'movies' | 'others';

const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'network', label: 'Network' },
  { id: 'metadata', label: 'Metadata API Keys' },
  { id: 'theme', label: 'Theme' },
  { id: 'about', label: 'About' },
];

const SETTINGS_SECTION_STORAGE_KEY = 'loomtv:settings-active-section';

function isSettingsSection(value: string | null): value is SettingsSection {
  return value === 'library'
    || value === 'network'
    || value === 'metadata'
    || value === 'theme'
    || value === 'about';
}

type LocalNetworkStatus = {
  sharingEnabled: boolean;
  token: string;
  networkName: string;
  port: number;
  addresses: string[];
  baseUrl: string | null;
  libraryUrl: string | null;
};

type SharedLibrarySnapshot = {
  baseUrl: string;
  connectedAt: number;
  library: {
    movies?: { title?: string; year?: number }[];
    tvShows?: { title?: string; year?: number }[];
    animeShows?: { title?: string; year?: number }[];
  };
};

const DEFAULT_SIDEBAR_NAV_ORDER: SidebarNavItemId[] = ['anime', 'tv', 'movies', 'others'];

const LOADER_OPTIONS: { id: AppLoaderStyle; label: string; description: string }[] = [
  { id: 'play-mark', label: 'Play Mark', description: 'The clean white play icon from the LoomTV logo.' },
  { id: 'logo-mark', label: 'Logo Only', description: 'Compact logo-only loader for tighter surfaces.' },
  { id: 'horizontal-logo', label: 'Horizontal Logo', description: 'Full LoomTV wordmark animation for branded screens.' },
];

const SIDEBAR_NAV_LABELS: Record<SidebarNavItemId, string> = {
  anime: 'Anime',
  tv: 'TV Shows',
  movies: 'Movies',
  others: 'Others',
};

const APP_LICENSE = {
  name: 'LoomTV',
  license: 'MIT',
  copyright: 'Copyright (c) 2026 malllenkb',
};

const THIRD_PARTY_DEPENDENCIES = [
  { name: 'Electron', owner: 'Electron Community', license: 'MIT', url: 'https://www.electronjs.org/' },
  { name: 'Electron Forge', owner: 'Electron Forge contributors', license: 'MIT', url: 'https://www.electronforge.io/' },
  { name: 'React', owner: 'Meta Platforms, Inc. and affiliates', license: 'MIT', url: 'https://react.dev/' },
  { name: 'React Router', owner: 'Remix Software', license: 'MIT', url: 'https://reactrouter.com/' },
  { name: 'Vite', owner: 'Evan You and Vite contributors', license: 'MIT', url: 'https://vite.dev/' },
  { name: 'TypeScript', owner: 'Microsoft Corporation', license: 'Apache-2.0', url: 'https://www.typescriptlang.org/' },
  { name: 'Tailwind CSS', owner: 'Tailwind Labs', license: 'MIT', url: 'https://tailwindcss.com/' },
  { name: 'PostCSS', owner: 'Andrey Sitnik and PostCSS contributors', license: 'MIT', url: 'https://postcss.org/' },
  { name: 'better-sqlite3', owner: 'Joshua Wise and contributors', license: 'MIT', url: 'https://github.com/WiseLibs/better-sqlite3' },
  { name: 'clsx', owner: 'Luke Edwards', license: 'MIT', url: 'https://github.com/lukeed/clsx' },
  { name: 'electron-squirrel-startup', owner: 'MongoDB, Inc. and contributors', license: 'Apache-2.0', url: 'https://github.com/mongodb-js/electron-squirrel-startup' },
  { name: 'ffmpeg-static', owner: 'Eugene Ware, Jannis R, and contributors', license: 'GPL-3.0-or-later', url: 'https://github.com/eugeneware/ffmpeg-static' },
  { name: 'ffprobe-static', owner: 'joshwnj and contributors', license: 'MIT', url: 'https://github.com/joshwnj/ffprobe-static' },
  { name: 'hls.js', owner: 'video-dev contributors', license: 'Apache-2.0', url: 'https://github.com/video-dev/hls.js' },
  { name: 'Lucide React', owner: 'Eric Fennis and Lucide contributors', license: 'ISC', url: 'https://lucide.dev/' },
  { name: 'Motion', owner: 'Motion Division', license: 'MIT', url: 'https://motion.dev/' },
  { name: 'tailwind-merge', owner: 'Dany Castillo', license: 'MIT', url: 'https://github.com/dcastil/tailwind-merge' },
  { name: 'DefinitelyTyped type packages', owner: 'DefinitelyTyped contributors', license: 'MIT', url: 'https://github.com/DefinitelyTyped/DefinitelyTyped' },
  { name: 'shadcn/ui-style components', owner: 'shadcn and contributors', license: 'MIT', url: 'https://ui.shadcn.com/' },
];

const METADATA_ATTRIBUTIONS = [
  { name: 'TMDB', details: 'Movie and TV posters, backdrops, cast data, ratings, and metadata.', url: 'https://www.themoviedb.org/' },
  { name: 'TVmaze', details: 'TV show and episode metadata.', url: 'https://www.tvmaze.com/' },
  { name: 'Jikan / MyAnimeList', details: 'Anime posters, ratings, and anime metadata.', url: 'https://jikan.moe/' },
  { name: 'OMDb API', details: 'Fallback movie and TV metadata.', url: 'https://www.omdbapi.com/' },
];

function getUpdateButtonLabel(updateState: UpdateState | null): string {
  if (!updateState) return 'Check for updates';
  if (updateState.status === 'checking') return 'Checking...';
  if (updateState.status === 'downloading') return updateState.downloadPercent ? `Downloading ${updateState.downloadPercent}%` : 'Downloading...';
  if (updateState.status === 'downloaded') return 'Update now';
  if (updateState.status === 'installing') return 'Restarting...';
  return 'Check for updates';
}

function getUpdateStatusText(updateState: UpdateState | null): string {
  if (!updateState) return 'Update status is loading.';
  if (updateState.message) return updateState.message;
  if (updateState.status === 'idle') return 'LoomTV will check for updates automatically.';
  return 'Use the button to check for the latest release.';
}

function isBundledFFmpegPath(pathValue?: string | null): boolean {
  if (!pathValue) return false;
  return /[\\/]ffmpeg[\\/](mac|win|linux)[\\/]/i.test(pathValue);
}

function normalizeSidebarNavOrder(order?: string[]): SidebarNavItemId[] {
  const savedOrder = Array.isArray(order) ? order : [];
  const uniqueSavedOrder = Array.from(new Set(savedOrder));
  return [
    ...uniqueSavedOrder.filter((item): item is SidebarNavItemId => DEFAULT_SIDEBAR_NAV_ORDER.includes(item as SidebarNavItemId)),
    ...DEFAULT_SIDEBAR_NAV_ORDER.filter((item) => !uniqueSavedOrder.includes(item)),
  ];
}

export default function Settings() {
  const { state, addLibraryFolder, scanLibrary, fullRescanLibrary, refreshMetadata, refreshLibrary, clearAppData, removeLibraryFolder, setAutoSyncIntervalHours } = useLibrary();
  const { libraryFolderGroups, isScanning, scanProgress, movies, tvShows, animeShows, autoSyncIntervalHours } = state;

  const [metadataKeys, setMetadataKeys] = useState<Record<string, string>>({});
  const [editingKeys, setEditingKeys] = useState<Record<string, boolean>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderKey, setNewProviderKey] = useState('');
  const [savedKey, setSavedKey] = useState(false);
  const [ffmpegStatus, setFfmpegStatus] = useState<{ available: boolean; path: string | null } | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>(() => {
    const savedSection = localStorage.getItem(SETTINGS_SECTION_STORAGE_KEY);
    return isSettingsSection(savedSection) ? savedSection : 'library';
  });
  const [sidebarNavOrder, setSidebarNavOrder] = useState<SidebarNavItemId[]>(DEFAULT_SIDEBAR_NAV_ORDER);
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
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const { theme, setTheme } = useTheme();
  const METADATA_PROVIDERS = makeMetadataProviders((url) => desktopApi.openExternal(url));

  const refreshLocalNetworkStatus = async () => {
    try {
      setLocalNetworkStatus(await desktopApi.getLocalNetworkStatus());
    } catch (error) {
      console.error('Failed to load local network status:', error);
      setNetworkStatusMessage('Could not read local network status.');
    }
  };

  useEffect(() => {
    desktopApi.getSettings().then((s) => {
      const loadedKeys = {
        ...(s.metadataApiKeys || {}),
        tmdb: s.metadataApiKeys?.tmdb || s.tmdbApiKey || '',
        omdb: s.metadataApiKeys?.omdb || s.omdbApiKey || '',
      };
      setMetadataKeys(loadedKeys);
      setEditingKeys(
        Object.fromEntries(
          Object.entries(loadedKeys).map(([provider, value]) => [provider, !value]),
        ),
      );
      setSidebarNavOrder(normalizeSidebarNavOrder(s.sidebarNavOrder));
    });
    desktopApi.checkFFmpeg().then(setFfmpegStatus);
    void refreshLocalNetworkStatus();
    desktopApi.getUpdateState().then(setUpdateState);
    const unsubscribeUpdates = desktopApi.onUpdateState(setUpdateState);
    try {
      const savedRemoteLibrary = JSON.parse(localStorage.getItem('loomtv:last-remote-library') || 'null') as { baseUrl?: string; code?: string } | null;
      if (savedRemoteLibrary?.baseUrl) setRemoteLibraryAddress(savedRemoteLibrary.baseUrl);
      if (savedRemoteLibrary?.code) setRemoteShareCode(savedRemoteLibrary.code);
      const savedSharedLibrary = JSON.parse(localStorage.getItem('loomtv:shared-library') || 'null') as SharedLibrarySnapshot | null;
      if (savedSharedLibrary?.library) setSharedLibrarySnapshot(savedSharedLibrary);
    } catch {
      // Ignore invalid saved pairing data.
    }
    return unsubscribeUpdates;
  }, []);

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
    });
    setMetadataKeys(cleanedKeys);
    setEditingKeys(
      Object.fromEntries(Object.keys(cleanedKeys).map((provider) => [provider, false])),
    );
    setSavedKey(true);
    setTimeout(() => setSavedKey(false), 2000);
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
      'Clear all LoomTV library folders, metadata, artwork, watch progress, and settings from this device?',
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
      setNetworkStatusMessage(enabled ? 'Local network sharing is on.' : 'Local network sharing is off.');
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
        code: connection.code,
        connectedAt: Date.now(),
      }));
      const snapshot = {
        baseUrl: connection.baseUrl,
        connectedAt: Date.now(),
        library: connection.library,
      };
      localStorage.setItem('loomtv:shared-library', JSON.stringify(snapshot));
      setSharedLibrarySnapshot(snapshot);
      setRemoteLibraryAddress(connection.baseUrl);
      setRemoteShareCode(connection.code);
      setRemoteLibraryStatus(`Connected. Found ${itemCount} shared item${itemCount === 1 ? '' : 's'}.`);
    } catch (error) {
      setRemoteLibraryStatus(error instanceof Error ? error.message : 'Could not connect to that shared library.');
    } finally {
      setIsConnectingRemoteLibrary(false);
    }
  };

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

  return (
    <div className="loom-page h-full overflow-y-auto">
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6">
        <div className="mx-auto max-w-5xl pt-16">
          <LayoutGroup>
            <div className="fixed left-[max(calc(12rem+1.5rem),calc(12rem+((100vw-12rem-64rem)/2)))] top-6 z-40 inline-flex rounded-xl border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-1 backdrop-blur-md">
              {SETTINGS_SECTIONS.map((section) => {
                const isActive = activeSection === section.id;
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => {
                      setActiveSection(section.id);
                      localStorage.setItem(SETTINGS_SECTION_STORAGE_KEY, section.id);
                    }}
                    className={`relative h-9 rounded-lg px-4 text-sm font-medium transition-colors ${
                      isActive
                        ? 'text-[var(--loom-accent-foreground)]'
                        : 'text-[var(--loom-muted)] hover:text-[var(--loom-text)]'
                    }`}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="settings-active-tab"
                        className="absolute inset-0 rounded-lg bg-[var(--loom-accent)]"
                        transition={{ type: 'spring', stiffness: 460, damping: 36, mass: 0.8 }}
                      />
                    )}
                    <span className="relative z-10">{section.label}</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeSection}
              className="space-y-6"
              initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -8, filter: 'blur(6px)' }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >

        {activeSection === 'library' && (
          <>
        {/* Library Folders */}
        <Card className="settings-panel">
          <CardHeader>
            <CardTitle className="text-white">Library Folders</CardTitle>
            <CardDescription className="text-[var(--loom-muted)]">
              Add folders containing your movies, TV shows, anime, and other media.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {folderSections.map((section) => (
                <div key={section.key} className="rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{section.title}</p>
                      <p className="text-xs text-[var(--loom-muted)]">{section.description}</p>
                    </div>
                    <Button onClick={() => addLibraryFolder(section.key)} className="gap-2 shrink-0">
                      <FolderPlus className="w-4 h-4" />
                      Add
                    </Button>
                  </div>

                  <div className="flex flex-col gap-2">
                    {section.folders.length === 0 ? (
                      <p className="text-[var(--loom-faint)] text-sm py-2">No {section.title.toLowerCase()} folders added</p>
                    ) : (
                      section.folders.map((folder) => (
                        <div key={folder} className="settings-panel-soft flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-white">
                          <span className="truncate flex-1">{folder}</span>
                          <button
                            onClick={() => removeLibraryFolder(folder)}
                            className="text-red-500 hover:text-red-400 p-1 shrink-0"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Sidebar Order */}
        <Card className="settings-panel">
          <CardHeader>
            <CardTitle className="text-white">Sidebar Order</CardTitle>
            <CardDescription className="text-[var(--loom-muted)]">
              Drag the middle sidebar items into the order you want.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-2">
              {sidebarNavOrder.map((itemId, index) => (
                <div
                  key={itemId}
                  draggable
                  onDragStart={() => setDraggedSidebarItem(itemId)}
                  onDragEnd={() => setDraggedSidebarItem(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => handleSidebarOrderDrop(itemId)}
                  className={`flex cursor-grab items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors active:cursor-grabbing ${
                    draggedSidebarItem === itemId
                      ? 'border-[var(--loom-accent)] bg-[var(--loom-accent)]/10'
                      : 'border-[var(--loom-panel-border)] bg-[var(--loom-surface-2)] hover:border-[var(--loom-accent)]/35'
                  }`}
                >
                  <GripVertical className="h-4 w-4 shrink-0 text-[var(--loom-faint)]" />
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[var(--loom-surface-3)] text-xs font-semibold text-[var(--loom-accent)]">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium text-white">
                    {SIDEBAR_NAV_LABELS[itemId]}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveSidebarItem(itemId, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${SIDEBAR_NAV_LABELS[itemId]} up`}
                      className="grid h-8 w-8 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSidebarItem(itemId, 1)}
                      disabled={index === sidebarNavOrder.length - 1}
                      aria-label={`Move ${SIDEBAR_NAV_LABELS[itemId]} down`}
                      className="grid h-8 w-8 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-[var(--loom-faint)]">
              Home stays pinned first. Settings and refresh stay pinned at the bottom.
            </p>
          </CardContent>
        </Card>

        {/* Scan Library */}
        <Card className="settings-panel">
          <CardHeader>
            <CardTitle className="text-white">Scan Library</CardTitle>
            <CardDescription className="text-[var(--loom-muted)]">
              Scans local files and fetches metadata from TMDB, TVmaze, Jikan (MAL), and OMDb.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-sm text-[var(--loom-muted)]">
                Movies: {movies.length} &nbsp;|&nbsp; TV Shows: {tvShows.length} &nbsp;|&nbsp; Anime: {animeShows.length}
              </p>
              {isScanning && (
                <div className="space-y-2">
                  <div className="w-full bg-[var(--loom-bg)] rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-[var(--loom-accent)] h-2 rounded-full transition-[width] duration-300"
                      style={{ width: `${Math.max(4, scanProgress)}%` }}
                    />
                  </div>
                  <p className="text-xs text-[var(--loom-muted)]">Syncing library progressively... {scanProgress}%</p>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={scanLibrary} disabled={isScanning} className="gap-2">
                  <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
                  {isScanning ? 'Syncing...' : 'Quick Sync'}
                </Button>
                <Button onClick={refreshMetadata} disabled={isScanning} variant="outline" className="gap-2">
                  Refresh Metadata
                </Button>
                <Button onClick={fullRescanLibrary} disabled={isScanning} variant="outline" className="gap-2">
                  Full Rescan
                </Button>
                <Button onClick={refreshLibrary} variant="outline" className="gap-2">
                  Refresh
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Automatic Sync */}
        <Card className="settings-panel">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--loom-accent)]" />
              Automatic Sync
            </CardTitle>
            <CardDescription className="text-[var(--loom-muted)]">
              Automatically refreshes your local files and metadata while LoomTV is open.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-3">
              <label className="relative inline-flex h-11 min-w-56 items-center rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] text-sm text-white transition-colors focus-within:border-[var(--loom-accent)]">
                <Clock className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--loom-accent)]" />
                <select
                  value={autoSyncIntervalHours}
                  onChange={(event) => void setAutoSyncIntervalHours(Number(event.target.value))}
                  aria-label="Automatic sync interval"
                  className="h-full w-full cursor-pointer appearance-none rounded-lg bg-transparent py-0 pl-9 pr-10 text-sm font-medium text-white outline-none"
                >
                  {AUTO_SYNC_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-[var(--loom-muted)]" />
              </label>
              <p className="text-sm text-[var(--loom-muted)]">
                Current interval: {AUTO_SYNC_OPTIONS.find((option) => option.value === autoSyncIntervalHours)?.label.toLowerCase() || `${autoSyncIntervalHours} hours`}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="settings-panel">
          <CardHeader>
            <CardTitle className="text-white">Data Management</CardTitle>
            <CardDescription className="text-[var(--loom-muted)]">
              Back up the database or clear this device's local LoomTV data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3">
              <div className="settings-panel-soft rounded-xl p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-semibold text-white">
                      <Download className="h-4 w-4 text-[var(--loom-accent)]" />
                      Database Backup
                    </p>
                    <p className="mt-1 text-xs text-[var(--loom-muted)]">
                      Saves a copy of the local SQLite database with library metadata, artwork, progress, and settings.
                    </p>
                  </div>
                  <Button onClick={handleBackupDatabase} variant="outline" className="gap-2">
                    <Download className="h-4 w-4" />
                    Back Up Database
                  </Button>
                </div>
                {backupStatus && <p className="mt-3 min-w-0 truncate text-sm text-[var(--loom-muted)]">{backupStatus}</p>}
              </div>

              <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-semibold text-white">
                      <Trash2 className="h-4 w-4 text-red-400" />
                      Clear App Data
                    </p>
                    <p className="mt-1 text-xs text-[var(--loom-muted)]">
                      Removes saved library folders, scanned metadata, artwork, watch progress, and settings.
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={handleClearAppData}
                    disabled={isClearingData}
                    variant="outline"
                    className="gap-2 border-red-500/25 bg-red-500/10 text-red-100 hover:border-red-400/40 hover:bg-red-500/20 hover:text-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    {isClearingData ? 'Clearing...' : 'Clear Data'}
                  </Button>
                </div>
                {clearDataStatus && <p className="mt-3 text-sm text-[var(--loom-muted)]">{clearDataStatus}</p>}
              </div>
            </div>
          </CardContent>
        </Card>
          </>
        )}

        {activeSection === 'network' && (
          <>
            <Card className="settings-panel">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-white">
                  <Wifi className="h-4 w-4 text-[var(--loom-accent)]" />
                  Local Network Sharing
                </CardTitle>
                <CardDescription className="text-[var(--loom-muted)]">
                  Share this device's library with nearby LoomTV apps without internet.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="settings-panel-soft rounded-lg p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">Sharing device</p>
                    <p className="mt-1 text-sm text-[var(--loom-muted)]">Turn on sharing, then give the other person this 6-digit share code.</p>
                  </div>
                  <div className="settings-panel-soft rounded-lg p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">Connecting device</p>
                    <p className="mt-1 text-sm text-[var(--loom-muted)]">Join the same Wi-Fi network, enter the code below, then connect.</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-4">
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {isTogglingNetworkSharing ? 'Updating sharing...' : isNetworkSharingOn ? 'Sharing is on' : 'Sharing is off'}
                    </p>
                    <p className="text-xs text-[var(--loom-muted)]">
                      {isTogglingNetworkSharing
                        ? 'Preparing the local network address and share code.'
                        : isNetworkSharingOn
                        ? 'Only devices with this 6-digit code can read the network library or stream files.'
                        : 'Turn on sharing to reveal this device address, library URL, and share code.'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={() => void setLocalNetworkSharing(!isNetworkSharingOn)}
                    disabled={isTogglingNetworkSharing}
                    className="gap-2"
                    variant={isNetworkSharingOn ? 'outline' : 'default'}
                  >
                    {isTogglingNetworkSharing ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Wifi className="h-4 w-4" />
                    )}
                    {isTogglingNetworkSharing ? 'Updating...' : isNetworkSharingOn ? 'Turn Off' : 'Turn On'}
                  </Button>
                </div>

                <AnimatePresence initial={false}>
                  {isNetworkSharingOn && (
                    <motion.div
                      className="space-y-5"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="settings-panel-soft rounded-lg p-3">
                          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">Device Address</p>
                          <div className="flex items-center gap-2">
                            <code className="min-w-0 flex-1 truncate text-sm text-white">
                              {localNetworkStatus?.baseUrl || 'No local network address found'}
                            </code>
                            <button
                              type="button"
                              onClick={() => void copyNetworkValue(localNetworkStatus?.baseUrl)}
                              disabled={!localNetworkStatus?.baseUrl}
                              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:opacity-35"
                              aria-label="Copy device address"
                            >
                              <Copy className="h-4 w-4" />
                            </button>
                          </div>
                        </div>

                        <div className="settings-panel-soft rounded-lg p-3">
                          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">Share Code</p>
                          <div className="flex items-center gap-2">
                            <code className="min-w-0 flex-1 truncate text-sm text-white">
                              {localNetworkStatus?.token || 'Loading...'}
                            </code>
                            <button
                              type="button"
                              onClick={() => void copyNetworkValue(localNetworkStatus?.token)}
                              disabled={!localNetworkStatus?.token}
                              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:opacity-35"
                              aria-label="Copy share code"
                            >
                              <Copy className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="settings-panel-soft rounded-lg p-3">
                        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">Network Library URL</p>
                        <div className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 truncate text-sm text-white">
                            {localNetworkStatus?.libraryUrl || 'Turn on sharing to expose the network library'}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copyNetworkValue(localNetworkStatus?.libraryUrl)}
                            disabled={!localNetworkStatus?.libraryUrl}
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:opacity-35"
                            aria-label="Copy network library URL"
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      {localNetworkStatus?.addresses?.length ? (
                        <p className="text-xs text-[var(--loom-faint)]">
                          Network: {currentNetworkName} · Visible addresses: {localNetworkStatus.addresses.join(', ')}
                        </p>
                      ) : (
                        <p className="text-xs text-[var(--loom-faint)]">
                          Connect this device to Wi-Fi or Ethernet to make it visible to other devices.
                        </p>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
                {networkStatusMessage && <p className="text-sm text-[var(--loom-muted)]">{networkStatusMessage}</p>}
              </CardContent>
            </Card>

            <Card className="settings-panel">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-white">
                  <Key className="h-4 w-4 text-[var(--loom-accent)]" />
                  Connect to Shared Library
                </CardTitle>
                <CardDescription className="text-[var(--loom-muted)]">
                  Use the 6-digit code from the sharing device. LoomTV will find it on the same network.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3 rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] p-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-500/12 text-emerald-400">
                    <Wifi className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">Current Network</p>
                    <p className="truncate text-sm font-semibold text-white">{currentNetworkName}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={remoteShareCode}
                    onChange={(event) => setRemoteShareCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    aria-label="Share code"
                    className="h-10 w-44 rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 text-center text-sm font-semibold tracking-[0.28em] text-white outline-none transition-colors placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)]"
                  />
                  <Button
                    type="button"
                    onClick={() => void connectRemoteLibrary()}
                    disabled={isConnectingRemoteLibrary || !/^\d{6}$/.test(remoteShareCode)}
                    className="ml-auto gap-2 px-5"
                  >
                    <Wifi className="h-4 w-4" />
                    {isConnectingRemoteLibrary ? 'Connecting...' : 'Connect'}
                  </Button>
                </div>

                <button
                  type="button"
                  onClick={() => setShowManualNetworkAddress((current) => !current)}
                  className="rounded-md text-xs font-medium text-[var(--loom-accent)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--loom-surface)]"
                >
                  {showManualNetworkAddress ? 'Hide manual address' : 'Advanced: enter address manually'}
                </button>

                {showManualNetworkAddress && (
                  <input
                    type="text"
                    value={remoteLibraryAddress}
                    onChange={(event) => setRemoteLibraryAddress(event.target.value)}
                    placeholder="192.168.1.50:3847"
                    className="h-10 w-full min-w-0 rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 text-sm text-white outline-none transition-colors placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)]"
                  />
                )}
                {remoteLibraryStatus && <p className="text-sm text-[var(--loom-muted)]">{remoteLibraryStatus}</p>}
              </CardContent>
            </Card>

            {sharedLibrarySnapshot && (
              <Card className="settings-panel">
                <CardHeader>
                  <CardTitle className="text-white">Shared Library</CardTitle>
                  <CardDescription className="text-[var(--loom-muted)]">
                    Connected from {sharedLibrarySnapshot.baseUrl}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-3 md:grid-cols-3">
                    {sharedLibrarySections.map((section) => (
                      <div key={section.title} className="settings-panel-soft rounded-lg p-3">
                        <p className="text-sm font-semibold text-white">{section.title}</p>
                        <p className="mb-3 text-xs text-[var(--loom-muted)]">{section.items.length} item{section.items.length === 1 ? '' : 's'}</p>
                        <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                          {section.items.length === 0 ? (
                            <p className="text-xs text-[var(--loom-faint)]">Nothing shared here yet.</p>
                          ) : (
                            section.items.map((item, index) => (
                              <p key={`${section.title}-${item.title || index}`} className="truncate text-xs text-[var(--loom-muted)]">
                                {item.title || 'Untitled'}{item.year ? ` (${item.year})` : ''}
                              </p>
                            ))
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {activeSection === 'metadata' && (
          <>
        {/* Metadata API keys */}
        <Card className="settings-panel">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Key className="w-4 h-4 text-[var(--loom-accent)]" />
              Metadata API Keys
            </CardTitle>
            <CardDescription className="text-[var(--loom-muted)]">
              The app automatically lists every keyed metadata provider it knows about.
              TVmaze and Jikan do not need keys.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
              {METADATA_PROVIDERS.map((provider) => {
                const currentValue = metadataKeys[provider.id] || '';
                const isEditing = editingKeys[provider.id] ?? !currentValue;
                const isVisible = visibleKeys[provider.id] || false;
                return (
                  <div key={provider.id} className="space-y-2 border-b border-[var(--loom-border)] pb-5 last:border-b-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-white">{provider.label}</p>
                        {provider.badge && (
                          <span className={`text-xs px-2 py-0.5 rounded font-normal ${provider.required ? 'bg-[var(--loom-accent)]/20 text-[var(--loom-accent)]' : 'bg-white/10 text-[var(--loom-muted)]'}`}>
                            {provider.badge}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-[var(--loom-muted)]">{provider.description}</p>
                    </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type={isEditing || isVisible ? 'text' : 'password'}
                        value={currentValue}
                        onChange={(e) => setMetadataKey(provider.id, e.target.value)}
                        placeholder={provider.placeholder}
                        readOnly={!isEditing}
                        className="min-w-0 flex-1 bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)] read-only:text-[var(--loom-muted)]"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        onClick={() => toggleProviderVisibility(provider.id)}
                        disabled={!currentValue}
                        title={isVisible ? `Hide ${provider.label}` : `Show ${provider.label}`}
                        aria-label={isVisible ? `Hide ${provider.label}` : `Show ${provider.label}`}
                        className="h-10 w-10 shrink-0"
                      >
                        {isVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        onClick={() => setProviderEditing(provider.id, !isEditing)}
                        title={isEditing ? `Done editing ${provider.label}` : `Edit ${provider.label}`}
                        aria-label={isEditing ? `Done editing ${provider.label}` : `Edit ${provider.label}`}
                        className="h-10 w-10 shrink-0"
                      >
                        {isEditing ? <Save className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        onClick={() => handleDeleteMetadataKey(provider.id)}
                        disabled={!currentValue}
                        title={`Delete ${provider.label}`}
                        aria-label={`Delete ${provider.label}`}
                        className="h-10 w-10 shrink-0 border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}

            {customProviders.length > 0 && (
              <div className="space-y-3 border-t border-[var(--loom-border)] pt-5">
                <p className="text-sm font-semibold text-white">Additional Metadata Keys</p>
                  {customProviders.map((providerId) => {
                    const currentValue = metadataKeys[providerId] || '';
                    const isEditing = editingKeys[providerId] ?? !currentValue;
                    const isVisible = visibleKeys[providerId] || false;
                    return (
                      <div key={providerId} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={providerId}
                          readOnly
                          className="w-36 shrink-0 bg-[var(--loom-bg)] text-[var(--loom-muted)] border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm"
                        />
                        <input
                          type={isEditing || isVisible ? 'text' : 'password'}
                          value={currentValue}
                          onChange={(e) => setMetadataKey(providerId, e.target.value)}
                          readOnly={!isEditing}
                          placeholder="API key"
                          className="min-w-0 flex-1 bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)] read-only:text-[var(--loom-muted)]"
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          onClick={() => toggleProviderVisibility(providerId)}
                          disabled={!currentValue}
                          title={isVisible ? `Hide ${providerId}` : `Show ${providerId}`}
                          aria-label={isVisible ? `Hide ${providerId}` : `Show ${providerId}`}
                          className="h-10 w-10 shrink-0"
                        >
                          {isVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          onClick={() => setProviderEditing(providerId, !isEditing)}
                          title={isEditing ? `Done editing ${providerId}` : `Edit ${providerId}`}
                          aria-label={isEditing ? `Done editing ${providerId}` : `Edit ${providerId}`}
                          className="h-10 w-10 shrink-0"
                        >
                          {isEditing ? <Save className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          onClick={() => handleDeleteMetadataKey(providerId)}
                          disabled={!currentValue}
                          title={`Delete ${providerId}`}
                          aria-label={`Delete ${providerId}`}
                          className="h-10 w-10 shrink-0 border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                        </div>
                      );
                })}
              </div>
            )}

              <div className="space-y-3 border-t border-[var(--loom-border)] pt-5">
                <p className="text-sm font-semibold text-white">Add New Metadata Key</p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newProviderName}
                    onChange={(e) => setNewProviderName(e.target.value)}
                    placeholder="Provider name, e.g. fanart"
                    className="w-52 shrink-0 bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)]"
                  />
                  <input
                    type="text"
                    value={newProviderKey}
                    onChange={(e) => setNewProviderKey(e.target.value)}
                    placeholder="API key"
                    className="min-w-0 flex-1 bg-[var(--loom-bg)] text-white border border-[var(--loom-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--loom-accent)]"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={handleAddMetadataKey}
                    disabled={!normalizeProviderId(newProviderName) || !newProviderKey.trim()}
                    title="Add metadata key"
                    aria-label="Add metadata key"
                    className="h-10 w-10 shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </div>
          </CardContent>
        </Card>

        {/* Save button for metadata keys */}
        <Button onClick={handleSaveApiKeys} className="gap-2 w-full sm:w-auto">
          {savedKey ? <CheckCircle className="w-4 h-4" /> : <Key className="w-4 h-4" />}
          {savedKey ? 'API keys saved!' : 'Save API Keys'}
        </Button>
          </>
        )}

        {activeSection === 'theme' && (
          <div className="space-y-6">
            <Card className="settings-panel">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2 text-[var(--loom-text)]">
                  <Palette className="h-4 w-4 text-[var(--loom-accent)]" />
                  Theme
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-8">
                <div className="space-y-7">
                  <div>
                    <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Dark Theme</p>
                    <div className="flex flex-wrap gap-2">
                      {(Object.keys(DARK_THEMES) as AppDarkTheme[]).map((darkTheme) => {
                        const palette = DARK_THEMES[darkTheme];
                        const isSelected = theme.darkTheme === darkTheme;
                        return (
                          <button
                            key={darkTheme}
                            type="button"
                            onClick={() => void setTheme({ darkTheme })}
                            className={`inline-flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                              isSelected
                                ? 'bg-[var(--loom-accent)]/10 ring-1 ring-[var(--loom-accent)]/80'
                                : 'bg-[var(--loom-bg)] hover:bg-[var(--loom-surface-3)]/55'
                            }`}
                          >
                            <span className="text-sm font-semibold text-[var(--loom-text)]">{palette.label}</span>
                            <span
                              className="block h-6 w-14 rounded-md ring-1 ring-white/10"
                              style={{ backgroundColor: palette.bg }}
                            >
                              <span className="sr-only">{palette.bg}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Logo Colour</p>
                    <div className="flex flex-wrap gap-2">
                      {(Object.keys(THEME_COLORS) as AppThemeColor[]).map((color) => {
                        const palette = THEME_COLORS[color];
                        const isSelected = theme.color === color;
                        return (
                          <button
                            key={color}
                            type="button"
                            onClick={() => void setTheme({ color })}
                            className={`inline-flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                              isSelected
                                ? 'bg-[var(--loom-accent)]/10 ring-1 ring-[var(--loom-accent)]/80'
                                : 'bg-[var(--loom-bg)] hover:bg-[var(--loom-surface-3)]/55'
                            }`}
                          >
                            <span
                              className="text-sm font-semibold"
                              style={{ color: color === 'yellow' ? '#fbc500' : 'var(--loom-text)' }}
                            >
                              {color === 'yellow' ? 'Yellow' : palette.label}
                            </span>
                            <span
                              className="block h-6 w-14 rounded-md ring-1 ring-black/10"
                              style={{ backgroundColor: palette.hex }}
                            >
                              <span className="sr-only">{palette.hex}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="space-y-7">
                  <div>
                    <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Preview</p>
                    <div className="grid gap-4 rounded-lg bg-[var(--loom-bg)] p-4 ring-1 ring-white/10 lg:grid-cols-[minmax(0,1fr)_13rem]">
                      <div className="flex min-h-52 items-center justify-center rounded-lg bg-[var(--loom-surface-2)] p-8">
                        <LoomBrandLockup className="h-32 w-auto" />
                      </div>
                      <div className="grid gap-3">
                        <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--loom-surface-2)] px-3 py-3">
                          <span className="text-xs font-medium text-[var(--loom-muted)]">Icon</span>
                          <LoomPlayMark className="h-7 w-7 text-[var(--loom-accent)]" />
                        </div>
                        <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--loom-surface-2)] px-3 py-3">
                          <span className="text-xs font-medium text-[var(--loom-muted)]">Horizontal</span>
                          <LoomLogo className="h-7 w-auto" />
                        </div>
                        <Button className="h-12 gap-2">
                          <Palette className="h-4 w-4" />
                          Accent Action
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="mb-3 text-sm font-semibold text-[var(--loom-text)]">Loader</p>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {LOADER_OPTIONS.map((option) => {
                        const isSelected = theme.loaderStyle === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => void setTheme({ loaderStyle: option.id })}
                            className={`flex min-h-28 flex-col items-center justify-center gap-3 rounded-lg p-3 text-center transition-colors ${
                              isSelected
                                ? 'bg-[var(--loom-accent)]/10 ring-1 ring-[var(--loom-accent)]/80'
                                : 'bg-[var(--loom-bg)] hover:bg-[var(--loom-surface-3)]/55'
                            }`}
                          >
                            <LoomLoader
                              style={option.id}
                              className="h-12 w-12 rounded-full bg-white/10 text-white ring-1 ring-white/10"
                              markClassName={option.id === 'horizontal-logo' ? 'h-4 w-auto' : 'h-7 w-7'}
                              color="currentColor"
                            />
                            <span className="block text-sm font-semibold text-[var(--loom-text)]">{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {activeSection === 'about' && (
          <div className="space-y-4">
            {/* App identity hero */}
            <div className="settings-panel relative overflow-hidden rounded-2xl p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <h2 className="text-2xl font-bold tracking-tight text-white">{APP_LICENSE.name}</h2>
                    <span className="rounded-full bg-[var(--loom-accent)]/15 px-2.5 py-0.5 text-xs font-semibold text-[var(--loom-accent)] ring-1 ring-[var(--loom-accent)]/25">
                      v{updateState?.currentVersion ?? 'dev'}
                    </span>
                    <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs font-medium text-[var(--loom-faint)] ring-1 ring-white/10">
                      {APP_LICENSE.license}
                    </span>
                  </div>
                  <p className="text-sm text-[var(--loom-muted)] max-w-md leading-relaxed">
                    Local media library and playback app powered by Electron, React, and FFmpeg.
                  </p>
                  <p className="mt-3 text-xs text-[var(--loom-faint)]">{APP_LICENSE.copyright}</p>
                </div>

                <div className="grid min-w-48 gap-3 sm:w-52">
                  <div className="rounded-lg bg-[var(--loom-surface-2)] p-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (updateState?.status === 'downloaded') {
                          void desktopApi.installUpdate();
                        } else {
                          void desktopApi.checkForUpdates().then(setUpdateState);
                        }
                      }}
                      disabled={updateState?.status === 'checking' || updateState?.status === 'downloading' || updateState?.status === 'installing'}
                      className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-[var(--loom-accent)] px-3 text-xs font-semibold text-[var(--loom-accent-foreground)] transition-colors hover:bg-[var(--loom-accent-hover)] disabled:cursor-wait disabled:opacity-70"
                    >
                      {updateState?.status === 'checking' || updateState?.status === 'downloading' || updateState?.status === 'installing' ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      {getUpdateButtonLabel(updateState)}
                    </button>
                  </div>

                  <div className="rounded-lg bg-[var(--loom-surface-2)] p-1">
                    <div className={`flex h-9 items-center justify-center gap-2 rounded-md px-3 text-xs font-medium ${
                      ffmpegStatus === null
                        ? 'text-[var(--loom-faint)]'
                      : ffmpegStatus.available
                        ? 'text-green-400'
                        : 'bg-yellow-500/8 text-yellow-400 ring-1 ring-yellow-500/20'
                    }`}>
                      {ffmpegStatus === null ? (
                        <>
                          <span className="h-2 w-2 rounded-full bg-[var(--loom-faint)]" />
                          Checking FFmpeg...
                        </>
                      ) : ffmpegStatus.available ? (
                        <>
                          <CheckCircle className="h-3.5 w-3.5" />
                          {isBundledFFmpegPath(ffmpegStatus.path) ? 'Bundled FFmpeg' : 'System FFmpeg'}
                        </>
                      ) : (
                        <>
                          <span className="h-2 w-2 rounded-full bg-yellow-400" />
                          FFmpeg not found
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-6 grid gap-3 md:grid-cols-2">
                <div className="settings-panel-soft rounded-xl p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-faint)]">Update Status</p>
                  <p className="mt-2 text-sm leading-5 text-[var(--loom-muted)]">{getUpdateStatusText(updateState)}</p>
                </div>
                <div className="settings-panel-soft rounded-xl p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-faint)]">License Scope</p>
                  <p className="mt-2 text-sm leading-5 text-[var(--loom-muted)]">
                    LoomTV source is MIT licensed. Third-party libraries, services, and bundled tools keep their own licenses.
                  </p>
                </div>
              </div>
            </div>

            {/* Metadata sources */}
            <Card className="settings-panel">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-white">Metadata &amp; Artwork Sources</CardTitle>
                <CardDescription className="text-[var(--loom-faint)] text-xs">
                  Content data is fetched from these services at scan time.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2">
                  {METADATA_ATTRIBUTIONS.map((source) => (
                    <button
                      key={source.name}
                      type="button"
                      onClick={() => desktopApi.openExternal(source.url)}
                      className="settings-action-tile group flex items-start gap-3 rounded-xl p-3 text-left transition-all"
                    >
                      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--loom-accent)]/10 transition-colors group-hover:bg-[var(--loom-accent)]/18">
                        <ExternalLink className="h-3.5 w-3.5 text-[var(--loom-accent)]" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white leading-tight">{source.name}</p>
                        <p className="mt-0.5 text-xs leading-4 text-[var(--loom-faint)]">{source.details}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Bundled media tools */}
            <Card className="settings-panel">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-white">Bundled Media Tools</CardTitle>
                <CardDescription className="text-[var(--loom-faint)] text-xs leading-5">
                  LoomTV bundles FFmpeg and FFprobe for macOS and Windows. These binaries include GPL
                  components and are distributed under GNU GPL v3 or later. FFmpeg is a trademark of
                  Fabrice Bellard; LoomTV is not affiliated with the FFmpeg project.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { label: 'macOS FFmpeg builds', sub: "Martin Riedl's FFmpeg Build Server", url: 'https://ffmpeg.martin-riedl.de/' },
                    { label: 'Windows FFmpeg builds', sub: 'CODEX FFMPEG by Gyan Doshi', url: 'https://www.gyan.dev/ffmpeg/builds/' },
                    { label: 'FFmpeg legal notes', sub: 'Licensing and compliance guidance', url: 'https://ffmpeg.org/legal.html' },
                    { label: 'FFmpeg source code', sub: 'Official FFmpeg source repository', url: 'https://git.ffmpeg.org/ffmpeg.git' },
                  ].map((link) => (
                    <button
                      key={link.label}
                      type="button"
                      onClick={() => desktopApi.openExternal(link.url)}
                      className="settings-action-tile group flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-all"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white leading-tight">{link.label}</p>
                        <p className="text-xs text-[var(--loom-faint)] mt-0.5">{link.sub}</p>
                      </div>
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[var(--loom-accent)] opacity-60 group-hover:opacity-100 transition-opacity" />
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Third-party libraries */}
            <Card className="settings-panel">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-white">Third-Party Libraries</CardTitle>
                <CardDescription className="text-[var(--loom-faint)] text-xs">
                  Direct dependencies and major development tools. Packaged builds also include Chromium/Electron notices.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="settings-panel-soft overflow-hidden rounded-xl">
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem_2.5rem] bg-black/16 px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--loom-faint)]">
                    <span>Project</span>
                    <span>License</span>
                    <span />
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-[var(--loom-panel-border)]">
                    {THIRD_PARTY_DEPENDENCIES.map((dependency) => (
                      <div
                        key={dependency.name}
                        className="grid grid-cols-[minmax(0,1fr)_7rem_2.5rem] items-center gap-2 px-3 py-2.5 transition-colors hover:bg-[var(--loom-surface-3)]/70"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white">{dependency.name}</p>
                          <p className="truncate text-xs text-[var(--loom-faint)]">{dependency.owner}</p>
                        </div>
                        <span className="truncate text-xs text-[var(--loom-faint)]">{dependency.license}</span>
                        <button
                          type="button"
                          onClick={() => desktopApi.openExternal(dependency.url)}
                          aria-label={`Open ${dependency.name}`}
                          title={dependency.name}
                          className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-[var(--loom-accent)] opacity-50 transition-all hover:opacity-100 hover:bg-[var(--loom-surface-3)]"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
