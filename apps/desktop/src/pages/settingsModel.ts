import type { SettingsSection } from './Settings.helpers';

export type SettingsPageId = 'overview' | SettingsSection;

export const SETTINGS_PAGES: Record<SettingsSection, { label: string; description: string }> = {
  library: { label: 'Library', description: 'Folders Loom watches, how it syncs them, and how files are named.' },
  playback: { label: 'Playback', description: 'Seek buttons, intro skipping, players, and what happens when you resume.' },
  metadata: { label: 'Metadata keys', description: 'API keys that fetch posters, cast, episode data, ratings, and logos.' },
  plugins: { label: 'Add-ons', description: 'Stremio add-ons that add catalogs and sources.' },
  'live-tv': { label: 'Live TV', description: 'IPTV playlists and their program guides.' },
  profiles: { label: 'Profiles', description: 'Who uses Loom and their sign-in settings.' },
  network: { label: 'Devices and network', description: 'Share your library with phones and other computers on this network.' },
  theme: { label: 'Appearance', description: 'Theme, Home layout, ratings, and loading animation.' },
  about: { label: 'About', description: 'Version, updates, bundled tools, and licenses.' },
};

export const SETTINGS_GROUPS: { label: string; pages: SettingsSection[] }[] = [
  { label: 'Library', pages: ['library', 'playback', 'metadata'] },
  { label: 'Sources', pages: ['plugins', 'live-tv'] },
  { label: 'People and devices', pages: ['profiles', 'network'] },
  { label: 'App', pages: ['theme', 'about'] },
];

export type SettingsSearchEntry = {
  section: SettingsSection;
  label: string;
  description: string;
  keywords?: string;
  /** Text to find on the page when it differs from the label. */
  anchor?: string;
  /** The row only shows with the page's advanced sections open. */
  advanced?: boolean;
};

