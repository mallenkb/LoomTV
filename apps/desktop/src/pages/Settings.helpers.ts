import type { AppLoaderStyle } from '@/lib/theme';
import type { UpdateState } from '@/lib/desktopApi';

export type SettingsSection = 'library' | 'playback' | 'network' | 'metadata' | 'theme' | 'about';
export type SidebarNavItemId = 'anime' | 'tv' | 'movies' | 'others';
export type SettingsGroup = 'media' | 'connections' | 'personalize' | 'system';

export const SETTINGS_GROUP_LABELS: Record<SettingsGroup, string> = {
  media: 'Media',
  connections: 'Connections',
  personalize: 'Personalize',
  system: 'System',
};

export const SETTINGS_SECTIONS: {
  id: SettingsSection;
  label: string;
  description: string;
  group: SettingsGroup;
}[] = [
  { id: 'library', label: 'Library', description: 'Folders, scans, and sync', group: 'media' },
  { id: 'playback', label: 'Player', description: 'Playback and seek defaults', group: 'media' },
  { id: 'metadata', label: 'Metadata & Subtitles', description: 'Artwork, provider access, and downloads', group: 'media' },
  { id: 'network', label: 'Sharing & Devices', description: 'Host or join a library', group: 'connections' },
  { id: 'theme', label: 'Appearance', description: 'Theme, accent, loader, and navigation', group: 'personalize' },
  { id: 'about', label: 'App & Data', description: 'Updates, backup, reset, and legal', group: 'system' },
];

export const SETTINGS_SECTION_STORAGE_KEY = 'loomtv:settings-active-section';

export const DEFAULT_SIDEBAR_NAV_ORDER: SidebarNavItemId[] = ['anime', 'tv', 'movies', 'others'];

export const LOADER_OPTIONS: { id: AppLoaderStyle; label: string; description: string }[] = [
  { id: 'play-mark', label: 'Play Mark', description: 'The clean white play icon from the Loom Media Server logo.' },
  { id: 'logo-mark', label: 'Logo Only', description: 'Compact logo-only loader for tighter surfaces.' },
  { id: 'horizontal-logo', label: 'Horizontal Logo', description: 'Full Loom Media Server wordmark animation for branded screens.' },
];

export const SIDEBAR_NAV_LABELS: Record<SidebarNavItemId, string> = {
  anime: 'Anime',
  tv: 'TV Shows',
  movies: 'Movies',
  others: 'Others',
};

export const APP_LICENSE = {
  name: 'Loom Media Server',
  license: 'MIT',
  copyright: 'Copyright (c) 2026 malllenkb',
};

export const THIRD_PARTY_DEPENDENCIES = [
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

export const METADATA_ATTRIBUTIONS = [
  { name: 'TMDB', details: 'Movie and TV posters, backdrops, cast data, ratings, and metadata.', url: 'https://www.themoviedb.org/' },
  { name: 'TVmaze', details: 'TV show and episode metadata.', url: 'https://www.tvmaze.com/' },
  { name: 'Jikan / MyAnimeList', details: 'Anime posters, ratings, and anime metadata.', url: 'https://jikan.moe/' },
  { name: 'OMDb API', details: 'Fallback movie and TV metadata.', url: 'https://www.omdbapi.com/' },
  { name: 'Fanart.tv', details: 'Clearlogos and media-center artwork.', url: 'https://fanart.tv/' },
];

export function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function isSettingsSection(value: string | null): value is SettingsSection {
  return value === 'library'
    || value === 'playback'
    || value === 'network'
    || value === 'metadata'
    || value === 'theme'
    || value === 'about';
}

export function getUpdateButtonLabel(updateState: UpdateState | null): string {
  if (!updateState) return 'Check for updates';
  if (updateState.status === 'checking') return 'Checking...';
  if (updateState.status === 'downloading') return updateState.downloadPercent ? `Downloading ${updateState.downloadPercent}%` : 'Downloading...';
  if (updateState.status === 'downloaded') return 'Update now';
  if (updateState.status === 'installing') return 'Restarting...';
  if (updateState.status === 'available') return updateState.latestVersion ? `Update ${updateState.latestVersion}` : 'Update available';
  return 'Check for updates';
}

export function getCompactUpdateStatus(updateState: UpdateState | null): string {
  if (!updateState) return 'Update status is loading.';
  if (updateState.message) return updateState.message;
  if (updateState.status === 'checking') return 'Checking for updates...';
  if (updateState.status === 'idle') return 'Ready to check for updates.';
  return 'Use the button to check for the latest release.';
}

export function isBundledFFmpegPath(pathValue?: string | null): boolean {
  if (!pathValue) return false;
  return /[\\/]ffmpeg[\\/](mac|win|linux)[\\/]/i.test(pathValue);
}

export function normalizeSidebarNavOrder(order?: string[]): SidebarNavItemId[] {
  const savedOrder = Array.isArray(order) ? order : [];
  const uniqueSavedOrder = Array.from(new Set(savedOrder));
  return [
    ...uniqueSavedOrder.filter((item): item is SidebarNavItemId => DEFAULT_SIDEBAR_NAV_ORDER.includes(item as SidebarNavItemId)),
    ...DEFAULT_SIDEBAR_NAV_ORDER.filter((item) => !uniqueSavedOrder.includes(item)),
  ];
}
