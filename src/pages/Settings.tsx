import React, { useEffect, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { FolderPlus, RefreshCw, X, Key, CheckCircle, ExternalLink, Pencil, Plus, Save, Trash2, Eye, EyeOff, Clock, GripVertical, Download } from 'lucide-react';
import { useLibrary } from '@/contexts/LibraryContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { desktopApi } from '@/lib/desktopApi';

type MetadataProvider = {
  id: string;
  label: string;
  description: React.ReactNode;
  placeholder: string;
  badge?: string;
  required?: boolean;
};

const METADATA_PROVIDERS: MetadataProvider[] = [
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
        <a
          href="https://www.themoviedb.org/settings/api"
          target="_blank"
          rel="noreferrer"
          className="text-[#eba865] hover:underline inline-flex items-center gap-0.5"
        >
          themoviedb.org <ExternalLink className="w-3 h-3" />
        </a>
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
        <a
          href="https://www.omdbapi.com/apikey.aspx"
          target="_blank"
          rel="noreferrer"
          className="text-[#eba865] hover:underline inline-flex items-center gap-0.5"
        >
          omdbapi.com <ExternalLink className="w-3 h-3" />
        </a>
        .
      </>
    ),
  },
];

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

type SettingsSection = 'library' | 'metadata' | 'about';
type SidebarNavItemId = 'anime' | 'tv' | 'movies';

const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'metadata', label: 'Metadata API Keys' },
  { id: 'about', label: 'About' },
];

const DEFAULT_SIDEBAR_NAV_ORDER: SidebarNavItemId[] = ['anime', 'tv', 'movies'];

const SIDEBAR_NAV_LABELS: Record<SidebarNavItemId, string> = {
  anime: 'Anime',
  tv: 'TV Shows',
  movies: 'Movies',
};

function normalizeSidebarNavOrder(order?: string[]): SidebarNavItemId[] {
  const savedOrder = Array.isArray(order) ? order : [];
  const uniqueSavedOrder = Array.from(new Set(savedOrder));
  return [
    ...uniqueSavedOrder.filter((item): item is SidebarNavItemId => DEFAULT_SIDEBAR_NAV_ORDER.includes(item as SidebarNavItemId)),
    ...DEFAULT_SIDEBAR_NAV_ORDER.filter((item) => !uniqueSavedOrder.includes(item)),
  ];
}

