import type { SettingsSection } from './Settings.helpers';

export type SettingsSearchEntry = {
  section: SettingsSection;
  /** Matches the title of a group or row on the page, so a result can be scrolled to. */
  title: string;
  description: string;
  keywords?: string;
  /** Storage key of the collapsible group the row lives in. Search opens it first. */
  group?: string;
};

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  library: 'Library',
  playback: 'Playback',
  metadata: 'Metadata keys',
  plugins: 'Add-ons',
  'live-tv': 'Live TV',
  profiles: 'Profiles',
  network: 'Devices and network',
  theme: 'Appearance',
  about: 'About',
};

/** Names of the collapsible groups, shown in a result's breadcrumb. */
export const SETTINGS_GROUP_LABELS: Record<string, string> = {
  'library-advanced': 'Advanced',
  'playback-advanced': 'Advanced skipping',
  'theme-sidebar-order': 'Sidebar order',
};

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  { section: 'library', title: 'Libraries', description: 'Movies, TV Shows, Anime and other folders', keywords: 'folders add remove edit nas share reorder sidebar new library' },
  { section: 'library', title: 'Library health', description: 'Unmatched titles, missing episodes, and files without subtitles', keywords: 'check problems unmatched missing subtitles split' },
  { section: 'library', title: 'Automatic sync', description: 'How often Loom looks for new or changed files', keywords: 'scan interval schedule quick sync background hours' },
  { section: 'library', title: 'Refresh metadata', description: 'Download titles, artwork, and ratings again', keywords: 'posters artwork refresh' },
  { section: 'library', title: 'Full rescan', description: 'Read every file again from scratch', keywords: 'rescan scan reset' },
  { section: 'library', title: 'Rename files after sync', description: 'Rename and move matched files to the Loom naming rules', keywords: 'organize rename move naming review' },
  { section: 'library', title: 'Rename history', description: 'Past renames and their records', keywords: 'undo history renames' },
  { section: 'library', title: 'Clean up download clutter', description: 'Move leftover junk files and duplicate subtitles aside', keywords: 'cleanup samples junk nfo txt', group: 'library-advanced' },
  { section: 'library', title: 'Cleanup history', description: 'Put cleaned-up files back', keywords: 'restore put back cleanup', group: 'library-advanced' },
  { section: 'library', title: 'Original file names', description: 'Restore the first recorded names and locations', keywords: 'restore undo original imports', group: 'library-advanced' },
  { section: 'library', title: 'Back up database', description: 'Save a copy of library data and settings', keywords: 'backup export database', group: 'library-advanced' },
  { section: 'library', title: 'Clear local app data', description: 'Remove saved folders, metadata, progress, and settings', keywords: 'reset delete wipe clear', group: 'library-advanced' },
  { section: 'playback', title: 'Skip back', description: 'How far the back button and left arrow jump', keywords: 'seek seconds rewind arrow' },
  { section: 'playback', title: 'Skip forward', description: 'How far the forward button and right arrow jump', keywords: 'seek seconds arrow' },
  { section: 'playback', title: 'Rewind on resume', description: 'Replay a few seconds when you continue watching', keywords: 'resume continue' },
  { section: 'playback', title: 'Keep display awake', description: 'Screen sleep while a video plays', keywords: 'sleep screen display timeout' },
  { section: 'playback', title: 'Detect intros and outros', description: 'Find them automatically and show a skip button', keywords: 'intro outro credits recap skip analysis' },
  { section: 'playback', title: 'Scan new media automatically', description: 'Analyze new episodes after each sync', keywords: 'analysis queue new episodes' },
  { section: 'playback', title: 'Analyze Season 0 specials', description: 'Include specials in intro detection', keywords: 'specials season 0', group: 'playback-advanced' },
  { section: 'playback', title: 'Use SkipDB', description: 'Community intro markers', keywords: 'skipdb experimental provider', group: 'playback-advanced' },
  { section: 'playback', title: 'Section types', description: 'Which sections to detect and their length limits', keywords: 'intro recap outro credits preview min max seconds prompt', group: 'playback-advanced' },
  { section: 'playback', title: 'Exclusions', description: 'Series, movies, seasons, and folders never analyzed', keywords: 'exclude ignore skip', group: 'playback-advanced' },
  { section: 'playback', title: 'Maintenance', description: 'Rescan, pause, clear cache, rebuild markers', keywords: 'rebuild markers cache fingerprints pause cancel season scan', group: 'playback-advanced' },
  { section: 'playback', title: 'Manual markers', description: 'Set intro and outro times yourself', keywords: 'timestamps manual markers', group: 'playback-advanced' },
  { section: 'metadata', title: 'Metadata services', description: 'TMDB, TheTVDB, Fanart.tv, and other keys', keywords: 'tmdb tvdb fanart omdb api key test' },
  { section: 'metadata', title: 'Add another service key', description: 'Keys for add-ons or providers that need one', keywords: 'custom provider api key' },
  { section: 'plugins', title: 'Installed add-ons', description: 'Install, configure, or remove Stremio add-ons', keywords: 'stremio addon plugin catalog install manifest' },
  { section: 'plugins', title: 'Profile access', description: 'Which standard profiles can use each add-on', keywords: 'access permission profiles' },
  { section: 'plugins', title: 'Warnings and host history', description: 'Approvals, configuration, and host requests', keywords: 'warnings audit history' },
  { section: 'live-tv', title: 'Sources', description: 'IPTV playlists and program guides', keywords: 'iptv m3u playlist channels xmltv epg guide' },
  { section: 'profiles', title: 'This profile', description: 'Lock, PIN, and sign-in for the current profile', keywords: 'lock current' },
  { section: 'profiles', title: 'Profile PIN', description: 'Protect this profile with four digits', keywords: 'pin password lock code' },
  { section: 'profiles', title: 'Sign in automatically', description: 'Open Loom without choosing a profile', keywords: 'auto login sign in' },
  { section: 'profiles', title: 'Everyone', description: 'Add, edit, and switch profiles', keywords: 'users people owner kids switch add' },
  { section: 'profiles', title: 'My List', description: 'Saved titles for this profile', keywords: 'watchlist saved bookmark' },
  { section: 'profiles', title: 'Favorites', description: 'Favorite titles for this profile', keywords: 'heart favorite' },
  { section: 'network', title: 'Local network sharing', description: 'Let phones and computers on this network play your library', keywords: 'lan share network sharing server' },
  { section: 'network', title: 'Require approval for new devices', description: 'Approve devices before they connect', keywords: 'approve approval security' },
  { section: 'network', title: 'Connect a device', description: 'Pair a phone or another computer', keywords: 'pair pin phone mobile qr code' },
  { section: 'network', title: 'Connected devices', description: 'Remove devices that should lose access', keywords: 'devices remove revoke paired' },
  { section: 'network', title: 'Technical details', description: 'Address, port, and media server status', keywords: 'ip address url port manual server' },
  { section: 'network', title: 'Watch another library', description: 'Connect to Loom on another computer', keywords: 'remote library nearby connect address pin' },
  { section: 'theme', title: 'Appearance', description: 'Dark or light', keywords: 'theme dark light mode' },
  { section: 'theme', title: 'Accent color', description: 'Color for buttons and selection', keywords: 'theme palette color sunbeam ember cobalt tide aurora' },
  { section: 'theme', title: 'Loading animation', description: 'Shown while pages load', keywords: 'loader spinner' },
  { section: 'theme', title: 'Home layout', description: 'Modern or Classic Home', keywords: 'home modern classic layout hero' },
  { section: 'theme', title: 'Show ratings', description: 'Rating logos on posters and detail pages', keywords: 'ratings badges imdb scores' },
  { section: 'theme', title: 'Cast card style', description: 'Standard or compact anime cast cards', keywords: 'anime cast character voice actor' },
  { section: 'theme', title: 'Sidebar order', description: 'Order of pages in the sidebar', keywords: 'sidebar order reorder navigation', group: 'theme-sidebar-order' },
  { section: 'about', title: 'Loom', description: 'Version and updates', keywords: 'update upgrade version release' },
  { section: 'about', title: 'FFmpeg', description: 'Bundled media tool', keywords: 'ffmpeg tools transcode' },
  { section: 'about', title: 'LibVLC', description: 'Native player engine', keywords: 'vlc player engine' },
  { section: 'about', title: 'libmpv', description: 'Native player engine', keywords: 'mpv player engine' },
  { section: 'about', title: 'License', description: 'Loom license', keywords: 'legal mit' },
  { section: 'about', title: 'Third-party libraries', description: 'Libraries Loom is built with', keywords: 'license legal open source credits' },
  { section: 'about', title: 'Metadata and artwork sources', description: 'Credits for content data and images', keywords: 'attribution credit poster artwork' },
];

const wordsOf = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Every query word must start a word in the entry. Title matches rank first. */
export function searchSettingsIndex(query: string, visible: ReadonlySet<SettingsSection>): SettingsSearchEntry[] {
  const words = wordsOf(query);
  if (!words.length) return [];
  return SETTINGS_SEARCH_INDEX
    .filter((entry) => visible.has(entry.section))
    .map((entry) => {
      const titleWords = wordsOf(entry.title);
      const allWords = wordsOf(`${entry.title} ${entry.description} ${entry.keywords || ''} ${SETTINGS_SECTION_LABELS[entry.section]}`);
      if (!words.every((word) => allWords.some((candidate) => candidate.startsWith(word)))) return null;
      const score = words.reduce((total, word) => total + (titleWords.some((candidate) => candidate.startsWith(word)) ? 3 : 0), 0);
      return { entry, score };
    })
    .filter((result): result is { entry: SettingsSearchEntry; score: number } => result !== null)
    .sort((left, right) => right.score - left.score)
    .map((result) => result.entry)
    .slice(0, 12);
}