// Labels match a row or heading on the page, so a result can be found and
// highlighted after Settings v2 opens it. `advanced` opens the page's advanced
// sections first.
export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  { section: 'library', label: 'Libraries', description: 'Movies, TV Shows, Anime and Other folders', keywords: 'folders add remove edit nas share reorder sidebar' },
  { section: 'library', label: 'Library health', description: 'Unmatched titles, missing episodes and duplicates', keywords: 'check problems unmatched missing subtitles' },
  { section: 'library', label: 'Library sync', description: 'Scan progress, refresh metadata and full rescan', keywords: 'scan rescan refresh metadata' },
  { section: 'library', label: 'Automatic quick sync', description: 'How often Loom looks for new or changed files', keywords: 'interval background hours' },
  { section: 'library', label: 'Organize files after sync', description: 'Rename and move matched files to the Loom naming rules', keywords: 'rename move naming review renames history' },
  { section: 'library', label: 'Clean up library folders', description: 'Remove leftover files and put them back', keywords: 'cleanup samples junk', advanced: true },
  { section: 'library', label: 'Original imports', description: 'Restore the first recorded names and locations', keywords: 'restore undo original names', advanced: true },
  { section: 'library', label: 'Database backup', description: 'Back up the database', keywords: 'backup database export', advanced: true },
  { section: 'library', label: 'Clear local app data', description: 'Remove saved folders, metadata, progress and settings', keywords: 'reset delete clear', advanced: true },
  { section: 'playback', label: 'Skip back', description: 'Left arrow and the back button', keywords: 'seek seconds rewind' },
  { section: 'playback', label: 'Skip forward', description: 'Right arrow and the forward button', keywords: 'seek seconds' },
  { section: 'playback', label: 'Rewind on resume', description: 'Steps back a little when you continue watching', keywords: 'resume continue' },
  { section: 'playback', label: 'Show skip button', description: 'Skip Intro and Skip Credits during playback', keywords: 'intro outro credits recap skip prompt' },
  { section: 'playback', label: 'Detect', description: 'Which parts of an episode intro analysis looks for', keywords: 'intro recap credits detection analysis' },
  { section: 'playback', label: 'Display sleep timer', description: 'Screen turns off after the player is paused', keywords: 'sleep screen display timeout' },
  { section: 'playback', label: 'Skip analysis', description: 'Progress, queue and exclusions', keywords: 'analysis queue exclusions specials skipdb scan', advanced: true },
  { section: 'playback', label: 'Rebuild automatic markers', description: 'Discard detected intros and scan again', keywords: 'markers rebuild cache maintenance', advanced: true },
  { section: 'playback', label: 'Players', description: 'LibVLC and libmpv', keywords: 'vlc mpv engine player', advanced: true },
  { section: 'metadata', label: 'TMDB', description: 'Posters, backdrops, cast and ratings', keywords: 'themoviedb key api' },
  { section: 'metadata', label: 'TheTVDB', description: 'TV series, seasons and episodes', keywords: 'tvdb key api episodes' },
  { section: 'metadata', label: 'MDBList', description: 'Fallback critic and audience ratings', keywords: 'mdblist rotten tomatoes metacritic popcorn ratings api key' },
  { section: 'metadata', label: 'Fanart.tv', description: 'Clearlogos during playback', keywords: 'fanart logo clearlogo key' },
  { section: 'metadata', label: 'Refresh all metadata', description: 'Download details again with your keys', keywords: 'refresh metadata', advanced: true },
  { section: 'plugins', label: 'Installed add-ons', description: 'Configure, update or remove add-ons', keywords: 'stremio addon plugin catalog install manifest' },
  { section: 'live-tv', label: 'Your live TV sources', description: 'IPTV playlists in the sidebar', keywords: 'iptv m3u playlist channels xmltv guide' },
  { section: 'profiles', label: 'Profiles', description: 'Add, edit and switch profiles', keywords: 'users people owner pin' },
  { section: 'network', label: 'Share library on this network', description: 'Let phones and computers on this network play your library', keywords: 'lan share network sharing' },
  { section: 'network', label: 'Ask before new devices connect', description: 'Approve devices before they connect', keywords: 'approve approval security' },
  { section: 'network', label: 'Pairing PIN', description: 'One-time PIN for a phone or another computer', keywords: 'pair pin phone mobile code' },
  { section: 'network', label: 'Paired devices', description: 'Remove devices that should lose access', keywords: 'devices remove revoke' },
  { section: 'network', label: 'Desktop address', description: 'Address for manual setup', keywords: 'ip address url port manual' },
  { section: 'theme', label: 'Appearance', description: 'Dark or light', keywords: 'theme dark light mode' },
  { section: 'theme', label: 'Accent color', description: 'Choose from the color palette', keywords: 'theme palette sunbeam ember cobalt tide aurora' },
  { section: 'theme', label: 'Loading animation', description: 'Shown while pages load', keywords: 'loader loading spinner' },
  { section: 'theme', label: 'Player control style', description: 'Default or pill controls', keywords: 'player controls pill youtube rounded volume timeline appearance' },
  { section: 'theme', label: 'Home layout', description: 'Modern or classic Home', keywords: 'home modern classic layout hero style' },
  { section: 'theme', label: 'Show ratings', description: 'Rating logos on posters and detail pages', keywords: 'ratings badges imdb' },
  { section: 'theme', label: 'Anime cast cards', description: 'Preview standard or compact character and voice actor cards', keywords: 'cast card style character actor preview' },
  { section: 'library', label: 'Sidebar', description: 'Reorder sidebar pages or hide them without changing your libraries', keywords: 'sidebar order reorder navigation hide show visibility', advanced: false },
  { section: 'about', label: 'Loom', description: 'Version and updates', keywords: 'update upgrade version release' },
  { section: 'about', label: 'Bundled media tools', description: 'FFmpeg, LibVLC and libmpv', keywords: 'ffmpeg vlc mpv tools' },
  { section: 'about', label: 'Third-party libraries', description: 'Libraries Loom is built with', keywords: 'license legal open source credits', advanced: true },
  { section: 'about', label: 'Metadata and artwork sources', description: 'Credits for content data and images', keywords: 'attribution credit poster artwork source', advanced: true },
];