export default function Settings() {
  const { state, addLibraryFolder, scanLibrary, refreshLibrary, removeLibraryFolder, setAutoSyncIntervalHours } = useLibrary();
  const { libraryFolderGroups, isScanning, movies, tvShows, animeShows, autoSyncIntervalHours } = state;

  const [metadataKeys, setMetadataKeys] = useState<Record<string, string>>({});
  const [editingKeys, setEditingKeys] = useState<Record<string, boolean>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderKey, setNewProviderKey] = useState('');
  const [savedKey, setSavedKey] = useState(false);
  const [ffmpegStatus, setFfmpegStatus] = useState<{ available: boolean; path: string | null } | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>('library');
  const [sidebarNavOrder, setSidebarNavOrder] = useState<SidebarNavItemId[]>(DEFAULT_SIDEBAR_NAV_ORDER);
  const [draggedSidebarItem, setDraggedSidebarItem] = useState<SidebarNavItemId | null>(null);
  const [backupStatus, setBackupStatus] = useState('');

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

  const handleBackupDatabase = async () => {
    setBackupStatus('');
    const result = await desktopApi.backupDatabase();
    if (result.ok && result.path) {
      setBackupStatus(`Saved to ${result.path}`);
    } else if (result.error !== 'cancelled') {
      setBackupStatus('Backup failed. Try another location.');
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
      folders: libraryFolderGroups.movies,
    },
    {
      key: 'tvShows' as const,
      title: 'TV Shows',
      description: 'Folders added here always scan into TV Shows.',
      folders: libraryFolderGroups.tvShows,
    },
    {
      key: 'anime' as const,
      title: 'Anime / Animations',
      description: 'Folders added here always scan into Anime.',
      folders: libraryFolderGroups.anime,
    },
  ];

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a]">
      <div className="page-bottom-safe mx-auto max-w-[1440px] p-6">
        <div className="mx-auto max-w-4xl pt-16">
          <LayoutGroup>
            <div className="fixed left-[max(calc(12rem+1.5rem),calc(12rem+((100vw-12rem-56rem)/2)))] top-6 z-40 inline-flex rounded-xl border border-[#343434] bg-[#232323]/95 p-1 shadow-lg shadow-black/10 backdrop-blur-md">
              {SETTINGS_SECTIONS.map((section) => {
                const isActive = activeSection === section.id;
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSection(section.id)}
                    className={`relative h-9 rounded-lg px-4 text-sm font-medium transition-colors ${
                      isActive
                        ? 'text-black'
                        : 'text-[#a8a8a8] hover:text-white'
                    }`}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="settings-active-tab"
                        className="absolute inset-0 rounded-lg bg-[#eba865]"
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
        <Card className="bg-[#232323] border-[#2d2d2d]">
          <CardHeader>
            <CardTitle className="text-white">Library Folders</CardTitle>
            <CardDescription className="text-[#a8a8a8]">
              Add folders containing your movies, TV shows, and anime
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-5">
              {folderSections.map((section) => (
                <div key={section.key} className="rounded-lg border border-[#343434] bg-[#1d1d1d] p-3">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{section.title}</p>
                      <p className="text-xs text-[#a8a8a8]">{section.description}</p>
                    </div>
                    <Button onClick={() => addLibraryFolder(section.key)} className="gap-2 shrink-0">
                      <FolderPlus className="w-4 h-4" />
                      Add
                    </Button>
                  </div>

                  <div className="flex flex-col gap-2">
                    {section.folders.length === 0 ? (
                      <p className="text-[#777] text-sm py-2">No {section.title.toLowerCase()} folders added</p>
                    ) : (
                      section.folders.map((folder) => (
                        <div key={folder} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#151515] text-white text-sm">
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
        <Card className="bg-[#232323] border-[#2d2d2d]">
          <CardHeader>
            <CardTitle className="text-white">Sidebar Order</CardTitle>
            <CardDescription className="text-[#a8a8a8]">
              Drag the middle sidebar items into the order you want.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 rounded-lg border border-[#343434] bg-[#1d1d1d] p-2">
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
                      ? 'border-[#eba865] bg-[#eba865]/10'
                      : 'border-[#343434] bg-[#151515] hover:border-[#4a4a4a]'
                  }`}
                >
                  <GripVertical className="h-4 w-4 shrink-0 text-[#777]" />
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[#2d2d2d] text-xs font-semibold text-[#eba865]">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium text-white">
                    {SIDEBAR_NAV_LABELS[itemId]}
                  </span>
                  <span className="text-xs text-[#777]">Drag</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-[#777]">
              Home stays pinned first. Settings and refresh stay pinned at the bottom.
            </p>
          </CardContent>
        </Card>

        {/* Scan Library */}
        <Card className="bg-[#232323] border-[#2d2d2d]">
          <CardHeader>
            <CardTitle className="text-white">Scan Library</CardTitle>
            <CardDescription className="text-[#a8a8a8]">
              Scans local files and fetches metadata from TMDB, TVmaze, Jikan (MAL), and OMDb.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-sm text-[#a8a8a8]">
                Movies: {movies.length} &nbsp;|&nbsp; TV Shows: {tvShows.length} &nbsp;|&nbsp; Anime: {animeShows.length}
              </p>
              {isScanning && (
                <div className="w-full bg-[#1a1a1a] rounded-full h-2">
                  <div className="bg-[#eba865] h-2 rounded-full animate-pulse w-full" />
                </div>
              )}
              <div className="flex gap-2">
                <Button onClick={scanLibrary} disabled={isScanning} className="gap-2">
                  <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
                  {isScanning ? 'Scanning…' : 'Scan Library'}
                </Button>
                <Button onClick={refreshLibrary} variant="outline" className="gap-2">
                  Refresh
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[#232323] border-[#2d2d2d]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Download className="h-4 w-4 text-[#eba865]" />
              Database Backup
            </CardTitle>
            <CardDescription className="text-[#a8a8a8]">
              Saves a copy of the local SQLite database with library metadata, artwork, progress, and settings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleBackupDatabase} variant="outline" className="gap-2">
                <Download className="h-4 w-4" />
                Back Up Database
              </Button>
              {backupStatus && <p className="min-w-0 truncate text-sm text-[#a8a8a8]">{backupStatus}</p>}
            </div>
          </CardContent>
        </Card>

        {/* Automatic Sync */}
        <Card className="bg-[#232323] border-[#2d2d2d]">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Clock className="w-4 h-4 text-[#eba865]" />
              Automatic Sync
            </CardTitle>
            <CardDescription className="text-[#a8a8a8]">
              Automatically refreshes your local files and metadata while LoomTV is open.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <select
                value={autoSyncIntervalHours}
                onChange={(event) => void setAutoSyncIntervalHours(Number(event.target.value))}
                className="h-10 min-w-48 rounded-lg border border-[#3d3d3d] bg-[#1a1a1a] px-3 text-sm text-white outline-none focus:border-[#eba865]"
              >
                {AUTO_SYNC_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-sm text-[#a8a8a8]">
                Current interval: {AUTO_SYNC_OPTIONS.find((option) => option.value === autoSyncIntervalHours)?.label.toLowerCase() || `${autoSyncIntervalHours} hours`}
              </p>
            </div>
          </CardContent>
        </Card>
          </>
        )}

        {activeSection === 'metadata' && (
          <>
        {/* Metadata API keys */}
        <Card className="bg-[#232323] border-[#2d2d2d]">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Key className="w-4 h-4 text-[#eba865]" />
              Metadata API Keys
            </CardTitle>
            <CardDescription className="text-[#a8a8a8]">
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
	                <div key={provider.id} className="space-y-2 border-b border-[#343434] pb-5 last:border-b-0 last:pb-0">
	                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-white">{provider.label}</p>
                        {provider.badge && (
                          <span className={`text-xs px-2 py-0.5 rounded font-normal ${provider.required ? 'bg-[#eba865]/20 text-[#eba865]' : 'bg-white/10 text-[#a8a8a8]'}`}>
                            {provider.badge}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-[#a8a8a8]">{provider.description}</p>
                    </div>
	                  </div>
	                  <div className="flex items-center gap-2">
	                    <input
	                      type={isEditing || isVisible ? 'text' : 'password'}
	                      value={currentValue}
	                      onChange={(e) => setMetadataKey(provider.id, e.target.value)}
	                      placeholder={provider.placeholder}
	                      readOnly={!isEditing}
	                      className="min-w-0 flex-1 bg-[#1a1a1a] text-white border border-[#3d3d3d] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#eba865] read-only:text-[#a8a8a8]"
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
              <div className="space-y-3 border-t border-[#343434] pt-5">
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
	                        className="w-36 shrink-0 bg-[#1a1a1a] text-[#a8a8a8] border border-[#3d3d3d] rounded-lg px-3 py-2 text-sm"
	                      />
	                      <input
	                        type={isEditing || isVisible ? 'text' : 'password'}
	                        value={currentValue}
	                        onChange={(e) => setMetadataKey(providerId, e.target.value)}
	                        readOnly={!isEditing}
	                        placeholder="API key"
	                        className="min-w-0 flex-1 bg-[#1a1a1a] text-white border border-[#3d3d3d] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#eba865] read-only:text-[#a8a8a8]"
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

	            <div className="space-y-3 border-t border-[#343434] pt-5">
	              <p className="text-sm font-semibold text-white">Add New Metadata Key</p>
	              <div className="flex items-center gap-2">
	                <input
	                  type="text"
	                  value={newProviderName}
	                  onChange={(e) => setNewProviderName(e.target.value)}
	                  placeholder="Provider name, e.g. fanart"
	                  className="w-52 shrink-0 bg-[#1a1a1a] text-white border border-[#3d3d3d] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#eba865]"
	                />
	                <input
	                  type="text"
	                  value={newProviderKey}
	                  onChange={(e) => setNewProviderKey(e.target.value)}
	                  placeholder="API key"
	                  className="min-w-0 flex-1 bg-[#1a1a1a] text-white border border-[#3d3d3d] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#eba865]"
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

        {activeSection === 'about' && (
          <>
        {/* FFmpeg status */}
        <Card className="bg-[#232323] border-[#2d2d2d]">
          <CardHeader>
            <CardTitle className="text-white">FFmpeg</CardTitle>
            <CardDescription className="text-[#a8a8a8]">
              Required for playing AVI, WMV, and other non-native formats
            </CardDescription>
          </CardHeader>
          <CardContent>
            {ffmpegStatus === null ? (
              <p className="text-[#a8a8a8] text-sm">Checking…</p>
            ) : ffmpegStatus.available ? (
              <div>
                <p className="text-green-400 text-sm flex items-center gap-2">
                  <CheckCircle className="w-4 h-4" />
                  FFmpeg detected
                </p>
                {ffmpegStatus.path && (
                  <p className="text-[#555] text-xs mt-1">{ffmpegStatus.path}</p>
                )}
              </div>
            ) : (
              <div>
                <p className="text-yellow-500 text-sm mb-2">FFmpeg not found — AVI/WMV playback requires it</p>
                <code className="text-xs text-[#a8a8a8] bg-[#1a1a1a] px-3 py-1 rounded">brew install ffmpeg</code>
              </div>
            )}
          </CardContent>
        </Card>

        {/* About */}
        <Card className="bg-[#232323] border-[#2d2d2d]">
          <CardHeader>
            <CardTitle className="text-white">About</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-[#a8a8a8] text-sm">
              LoomTV v1.0.0 — Local media server powered by Electron + ffmpeg
            </p>
            <div className="mt-3 space-y-1 text-xs text-[#555]">
              <p>Metadata sources: TMDB · TVmaze · Jikan (MyAnimeList) · OMDb</p>
              <p>TV shows &amp; anime episode titles: TVmaze (free, no key)</p>
              <p>Anime posters &amp; ratings: Jikan/MAL (free, no key)</p>
            </div>
          </CardContent>
        </Card>
          </>
        )}

            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
