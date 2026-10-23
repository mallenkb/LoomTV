import type { AppLoaderStyle } from '@/lib/theme';
import type { UpdateState } from '@/lib/desktopApi';
export {
  DEFAULT_SIDEBAR_NAV_ORDER,
  SIDEBAR_NAV_LABELS,
  normalizeSidebarNavOrder,
  type SidebarNavItemId,
  type SidebarOrderItem,
} from '@/lib/sidebarNavOrder';

export type SettingsSection = 'profiles' | 'library' | 'playback' | 'plugins' | 'live-tv' | 'network' | 'metadata' | 'theme' | 'about';
export const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'library', label: 'Library' },
  { id: 'network', label: 'Network' },
  { id: 'playback', label: 'Playback' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'live-tv', label: 'Live TV' },
  { id: 'metadata', label: 'Metadata' },
  { id: 'theme', label: 'Theme' },
  { id: 'about', label: 'About' },
];

export const SETTINGS_SECTION_STORAGE_KEY = 'loomtv:settings-active-section';

export const LOADER_OPTIONS: { id: AppLoaderStyle; label: string; description: string }[] = [
  { id: 'play-mark', label: 'Play Mark', description: 'The clean white play icon from the Loom logo.' },
  { id: 'logo-mark', label: 'Logo Only', description: 'Compact logo-only loader for tighter surfaces.' },
  { id: 'horizontal-logo', label: 'Horizontal Logo', description: 'Full Loom wordmark animation for branded screens.' },
];

export const APP_LICENSE = {
  name: 'Loom',
  license: 'MIT',
  copyright: 'Copyright © 2026 LoomTV',
};

export const THIRD_PARTY_DEPENDENCIES = [
  { name: 'Stremio official add-on registry', owner: 'SmartCode OOD / Stremio', license: 'MIT', url: 'https://github.com/Stremio/stremio-official-addons/blob/master/LICENSE.md' },
  { name: 'DiceBear Glyphs', owner: 'Matt Houser / DiceBear', license: 'CC BY 4.0', url: 'https://www.dicebear.com/styles/glyphs/' },
  { name: 'Electron', owner: 'Electron Community', license: 'MIT', url: 'https://www.electronjs.org/' },
  { name: 'YouTube embedded player', owner: 'Google LLC / YouTube', license: 'YouTube Terms of Service', url: 'https://www.youtube.com/t/terms' },
  { name: 'Electron Forge', owner: 'Electron Forge contributors', license: 'MIT', url: 'https://www.electronforge.io/' },
  { name: 'Electron Updater', owner: 'electron-builder contributors', license: 'MIT', url: 'https://github.com/electron-userland/electron-builder' },
  { name: 'React', owner: 'Meta Platforms, Inc. and affiliates', license: 'MIT', url: 'https://react.dev/' },
  { name: 'React DOM', owner: 'Meta Platforms, Inc. and affiliates', license: 'MIT', url: 'https://react.dev/' },
  { name: 'TanStack Query, Router and Virtual', owner: 'TanStack contributors', license: 'MIT', url: 'https://tanstack.com/' },
  { name: 'WebTorrent', owner: 'Feross Aboukhadijeh / WebTorrent, LLC', license: 'MIT', url: 'https://github.com/webtorrent/webtorrent' },
  { name: 'Sharp', owner: 'Lovell Fuller and contributors', license: 'Apache-2.0', url: 'https://sharp.pixelplumbing.com/' },
  { name: 'Vite', owner: 'Evan You and Vite contributors', license: 'MIT', url: 'https://vite.dev/' },
  { name: 'TypeScript', owner: 'Microsoft Corporation', license: 'Apache-2.0', url: 'https://www.typescriptlang.org/' },
  { name: 'Tailwind CSS', owner: 'Tailwind Labs', license: 'MIT', url: 'https://tailwindcss.com/' },
  { name: 'PostCSS', owner: 'Andrey Sitnik and PostCSS contributors', license: 'MIT', url: 'https://postcss.org/' },
  { name: 'better-sqlite3', owner: 'Joshua Wise and contributors', license: 'MIT', url: 'https://github.com/WiseLibs/better-sqlite3' },
  { name: 'bonjour-service', owner: 'bonjour-service contributors', license: 'MIT', url: 'https://github.com/onlxltd/bonjour-service' },
  { name: 'LibVLC / VLC media engine', owner: 'VideoLAN', license: 'LGPL-2.1+ core*', url: 'https://www.videolan.org/legal.html' },
  { name: 'libmpv media library', owner: 'mpv contributors', license: 'GPL-2.0-or-later*', url: 'https://github.com/mpv-player/mpv' },
  { name: 'FFmpeg / FFprobe', owner: 'FFmpeg contributors and build providers', license: 'GPL-3.0-or-later*', url: 'https://ffmpeg.org/legal.html' },
  { name: 'fpcalc / Chromaprint', owner: 'AcoustID / Chromaprint contributors', license: 'MIT + upstream notices*', url: 'https://github.com/acoustid/chromaprint' },
  { name: 'Koffi', owner: 'Koromix', license: 'MIT', url: 'https://github.com/Koromix/koffi' },
  { name: 'clsx', owner: 'Luke Edwards', license: 'MIT', url: 'https://github.com/lukeed/clsx' },
  { name: 'electron-squirrel-startup', owner: 'MongoDB, Inc. and contributors', license: 'Apache-2.0', url: 'https://github.com/mongodb-js/electron-squirrel-startup' },
  { name: 'hls.js', owner: 'video-dev contributors', license: 'Apache-2.0', url: 'https://github.com/video-dev/hls.js' },
  { name: 'Lucide React / Feather-derived icons', owner: 'Lucide contributors / Cole Bemis', license: 'ISC / MIT', url: 'https://lucide.dev/license' },
  { name: 'Motion', owner: 'Motion Division', license: 'MIT', url: 'https://motion.dev/' },
  { name: 'Phosphor Icons React', owner: 'Phosphor Icons contributors', license: 'MIT', url: 'https://phosphoricons.com/' },
  { name: 'tailwind-merge', owner: 'Dany Castillo', license: 'MIT', url: 'https://github.com/dcastil/tailwind-merge' },
  { name: 'Zod', owner: 'Colin McDonnell and contributors', license: 'MIT', url: 'https://github.com/colinhacks/zod' },
  { name: 'DefinitelyTyped type packages', owner: 'DefinitelyTyped contributors', license: 'MIT', url: 'https://github.com/DefinitelyTyped/DefinitelyTyped' },
  { name: 'shadcn/ui-style components', owner: 'shadcn and contributors', license: 'MIT', url: 'https://ui.shadcn.com/' },
];