const wordsOf = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Every query word must start a word in the entry, so "pin" finds PIN but not "skipping". Label matches rank first. */
export function searchSettings(query: string, visible: readonly SettingsSection[]): SettingsSearchEntry[] {
  const words = wordsOf(query);
  if (!words.length) return [];
  const allowed = new Set(visible);
  return SETTINGS_SEARCH_INDEX
    .filter((entry) => allowed.has(entry.section))
    .map((entry) => {
      const labelWords = wordsOf(entry.label);
      const allWords = wordsOf(`${entry.label} ${entry.description} ${entry.keywords || ''} ${SETTINGS_PAGES[entry.section].label}`);
      if (!words.every((word) => allWords.some((candidate) => candidate.startsWith(word)))) return null;
      const score = words.reduce((total, word) => total + (labelWords.some((candidate) => candidate.startsWith(word)) ? 3 : 0), 0);
      return { entry, score };
    })
    .filter((result): result is { entry: SettingsSearchEntry; score: number } => result !== null)
    .sort((a, b) => b.score - a.score)
    .map((result) => result.entry);
}

export type SettingsAttentionItem = {
  id: string;
  page: SettingsSection;
  title: string;
  description: string;
  actionLabel: string;
  action: 'open-page' | 'update';
};

export type SettingsAttentionInput = {
  canManageLibrary: boolean;
  tmdbKey: string;
  folderStatuses: readonly { path: string; state: 'available' | 'degraded' | 'unavailable'; isNetworkLike: boolean; message: string }[];
  updateStatus: string | null;
  latestVersion?: string;
  updateActionLabel: string;
  analysisState: string | null;
  analysisError?: string;
};

export function folderDisplayName(folderPath: string): string {
  return folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || folderPath;
}

export function buildAttentionItems(input: SettingsAttentionInput): SettingsAttentionItem[] {
  const items: SettingsAttentionItem[] = [];
  if (input.updateStatus === 'available' || input.updateStatus === 'downloaded') {
    const version = input.latestVersion ? `Loom ${input.latestVersion}` : 'A new version of Loom';
    items.push({
      id: 'update',
      page: 'about',
      title: input.updateStatus === 'downloaded' ? 'Update ready to install' : 'Update available',
      description: input.updateStatus === 'downloaded' ? `${version} is downloaded. Loom restarts to finish.` : `${version} is ready to download.`,
      actionLabel: input.updateActionLabel,
      action: 'update',
    });
  }
  if (!input.canManageLibrary) return items;
  if (!input.tmdbKey.trim()) {
    items.push({
      id: 'tmdb',
      page: 'metadata',
      title: 'Add a TMDB key',
      description: 'Posters, cast and ratings come from TMDB. Without a key, new titles show up bare.',
      actionLabel: 'Add key',
      action: 'open-page',
    });
  }
  for (const folder of input.folderStatuses) {
    if (folder.state === 'available') continue;
    const name = folderDisplayName(folder.path);
    const unavailable = folder.state === 'unavailable';
    items.push({
      id: `folder:${folder.path}`,
      page: 'library',
      title: unavailable ? `${name} is unavailable` : `${name} was not fully scanned`,
      description: folder.message || (unavailable
        ? (folder.isNetworkLike ? `Reconnect the network share at ${folder.path}.` : `Loom cannot reach ${folder.path}.`)
        : 'Some files could not be read during the last scan.'),
      actionLabel: 'Open Library',
      action: 'open-page',
    });
  }
  if (input.analysisState === 'error') {
    items.push({
      id: 'analysis',
      page: 'playback',
      title: 'Intro detection stopped',
      description: input.analysisError || 'Skip analysis hit an error. Skip Intro may be missing on new episodes.',
      actionLabel: 'Open Playback',
      action: 'open-page',
    });
  }
  return items;
}

/** The preset choices plus the saved value when it is not one of them. */
export function choicesWith(presets: readonly number[], current: number): number[] {
  return presets.includes(current) ? [...presets] : [...presets, current].sort((a, b) => a - b);
}
