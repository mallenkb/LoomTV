import React, { useEffect, useState } from 'react';
import { FolderPlus, RefreshCw, X, Key, CheckCircle, ExternalLink, Pencil, Plus, Save } from 'lucide-react';
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
        <span className="text-[#eba865]">omdbapi.com</span>.
      </>
    ),
  },
];

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export default function Settings() {
  const { state, addLibraryFolder, scanLibrary, refreshLibrary, removeLibraryFolder } = useLibrary();
  const { libraryFolders, isScanning, movies, tvShows, animeShows } = state;

  const [metadataKeys, setMetadataKeys] = useState<Record<string, string>>({});
  const [editingKeys, setEditingKeys] = useState<Record<string, boolean>>({});
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderKey, setNewProviderKey] = useState('');
  const [savedKey, setSavedKey] = useState(false);
  const [ffmpegStatus, setFfmpegStatus] = useState<{ available: boolean; path: string | null } | null>(null);

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
    });
    desktopApi.checkFFmpeg().then(setFfmpegStatus);
  }, []);

  const setMetadataKey = (providerId: string, value: string) => {
    setMetadataKeys((current) => ({ ...current, [providerId]: value }));
  };

  const setProviderEditing = (providerId: string, isEditing: boolean) => {
    setEditingKeys((current) => ({ ...current, [providerId]: isEditing }));
  };

  const handleAddMetadataKey = () => {
    const providerId = normalizeProviderId(newProviderName);
    if (!providerId || !newProviderKey.trim()) return;

    setMetadataKey(providerId, newProviderKey);
    setProviderEditing(providerId, false);
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

  const customProviders = Object.keys(metadataKeys)
    .filter((providerId) => !METADATA_PROVIDERS.some((provider) => provider.id === providerId))
    .sort();

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a] p-6">
      <h2 className="text-2xl font-bold text-white mb-6">Settings</h2>

      <div className="space-y-6 max-w-2xl">

        {/* Library Folders */}
        <Card className="bg-[#232323] border-[#2d2d2d]">
          <CardHeader>
            <CardTitle className="text-white">Library Folders</CardTitle>
            <CardDescription className="text-[#a8a8a8]">
              Add folders containing your movies, TV shows, and anime
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex flex-col gap-2">
                {libraryFolders.length === 0 ? (
                  <p className="text-[#a8a8a8] text-sm py-2">No library folders added</p>
                ) : (
                  libraryFolders.map((folder) => (
                    <div key={folder} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#1a1a1a] text-white text-sm">
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
              <Button onClick={addLibraryFolder} className="gap-2">
                <FolderPlus className="w-4 h-4" />
                Add Folder
              </Button>
            </div>
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
                    {currentValue && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setProviderEditing(provider.id, !isEditing)}
                        className="gap-2"
                      >
                        {isEditing ? <Save className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                        {isEditing ? 'Done' : 'Edit'}
                      </Button>
                    )}
                  </div>
                  <input
                    type={isEditing ? 'text' : 'password'}
                    value={currentValue}
                    onChange={(e) => setMetadataKey(provider.id, e.target.value)}
                    placeholder={provider.placeholder}
                    readOnly={!isEditing}
                    className="w-full bg-[#1a1a1a] text-white border border-[#3d3d3d] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#eba865] read-only:text-[#a8a8a8]"
                  />
                </div>
              );
            })}

            {customProviders.length > 0 && (
              <div className="space-y-3 border-t border-[#343434] pt-5">
                <p className="text-sm font-semibold text-white">Additional Metadata Keys</p>
                {customProviders.map((providerId) => {
                  const currentValue = metadataKeys[providerId] || '';
                  const isEditing = editingKeys[providerId] ?? !currentValue;
                  return (
                    <div key={providerId} className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        value={providerId}
                        readOnly
                        className="sm:w-44 bg-[#1a1a1a] text-[#a8a8a8] border border-[#3d3d3d] rounded-lg px-3 py-2 text-sm"
                      />
                      <input
                        type={isEditing ? 'text' : 'password'}
                        value={currentValue}
                        onChange={(e) => setMetadataKey(providerId, e.target.value)}
                        readOnly={!isEditing}
                        placeholder="API key"
                        className="flex-1 bg-[#1a1a1a] text-white border border-[#3d3d3d] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#eba865] read-only:text-[#a8a8a8]"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setProviderEditing(providerId, !isEditing)}
                        className="gap-2"
                      >
                        {isEditing ? <Save className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                        {isEditing ? 'Done' : 'Edit'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="space-y-3 border-t border-[#343434] pt-5">
              <p className="text-sm font-semibold text-white">Add New Metadata Key</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={newProviderName}
                  onChange={(e) => setNewProviderName(e.target.value)}
                  placeholder="Provider name, e.g. fanart"
                  className="sm:w-52 bg-[#1a1a1a] text-white border border-[#3d3d3d] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#eba865]"
                />
                <input
                  type="text"
                  value={newProviderKey}
                  onChange={(e) => setNewProviderKey(e.target.value)}
                  placeholder="API key"
                  className="flex-1 bg-[#1a1a1a] text-white border border-[#3d3d3d] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#eba865]"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddMetadataKey}
                  disabled={!normalizeProviderId(newProviderName) || !newProviderKey.trim()}
                  className="gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Add
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

      </div>
    </div>
  );
}