export const METADATA_ATTRIBUTIONS = [
  { name: 'TMDB', details: 'Movie and TV posters, backdrops, cast data, ratings, and metadata.', url: 'https://www.themoviedb.org/' },
  { name: 'TheTVDB', details: 'TV series, season, episode, and artwork metadata.', url: 'https://thetvdb.com/' },
  { name: 'TVmaze', details: 'Keyless TV discovery, ratings, and show and episode metadata. TVmaze data is provided under CC BY-SA.', url: 'https://www.tvmaze.com/api' },
  { name: 'Jikan / MyAnimeList', details: 'Anime posters, ratings, and anime metadata.', url: 'https://jikan.moe/' },
  { name: 'AniList', details: 'Anime discovery, descriptions, artwork, and ratings.', url: 'https://anilist.co/' },
  { name: 'OMDb API', details: 'Ratings for movies and completed series, plus fallback title metadata.', url: 'https://www.omdbapi.com/' },
  { name: 'MDBList', details: 'Fills missing add-on ratings when OMDb has no score or is unavailable, including quota limits.', url: 'https://mdblist.com/' },
  { name: 'IMDb', details: 'Original source of IMDb ratings, supplied through metadata providers. IMDb names and logos belong to their respective owners.', url: 'https://www.imdb.com/' },
  { name: 'Rotten Tomatoes', details: 'Original source of Tomatometer and Popcornmeter scores, supplied through OMDb or MDBList where available. Rotten Tomatoes brands belong to their respective owners.', url: 'https://www.rottentomatoes.com/help_desk/licensing' },
  { name: 'Metacritic', details: 'Original source of Metascores, supplied through OMDb or MDBList where available. Metacritic names and logos belong to their respective owners.', url: 'https://www.metacritic.com/' },
  { name: 'Fanart.tv', details: 'Clearlogos and media-center artwork.', url: 'https://fanart.tv/' },
  { name: 'Cinemeta / Stremio', details: 'Library metadata and artwork without an API key, plus movie and TV discovery when no TMDB key is configured.', url: 'https://v3-cinemeta.strem.io/' },
  { name: 'WatchHub / Stremio', details: 'External streaming-provider links for Where to watch. Availability and access are controlled by each provider.', url: 'https://github.com/Stremio/stremio-official-addons' },
  { name: 'OpenSubtitles v3 / Stremio', details: 'Online subtitle search and downloads through Stremio’s OpenSubtitles v3 service when you use online subtitles.', url: 'https://github.com/Stremio/stremio-official-addons' },
  { name: 'TheIntroDB', details: 'Intro, recap, and credits timestamps for the skip buttons on movies and TV.', url: 'https://theintrodb.org/' },
  { name: 'AniSkip', details: 'Opening and ending timestamps for the skip buttons on anime.', url: 'https://aniskip.com/' },
  { name: 'SkipDB', details: 'Community intro and credits timestamps used as another source for the skip buttons.', url: 'https://skipdb.tv/' },
];

export function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function isSettingsSection(value: string | null): value is SettingsSection {
  return value === 'profiles'
    || value === 'library'
    || value === 'playback'
    || value === 'plugins'
    || value === 'live-tv'
    || value === 'network'
    || value === 'metadata'
    || value === 'theme'
    || value === 'about';
}

export function getUpdateButtonLabel(updateState: UpdateState | null): string {
  if (!updateState) return 'Check for updates';
  if (updateState.status === 'checking') return 'Checking...';
  if (updateState.manualDownload) return 'Download from GitHub';
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
