import { StatusBar } from 'expo-status-bar';
import * as Brightness from 'expo-brightness';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  FlatList,
  type ImageStyle,
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  type RefreshControlProps,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  type StyleProp,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Image as ExpoImage, type ImageContentFit } from 'expo-image';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as SecureStore from 'expo-secure-store';
import { VideoView, useVideoPlayer, type AudioTrack, type SubtitleTrack, type VideoSource } from 'expo-video';
import Zeroconf, { type ZeroconfService } from 'react-native-zeroconf';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect as SvgRect, Stop } from 'react-native-svg';
import {
  AudioTracksIcon,
  BackIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  LoomLogo,
  PauseIcon,
  PlayIcon,
  PlayMark,
  RefreshIcon,
  SearchIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SpeedIcon,
  StarIcon,
  SubtitlesIcon,
  navIcons,
  type IconProps,
} from './components/LoomIcons';

type LibraryKind = 'home' | 'anime' | 'tv' | 'movies' | 'others' | 'settings';
type SettingsSection = 'library' | 'network';
type PlayerVerticalGesture = 'brightness' | 'volume';

type LocalMediaTrack = {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'data' | 'unknown';
  codec?: string;
  language?: string;
  title?: string;
  channels?: number;
  width?: number;
  height?: number;
  profile?: string;
  pixelFormat?: string;
  default?: boolean;
  forced?: boolean;
};

type LocalMediaDetails = {
  durationSeconds?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioTracks?: number;
  subtitleTracks?: number;
  tracks?: LocalMediaTrack[];
  container?: string;
  width?: number;
  height?: number;
};

type SubtitleRecord = {
  lang: string;
  label: string;
  url: string;
};

type EpisodeFile = {
  season: number;
  episode: number;
  filePath: string;
  title?: string;
  thumbnail?: string;
  still?: string;
  subtitles?: SubtitleRecord[];
  localMetadata?: LocalMediaDetails;
};

type MediaItem = {
  id: string;
  type: 'movie' | 'tv' | 'anime';
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  posterCandidates?: string[];
  backdropCandidates?: string[];
  summary?: string;
  rating?: number;
  genres?: string[];
  filePath: string;
  lastPlayed?: number;
  subtitles?: SubtitleRecord[];
  localMetadata?: LocalMediaDetails;
  episodeFiles?: EpisodeFile[];
};

type LibraryPayload = {
  movies?: MediaItem[];
  tvShows?: MediaItem[];
  animeShows?: MediaItem[];
};

type PairResponse = {
  deviceId: string;
  deviceToken: string;
  hostDeviceId?: string;
  hostDeviceName?: string;
  library: LibraryPayload;
  libraryEtag: string;
};

type Connection = {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  hostDeviceId: string;
  hostDeviceName: string;
  library: LibraryPayload;
  libraryEtag: string;
};

type SavedConnection = Pick<Connection, 'baseUrl' | 'deviceId' | 'deviceToken' | 'hostDeviceId' | 'hostDeviceName'>;

type DiscoveredHost = {
  deviceId: string;
  deviceName: string;
  /** mDNS instance name — differs from deviceName, which comes from TXT. */
  serviceName: string;
  baseUrl: string;
  pairCode: string;
};

const SAVED_CONNECTION_KEY = 'loomtv.saved-connection.v1';
const MOBILE_DEVICE_ID_KEY = 'loomtv.mobile-device-id.v1';

type MobileThemeSettings = {
  appThemeColor?: string;
  appDarkTheme?: string;
};

type MobileThemeColors = {
  accent: string;
  accentSoft: string;
  accentBorder: string;
  accentForeground: string;
  bg: string;
  panel: string;
  panel2: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  themeLabel: string;
};

type ApiResult<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

type HlsSession = {
  playlistUrl: string;
};

type OfficialArtworkResponse = {
  thumbnail?: string;
  cover?: string;
  summary?: string;
  rating?: number;
  genres?: string[];
  episodes?: unknown[];
  episodeSource?: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
  posterCandidates?: string[];
  backdropCandidates?: string[];
  logo?: string;
  logoCandidates?: string[];
  error?: string;
};

type OfficialMetadataCandidate = OfficialArtworkResponse & {
  id?: string;
  source?: 'TMDB' | 'OMDb' | 'TVmaze' | 'Jikan';
  title?: string;
  year?: number;
  episodeCount?: number;
  episodePreview?: string[];
};

type PosterCandidateSheetState = {
  item: MediaItem;
  candidates: OfficialMetadataCandidate[];
};

type StreamOptions = {
  forceTranscode?: boolean;
  startSeconds?: number;
  audioTrackIndex?: number;
  subtitleTrackIndex?: number;
  subtitleStreamOrdinal?: number;
  subtitleCodec?: string;
  subtitleFilePath?: string;
};

type TrackPreference = {
  enabled: boolean;
  index?: number;
  language?: string;
  title?: string;
  codec?: string;
  forced?: boolean;
};

type PlaybackTrackPreferences = {
  audio?: TrackPreference;
  subtitle?: TrackPreference;
};

type LibraryMetric = {
  key: string;
  label: string;
  value: number;
  Icon: (props: IconProps) => ReactElement;
};

type PlayTarget = {
  title: string;
  subtitle?: string;
  streamPath: string;
  transcode: boolean;
  localMetadata?: LocalMediaDetails;
  subtitles?: SubtitleRecord[];
  startPosition?: number;
  mediaId?: string;
  thumbnail?: string;
  thumbnailCandidates?: string[];
};

type PlayerAudioOption = {
  key: string;
  label: string;
  localTrack?: LocalMediaTrack;
  nativeTrack?: AudioTrack;
};

type PlayerSubtitleOption = {
  key: string;
  label: string;
  localTrack?: LocalMediaTrack;
  nativeTrack?: SubtitleTrack;
  sidecar?: SubtitleRecord;
  streamOrdinal?: number;
};

type StoredProgress = {
  position: number;
  duration: number;
  updatedAt: number;
  watched: boolean;
};

const MOBILE_ACCENTS: Record<string, Pick<MobileThemeColors, 'accent' | 'accentSoft' | 'accentBorder' | 'accentForeground'>> = {
  yellow: { accent: '#fbc500', accentSoft: 'rgba(251,197,0,0.16)', accentBorder: 'rgba(251,197,0,0.45)', accentForeground: '#08101a' },
  red: { accent: '#931116', accentSoft: 'rgba(147,17,22,0.18)', accentBorder: 'rgba(147,17,22,0.48)', accentForeground: '#ffffff' },
  blue: { accent: '#8FB8FF', accentSoft: 'rgba(143,184,255,0.18)', accentBorder: 'rgba(143,184,255,0.48)', accentForeground: '#071322' },
  orange: { accent: '#FF9900', accentSoft: 'rgba(255,153,0,0.18)', accentBorder: 'rgba(255,153,0,0.48)', accentForeground: '#000000' },
};

const MOBILE_DARK_THEMES: Record<string, Pick<MobileThemeColors, 'bg' | 'panel' | 'panel2' | 'border' | 'muted' | 'faint' | 'themeLabel'>> = {
  black: {
    bg: '#0a0a0a',
    panel: '#141414',
    panel2: '#101010',
    border: '#262626',
    muted: '#a3a3a3',
    faint: '#737373',
    themeLabel: 'Black',
  },
  default: {
    bg: '#1a1a1a',
    panel: '#232323',
    panel2: '#1d1d1d',
    border: '#2d2d2d',
    muted: '#a8a8a8',
    faint: '#777777',
    themeLabel: 'Default',
  },
  justwatch: {
    bg: '#060d17',
    panel: '#101a28',
    panel2: '#0b1420',
    border: '#243348',
    muted: '#9aa7b8',
    faint: '#647287',
    themeLabel: 'Navy Black',
  },
};

const DEFAULT_MOBILE_THEME: MobileThemeColors = {
  ...MOBILE_ACCENTS.yellow,
  ...MOBILE_DARK_THEMES.black,
  text: '#ffffff',
};

let accent = DEFAULT_MOBILE_THEME.accent;
let accentForeground = DEFAULT_MOBILE_THEME.accentForeground;
let bg = DEFAULT_MOBILE_THEME.bg;
let panel = DEFAULT_MOBILE_THEME.panel;
let panel2 = DEFAULT_MOBILE_THEME.panel2;
let border = DEFAULT_MOBILE_THEME.border;
let text = DEFAULT_MOBILE_THEME.text;
let muted = DEFAULT_MOBILE_THEME.muted;
let faint = DEFAULT_MOBILE_THEME.faint;
const settingsContentMaxWidth = 640;
const settingsPageHorizontalPadding = 32;
const settingsCardHorizontalPadding = 32;
const settingsMetricGap = 8;
const imageLoadTimeoutMs = 8000;
const imageRetryDelayMs = 12000;
const imageCacheBustQueryParam = 'loomtvImageBust';
const serverOfflineHint = 'The desktop app or Local Network Sharing may be off. LoomTV will reconnect automatically when it becomes available.';

const navItems: { id: LibraryKind; label: string; Icon: (props: IconProps) => ReactElement }[] = [
  { id: 'home', label: 'Home', Icon: navIcons.home },
  { id: 'anime', label: 'Anime', Icon: navIcons.anime },
  { id: 'tv', label: 'TV Shows', Icon: navIcons.tv },
  { id: 'movies', label: 'Movies', Icon: navIcons.movies },
  { id: 'settings', label: 'More', Icon: navIcons.settings },
];

const settingsSections: { id: SettingsSection; label: string; description: string }[] = [
  { id: 'library', label: 'Library', description: 'Refresh and review the paired desktop library.' },
  { id: 'network', label: 'Network', description: 'Pairing status and desktop connection details.' },
];

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter the desktop app address.');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function discoveredHostFromService(service: ZeroconfService): DiscoveredHost | null {
  const txt = service.txt || {};
  const deviceId = String(txt.deviceId || '').trim();
  const deviceName = String(txt.deviceName || service.name || '').trim();
  const pairCode = String(txt.pairCode || '').replace(/\D/g, '').slice(0, 6);
  const port = Number(service.port || 0);
  if (!deviceId || !Number.isInteger(port) || port <= 0) return null;

  const serviceName = String(service.name || '').trim();
  const advertisedBaseUrl = String(txt.baseUrl || '').trim().replace(/\/$/, '');
  if (/^https?:\/\/[^/]+(?::\d+)?$/i.test(advertisedBaseUrl)) {
    return {
      deviceId,
      deviceName: deviceName || advertisedBaseUrl,
      serviceName,
      baseUrl: advertisedBaseUrl,
      pairCode,
    };
  }

  const addresses = service.addresses || [];
  const ipv4Address = addresses.find((candidate) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate));
  const ipv6Address = addresses.find((candidate) => candidate.includes(':'))?.split('%')[0];
  const resolvedHost = ipv4Address
    || (ipv6Address ? `[${ipv6Address}]` : '')
    || String(service.host || '').trim().replace(/\.$/, '');
  if (!resolvedHost) return null;

  return {
    deviceId,
    deviceName: deviceName || resolvedHost,
    serviceName,
    baseUrl: `http://${resolvedHost}:${port}`,
    pairCode,
  };
}

function isLikelyServerOfflineError(error: string): boolean {
  const normalized = error.toLowerCase();
  const statusMatch = normalized.match(/\((\d{3})\)/);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : NaN;
  return (
    normalized.includes('network request failed')
    || normalized.includes('failed to fetch')
    || normalized.includes('econnrefused')
    || normalized.includes('ehostunreach')
    || normalized.includes('enetunreach')
    || normalized.includes('timed out')
    || status === 502
    || status === 503
    || status === 504
  );
}

function connectionErrorFor(error: unknown, fallback: string): { message: string; isOffline: boolean } {
  if (error instanceof Error) {
    const isOffline = isLikelyServerOfflineError(error.message);
    return {
      isOffline,
      message: isOffline
        ? `Could not reach the desktop server. ${serverOfflineHint}`
        : error.message || fallback,
    };
  }
  const message = typeof error === 'string' ? error : fallback;
  return {
    isOffline: isLikelyServerOfflineError(message),
    message: isLikelyServerOfflineError(message)
      ? `Could not reach the desktop server. ${serverOfflineHint}`
      : message,
  };
}

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return 'Runtime unknown';
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${minutes}m`;
}

function streamPathFor(item: MediaItem): string {
  return item.type === 'movie'
    ? item.filePath
    : item.episodeFiles?.slice().sort((a, b) => a.season - b.season || a.episode - b.episode)[0]?.filePath || item.filePath;
}

function filePathFromUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.searchParams.get('path') || value;
  } catch {
    return value;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function mobileThemeFromSettings(settings?: MobileThemeSettings): MobileThemeColors {
  return {
    ...(MOBILE_ACCENTS[settings?.appThemeColor || ''] || MOBILE_ACCENTS.yellow),
    ...(MOBILE_DARK_THEMES[settings?.appDarkTheme || ''] || MOBILE_DARK_THEMES.black),
    text: '#ffffff',
  };
}

function applyMobileThemeGlobals(theme: MobileThemeColors, nextStyles: ReturnType<typeof createStyles>) {
  accent = theme.accent;
  accentForeground = theme.accentForeground;
  bg = theme.bg;
  panel = theme.panel;
  panel2 = theme.panel2;
  border = theme.border;
  text = theme.text;
  muted = theme.muted;
  faint = theme.faint;
  styles = nextStyles;
}

// Stable empty list so the library feed keeps the same `data` reference in rails
// mode (rails render in the header; the grid data is intentionally empty).
const EMPTY_ITEMS: MediaItem[] = [];
const TRANSCODE_EXTENSIONS = ['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', '3gp', 'ts'];
// Audio codecs the native mobile players decode reliably; anything else
// (ac3/eac3/dts/truehd) plays video with no sound unless the host transcodes.
const DIRECT_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm'];
const LIBRARY_SECTION_APPLY_DELAY_MS = 45;

function needsTranscode(streamPath: string, meta?: LocalMediaDetails): boolean {
  const filePath = filePathFromUrl(streamPath);
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  if ((meta?.container || '').toLowerCase().includes('matroska') || TRANSCODE_EXTENSIONS.includes(extension)) return true;
  const audioCodec = (meta?.audioCodec || '').toLowerCase();
  if (audioCodec && !DIRECT_AUDIO_CODECS.some((codec) => audioCodec.includes(codec))) return true;
  return false;
}

function shouldTranscode(item: MediaItem): boolean {
  return needsTranscode(streamPathFor(item), item.localMetadata);
}

function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function sortedEpisodes(item: MediaItem): EpisodeFile[] {
  return (item.episodeFiles || []).slice().sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function episodePlayTarget(item: MediaItem, ep: EpisodeFile, progress?: Record<string, StoredProgress>): PlayTarget {
  const name = ep.title || `Episode ${ep.episode}`;
  const state = progress ? progressStateFor(progress, ep.filePath, ep.localMetadata?.durationSeconds) : null;
  return {
    title: name,
    subtitle: `${episodeCode(ep.season, ep.episode)} · ${item.title}`,
    streamPath: ep.filePath,
    transcode: needsTranscode(ep.filePath, ep.localMetadata),
    localMetadata: ep.localMetadata,
    subtitles: ep.subtitles || item.subtitles,
    startPosition: state?.inProgress ? state.position : 0,
    mediaId: item.id,
    thumbnail: ep.still || ep.thumbnail || item.backdrop || item.poster,
    thumbnailCandidates: [
      ep.still,
      ep.thumbnail,
      item.backdrop,
      ...(item.backdropCandidates || []),
      item.poster,
      ...(item.posterCandidates || []),
    ].filter(Boolean) as string[],
  };
}

function videoSourceFor(playbackUrl: string, target?: PlayTarget | null): VideoSource {
  return {
    uri: playbackUrl,
    contentType: playbackUrl.includes('.m3u8') ? 'hls' : 'auto',
    metadata: target ? {
      title: target.title,
      artist: target.subtitle,
    } : undefined,
  };
}

function playbackUrlWithAnchor(url: string, startSeconds?: number): string {
  if (!(typeof startSeconds === 'number') || startSeconds <= 0) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('anchor', String(Math.floor(startSeconds)));
    parsed.searchParams.set('v', String(Date.now()));
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}anchor=${Math.floor(startSeconds)}&v=${Date.now()}`;
  }
}

function playerDisplayLabels(target: PlayTarget): { topTitle: string; bottomTitle: string } {
  const subtitle = target.subtitle?.trim() || '';
  const episodeMatch = subtitle.match(/^(S\d{2}E\d{2})\s*[·-]\s*(.+)$/i);
  if (episodeMatch) {
    const episodeCodeLabel = episodeMatch[1]?.toUpperCase() || '';
    const showTitle = episodeMatch[2]?.trim() || '';
    return {
      topTitle: showTitle || target.title,
      bottomTitle: [episodeCodeLabel, target.title].filter(Boolean).join(' · '),
    };
  }
  return {
    topTitle: subtitle || target.title,
    bottomTitle: target.title,
  };
}

function hasStreamOptions(options: StreamOptions): boolean {
  return typeof options.audioTrackIndex === 'number'
    || typeof options.subtitleTrackIndex === 'number'
    || Boolean(options.subtitleFilePath);
}

function normalizeTrackField(value?: string): string {
  return (value || '').trim().toLowerCase();
}

function playbackPreferenceScope(target: Pick<PlayTarget, 'mediaId' | 'streamPath'>): string {
  return target.mediaId ? `media:${target.mediaId}` : `file:${filePathFromUrl(target.streamPath)}`;
}

function trackLanguageLabel(language?: string): string {
  const normalized = language?.trim();
  return normalized ? normalized.toUpperCase() : '';
}

function trackLanguageName(language?: string): string {
  const normalized = (language || '').trim().toLowerCase().split(/[-_]/)[0];
  if (!normalized || normalized === 'und') return '';
  const aliases: Record<string, string> = {
    chs: 'Chinese',
    cht: 'Chinese',
  };
  if (aliases[normalized]) return aliases[normalized];
  try {
    const DisplayNames = (Intl as typeof Intl & {
      DisplayNames?: new (locales: string[], options: { type: 'language' }) => { of: (code: string) => string | undefined };
    }).DisplayNames;
    const label = DisplayNames ? new DisplayNames(['en'], { type: 'language' }).of(normalized) : undefined;
    return label && label !== 'root' ? label : '';
  } catch {
    return '';
  }
}

function localTrackLabel(track: LocalMediaTrack, ordinal: number): string {
  const title = track.title?.trim();
  const languageCode = track.language?.trim();
  const languageName = trackLanguageName(languageCode);
  const language = languageCode
    ? languageName
      ? `${languageName} [${languageCode}]`
      : `[${languageCode}]`
    : '';
  const name = [language, title].filter(Boolean).join(' ') || `Track ${ordinal + 1}`;
  const details = [
    track.codec?.toUpperCase(),
    track.channels ? `${track.channels}ch` : undefined,
    track.default ? 'Default' : undefined,
    track.forced ? 'Forced' : undefined,
  ].filter(Boolean).join(' · ');
  return `#${ordinal + 1} ${details ? `${name} · ${details}` : name}`;
}

function nativeTrackKey(track: { id?: string; language?: string; label?: string }, prefix: string, index: number): string {
  return `${prefix}-${track.id || `${track.language || ''}-${track.label || ''}` || index}`;
}

function nativeTrackLabel(track: { language?: string; label?: string }, index: number): string {
  const languageCode = track.language?.trim();
  const languageName = trackLanguageName(languageCode);
  const language = languageCode
    ? languageName
      ? `${languageName} [${languageCode}]`
      : `[${languageCode}]`
    : '';
  return `#${index + 1} ${[language, track.label?.trim()].filter(Boolean).join(' ') || `Track ${index + 1}`}`;
}

function sidecarSubtitleLabel(subtitle: SubtitleRecord, index: number): string {
  const languageCode = subtitle.lang?.trim();
  const languageName = trackLanguageName(languageCode);
  const language = languageCode
    ? languageName
      ? `${languageName} [${languageCode}]`
      : `[${languageCode}]`
    : '';
  return `#${index + 1} ${[language, subtitle.label?.trim()].filter(Boolean).join(' ') || `Subtitle ${index + 1}`}`;
}

function audioPreference(option: PlayerAudioOption | undefined, enabled: boolean): TrackPreference {
  const track = option?.localTrack;
  const nativeTrack = option?.nativeTrack;
  return {
    enabled,
    ...(typeof track?.index === 'number' ? { index: track.index } : {}),
    language: normalizeTrackField(track?.language || nativeTrack?.language),
    title: normalizeTrackField(track?.title || nativeTrack?.label),
    codec: normalizeTrackField(track?.codec),
    ...(typeof track?.forced === 'boolean' ? { forced: track.forced } : {}),
  };
}

function subtitlePreference(option: PlayerSubtitleOption | null, enabled: boolean): TrackPreference {
  const track = option?.localTrack;
  const nativeTrack = option?.nativeTrack;
  const sidecar = option?.sidecar;
  return {
    enabled,
    ...(typeof track?.index === 'number' ? { index: track.index } : {}),
    language: normalizeTrackField(track?.language || nativeTrack?.language || sidecar?.lang),
    title: normalizeTrackField(track?.title || nativeTrack?.label || sidecar?.label),
    codec: normalizeTrackField(track?.codec),
    ...(typeof track?.forced === 'boolean' ? { forced: track.forced } : {}),
  };
}

function optionMatchesPreference(
  option: PlayerAudioOption | PlayerSubtitleOption,
  preference: TrackPreference,
  type: 'audio' | 'subtitle',
): boolean {
  const localTrack = option.localTrack;
  const nativeTrack = option.nativeTrack;
  const sidecar = 'sidecar' in option ? option.sidecar : undefined;
  const language = normalizeTrackField(localTrack?.language || nativeTrack?.language || sidecar?.lang);
  const title = normalizeTrackField(localTrack?.title || nativeTrack?.label || sidecar?.label);
  const codec = normalizeTrackField(localTrack?.codec);
  const prefLanguage = normalizeTrackField(preference.language);
  const prefTitle = normalizeTrackField(preference.title);
  const prefCodec = normalizeTrackField(preference.codec);

  if (typeof localTrack?.index === 'number' && localTrack.index === preference.index) return true;
  if (type === 'subtitle' && prefLanguage && language === prefLanguage && prefTitle && title === prefTitle) return true;
  if (prefLanguage && language === prefLanguage && prefCodec && codec === prefCodec) return true;
  if (prefLanguage && language === prefLanguage) return true;
  return Boolean(prefTitle && title === prefTitle);
}

function preferredAudioKey(options: PlayerAudioOption[], preference?: TrackPreference): string {
  if (!preference?.enabled) return options[0]?.key || '';
  return options.find((option) => optionMatchesPreference(option, preference, 'audio'))?.key || options[0]?.key || '';
}

function preferredSubtitleKey(options: PlayerSubtitleOption[], preference?: TrackPreference): string {
  if (!preference) return 'off';
  if (!preference.enabled) return 'off';
  return options.find((option) => optionMatchesPreference(option, preference, 'subtitle'))?.key || 'off';
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function seasonCountLabel(item: MediaItem): string {
  const seasons = new Set((item.episodeFiles || []).map((ep) => ep.season)).size;
  if (seasons > 0) return `${seasons} ${seasons === 1 ? 'season' : 'seasons'}`;
  return item.type === 'anime' ? 'Anime' : 'Series';
}

function libraryWithPlayedItem(library: LibraryPayload, streamPath: string, playedAt: number): LibraryPayload {
  const filePath = filePathFromUrl(streamPath);
  const markItems = (items?: MediaItem[]) => items?.map((item) => {
    const itemPath = filePathFromUrl(item.filePath);
    const episodeMatch = item.episodeFiles?.some((episode) => filePathFromUrl(episode.filePath) === filePath);
    return itemPath === filePath || episodeMatch ? { ...item, lastPlayed: playedAt } : item;
  });

  return {
    ...library,
    movies: markItems(library.movies),
    tvShows: markItems(library.tvShows),
    animeShows: markItems(library.animeShows),
  };
}

function progressStateFor(progress: Record<string, StoredProgress>, streamPath: string, durationHint = 0) {
  const stored = progress[filePathFromUrl(streamPath)] || progress[streamPath];
  const duration = stored?.duration || durationHint || 0;
  const position = Math.min(stored?.position || 0, duration || stored?.position || 0);
  const fraction = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const watched = Boolean(stored?.watched) || fraction >= 0.9;
  return {
    position,
    duration,
    fraction: watched ? 1 : fraction,
    watched,
    inProgress: position > 10 && !watched,
  };
}

function collections(library: LibraryPayload) {
  return {
    anime: library.animeShows || [],
    tv: library.tvShows || [],
    movies: library.movies || [],
    others: [] as MediaItem[],
  };
}

function allItems(library: LibraryPayload): MediaItem[] {
  const grouped = collections(library);
  return [...grouped.anime, ...grouped.tv, ...grouped.movies, ...grouped.others];
}

function appendImageCacheBust(url: string, cacheBust?: string): string {
  if (!cacheBust || !/^https?:/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(imageCacheBustQueryParam, cacheBust);
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${imageCacheBustQueryParam}=${encodeURIComponent(cacheBust)}`;
  }
}

function imageUrlFor(baseUrl: string, source?: string, cacheBust?: string): string {
  if (!source) return '';
  if (/^(file:|data:|blob:)/i.test(source)) return source;
  const url = /^https?:/i.test(source) ? source : `${baseUrl}${source.startsWith('/') ? '' : '/'}${source}`;
  return appendImageCacheBust(url, cacheBust);
}

function imageUrlsFor(baseUrl: string, sources: Array<string | undefined>, cacheBust?: string): string[] {
  return Array.from(new Set(sources.map((source) => imageUrlFor(baseUrl, source, cacheBust)).filter(Boolean)));
}

function metadataCandidateKey(candidate: OfficialMetadataCandidate, index: number): string {
  return candidate.id || `${candidate.source || 'source'}-${candidate.title || 'untitled'}-${candidate.year || 'year'}-${index}`;
}

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

async function readJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    if (response.ok) return {} as T;
    throw new Error(fallbackMessage);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    const plainText = text.trim().replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(response.ok ? fallbackMessage : `${fallbackMessage}${plainText ? ` ${plainText}` : ''}`);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function FallbackImage({
  altFallback,
  resizeMode,
  sources,
  style,
}: {
  altFallback: ReactElement;
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
  sources: string[];
  style: StyleProp<ImageStyle>;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const sourcesKey = sources.join('|');
  const source = sources[sourceIndex] || '';
  const exhausted = !source && sources.length > 0;

  useEffect(() => {
    setSourceIndex(0);
  }, [sourcesKey]);

  // The desktop server can be briefly unreachable (asleep, restarting, or
  // relaunching during development). Without a retry, one failed pass through
  // the sources leaves the placeholder up for good even after the host comes
  // back, so exhausted sources restart from the top after a pause. The epoch
  // in the render key remounts the image so a URL that already failed gets a
  // fresh native load instead of being ignored as an unchanged prop.
  useEffect(() => {
    if (!exhausted) return;
    const timer = setTimeout(() => {
      setRetryEpoch((current) => current + 1);
      setSourceIndex(0);
    }, imageRetryDelayMs);
    return () => clearTimeout(timer);
  }, [exhausted]);

  if (!source) return altFallback;

  return (
    <FadeInImage
      key={`${retryEpoch}:${source}`}
      uri={source}
      style={style}
      resizeMode={resizeMode}
      onError={() => setSourceIndex((current) => current + 1)}
    />
  );
}

const ShimmerOverlay = memo(function ShimmerOverlay() {
  const progress = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1300,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);

  // A soft, transparent-edged sheen sized to the frame, swept from fully off the
  // left to fully off the right at a constant speed. Because both ends of the
  // travel put the highlight entirely out of view, the loop restart is invisible
  // — no hard bar, no stall at the edges, no snap-back flicker. Sizing to the
  // measured width keeps the sweep consistent across posters, thumbnails, and the
  // detail backdrop.
  const bandWidth = Math.max(140, width * 0.85);
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-bandWidth, width + bandWidth],
  });

  return (
    <View
      pointerEvents="none"
      style={styles.shimmerBase}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width > 0 ? (
        <Animated.View
          style={[styles.shimmerBand, { width: bandWidth, transform: [{ translateX }, { skewX: '-18deg' }] }]}
        >
          <Svg width="100%" height="100%">
            <Defs>
              <SvgLinearGradient id="shimmerSheen" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor="#ffffff" stopOpacity={0} />
                <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0.18} />
                <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
              </SvgLinearGradient>
            </Defs>
            <SvgRect x="0" y="0" width="100%" height="100%" fill="url(#shimmerSheen)" />
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  );
});

function matchesQuery(item: MediaItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    item.title,
    item.year ? String(item.year) : '',
    ...(item.genres || []),
    item.summary || '',
  ].some((value) => value.toLowerCase().includes(needle));
}

function sectionTitle(kind: LibraryKind): string {
  if (kind === 'settings') return 'Settings';
  if (kind === 'tv') return 'TV Shows';
  if (kind === 'movies') return 'Movies';
  if (kind === 'anime') return 'Anime';
  if (kind === 'others') return 'Others';
  return 'Home';
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// A Pressable that springs down slightly while held, then back on release.
// Replaces the flat opacity dim for cards and primary buttons so touches feel
// tactile without being flashy.
function PressableScale({
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  children,
  disabled,
  onPress,
  scaleTo = 0.96,
  style,
}: {
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'tab' | 'menuitem' | 'adjustable';
  accessibilityState?: { selected?: boolean; disabled?: boolean };
  children: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  scaleTo?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const springTo = (toValue: number) =>
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      speed: 45,
      bounciness: toValue < 1 ? 0 : 7,
    }).start();
  return (
    <AnimatedPressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => springTo(scaleTo)}
      onPressOut={() => springTo(1)}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}

// Fades an image in on load instead of letting it pop, softening poster,
// backdrop, and thumbnail swaps. Resets when the source URI changes.
function resizeModeToContentFit(resizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center'): ImageContentFit {
  switch (resizeMode) {
    case 'contain': return 'contain';
    case 'stretch': return 'fill';
    case 'center': return 'none';
    default: return 'cover';
  }
}

function FadeInImage({
  onError,
  resizeMode,
  style,
  uri,
}: {
  onError?: () => void;
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
  style: StyleProp<ImageStyle>;
  uri: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const settledRef = useRef(false);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    settledRef.current = false;
    setLoaded(false);
    const timeout = setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      setLoaded(true);
      onErrorRef.current?.();
    }, imageLoadTimeoutMs);
    return () => clearTimeout(timeout);
  }, [uri]);

  const settleAsLoaded = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setLoaded(true);
  };

  const settleAsFailed = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setLoaded(true);
    onErrorRef.current?.();
  };

  // expo-image keeps a persistent memory + disk cache, so an image loads once
  // and is reused across scrolls, screens, and app restarts instead of being
  // refetched. Its native transition fades the image in on first load but shows
  // instantly on a cache hit, and `recyclingKey` resets cleanly when a recycled
  // FlatList cell swaps to a different URL.
  return (
    <View style={[style as StyleProp<ViewStyle>, styles.imageLoadFrame]}>
      {!loaded ? <ShimmerOverlay /> : null}
      <ExpoImage
        source={uri}
        style={StyleSheet.absoluteFill}
        contentFit={resizeModeToContentFit(resizeMode)}
        transition={220}
        cachePolicy="memory-disk"
        recyclingKey={uri}
        onLoad={settleAsLoaded}
        onError={settleAsFailed}
      />
    </View>
  );
}

// One-shot mount entrance for full-screen overlays: fade, with an optional rise.
function useEntrance(translateY = 0) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress]);
  return {
    opacity: progress,
    transform: translateY
      ? [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [translateY, 0] }) }]
      : undefined,
  };
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppRoot />
    </SafeAreaProvider>
  );
}

function AppRoot() {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isTablet = Math.min(width, height) >= 760;

  const [baseUrl, setBaseUrl] = useState('');
  const [shareCode, setShareCode] = useState('');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [savedConnection, setSavedConnection] = useState<SavedConnection | null>(null);
  const [discoveredHosts, setDiscoveredHosts] = useState<DiscoveredHost[]>([]);
  const [isDiscoveringHosts, setIsDiscoveringHosts] = useState(true);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryScanNonce, setDiscoveryScanNonce] = useState(0);
  const [isRestoringConnection, setIsRestoringConnection] = useState(true);
  const [activeKind, setActiveKind] = useState<LibraryKind>('home');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<MediaItem | null>(null);
  const [playTarget, setPlayTarget] = useState<PlayTarget | null>(null);
  const [miniPlayerTarget, setMiniPlayerTarget] = useState<PlayTarget | null>(null);
  const playerReturnItemRef = useRef<MediaItem | null>(null);
  const detailItemCacheRef = useRef(new Map<string, MediaItem>());
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [streamOptions, setStreamOptions] = useState<StreamOptions>({});
  const shouldAutoplayRef = useRef(false);
  const userPausedRef = useRef(false);
  const pendingSeekRef = useRef(0);
  const [isPairing, setIsPairing] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshingArtworkId, setRefreshingArtworkId] = useState('');
  const [artworkRefreshError, setArtworkRefreshError] = useState('');
  const [artworkCacheBusters, setArtworkCacheBusters] = useState<Record<string, string>>({});
  const [posterCandidateSheet, setPosterCandidateSheet] = useState<PosterCandidateSheetState | null>(null);
  const [applyingPosterCandidateId, setApplyingPosterCandidateId] = useState('');
  const [isPreparingStream, setIsPreparingStream] = useState(false);
  const [error, setError] = useState('');
  const [isServerOffline, setIsServerOffline] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const [progress, setProgress] = useState<Record<string, StoredProgress>>({});
  const [mobileTheme, setMobileTheme] = useState<MobileThemeColors>(DEFAULT_MOBILE_THEME);
  const libraryListRef = useRef<FlatList<MediaItem> | null>(null);
  const settingsScrollRef = useRef<ScrollView | null>(null);
  const scrollOffsetsRef = useRef<Record<LibraryKind, number>>({
    home: 0,
    anime: 0,
    tv: 0,
    movies: 0,
    others: 0,
    settings: 0,
  });
  const themeSyncStartedRef = useRef(false);
  const prePairThemeBaseRef = useRef('');
  const reconnectingSavedConnectionRef = useRef(false);
  const connectionHealthCheckRef = useRef(false);
  const mobileDeviceIdRef = useRef('');
  const themedStyles = useMemo(() => createStyles(mobileTheme), [mobileTheme]);
  applyMobileThemeGlobals(mobileTheme, themedStyles);

  const navigateToKind = useCallback((kind: LibraryKind) => {
    setDetailItem(null);
    setSearchOpen(false);
    setQuery('');
    setActiveKind(kind);
  }, []);

  const rememberMainScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (query) return;
    scrollOffsetsRef.current[activeKind] = event.nativeEvent.contentOffset.y;
  }, [activeKind, query]);

  useEffect(() => {
    if (query) return;
    const offset = scrollOffsetsRef.current[activeKind] || 0;
    const frame = requestAnimationFrame(() => {
      if (activeKind === 'settings') {
        settingsScrollRef.current?.scrollTo({ y: offset, animated: false });
      } else {
        libraryListRef.current?.scrollToOffset({ offset, animated: false });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activeKind, query]);

  useEffect(() => {
    let cancelled = false;
    void SecureStore.getItemAsync(MOBILE_DEVICE_ID_KEY)
      .then((deviceId) => { if (!cancelled && deviceId) mobileDeviceIdRef.current = deviceId; })
      .catch(() => {});
    void SecureStore.getItemAsync(SAVED_CONNECTION_KEY)
      .then((stored) => {
        if (cancelled || !stored) return;
        const saved = JSON.parse(stored) as SavedConnection;
        if (!saved.baseUrl || !saved.deviceId || !saved.deviceToken) return;
        saved.hostDeviceId ||= '';
        setSavedConnection(saved);
        setBaseUrl(saved.baseUrl);
        void reconnectSavedConnection(saved);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsRestoringConnection(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (connection) {
      setIsDiscoveringHosts(false);
      return;
    }

    const zeroconf = new Zeroconf();
    setIsDiscoveringHosts(true);
    setDiscoveryError('');

    zeroconf.on('resolved', (service) => {
      const host = discoveredHostFromService(service);
      if (!host) return;
      setDiscoveredHosts((current) => [
        ...current.filter((candidate) => candidate.deviceId !== host.deviceId),
        host,
      ].sort((a, b) => a.deviceName.localeCompare(b.deviceName)));
    });
    zeroconf.on('remove', (name) => {
      setDiscoveredHosts((current) => current.filter((host) => host.serviceName !== name));
    });
    zeroconf.on('error', () => {
      setDiscoveryError('Automatic discovery is unavailable. You can still connect manually.');
      setIsDiscoveringHosts(false);
    });
    zeroconf.on('start', () => setIsDiscoveringHosts(true));
    try {
      zeroconf.scan('loomtv', 'tcp', 'local.');
    } catch {
      setDiscoveryError('Automatic discovery requires a LoomTV development or store build. You can still connect manually.');
      setIsDiscoveringHosts(false);
    }

    const scanWindow = setTimeout(() => setIsDiscoveringHosts(false), 5000);
    return () => {
      clearTimeout(scanWindow);
      try { zeroconf.stop(); } catch {}
      zeroconf.removeAllListeners();
      zeroconf.removeDeviceListeners();
    };
  }, [connection, discoveryScanNonce]);

  useEffect(() => {
    if (!savedConnection || connection) return;
    const discoveredSavedHost = discoveredHosts.find((host) =>
      host.deviceId === savedConnection.hostDeviceId
      || (!savedConnection.hostDeviceId && host.deviceName === savedConnection.hostDeviceName));
    if (discoveredSavedHost && (
      discoveredSavedHost.baseUrl !== savedConnection.baseUrl
      || discoveredSavedHost.deviceId !== savedConnection.hostDeviceId
    )) {
      const updated = { ...savedConnection, baseUrl: discoveredSavedHost.baseUrl, hostDeviceId: discoveredSavedHost.deviceId };
      setSavedConnection(updated);
      setBaseUrl(updated.baseUrl);
      void SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(updated));
      void reconnectSavedConnection(updated);
    }
  }, [connection, discoveredHosts, savedConnection]);

  useEffect(() => {
    if (!savedConnection || connection) return;
    const retry = setInterval(() => void reconnectSavedConnection(savedConnection), 5000);
    return () => clearInterval(retry);
  }, [connection, savedConnection]);

  useEffect(() => {
    if (!connection) return;
    const healthCheck = setInterval(() => void checkDesktopConnection(), 10000);
    return () => clearInterval(healthCheck);
  }, [connection?.baseUrl, connection?.deviceToken, connection?.libraryEtag]);

  // Browsing is portrait; video playback is locked to either landscape direction.
  useEffect(() => {
    const lock = playTarget ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP;
    void ScreenOrientation.lockAsync(lock).catch(() => {});
  }, [playTarget]);

  useEffect(() => {
    if (!connection || themeSyncStartedRef.current) return;
    themeSyncStartedRef.current = true;

    fetch(`${connection.baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${connection.deviceToken}` },
    })
      .then((response) => (response.ok ? response.json() as Promise<MobileThemeSettings> : undefined))
      .then((settings) => {
        if (settings) setMobileTheme(mobileThemeFromSettings(settings));
      })
      .catch(() => {});
  }, [connection]);

  useEffect(() => {
    if (connection) return;
    let nextBaseUrl = '';
    try {
      nextBaseUrl = normalizeBaseUrl(baseUrl);
    } catch {
      return;
    }
    if (prePairThemeBaseRef.current === nextBaseUrl) return;
    prePairThemeBaseRef.current = nextBaseUrl;

    let cancelled = false;
    fetch(`${nextBaseUrl}/api/settings`)
      .then((response) => (response.ok ? response.json() as Promise<MobileThemeSettings> : undefined))
      .then((settings) => {
        if (!cancelled && settings) setMobileTheme(mobileThemeFromSettings(settings));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [baseUrl, connection]);

  const library = connection?.library || {};
  const grouped = useMemo(() => collections(library), [library]);
  const everything = useMemo(() => allItems(library), [library]);
  const continueWatching = useMemo(
    () => everything.filter((item) => item.lastPlayed).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 16),
    [everything],
  );
  const visibleItems = useMemo(() => {
    if (activeKind === 'settings') return [];
    const source = activeKind === 'home' ? everything : grouped[activeKind === 'others' ? 'others' : activeKind];
    return source.filter((item) => matchesQuery(item, query));
  }, [activeKind, everything, grouped, query]);

  useEffect(() => {
    for (const item of everything) {
      detailItemCacheRef.current.set(item.id, item);
    }
  }, [everything]);

  const openDetailItem = useCallback((item: MediaItem) => {
    const cached = detailItemCacheRef.current.get(item.id) || item;
    detailItemCacheRef.current.set(cached.id, cached);
    setDetailItem(cached);
  }, []);

  const streamOptionsKey = useMemo(() => JSON.stringify(streamOptions), [streamOptions]);

  const player = useVideoPlayer(null, (nextPlayer) => {
    nextPlayer.loop = false;
    nextPlayer.timeUpdateEventInterval = 0.5;
  });

  useEffect(() => {
    if (playbackUrl) {
      shouldAutoplayRef.current = true;
      userPausedRef.current = false;
      pendingSeekRef.current = streamOptions.startSeconds ?? playTarget?.startPosition ?? 0;
    } else {
      shouldAutoplayRef.current = false;
      pendingSeekRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackUrl]);

  useEffect(() => {
    let cancelled = false;

    async function loadSource() {
      try {
        if (!playbackUrl) {
          await player.replaceAsync(null);
          return;
        }

        await player.replaceAsync(videoSourceFor(playbackUrl, playTarget));
      } catch (nextError) {
        if (!cancelled) {
          setPlaybackError(nextError instanceof Error ? nextError.message : 'Could not load this stream.');
        }
      }
    }

    void loadSource();
    return () => {
      cancelled = true;
    };
  }, [playbackUrl, player]);

  useEffect(() => {
    if (!playbackUrl) return;

    const statusSubscription = player.addListener?.('statusChange', (payload: { status: string }) => {
      if (payload.status === 'readyToPlay' && shouldAutoplayRef.current && !userPausedRef.current) {
        try {
          if (pendingSeekRef.current > 10) {
            player.currentTime = pendingSeekRef.current;
          }
          pendingSeekRef.current = 0;
          player.play();
          shouldAutoplayRef.current = false;
        } catch {
          // Native player readiness can lag behind this callback on some devices.
        }
      }
    });

    const playingSubscription = player.addListener?.('playingChange', (event: { isPlaying: boolean }) => {
      if (event.isPlaying) {
        userPausedRef.current = false;
      } else {
        userPausedRef.current = true;
      }
    });

    const sourceChangeSubscription = player.addListener?.('sourceChange', () => {
      shouldAutoplayRef.current = true;
      userPausedRef.current = false;
    });

    const endSubscription = player.addListener?.('playToEnd', () => {
      shouldAutoplayRef.current = false;
    });

    return () => {
      statusSubscription?.remove?.();
      playingSubscription?.remove?.();
      sourceChangeSubscription?.remove?.();
      endSubscription?.remove?.();
    };
  }, [playbackUrl, player]);

  useEffect(() => {
    if (!playbackUrl) return;

    if (shouldAutoplayRef.current && !userPausedRef.current) {
      try {
        player.play();
      } catch {
        // player may not be ready yet; the status listener will retry when ready.
      }
    }
  }, [playbackUrl, player]);

  // Only prepare/transcode a stream when the user actually opens the player —
  // browsing the library no longer kicks off a transcode for every tap.
  useEffect(() => {
    let cancelled = false;

    async function prepareStream() {
      if (!connection?.baseUrl || !connection.deviceToken || !playTarget) {
        setPlaybackUrl(null);
        return;
      }

      setPlaybackError('');
      setIsPreparingStream(true);
      try {
        const shouldUseHls = playTarget.transcode || hasStreamOptions(streamOptions);
        if (!shouldUseHls) {
          if (!cancelled) setPlaybackUrl(playTarget.streamPath);
          return;
        }

        const startSeconds = streamOptions.startSeconds ?? playTarget.startPosition ?? 0;
        const options: StreamOptions = {
          ...streamOptions,
          forceTranscode: true,
          ...(startSeconds > 2 ? { startSeconds } : {}),
        };
        const response = await fetch(`${connection.baseUrl}/api/lan/start-hls`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${connection.deviceToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filePath: filePathFromUrl(playTarget.streamPath),
            options,
          }),
        });
        const result = (await response.json()) as ApiResult<HlsSession>;
        if (!response.ok || !result.ok || !result.data?.playlistUrl) {
          throw new Error(result.error || `Could not prepare stream (${response.status}).`);
        }
        if (!cancelled) setPlaybackUrl(playbackUrlWithAnchor(result.data.playlistUrl, options.startSeconds));
      } catch (nextError) {
        if (!cancelled) {
          setPlaybackUrl(null);
          setPlaybackError(nextError instanceof Error ? nextError.message : 'Could not prepare this stream.');
        }
      } finally {
        if (!cancelled) setIsPreparingStream(false);
      }
    }

    void prepareStream();
    return () => {
      cancelled = true;
    };
  }, [connection?.baseUrl, connection?.deviceToken, playTarget, streamOptionsKey]);

  async function syncPlaybackProgress(target = playTarget) {
    if (!connection || !target) return;
    let position = 0;
    let duration = 0;
    try {
      position = Number(player.currentTime || 0);
      duration = Number(player.duration || 0);
    } catch {
      return; // player already torn down — nothing to report
    }
    if (!Number.isFinite(position) || position <= 0) return;

    try {
      const response = await fetch(`${connection.baseUrl}/api/progress`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.deviceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filePath: filePathFromUrl(target.streamPath),
          position,
          duration: Number.isFinite(duration) ? duration : 0,
        }),
      });
      if (response.ok) {
        const stored = (await response.json()) as StoredProgress;
        const playedAt = Date.now();
        setProgress((current) => ({
          ...current,
          [filePathFromUrl(target.streamPath)]: stored,
        }));
        setConnection((current) => current
          ? { ...current, library: libraryWithPlayedItem(current.library, target.streamPath, playedAt) }
          : current);
      }
    } catch {
      // Progress sync should never interrupt playback.
    }
  }

  const closePlayer = useCallback(() => {
    // Touch the native player defensively: if it is already torn down, the
    // currentTime getter throws, and bailing out here used to leave the
    // landscape player mounted in a portrait window (black screen below a
    // squashed video). The portrait re-lock is handled by the playTarget
    // effect, which fires after the player has actually unmounted.
    let resumePosition = 0;
    try {
      resumePosition = Number(player.currentTime || 0);
      player.pause();
    } catch {
      // ignore — player may already be torn down
    }
    const target = playTarget;
    const returnItemId = playerReturnItemRef.current?.id || target?.mediaId || '';
    void syncPlaybackProgress(playTarget || undefined);
    setPlayTarget(null);
    setPlaybackUrl(null);
    setStreamOptions({});
    setPlaybackError('');
    if (target) {
      setMiniPlayerTarget({
        ...target,
        startPosition: Number.isFinite(resumePosition) && resumePosition > 0
          ? resumePosition
          : target.startPosition,
      });
    }
    playerReturnItemRef.current = null;
    if (returnItemId && detailItem?.id !== returnItemId) {
      const cachedReturnItem = detailItemCacheRef.current.get(returnItemId)
        || allItems(connection?.library || {}).find((item) => item.id === returnItemId);
      if (cachedReturnItem) setDetailItem(cachedReturnItem);
    }
  }, [connection?.library, detailItem?.id, playTarget, player]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (playTarget) {
        closePlayer();
        return true;
      }
      if (detailItem) {
        setDetailItem(null);
        return true;
      }
      if (searchOpen) {
        setSearchOpen(false);
        setQuery('');
        return true;
      }
      if (activeKind !== 'home') {
        setActiveKind('home');
        return true;
      }
      return false;
    });

    return () => subscription.remove();
  }, [activeKind, closePlayer, detailItem, playTarget, searchOpen]);

  useEffect(() => {
    if (!playTarget || !playbackUrl) return undefined;
    const interval = setInterval(() => {
      void syncPlaybackProgress(playTarget);
    }, 15000);
    return () => clearInterval(interval);
  }, [playTarget, playbackUrl, connection?.baseUrl, connection?.deviceToken, player]);

  async function hydrateProgress(nextConnection = connection) {
    if (!nextConnection) return;
    try {
      const response = await fetch(`${nextConnection.baseUrl}/api/progress`, {
        headers: { Authorization: `Bearer ${nextConnection.deviceToken}` },
      });
      if (!response.ok) return;
      setProgress((await response.json()) as Record<string, StoredProgress>);
    } catch {
      // Progress is additive UI state; pairing and browsing should still work without it.
    }
  }

  async function reconnectSavedConnection(saved: SavedConnection) {
    if (reconnectingSavedConnectionRef.current) return;
    reconnectingSavedConnectionRef.current = true;
    setIsServerOffline(false);
    try {
      const response = await fetch(`${saved.baseUrl}/api/lan/library`, {
        headers: { Authorization: `Bearer ${saved.deviceToken}` },
      });
      if (response.status === 401) {
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        setSavedConnection(null);
        setError('This device is no longer authorized. Select the desktop and enter its 6-digit code to pair again.');
        return;
      }
      if (!response.ok) throw new Error(`Desktop sharing is unavailable (${response.status}).`);
      const nextConnection: Connection = {
        ...saved,
        library: (await response.json()) as LibraryPayload,
        libraryEtag: response.headers.get('ETag') || '',
      };
      setConnection(nextConnection);
      setBaseUrl(nextConnection.baseUrl);
      setError('');
      setIsServerOffline(false);
      void hydrateProgress(nextConnection);
    } catch {
      setIsServerOffline(true);
      setError('');
    } finally {
      reconnectingSavedConnectionRef.current = false;
      setIsRestoringConnection(false);
    }
  }

  async function pairWithDesktop(discoveredHost?: DiscoveredHost) {
    setError('');
    setIsServerOffline(false);
    setIsPairing(true);
    try {
      const host = discoveredHost && typeof discoveredHost.baseUrl === 'string' ? discoveredHost : undefined;
      const nextBaseUrl = normalizeBaseUrl(host?.baseUrl || baseUrl);
      const code = (host?.pairCode || shareCode).replace(/\D/g, '').slice(0, 6);
      if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit sharing code from the desktop app.');

      const response = await fetch(`${nextBaseUrl}/api/lan/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          deviceId: mobileDeviceIdRef.current || undefined,
          deviceName: Platform.OS === 'android' ? 'LoomTV Android' : 'LoomTV iOS',
        }),
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error('The sharing code was not accepted.');
        if (response.status === 429) throw new Error('Too many failed attempts. Try again later.');
        throw new Error(`Could not pair with the desktop app (${response.status}).`);
      }

      const payload = (await response.json()) as PairResponse;
      const nextConnection = {
        baseUrl: nextBaseUrl,
        deviceId: payload.deviceId,
        deviceToken: payload.deviceToken,
        hostDeviceId: payload.hostDeviceId || discoveredHosts.find((host) => host.baseUrl === nextBaseUrl)?.deviceId || '',
        hostDeviceName: payload.hostDeviceName || 'Loom Media Player Desktop',
        library: payload.library || {},
        libraryEtag: payload.libraryEtag,
      };
      const nextSavedConnection: SavedConnection = {
        baseUrl: nextConnection.baseUrl,
        deviceId: nextConnection.deviceId,
        deviceToken: nextConnection.deviceToken,
        hostDeviceId: nextConnection.hostDeviceId,
        hostDeviceName: nextConnection.hostDeviceName,
      };
      mobileDeviceIdRef.current = nextConnection.deviceId;
      await SecureStore.setItemAsync(MOBILE_DEVICE_ID_KEY, nextConnection.deviceId);
      await SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(nextSavedConnection));
      setSavedConnection(nextSavedConnection);
      setConnection(nextConnection);
      setShareCode('');
      setIsServerOffline(false);
      void hydrateProgress(nextConnection);
    } catch (nextError) {
      const connectionError = connectionErrorFor(nextError, 'Pairing failed.');
      setError(connectionError.message);
      setIsServerOffline(connectionError.isOffline);
    } finally {
      setIsPairing(false);
    }
  }

  async function applyLibraryInSections(nextLibrary: LibraryPayload, libraryEtag = '') {
    const sections: Array<keyof LibraryPayload> = ['movies', 'tvShows', 'animeShows'];
    for (const section of sections) {
      await wait(LIBRARY_SECTION_APPLY_DELAY_MS);
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
    setConnection((current) => current
      ? {
        ...current,
        library: nextLibrary,
        libraryEtag,
      }
      : current);

    const nextItems = allItems(nextLibrary);
    for (const item of nextItems) {
      detailItemCacheRef.current.set(item.id, item);
    }
    setDetailItem((current) => current ? nextItems.find((item) => item.id === current.id) || null : null);
    const returnItem = playerReturnItemRef.current;
    if (returnItem && !nextItems.some((item) => item.id === returnItem.id)) {
      playerReturnItemRef.current = null;
    }
  }

  async function refreshLibrary() {
    if (!connection) return;
    setError('');
    setIsServerOffline(false);
    setIsRefreshing(true);
    try {
      const response = await fetch(`${connection.baseUrl}/api/lan/library`, {
        headers: {
          Authorization: `Bearer ${connection.deviceToken}`,
          ...(connection.libraryEtag ? { 'If-None-Match': connection.libraryEtag } : {}),
        },
      });
      if (response.status === 304) return;
      if (!response.ok) throw new Error(`Could not refresh the library (${response.status}).`);
      const nextLibrary = (await response.json()) as LibraryPayload;
      const libraryEtag = response.headers.get('ETag') || '';
      setIsRefreshing(false);
      await applyLibraryInSections(nextLibrary, libraryEtag);
      void hydrateProgress({
        ...connection,
        library: nextLibrary,
        libraryEtag,
      });
      setIsServerOffline(false);
    } catch (nextError) {
      const connectionError = connectionErrorFor(nextError, 'Refresh failed.');
      setError(connectionError.message);
      setIsServerOffline(connectionError.isOffline);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function checkDesktopConnection() {
    if (!connection || connectionHealthCheckRef.current || isRefreshing) return;
    connectionHealthCheckRef.current = true;
    try {
      const response = await fetch(`${connection.baseUrl}/api/lan/library`, {
        headers: {
          Authorization: `Bearer ${connection.deviceToken}`,
          ...(connection.libraryEtag ? { 'If-None-Match': connection.libraryEtag } : {}),
        },
      });
      if (response.status === 401) {
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        setSavedConnection(null);
        setConnection(null);
        setError('This device is no longer authorized. Enter the current 6-digit code to pair again.');
        return;
      }
      if (response.status === 304) {
        setIsServerOffline(false);
        setError('');
        return;
      }
      if (!response.ok) throw new Error(`Desktop sharing is unavailable (${response.status}).`);
      const nextLibrary = (await response.json()) as LibraryPayload;
      await applyLibraryInSections(nextLibrary, response.headers.get('ETag') || '');
      setIsServerOffline(false);
      setError('');
    } catch {
      setIsServerOffline(true);
      setError(`Desktop app offline or sharing is off. ${serverOfflineHint}`);
    } finally {
      connectionHealthCheckRef.current = false;
    }
  }

  async function syncLibraryAfterArtworkChange(itemId: string, appliedCandidate?: OfficialMetadataCandidate): Promise<void> {
    if (!connection) return;
    const libraryResponse = await fetch(`${connection.baseUrl}/api/lan/library`, {
      headers: { Authorization: `Bearer ${connection.deviceToken}` },
    });
    if (!libraryResponse.ok) {
      throw new Error(`Poster updated, but mobile sync failed (${libraryResponse.status}).`);
    }
    const nextLibrary = await readJsonResponse<LibraryPayload>(
      libraryResponse,
      `Poster updated, but mobile sync failed (${libraryResponse.status}).`,
    );
    const libraryEtag = libraryResponse.headers.get('ETag') || '';
    await applyLibraryInSections(nextLibrary, libraryEtag);
    setArtworkCacheBusters((current) => ({ ...current, [itemId]: String(Date.now()) }));
    const refreshedItem = allItems(nextLibrary).find((candidate) => candidate.id === itemId);
    if (refreshedItem) {
      const nextItem = appliedCandidate ? mergeCandidateArtwork(refreshedItem, appliedCandidate) : refreshedItem;
      detailItemCacheRef.current.set(nextItem.id, nextItem);
      setDetailItem(nextItem);
    }
  }

  async function refreshPosterOnHost(item: MediaItem) {
    if (!connection) return;
    setArtworkRefreshError('');
    setRefreshingArtworkId(item.id);
    try {
      const response = await fetch(`${connection.baseUrl}/api/artwork/official-candidates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.deviceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mediaId: item.id }),
      });
      const result = await readJsonResponse<OfficialMetadataCandidate[] | { error?: string }>(
        response,
        `Could not load poster choices (${response.status}).`,
      );
      if (!response.ok || !Array.isArray(result)) {
        const message = Array.isArray(result) ? '' : result.error;
        throw new Error(message || `Could not load poster choices (${response.status}).`);
      }
      setPosterCandidateSheet({ item, candidates: result });
    } catch (nextError) {
      setArtworkRefreshError(nextError instanceof Error ? nextError.message : 'Poster refresh failed.');
    } finally {
      setRefreshingArtworkId('');
    }
  }

  async function applyPosterCandidate(candidate: OfficialMetadataCandidate, candidateKey: string) {
    if (!connection || !posterCandidateSheet) return;
    const itemId = posterCandidateSheet.item.id;
    setArtworkRefreshError('');
    setApplyingPosterCandidateId(candidateKey);
    try {
      const response = await fetch(`${connection.baseUrl}/api/artwork/apply-official`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.deviceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mediaId: itemId, candidate }),
      });
      const result = await readJsonResponse<OfficialArtworkResponse>(
        response,
        `Could not apply poster (${response.status}).`,
      );
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
  const canRetryPairing = isServerOffline && Boolean(baseUrl.trim()) && /^\d{6}$/.test(shareCode);
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
  const showHomeRails = activeKind === 'home' && !query;

  return (
    <View style={styles.app}>
      <StatusBar style="light" />
      {!connection ? (
        <PairingScreen
          baseUrl={baseUrl}
          discoveredHosts={discoveredHosts}
          discoveryError={discoveryError}
          error={error}
          isDiscoveringHosts={isDiscoveringHosts}
          isPairing={isPairing}
          isRestoringConnection={isRestoringConnection}
          isServerOffline={isServerOffline}
          onRefreshDiscovery={() => {
            setDiscoveredHosts([]);
            setDiscoveryScanNonce((current) => current + 1);
          }}
          savedConnection={savedConnection}
          setBaseUrl={setBaseUrl}
          setShareCode={setShareCode}
          shareCode={shareCode}
          onPair={pairWithDesktop}
        />
      ) : (
        <View style={[styles.shell, isTablet && styles.shellTablet]}>
          {isTablet ? (
            <SideNav
              activeKind={activeKind}
              counts={{ anime: grouped.anime.length, tv: grouped.tv.length, movies: grouped.movies.length, others: grouped.others.length }}
              hostName={connection.hostDeviceName}
              isRefreshing={isRefreshing}
              onRefresh={refreshLibrary}
              setActiveKind={navigateToKind}
            />
          ) : null}
          <View style={styles.main}>
            {activeKind === 'settings' ? (
              <ScrollView
                ref={settingsScrollRef}
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={mainContentPadding}
                onScroll={rememberMainScroll}
                refreshControl={libraryRefreshControl}
                scrollEventThrottle={120}
              >
                <SettingsScreen
                  connection={connection}
                  counts={{
                    anime: grouped.anime.length,
                    tv: grouped.tv.length,
                    movies: grouped.movies.length,
                    others: grouped.others.length,
                  }}
                  isTablet={isTablet}
                  isRefreshing={isRefreshing}
                  onDisconnect={() => {
                    void SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
                    setSavedConnection(null);
                    setConnection(null);
                    setBaseUrl('');
                    setShareCode('');
                    setDetailItem(null);
                    setPlayTarget(null);
                    setMiniPlayerTarget(null);
                    playerReturnItemRef.current = null;
                    setPlaybackUrl(null);
                    setStreamOptions({});
                    setSearchOpen(false);
                    setQuery('');
                    setActiveKind('home');
                    setArtworkCacheBusters({});
                    setError('');
                    setIsServerOffline(false);
                  }}
                  onRefresh={refreshLibrary}
                />
              </ScrollView>
            ) : (
              <LibraryList
                artworkCacheBusters={artworkCacheBusters}
                baseUrl={connection.baseUrl}
                contentContainerStyle={mainContentPadding}
                isTablet={isTablet}
                items={showHomeRails ? EMPTY_ITEMS : visibleItems}
                listRef={libraryListRef}
                onScroll={rememberMainScroll}
                showEmpty={!showHomeRails}
                onSelect={openDetailItem}
                refreshControl={libraryRefreshControl}
                header={(
                  <View style={{ gap: 18 }}>
                    <Header
                      activeKind={activeKind}
                      searchOpen={searchOpen}
                      setSearchOpen={setSearchOpen}
                      query={query}
                      setQuery={setQuery}
                    />
                    {error ? (
                      <View style={styles.errorCard}>
                        <Text selectable style={styles.errorText}>{error}</Text>
                        {canRetryPairing ? (
                          <Pressable
                            onPress={() => { void pairWithDesktop(); }}
                            style={({ pressed }) => [styles.reconnectButton, pressed && styles.pressed]}
                            disabled={isPairing}
                          >
                            <Text style={styles.reconnectButtonText}>
                              {isPairing ? 'Reconnecting…' : 'Reconnect'}
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ) : null}
                    {showHomeRails ? (
                      <HomeSections
                        artworkCacheBusters={artworkCacheBusters}
                        baseUrl={connection.baseUrl}
                        continueWatching={continueWatching}
                        grouped={grouped}
                        isTablet={isTablet}
                        onOpenKind={navigateToKind}
                        onSelect={openDetailItem}
                      />
                    ) : null}
                  </View>
                )}
              />
            )}
            {!isTablet && !searchOpen ? (
              <BottomNav
                activeKind={activeKind}
                setActiveKind={navigateToKind}
              />
            ) : null}
          </View>
        </View>
      )}

      <DetailModal
        activeKind={activeKind}
        artworkCacheBusters={artworkCacheBusters}
        baseUrl={connection?.baseUrl || ''}
        hasMiniPlayer={Boolean(miniPlayerTarget)}
        isTablet={isTablet}
        item={detailItem}
        progress={progress}
        artworkRefreshError={artworkRefreshError}
        isRefreshingArtwork={Boolean(detailItem && refreshingArtworkId === detailItem.id)}
        onClose={() => setDetailItem(null)}
        onOpenKind={navigateToKind}
        onPlay={(target) => {
          void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
          playerReturnItemRef.current = detailItem;
          setMiniPlayerTarget(null);
          setStreamOptions({});
          setPlayTarget(target);
        }}
        onRefreshArtwork={refreshPosterOnHost}
      />
      <PosterCandidateSheet
        applyingCandidateId={applyingPosterCandidateId}
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
      <MiniPlayerStrip
        baseUrl={connection?.baseUrl || ''}
        cacheBust={miniPlayerTarget?.mediaId ? artworkCacheBusters[miniPlayerTarget.mediaId] : undefined}
        target={miniPlayerTarget}
        bottomOffset={isTablet || searchOpen ? Math.max(insets.bottom, 12) : Math.max(insets.bottom, 10) + 70}
        onDismiss={() => setMiniPlayerTarget(null)}
        onOpen={() => {
          if (!miniPlayerTarget) return;
          void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
          playerReturnItemRef.current = detailItem;
          setStreamOptions({});
          setPlayTarget(miniPlayerTarget);
          setMiniPlayerTarget(null);
          setDetailItem(null);
        }}
      />
      <PlayerModal
        baseUrl={connection?.baseUrl || ''}
        deviceToken={connection?.deviceToken || ''}
        isPreparing={isPreparingStream}
        target={playTarget}
        error={playbackError}
        playbackUrl={playbackUrl}
        player={player}
        streamOptions={streamOptions}
        onClose={closePlayer}
        onStreamOptionsChange={setStreamOptions}
      />
    </View>
  );
}

function PairingScreen({
  baseUrl,
  discoveredHosts,
  discoveryError,
  error,
  isDiscoveringHosts,
  isPairing,
  isRestoringConnection,
  isServerOffline,
  onRefreshDiscovery,
  savedConnection,
  setBaseUrl,
  setShareCode,
  shareCode,
  onPair,
}: {
  baseUrl: string;
  discoveredHosts: DiscoveredHost[];
  discoveryError: string;
  error: string;
  isDiscoveringHosts: boolean;
  isPairing: boolean;
  isRestoringConnection: boolean;
  isServerOffline: boolean;
  onRefreshDiscovery: () => void;
  savedConnection: SavedConnection | null;
  setBaseUrl: (value: string) => void;
  setShareCode: (value: string) => void;
  shareCode: string;
  onPair: (host?: DiscoveredHost) => void;
}) {
  const canPair = Boolean(baseUrl.trim()) && /^\d{6}$/.test(shareCode);
  const [showManual, setShowManual] = useState(false);
  // Without a saved desktop, manual entry is the always-visible fallback under
  // the device list; with one, it stays behind a single link.
  const manualVisible = !savedConnection || showManual;
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSubscription = Keyboard.addListener(showEvent, () => setIsKeyboardVisible(true));
    const hideSubscription = Keyboard.addListener(hideEvent, () => setIsKeyboardVisible(false));
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.pairingAvoider}>
      <ScrollView
        alwaysBounceVertical={false}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios' && isKeyboardVisible}
        bounces={isKeyboardVisible}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={[styles.pairingContent, isKeyboardVisible && styles.pairingContentKeyboard]}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={isKeyboardVisible}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pairingHero}>
          <LoomLogo width={118} height={33} accent={accent} wordColor={text} />
          <Text selectable style={styles.pairingSubtitle}>
            {savedConnection ? savedConnection.hostDeviceName : 'Pick your desktop to start watching.'}
          </Text>
        </View>
        <View style={styles.formBlock}>
          {savedConnection && !showManual ? (
            <View style={styles.savedHostCard}>
              <View style={styles.hostStatusRow}>
                <View style={[styles.hostStatusDot, (isRestoringConnection || !isServerOffline) && styles.hostStatusDotSearching]} />
                <Text style={styles.savedHostStatus}>
                  {isRestoringConnection ? 'Reconnecting…' : 'Desktop is offline'}
                </Text>
              </View>
              <Text selectable style={styles.hostName}>{savedConnection.hostDeviceName}</Text>
              <Text selectable style={styles.hostAddress}>{savedConnection.baseUrl}</Text>
            </View>
          ) : null}

          {!savedConnection ? (
            <View style={styles.discoveryBlock}>
              <View style={styles.discoveryHeading}>
                <Text style={styles.discoveryTitle}>Devices</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Refresh devices"
                  disabled={isDiscoveringHosts}
                  onPress={onRefreshDiscovery}
                  style={({ pressed }) => [styles.refreshDiscoveryButton, pressed && styles.pressed]}
                >
                  {isDiscoveringHosts ? <ActivityIndicator size="small" color={accent} /> : <RefreshIcon size={17} color={accent} />}
                </Pressable>
              </View>
              {discoveredHosts.map((host) => (
                  <Pressable
                    key={host.deviceId}
                    disabled={isPairing}
                    onPress={() => {
                      setBaseUrl(host.baseUrl);
                      void onPair(host);
                    }}
                    style={({ pressed }) => [styles.hostCard, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`Connect to ${host.deviceName}`}
                  >
                    <View style={styles.hostCardCopy}>
                      <Text selectable numberOfLines={1} style={styles.hostName}>{host.deviceName}</Text>
                      <Text selectable numberOfLines={1} style={styles.hostAddress}>{host.baseUrl}</Text>
                    </View>
                    <Text style={styles.hostConnectLabel}>{isPairing ? 'Connecting…' : 'Connect'}</Text>
                  </Pressable>
              ))}
              {!discoveredHosts.length ? (
                <View style={styles.emptyDiscoveryCard}>
                  {isDiscoveringHosts ? (
                    <ActivityIndicator size="small" color={accent} />
                  ) : (
                    <>
                      <Text style={styles.emptyDiscoveryTitle}>No desktops found</Text>
                      <Text style={styles.emptyDiscoveryCopy}>
                        {discoveryError
                          ? 'Enter the address below.'
                          : 'Turn on Local Network Sharing in the desktop app.'}
                      </Text>
                    </>
                  )}
                </View>
              ) : null}
            </View>
          ) : null}

          {manualVisible ? (
            <View style={styles.manualForm}>
              {!savedConnection ? (
                <View style={styles.manualDivider}>
                  <View style={styles.manualDividerLine} />
                  <Text style={styles.manualDividerText}>or connect manually</Text>
                  <View style={styles.manualDividerLine} />
                </View>
              ) : null}
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={setBaseUrl}
                onSubmitEditing={canPair ? () => onPair() : undefined}
                placeholder="192.168.1.25:3847"
                placeholderTextColor={faint}
                returnKeyType="next"
                style={styles.input}
                value={baseUrl}
              />
              <TextInput
                accessibilityLabel="6-digit sharing code"
                keyboardType="number-pad"
                maxLength={6}
                onChangeText={(value) => setShareCode(value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit code"
                placeholderTextColor={faint}
                style={[styles.input, styles.codeInput]}
                value={shareCode}
              />
            </View>
          ) : null}
          {error ? (
            <View style={styles.errorCard}>
              <Text selectable style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
          {manualVisible ? (
            <PressableScale
              scaleTo={0.97}
              style={[styles.primaryButton, (!canPair || isPairing) && styles.disabledButton]}
              onPress={() => onPair()}
              disabled={!canPair || isPairing}
              accessibilityRole="button"
              accessibilityLabel="Connect"
            >
              {isPairing ? <ActivityIndicator color={accentForeground} /> : <Text style={styles.primaryButtonText}>Connect</Text>}
            </PressableScale>
          ) : null}
          {manualVisible ? (
            <Text selectable style={styles.manualHint}>
              Address and code: desktop app → Settings → Network
            </Text>
          ) : null}
          {savedConnection ? (
            <Pressable
              onPress={() => {
                if (showManual) Keyboard.dismiss();
                setShowManual((current) => !current);
              }}
              style={styles.helpToggle}
            >
              <Text style={styles.helpToggleText}>{showManual ? 'Cancel' : 'Connect manually'}</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Header({
  activeKind,
  query,
  searchOpen,
  setQuery,
  setSearchOpen,
}: {
  activeKind: LibraryKind;
  query: string;
  searchOpen: boolean;
  setQuery: (value: string) => void;
  setSearchOpen: (value: boolean) => void;
}) {
  if (searchOpen) {
    return (
      <View style={styles.header}>
        <View style={styles.searchBox}>
          <SearchIcon size={20} color={muted} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onChangeText={setQuery}
            placeholder={`Search ${sectionTitle(activeKind).toLowerCase()}`}
            placeholderTextColor={faint}
            style={styles.searchInput}
            value={query}
          />
          <Pressable
            onPress={() => {
              setSearchOpen(false);
              setQuery('');
            }}
            accessibilityRole="button"
            accessibilityLabel="Close search"
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <CloseIcon size={20} color={muted} />
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.header, styles.topBarRow]}>
      <View style={styles.brandRow}>
        <LoomLogo width={86} height={24} accent={accent} wordColor={text} />
      </View>
      <Pressable
        onPress={() => setSearchOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Search"
        style={({ pressed }) => [styles.topBarIconButton, pressed && styles.pressed]}
      >
        <SearchIcon size={23} color={text} />
      </Pressable>
    </View>
  );
}

function SideNav({
  activeKind,
  counts,
  hostName,
  isRefreshing,
  onRefresh,
  setActiveKind,
}: {
  activeKind: LibraryKind;
  counts: Record<'anime' | 'tv' | 'movies' | 'others', number>;
  hostName: string;
  isRefreshing: boolean;
  onRefresh: () => void;
  setActiveKind: (kind: LibraryKind) => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.sideNav, { paddingTop: insets.top + 18 }]}>
      <View style={styles.brandRow}>
        <LoomLogo width={86} height={24} accent={accent} wordColor={text} />
      </View>
      <Text selectable style={styles.sideHost}>{hostName}</Text>
      <View style={styles.sideNavItems}>
        {navItems.map((item) => {
          const isActive = activeKind === item.id;
          const Icon = item.Icon;
          return (
            <Pressable
              key={item.id}
              style={({ pressed }) => [styles.sideNavButton, isActive && styles.sideNavButtonActive, pressed && styles.pressed]}
              onPress={() => setActiveKind(item.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <View style={styles.navGlyph}>
                <Icon size={20} color={isActive ? accent : muted} />
              </View>
              <Text style={[styles.sideNavLabel, isActive && styles.sideNavLabelActive]}>{item.label}</Text>
              {item.id !== 'home' && item.id !== 'settings' ? <Text style={styles.sideNavCount}>{counts[item.id]}</Text> : null}
            </Pressable>
          );
        })}
      </View>
      <Pressable style={styles.refreshButton} onPress={onRefresh} disabled={isRefreshing}>
        <Text style={styles.refreshButtonText}>{isRefreshing ? 'Refreshing...' : 'Refresh library'}</Text>
      </Pressable>
    </View>
  );
}

function BottomNavItem({
  item,
  isActive,
  onPress,
}: {
  item: { id: LibraryKind; label: string; Icon: (props: IconProps) => ReactElement };
  isActive: boolean;
  onPress: () => void;
}) {
  const active = useRef(new Animated.Value(isActive ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(active, {
      toValue: isActive ? 1 : 0,
      useNativeDriver: true,
      speed: 18,
      bounciness: 9,
    }).start();
  }, [active, isActive]);
  const iconScale = active.interpolate({ inputRange: [0, 1], outputRange: [1, 1.14] });
  const Icon = item.Icon;
  return (
    <Pressable
      style={styles.bottomNavButton}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={item.label}
    >
      <Animated.View style={[styles.bottomNavIconWrap, { transform: [{ scale: iconScale }] }]}>
        <Icon size={24} color={isActive ? accent : faint} />
      </Animated.View>
      <Text style={[styles.bottomNavLabel, isActive && styles.bottomNavLabelActive]} numberOfLines={1}>{item.label}</Text>
    </Pressable>
  );
}

function BottomNav({ activeKind, setActiveKind }: { activeKind: LibraryKind; setActiveKind: (kind: LibraryKind) => void }) {
  const insets = useSafeAreaInsets();
  const items = (
    <View style={styles.bottomNavRow}>
      {navItems.map((item) => (
        <BottomNavItem
          key={item.id}
          item={item}
          isActive={activeKind === item.id}
          onPress={() => setActiveKind(item.id)}
        />
      ))}
    </View>
  );

  // iOS gets the translucent "glass" tab bar; Android stays opaque above the
  // system navigation area.
  if (Platform.OS === 'ios') {
    return (
      <BlurView
        intensity={70}
        tint="systemChromeMaterialDark"
        style={[styles.bottomNav, styles.bottomNavBlur, { paddingBottom: Math.max(insets.bottom, 10) }]}
      >
        {items}
      </BlurView>
    );
  }

  return (
    <View style={[styles.bottomNav, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      {items}
    </View>
  );
}

function MiniPlayerStrip({
  baseUrl,
  bottomOffset,
  cacheBust,
  onDismiss,
  onOpen,
  target,
}: {
  baseUrl: string;
  bottomOffset: number;
  cacheBust?: string;
  onDismiss: () => void;
  onOpen: () => void;
  target: PlayTarget | null;
}) {
  if (!target) return null;
  const thumbnailSources = imageUrlsFor(baseUrl, [
    target.thumbnail,
    ...(target.thumbnailCandidates || []),
  ], cacheBust);
  const progressLabel = target.startPosition && target.startPosition > 0
    ? `Paused at ${formatClock(target.startPosition)}`
    : 'Paused';
  const content = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Resume ${target.title}`}
        onPress={onOpen}
        style={({ pressed }) => [styles.miniPlayerMain, pressed && styles.pressed]}
      >
        <View style={styles.miniPlayerThumb}>
          <FallbackImage
            sources={thumbnailSources}
            style={styles.miniPlayerThumbImage}
            resizeMode="cover"
            altFallback={(
              <View style={styles.miniPlayerThumbFallback}>
                <PlayIcon size={18} color={accentForeground} />
              </View>
            )}
          />
          <View style={styles.miniPlayerThumbBadge}>
            <PlayIcon size={10} color={accentForeground} />
          </View>
        </View>
        <View style={styles.miniPlayerText}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.miniPlayerTitle}>{target.title}</Text>
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.miniPlayerMeta}>
            {[target.subtitle, progressLabel].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss paused video"
        hitSlop={10}
        onPress={onDismiss}
        style={({ pressed }) => [styles.miniPlayerDismiss, pressed && styles.pressed]}
      >
        <CloseIcon size={18} color={muted} />
      </Pressable>
    </>
  );

  return (
    <View style={[styles.miniPlayerWrap, { bottom: bottomOffset }]}>
      {Platform.OS === 'ios' ? (
        <BlurView intensity={46} tint="systemChromeMaterialDark" style={[styles.miniPlayerStrip, styles.miniPlayerBlur]}>
          {content}
        </BlurView>
      ) : (
        <View style={styles.miniPlayerStrip}>{content}</View>
      )}
    </View>
  );
}

function DetailModal({
  activeKind,
  artworkCacheBusters,
  artworkRefreshError,
  baseUrl,
  hasMiniPlayer,
  isRefreshingArtwork,
  isTablet,
  item,
  progress,
  onClose,
  onOpenKind,
  onPlay,
  onRefreshArtwork,
}: {
  activeKind: LibraryKind;
  artworkCacheBusters: Record<string, string>;
  artworkRefreshError: string;
  baseUrl: string;
  hasMiniPlayer: boolean;
  isRefreshingArtwork: boolean;
  isTablet: boolean;
  item: MediaItem | null;
  progress: Record<string, StoredProgress>;
  onClose: () => void;
  onOpenKind: (kind: LibraryKind) => void;
  onPlay: (target: PlayTarget) => void;
  onRefreshArtwork: (item: MediaItem) => void;
}) {
  if (!item) return null;
  // Keyed so per-show state (selected season) resets when a different title opens.
  return (
    <DetailContent
      key={item.id}
      activeKind={activeKind}
      artworkCacheBusters={artworkCacheBusters}
      artworkRefreshError={artworkRefreshError}
      baseUrl={baseUrl}
      hasMiniPlayer={hasMiniPlayer}
      isRefreshingArtwork={isRefreshingArtwork}
      isTablet={isTablet}
      item={item}
      progress={progress}
      onClose={onClose}
      onOpenKind={onOpenKind}
      onPlay={onPlay}
      onRefreshArtwork={onRefreshArtwork}
    />
  );
}

const HeroGradient = memo(function HeroGradient() {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <SvgLinearGradient id="heroFade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0.3" stopColor={bg} stopOpacity={0} />
          <Stop offset="0.82" stopColor={bg} stopOpacity={0.85} />
          <Stop offset="1" stopColor={bg} stopOpacity={1} />
        </SvgLinearGradient>
      </Defs>
      <SvgRect x="0" y="0" width="100%" height="100%" fill="url(#heroFade)" />
    </Svg>
  );
});

function DetailContent({
  activeKind,
  artworkCacheBusters,
  artworkRefreshError,
  baseUrl,
  hasMiniPlayer,
  isRefreshingArtwork,
  isTablet,
  item,
  progress,
  onClose,
  onOpenKind,
  onPlay,
  onRefreshArtwork,
}: {
  activeKind: LibraryKind;
  artworkCacheBusters: Record<string, string>;
  artworkRefreshError: string;
  baseUrl: string;
  hasMiniPlayer: boolean;
  isRefreshingArtwork: boolean;
  isTablet: boolean;
  item: MediaItem;
  progress: Record<string, StoredProgress>;
  onClose: () => void;
  onOpenKind: (kind: LibraryKind) => void;
  onPlay: (target: PlayTarget) => void;
  onRefreshArtwork: (item: MediaItem) => void;
}) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const entrance = useEntrance(16);
  const episodes = useMemo(() => sortedEpisodes(item), [item]);
  const cacheBust = artworkCacheBusters[item.id];
  const heroSources = useMemo(() => {
    const episodeArtwork = episodes.flatMap((episode) => [episode.still, episode.thumbnail]);
    return imageUrlsFor(baseUrl, [
      item.poster,
      ...(item.posterCandidates || []),
      item.backdrop,
      ...(item.backdropCandidates || []),
      ...episodeArtwork,
    ], cacheBust);
  }, [baseUrl, cacheBust, episodes, item.backdrop, item.backdropCandidates, item.poster, item.posterCandidates]);
  const isSeries = item.type !== 'movie' && episodes.length > 0;
  const seasonNumbers = Array.from(new Set(episodes.map((ep) => ep.season))).sort((a, b) => a - b);
  const [selectedSeason, setSelectedSeason] = useState(seasonNumbers[0] ?? 1);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const seasonEpisodes = episodes.filter((ep) => ep.season === selectedSeason);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  // Plex-style "on deck": first unwatched episode; resume it if in progress.
  const nextUp = useMemo(() => {
    for (const ep of episodes) {
      const state = progressStateFor(progress, ep.filePath, ep.localMetadata?.durationSeconds);
      if (!state.watched) return { ep, inProgress: state.inProgress };
    }
    return episodes.length > 0 ? { ep: episodes[0], inProgress: false } : null;
  }, [episodes, progress]);
  const movieState = progressStateFor(progress, streamPathFor(item), item.localMetadata?.durationSeconds);

  const watchLabel = isSeries && nextUp
    ? `${nextUp.inProgress ? 'Resume' : 'Watch'} ${episodeCode(nextUp.ep.season, nextUp.ep.episode)}`
    : movieState.inProgress
      ? 'Resume'
      : 'Watch Now';
  const onPressPlay = () => {
    if (isSeries && nextUp) {
      onPlay(episodePlayTarget(item, nextUp.ep, progress));
    } else {
      onPlay({
        title: item.title,
        subtitle: item.year ? String(item.year) : undefined,
        streamPath: streamPathFor(item),
        transcode: shouldTranscode(item),
        localMetadata: item.localMetadata,
        subtitles: item.subtitles,
        startPosition: movieState.inProgress ? movieState.position : 0,
        mediaId: item.id,
        thumbnail: item.poster || item.backdrop,
        thumbnailCandidates: [
          item.poster,
          ...(item.posterCandidates || []),
          item.backdrop,
          ...(item.backdropCandidates || []),
        ].filter(Boolean) as string[],
      });
    }
  };

  const metaLine = [
    item.year ? String(item.year) : null,
    item.type === 'movie'
      ? (item.localMetadata?.durationSeconds ? formatDuration(item.localMetadata.durationSeconds) : null)
      : `${episodes.length || '–'} episodes`,
    item.genres?.slice(0, 2).join(', ') || null,
  ].filter(Boolean).join('   ');
  const detailBottomPadding = 48
    + (!isTablet ? Math.max(insets.bottom, 10) + 70 : 0)
    + (hasMiniPlayer ? 82 : 0);

  return (
    <Animated.View style={[styles.overlay, entrance]}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={[styles.detailScroll, { paddingBottom: detailBottomPadding }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.detailHero, { height: Math.round(windowHeight * 0.58) }]}>
          <FallbackImage
            sources={heroSources}
            style={styles.detailBackdrop}
            resizeMode="cover"
            altFallback={(
              <View style={[styles.detailBackdrop, styles.posterFallback]}>
                <PlayMark size={44} color={accent} />
              </View>
            )}
          />
          <HeroGradient />
        </View>

        <View style={styles.detailBody}>
          <Text selectable numberOfLines={2} style={styles.detailTitle}>{item.title}</Text>
          {metaLine ? <Text selectable style={styles.detailMeta}>{metaLine}</Text> : null}
          {item.rating && item.rating > 0 ? (
            <View style={styles.detailRatingRow}>
              <StarIcon size={15} color="#f5c451" />
              <Text style={styles.detailRatingText}>{item.rating.toFixed(1)}</Text>
            </View>
          ) : null}

          <PressableScale
            scaleTo={0.97}
            style={styles.playButton}
            onPress={onPressPlay}
            accessibilityRole="button"
            accessibilityLabel={`${watchLabel} ${item.title}`}
          >
              <PlayIcon size={22} color={accentForeground} />
            <Text style={styles.playButtonText}>{watchLabel}</Text>
          </PressableScale>
          {artworkRefreshError ? <Text selectable style={styles.detailErrorText}>{artworkRefreshError}</Text> : null}

          {item.summary ? (
            <View style={styles.detailSummaryBlock}>
              <Text selectable numberOfLines={summaryExpanded ? undefined : 3} style={styles.detailSummary}>
                {item.summary}
              </Text>
              <Pressable
                onPress={() => setSummaryExpanded((current) => !current)}
                accessibilityRole="button"
                accessibilityLabel={summaryExpanded ? 'Show less summary' : 'Show more summary'}
                style={({ pressed }) => [styles.detailSummaryToggle, pressed && styles.pressed]}
              >
                <Text style={styles.detailSummaryToggleText}>
                  {summaryExpanded ? 'Show less' : 'Show more'}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {isSeries ? (
            <View style={styles.episodesSection}>
              {seasonNumbers.length > 1 ? (
                <>
                  <Text style={styles.episodesHeading}>
                    {seasonNumbers.length} Seasons
                  </Text>
                  <FlatList
                    contentContainerStyle={styles.seasonRailContent}
                    data={seasonNumbers}
                    horizontal
                    keyExtractor={(season) => String(season)}
                    renderItem={({ item: season }) => {
                      const first = episodes.find((ep) => ep.season === season);
                      const artSources = imageUrlsFor(baseUrl, [first?.still, first?.thumbnail], cacheBust);
                      const count = episodes.filter((ep) => ep.season === season).length;
                      const isActive = season === selectedSeason;
                      return (
                        <PressableScale
                          onPress={() => setSelectedSeason(season)}
                          scaleTo={0.95}
                          style={styles.seasonCard}
                          accessibilityRole="button"
                          accessibilityState={{ selected: isActive }}
                        >
                          <View style={[styles.seasonCardFrame, isActive && styles.seasonCardFrameActive]}>
                            <FallbackImage
                              sources={artSources}
                              style={styles.seasonCardImage}
                              altFallback={(
                                <View style={styles.seasonCardFallback}>
                                  <Text style={styles.seasonCardFallbackText}>{season}</Text>
                                </View>
                              )}
                            />
                          </View>
                          <Text style={[styles.seasonCardTitle, isActive && styles.seasonCardTitleActive]}>Season {season}</Text>
                          <Text style={styles.seasonCardMeta}>{count} {count === 1 ? 'episode' : 'episodes'}</Text>
                        </PressableScale>
                      );
                    }}
                    showsHorizontalScrollIndicator={false}
                    getItemLayout={(_data, index) => ({ length: 148, offset: (148 + 12) * index, index })}
                    removeClippedSubviews
                  />
                  <Text style={styles.episodesSubheading}>Season {selectedSeason}</Text>
                </>
              ) : (
                <Text style={styles.episodesHeading}>Episodes</Text>
              )}
              <View style={styles.episodeList}>
                {seasonEpisodes.map((ep) => (
                  <EpisodeRow
                    key={`${ep.season}-${ep.episode}`}
                    baseUrl={baseUrl}
                    cacheBust={cacheBust}
                    episode={ep}
                    fallbackSources={[
                      item.backdrop,
                      ...(item.backdropCandidates || []),
                      item.poster,
                      ...(item.posterCandidates || []),
                    ]}
                    progress={progressStateFor(progress, ep.filePath, ep.localMetadata?.durationSeconds)}
                    onPress={() => onPlay(episodePlayTarget(item, ep, progress))}
                  />
                ))}
              </View>
            </View>
          ) : item.type !== 'movie' ? (
            <View style={styles.episodesSection}>
              <Text style={styles.episodesHeading}>Episodes</Text>
              <View style={styles.emptyEpisodesCard}>
                <Text style={styles.emptyEpisodesTitle}>No episodes found</Text>
                <Text style={styles.emptyEpisodesCopy}>Refresh the paired desktop library or rescan this show folder.</Text>
              </View>
            </View>
          ) : null}
        </View>
      </ScrollView>
      <Pressable
        style={({ pressed }) => [styles.detailBack, { top: insets.top + 8 }, pressed && styles.pressed]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <BackIcon size={24} color={text} />
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.detailRefreshPosterButton,
          { top: insets.top + 10 },
          isRefreshingArtwork && styles.disabledButton,
          pressed && styles.pressed,
        ]}
        onPress={() => onRefreshArtwork(item)}
        disabled={isRefreshingArtwork}
        accessibilityRole="button"
        accessibilityLabel={`Refresh poster for ${item.title}`}
      >
        {isRefreshingArtwork ? (
          <ActivityIndicator color={accent} size="small" />
        ) : (
          <RefreshIcon size={20} color="#ffffff" />
        )}
      </Pressable>
      {!isTablet ? (
        <BottomNav activeKind={activeKind} setActiveKind={onOpenKind} />
      ) : null}
    </Animated.View>
  );
}

function PosterCandidateSheet({
  applyingCandidateId,
  baseUrl,
  candidates,
  error,
  item,
  onApply,
  onClose,
}: {
  applyingCandidateId: string;
  baseUrl: string;
  candidates: OfficialMetadataCandidate[];
  error: string;
  item: MediaItem | null;
  onApply: (candidate: OfficialMetadataCandidate, candidateKey: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const entrance = useEntrance(22);
  if (!item) return null;

  return (
    <View style={styles.posterSheetOverlay}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close poster choices" />
      <Animated.View style={[styles.posterSheet, { paddingBottom: Math.max(insets.bottom, 14) + 8 }, entrance]}>
        <View style={styles.posterSheetHandle} />
        <View style={styles.posterSheetHeader}>
          <View style={styles.posterSheetTitleBlock}>
            <Text style={styles.posterSheetEyebrow}>Refresh poster</Text>
            <Text numberOfLines={2} style={styles.posterSheetTitle}>{item.title}</Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.posterSheetClose, pressed && styles.pressed]}
            onPress={onClose}
            disabled={Boolean(applyingCandidateId)}
            accessibilityRole="button"
            accessibilityLabel="Close poster choices"
          >
            <CloseIcon size={20} color={text} />
          </Pressable>
        </View>
        {error ? <Text selectable style={styles.posterSheetError}>{error}</Text> : null}
        <ScrollView
          contentContainerStyle={styles.posterCandidateList}
          showsVerticalScrollIndicator={false}
        >
          {candidates.length === 0 ? (
            <View style={styles.posterCandidateEmpty}>
              <Text style={styles.posterCandidateEmptyTitle}>No matches found</Text>
              <Text style={styles.posterCandidateEmptyCopy}>The desktop metadata search did not return poster choices for this title.</Text>
            </View>
          ) : candidates.map((candidate, index) => {
            const candidateKey = metadataCandidateKey(candidate, index);
            const posterSources = imageUrlsFor(baseUrl, [
              candidate.thumbnail,
              candidate.posterCandidates?.[0],
              candidate.cover,
              candidate.backdropCandidates?.[0],
            ]);
            const title = candidate.title?.trim() || item.title;
            const episodeTotal = candidate.episodeCount || candidate.episodePreview?.length || 0;
            const metaLine = [
              candidate.genres?.slice(0, 2).join(' • ') || null,
              episodeTotal ? `${episodeTotal} episodes` : null,
            ].filter(Boolean).join('   ·   ');
            const isApplying = applyingCandidateId === candidateKey;
            return (
              <View key={candidateKey} style={styles.posterCandidateCard}>
                <View style={styles.posterCandidateTop}>
                  <FallbackImage
                    sources={posterSources}
                    style={styles.posterCandidateImage}
                    resizeMode="cover"
                    altFallback={(
                      <View style={[styles.posterCandidateImage, styles.posterFallback]}>
                        <PlayMark size={26} color={accent} />
                      </View>
                    )}
                  />
                  <View style={styles.posterCandidateInfo}>
                    <Text numberOfLines={2} style={styles.posterCandidateTitle}>{title}</Text>
                    <View style={styles.posterCandidateDetails}>
                      {candidate.year ? <Text style={styles.posterCandidateYear}>{candidate.year}</Text> : null}
                      {candidate.source ? <Text style={styles.posterCandidateSource}>{candidate.source}</Text> : null}
                      {candidate.rating ? (
                        <View style={styles.posterCandidateRating}>
                          <StarIcon size={12} color="#f5c451" />
                          <Text style={styles.posterCandidateRatingText}>{candidate.rating.toFixed(1)}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text numberOfLines={3} style={styles.posterCandidateSummary}>
                      {candidate.summary?.trim() || 'No summary provided.'}
                    </Text>
                  </View>
                </View>
                <View style={styles.posterCandidateFooter}>
                  {metaLine ? (
                    <Text numberOfLines={1} style={styles.posterCandidateGenres}>{metaLine}</Text>
                  ) : <View style={styles.posterCandidateFooterSpacer} />}
                  <Pressable
                    style={({ pressed }) => [
                      styles.posterCandidateApply,
                      (isApplying || Boolean(applyingCandidateId)) && styles.disabledButton,
                      pressed && styles.pressed,
                    ]}
                    onPress={() => onApply(candidate, candidateKey)}
                    disabled={Boolean(applyingCandidateId)}
                    accessibilityRole="button"
                    accessibilityLabel={`Apply poster from ${candidate.source || 'metadata result'} for ${title}`}
                  >
                    {isApplying ? <ActivityIndicator color={accentForeground} size="small" /> : <CheckIcon size={17} color={accentForeground} />}
                    <Text style={styles.posterCandidateApplyText}>{isApplying ? 'Applying' : 'Apply'}</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function EpisodeRow({
  baseUrl,
  cacheBust,
  episode,
  fallbackSources,
  progress,
  onPress,
}: {
  baseUrl: string;
  cacheBust?: string;
  episode: EpisodeFile;
  fallbackSources: Array<string | undefined>;
  progress: ReturnType<typeof progressStateFor>;
  onPress: () => void;
}) {
  const thumbnailSources = useMemo(
    () => imageUrlsFor(baseUrl, [
      episode.thumbnail,
      episode.still,
      ...fallbackSources,
    ], cacheBust),
    [baseUrl, cacheBust, episode.still, episode.thumbnail, fallbackSources],
  );
  const progressWidth = `${Math.max(6, Math.round(progress.fraction * 100))}%` as `${number}%`;
  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.98}
      style={[styles.episodeRow, progress.watched && styles.episodeRowWatched]}
      accessibilityRole="button"
      accessibilityLabel={`Play ${episodeCode(episode.season, episode.episode)} ${episode.title || ''}`}
    >
      <View style={styles.episodeThumb}>
        <FallbackImage
          sources={thumbnailSources}
          style={styles.episodeThumbImage}
          altFallback={(
            <View style={styles.episodeThumbFallback}>
              <Text style={styles.episodeIndexText}>{episode.episode}</Text>
            </View>
          )}
        />
        {progress.watched ? (
          <View style={styles.watchedBadge}>
            <CheckIcon size={12} color="#06130a" />
          </View>
        ) : null}
        {progress.inProgress ? (
          <View style={styles.episodeProgressTrack}>
            <View style={[styles.episodeProgressFill, { width: progressWidth }]} />
          </View>
        ) : null}
      </View>
      <View style={styles.episodeInfo}>
        <View style={styles.episodeTitleRow}>
          <Text numberOfLines={1} style={[styles.episodeTitle, progress.watched && styles.episodeTitleWatched]}>
            {episode.title || `Episode ${episode.episode}`}
          </Text>
          {progress.inProgress ? <Text style={styles.resumePill}>Resume</Text> : null}
        </View>
        <Text style={styles.episodeMeta}>
          {[episodeCode(episode.season, episode.episode), episode.localMetadata?.durationSeconds ? formatDuration(episode.localMetadata.durationSeconds) : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      <PlayIcon size={18} color={progress.watched ? faint : muted} />
    </PressableScale>
  );
}

function PlayerModal({
  baseUrl,
  deviceToken,
  error,
  isPreparing,
  target,
  onClose,
  onStreamOptionsChange,
  playbackUrl,
  player,
  streamOptions,
}: {
  baseUrl: string;
  deviceToken: string;
  error: string;
  isPreparing: boolean;
  target: PlayTarget | null;
  onClose: () => void;
  onStreamOptionsChange: (options: StreamOptions) => void;
  playbackUrl: string | null;
  player: ReturnType<typeof useVideoPlayer>;
  streamOptions: StreamOptions;
}) {
  if (!target) return null;
  // Keyed so playback position/controls state resets per title.
  return (
    <PlayerContent
      key={target.streamPath}
      baseUrl={baseUrl}
      deviceToken={deviceToken}
      error={error}
      isPreparing={isPreparing}
      target={target}
      onClose={onClose}
      onStreamOptionsChange={onStreamOptionsChange}
      playbackUrl={playbackUrl}
      player={player}
      streamOptions={streamOptions}
    />
  );
}

function PlayerSkipButton({
  amount,
  direction,
  iconSize = 38,
  onPress,
  style,
}: {
  amount: number;
  direction: 'back' | 'forward';
  iconSize?: number;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const Icon = direction === 'back' ? SkipBackIcon : SkipForwardIcon;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.playerSkipButton, style, pressed && styles.playerControlPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${direction === 'back' ? 'Back' : 'Forward'} ${amount} seconds`}
    >
      <Icon size={iconSize} color={text} />
      <Text style={styles.playerSkipLabel}>{amount}</Text>
    </Pressable>
  );
}

function PlayerMenuRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.playerMenuRow, pressed && styles.pressed]}
      accessibilityRole="menuitem"
      accessibilityState={{ selected }}
    >
      <Text numberOfLines={2} style={[styles.playerMenuRowText, selected && styles.playerMenuRowTextActive]}>{label}</Text>
      {selected ? <CheckIcon size={16} color={accent} /> : null}
    </Pressable>
  );
}

function PlayerContent({
  baseUrl,
  deviceToken,
  error,
  isPreparing,
  target,
  onClose,
  onStreamOptionsChange,
  playbackUrl,
  player,
  streamOptions,
}: {
  baseUrl: string;
  deviceToken: string;
  error: string;
  isPreparing: boolean;
  target: PlayTarget;
  onClose: () => void;
  onStreamOptionsChange: (options: StreamOptions) => void;
  playbackUrl: string | null;
  player: ReturnType<typeof useVideoPlayer>;
  streamOptions: StreamOptions;
}) {
  const insets = useSafeAreaInsets();
  const { width: playerWidth } = useWindowDimensions();
  const [controlsVisible, setControlsVisible] = useState(true);
  const entrance = useEntrance();
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const [isPlaying, setIsPlaying] = useState(() => Boolean(player.playing));
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [trackWidth, setTrackWidth] = useState(0);
  const [interactionTick, setInteractionTick] = useState(0);
  const [menu, setMenu] = useState<'none' | 'speed' | 'audio' | 'subtitles'>('none');
  const [playbackRate, setPlaybackRate] = useState(1);
  const [nativeAudioTracks, setNativeAudioTracks] = useState<AudioTrack[]>([]);
  const [nativeSubtitleTracks, setNativeSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [activeAudioKey, setActiveAudioKey] = useState('');
  const [activeSubtitleKey, setActiveSubtitleKey] = useState('off');
  const [trackPreferences, setTrackPreferences] = useState<PlaybackTrackPreferences>({});
  const [gestureLevel, setGestureLevel] = useState<{ kind: PlayerVerticalGesture; value: number } | null>(null);
  const preferenceScope = useMemo(() => playbackPreferenceScope(target), [target.mediaId, target.streamPath]);
  const appliedPreferenceKeyRef = useRef('');
  const gestureStateRef = useRef<{
    kind: PlayerVerticalGesture | null;
    startValue: number;
    started: boolean;
  }>({ kind: null, startValue: 0, started: false });
  const brightnessRef = useRef(0.5);
  const volumeRef = useRef(1);
  const restoreBrightnessRef = useRef<number | null>(null);
  const gestureHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    Brightness.getBrightnessAsync()
      .then((value) => {
        if (cancelled) return;
        const nextValue = clamp01(value);
        brightnessRef.current = nextValue;
        restoreBrightnessRef.current = nextValue;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (gestureHintTimerRef.current) clearTimeout(gestureHintTimerRef.current);
      const restoreValue = restoreBrightnessRef.current;
      if (restoreValue !== null) {
        void Brightness.setBrightnessAsync(restoreValue).catch(() => {});
      }
    };
  }, []);

  const localAudioTracks = useMemo(
    () => (target.localMetadata?.tracks || []).filter((track) => track.type === 'audio'),
    [target.localMetadata?.tracks],
  );
  const localSubtitleTracks = useMemo(
    () => (target.localMetadata?.tracks || []).filter((track) => track.type === 'subtitle'),
    [target.localMetadata?.tracks],
  );
  const audioOptions = useMemo<PlayerAudioOption[]>(() => {
    if (localAudioTracks.length > 0) {
      return localAudioTracks.map((track, index) => ({
        key: `local-audio-${track.index}`,
        label: localTrackLabel(track, index),
        localTrack: track,
      }));
    }

    return nativeAudioTracks.map((track, index) => ({
      key: nativeTrackKey(track, 'native-audio', index),
      label: nativeTrackLabel(track, index),
      nativeTrack: track,
    }));
  }, [localAudioTracks, nativeAudioTracks]);
  const subtitleOptions = useMemo<PlayerSubtitleOption[]>(() => [
    ...localSubtitleTracks.map((track, index) => ({
      key: `local-subtitle-${track.index}`,
      label: localTrackLabel(track, index),
      localTrack: track,
      streamOrdinal: index,
    })),
    ...(target.subtitles || []).map((subtitle, index) => ({
      key: `sidecar-subtitle-${filePathFromUrl(subtitle.url)}-${index}`,
      label: sidecarSubtitleLabel(subtitle, index),
      sidecar: subtitle,
    })),
    ...(localSubtitleTracks.length > 0 || (target.subtitles || []).length > 0
      ? []
      : nativeSubtitleTracks.map((track, index) => ({
        key: nativeTrackKey(track, 'native-subtitle', index),
        label: nativeTrackLabel(track, index),
        nativeTrack: track,
      }))),
  ], [localSubtitleTracks, nativeSubtitleTracks, target.subtitles]);

  useEffect(() => {
    let cancelled = false;
    appliedPreferenceKeyRef.current = '';
    setTrackPreferences({});
    if (!baseUrl || !deviceToken || !preferenceScope) return () => { cancelled = true; };

    fetch(`${baseUrl}/api/playback-track-preferences?scope=${encodeURIComponent(preferenceScope)}`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
      .then((response) => (response.ok ? response.json() as Promise<PlaybackTrackPreferences> : {}))
      .then((preferences) => {
        if (!cancelled) setTrackPreferences(preferences || {});
      })
      .catch(() => {
        if (!cancelled) setTrackPreferences({});
      });

    return () => {
      cancelled = true;
    };
  }, [baseUrl, deviceToken, preferenceScope]);

  useEffect(() => {
    if (!activeAudioKey && audioOptions[0]) setActiveAudioKey(audioOptions[0].key);
  }, [activeAudioKey, audioOptions]);

  useEffect(() => {
    if (!playbackUrl) return;

    const refreshTracks = (payload?: { availableAudioTracks?: AudioTrack[]; availableSubtitleTracks?: SubtitleTrack[]; duration?: number }) => {
      try {
        setNativeAudioTracks(payload?.availableAudioTracks || player.availableAudioTracks || []);
        setNativeSubtitleTracks(payload?.availableSubtitleTracks || player.availableSubtitleTracks || []);
        const nextDuration = Number(payload?.duration || player.duration || 0);
        if (Number.isFinite(nextDuration) && nextDuration > 0) setDuration(nextDuration);
      } catch {
        // Track APIs can reject while the native player is still loading.
      }
    };

    const timeSubscription = player.addListener?.('timeUpdate', (event: { currentTime: number }) => {
      setPosition(Number(event.currentTime) || 0);
      const nextDuration = Number(player.duration || 0);
      if (Number.isFinite(nextDuration) && nextDuration > 0) setDuration(nextDuration);
    });
    const playingSubscription = player.addListener?.('playingChange', (event: { isPlaying: boolean }) => {
      setIsPlaying(event.isPlaying);
    });
    const volumeSubscription = player.addListener?.('volumeChange', (event: { volume: number }) => {
      volumeRef.current = clamp01(event.volume);
    });
    const statusSubscription = player.addListener?.('statusChange', (payload: { status: string }) => {
      if (payload.status === 'readyToPlay') refreshTracks();
    });
    const sourceLoadSubscription = player.addListener?.('sourceLoad', refreshTracks);
    const trackSubscriptions = [
      player.addListener?.('availableAudioTracksChange', (payload: { availableAudioTracks: AudioTrack[] }) => refreshTracks(payload)),
      player.addListener?.('availableSubtitleTracksChange', (payload: { availableSubtitleTracks: SubtitleTrack[] }) => refreshTracks(payload)),
      player.addListener?.('audioTrackChange', () => refreshTracks()),
      player.addListener?.('subtitleTrackChange', () => refreshTracks()),
    ];
    refreshTracks();
    return () => {
      timeSubscription?.remove?.();
      playingSubscription?.remove?.();
      volumeSubscription?.remove?.();
      statusSubscription?.remove?.();
      sourceLoadSubscription?.remove?.();
      trackSubscriptions.forEach((subscription) => subscription?.remove?.());
    };
  }, [playbackUrl, player]);

  // Auto-hide the controls while playing; any interaction restarts the timer,
  // and an open settings menu keeps them up.
  useEffect(() => {
    if (!controlsVisible || !isPlaying || menu !== 'none') return;
    const timer = setTimeout(() => setControlsVisible(false), 4000);
    return () => clearTimeout(timer);
  }, [controlsVisible, isPlaying, interactionTick, menu]);

  useEffect(() => {
    if (!controlsVisible) setMenu('none');
  }, [controlsVisible]);

  // Fade the control overlay in/out instead of a hard cut when it auto-hides.
  useEffect(() => {
    Animated.timing(controlsOpacity, {
      toValue: controlsVisible ? 1 : 0,
      duration: controlsVisible ? 150 : 220,
      useNativeDriver: true,
    }).start();
  }, [controlsOpacity, controlsVisible]);

  const bumpControls = () => {
    setControlsVisible(true);
    setInteractionTick((tick) => tick + 1);
  };

  const togglePlay = () => {
    bumpControls();
    try {
      if (isPlaying) player.pause();
      else player.play();
    } catch {
      // The native player can briefly reject commands during teardown.
    }
  };

  const seekToSeconds = (seconds: number) => {
    bumpControls();
    const nextTime = Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds);
    // Transcoded streams are served as a full VOD playlist whose segments the
    // desktop materializes on demand, so every jump — direct-play or HLS — is a
    // native player seek. Restarting the transcode per skip (the old path) forced
    // a full stream reload and re-primed A/V on each jump; a native seek just
    // pulls the target segment, which is far lighter on mobile. Changing the
    // audio/subtitle track is the only thing that still rebuilds the stream.
    setPosition(nextTime);
    try {
      player.currentTime = nextTime;
    } catch {
      // Seeking before the stream is ready is a no-op.
    }
  };

  const skipBy = (delta: number) => {
    const currentTime = Number(player.currentTime || position || 0);
    seekToSeconds(currentTime + delta);
  };

  const seekToFraction = (fraction: number) => {
    if (duration <= 0) return;
    seekToSeconds(Math.min(duration, Math.max(0, fraction * duration)));
  };

  const showGestureLevel = (kind: PlayerVerticalGesture, value: number) => {
    setGestureLevel({ kind, value });
    if (gestureHintTimerRef.current) clearTimeout(gestureHintTimerRef.current);
    gestureHintTimerRef.current = setTimeout(() => setGestureLevel(null), 700);
  };

  const setPlayerVolume = (value: number) => {
    const nextValue = clamp01(value);
    volumeRef.current = nextValue;
    try {
      player.volume = nextValue;
      player.muted = nextValue === 0;
    } catch {
      // Volume changes can be rejected while the native player is loading.
    }
    showGestureLevel('volume', nextValue);
  };

  const setPlayerBrightness = (value: number) => {
    const nextValue = clamp01(value);
    brightnessRef.current = nextValue;
    void Brightness.setBrightnessAsync(nextValue).catch(() => {});
    showGestureLevel('brightness', nextValue);
  };

  const playerPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => (
      Math.abs(gesture.dy) > 12
      && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.35
    ),
    onPanResponderGrant: (event) => {
      const kind: PlayerVerticalGesture = event.nativeEvent.locationX < playerWidth / 2 ? 'brightness' : 'volume';
      gestureStateRef.current = {
        kind,
        startValue: kind === 'brightness' ? brightnessRef.current : volumeRef.current,
        started: true,
      };
      setControlsVisible(true);
      setMenu('none');
    },
    onPanResponderMove: (_, gesture) => {
      const state = gestureStateRef.current;
      if (!state.started || !state.kind) return;
      const nextValue = state.startValue - (gesture.dy / 220);
      if (state.kind === 'brightness') setPlayerBrightness(nextValue);
      else setPlayerVolume(nextValue);
    },
    onPanResponderRelease: () => {
      gestureStateRef.current = { kind: null, startValue: 0, started: false };
      setInteractionTick((tick) => tick + 1);
    },
    onPanResponderTerminate: () => {
      gestureStateRef.current = { kind: null, startValue: 0, started: false };
    },
  }), [playerWidth, player]);

  const toggleMenu = (nextMenu: 'speed' | 'audio' | 'subtitles') => {
    bumpControls();
    setMenu((current) => (current === nextMenu ? 'none' : nextMenu));
  };

  const selectRate = (rate: number) => {
    bumpControls();
    try {
      player.playbackRate = rate;
    } catch {
      // Rate changes can be rejected while the stream is loading.
    }
    setPlaybackRate(rate);
  };

  const streamOptionsForSelection = (audioKey: string, subtitleKey: string, startSeconds: number): StreamOptions | null => {
    const audioOption = audioOptions.find((option) => option.key === audioKey);
    const subtitleOption = subtitleOptions.find((option) => option.key === subtitleKey);
    const options: StreamOptions = {};

    if (audioOption?.localTrack) {
      options.audioTrackIndex = audioOption.localTrack.index;
    }

    if (subtitleOption?.localTrack) {
      options.subtitleTrackIndex = subtitleOption.localTrack.index;
      options.subtitleStreamOrdinal = subtitleOption.streamOrdinal || 0;
      options.subtitleCodec = subtitleOption.localTrack.codec;
    } else if (subtitleOption?.sidecar) {
      options.subtitleFilePath = filePathFromUrl(subtitleOption.sidecar.url);
    }

    const needsServerVariant = target.transcode
      || Boolean(audioOption?.localTrack)
      || Boolean(subtitleOption?.localTrack)
      || Boolean(subtitleOption?.sidecar);
    if (!needsServerVariant) return null;

    return {
      ...options,
      forceTranscode: true,
      ...(startSeconds > 2 ? { startSeconds } : {}),
    };
  };

  const requestSelectionStream = (audioKey: string, subtitleKey: string) => {
    const startSeconds = Number(player.currentTime || position || 0);
    onStreamOptionsChange(streamOptionsForSelection(audioKey, subtitleKey, startSeconds) || {});
  };

  const applyNativeTrackSelection = (audioKey: string, subtitleKey: string) => {
    const audioOption = audioOptions.find((option) => option.key === audioKey);
    const subtitleOption = subtitleOptions.find((option) => option.key === subtitleKey);
    const hasServerSubtitle = Boolean(subtitleOption?.localTrack || subtitleOption?.sidecar);

    if (audioOption?.nativeTrack && localAudioTracks.length === 0 && !hasServerSubtitle) {
      try {
        player.audioTrack = audioOption.nativeTrack;
      } catch {
        // Track selection can be rejected while the stream is loading.
      }
    }

    if (subtitleOption?.nativeTrack && localSubtitleTracks.length === 0 && !target.subtitles?.length) {
      try {
        player.subtitleTrack = subtitleOption.nativeTrack;
      } catch {
        // Track selection can be rejected while the stream is loading.
      }
    } else if (subtitleKey === 'off') {
      try {
        player.subtitleTrack = null;
      } catch {
        // Track selection can be rejected while the stream is loading.
      }
    }
  };

  useEffect(() => {
    if (!trackPreferences.audio && !trackPreferences.subtitle) return;
    if (trackPreferences.audio && audioOptions.length === 0) return;

    const nextAudioKey = trackPreferences.audio
      ? preferredAudioKey(audioOptions, trackPreferences.audio)
      : activeAudioKey || audioOptions[0]?.key || '';
    const nextSubtitleKey = trackPreferences.subtitle
      ? preferredSubtitleKey(subtitleOptions, trackPreferences.subtitle)
      : activeSubtitleKey;
    const applyKey = JSON.stringify({
      scope: preferenceScope,
      audio: nextAudioKey,
      subtitle: nextSubtitleKey,
      preference: trackPreferences,
      audioOptions: audioOptions.map((option) => option.key),
      subtitleOptions: subtitleOptions.map((option) => option.key),
    });

    if (appliedPreferenceKeyRef.current === applyKey) return;
    appliedPreferenceKeyRef.current = applyKey;

    if (nextAudioKey && nextAudioKey !== activeAudioKey) setActiveAudioKey(nextAudioKey);
    if (nextSubtitleKey !== activeSubtitleKey) setActiveSubtitleKey(nextSubtitleKey);

    const startSeconds = Number(player.currentTime || position || 0);
    onStreamOptionsChange(streamOptionsForSelection(nextAudioKey, nextSubtitleKey, startSeconds) || {});
    applyNativeTrackSelection(nextAudioKey, nextSubtitleKey);
  }, [
    activeAudioKey,
    activeSubtitleKey,
    audioOptions,
    localAudioTracks.length,
    localSubtitleTracks.length,
    onStreamOptionsChange,
    player,
    position,
    preferenceScope,
    streamOptionsForSelection,
    subtitleOptions,
    target.subtitles?.length,
    trackPreferences,
  ]);

  const saveTrackPreferences = (nextPreference: PlaybackTrackPreferences) => {
    const nextPreferences = { ...trackPreferences, ...nextPreference };
    setTrackPreferences(nextPreferences);
    if (!baseUrl || !deviceToken || !preferenceScope) return;
    fetch(`${baseUrl}/api/playback-track-preferences`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scope: preferenceScope, preferences: nextPreferences }),
    }).catch(() => {});
  };

  const selectAudioOption = (option: PlayerAudioOption) => {
    bumpControls();
    setActiveAudioKey(option.key);
    saveTrackPreferences({ audio: audioPreference(option, true) });
    const activeSubtitleOption = subtitleOptions.find((candidate) => candidate.key === activeSubtitleKey);
    const hasServerSubtitle = Boolean(activeSubtitleOption?.localTrack || activeSubtitleOption?.sidecar);
    if (option.nativeTrack && localAudioTracks.length === 0 && !hasServerSubtitle) {
      try {
        player.audioTrack = option.nativeTrack;
      } catch {
        // Track selection can be rejected while the stream is loading.
      }
      return;
    }
    requestSelectionStream(option.key, activeSubtitleKey);
  };

  const selectSubtitleOption = (option: PlayerSubtitleOption | null) => {
    bumpControls();
    const nextSubtitleKey = option?.key || 'off';
    setActiveSubtitleKey(nextSubtitleKey);
    saveTrackPreferences({ subtitle: subtitlePreference(option, Boolean(option)) });

    if (option?.nativeTrack && localSubtitleTracks.length === 0 && !target.subtitles?.length) {
      try {
        player.subtitleTrack = option.nativeTrack;
      } catch {
        // Track selection can be rejected while the stream is loading.
      }
      return;
    }

    if (!option) {
      try {
        player.subtitleTrack = null;
      } catch {
        // Track selection can be rejected while the stream is loading.
      }
    }
    requestSelectionStream(activeAudioKey || audioOptions[0]?.key || '', nextSubtitleKey);
  };

  const progressFractionValue = duration > 0 ? Math.min(1, position / duration) : 0;
  const displayLabels = playerDisplayLabels(target);

  return (
    <Animated.View style={[styles.overlay, styles.playerRoot, entrance]}>
      <StatusBar style="light" hidden />
      {playbackUrl ? (
        <>
          <VideoView
            contentFit="contain"
            nativeControls={false}
            player={player}
            style={styles.playerVideo}
          />
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setControlsVisible((visible) => !visible)}
            accessibilityLabel={controlsVisible ? 'Hide player controls' : 'Show player controls'}
            {...playerPanResponder.panHandlers}
          />
          {gestureLevel ? (
            <View style={styles.playerGestureHint} pointerEvents="none">
              <Text style={styles.playerGestureTitle}>
                {gestureLevel.kind === 'brightness' ? 'Brightness' : 'Volume'}
              </Text>
              <View style={styles.playerGestureTrack}>
                <View style={[styles.playerGestureFill, { width: `${gestureLevel.value * 100}%` }]} />
              </View>
              <Text style={styles.playerGestureValue}>{Math.round(gestureLevel.value * 100)}%</Text>
            </View>
          ) : null}
          <Animated.View
            style={[StyleSheet.absoluteFill, { opacity: controlsOpacity }]}
            pointerEvents={controlsVisible ? 'box-none' : 'none'}
          >
            <View
              style={[
                styles.playerControls,
                {
                  paddingBottom: Math.max(insets.bottom, 20) + 8,
                  paddingLeft: Math.max(insets.left, 18),
                  paddingRight: Math.max(insets.right, 18),
                  paddingTop: Math.max(insets.top, 16) + 4,
                },
              ]}
              pointerEvents="box-none"
            >
              <View style={styles.playerTopRow}>
                <Pressable
                  style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Close player"
                >
                  <CloseIcon size={26} color={text} />
                </Pressable>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.playerTopTitle}>
                  {displayLabels.topTitle}
                </Text>
                <View style={styles.playerOptionsPill}>
                  <Pressable
                    onPress={() => toggleMenu('subtitles')}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Subtitles"
                  >
                    <SubtitlesIcon size={22} color={menu === 'subtitles' ? accent : text} />
                  </Pressable>
                  <Pressable
                    onPress={() => toggleMenu('audio')}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Audio tracks"
                  >
                    <AudioTracksIcon size={22} color={menu === 'audio' ? accent : text} />
                  </Pressable>
                  <Pressable
                    onPress={() => toggleMenu('speed')}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Playback speed"
                  >
                    <SpeedIcon size={22} color={menu === 'speed' ? accent : text} />
                  </Pressable>
                </View>
              </View>

                <View style={styles.playerCenterOverlay} pointerEvents="box-none">
                  <View style={styles.playerCenterRow} pointerEvents="box-none">
                    <PlayerSkipButton
                      amount={10}
                      direction="back"
                      onPress={() => skipBy(-10)}
                      style={styles.playerSkipBackControl}
                    />
                    <Pressable
                      onPress={togglePlay}
                      style={({ pressed }) => [styles.playerPlayButton, styles.playerPlayCenterControl, pressed && styles.playerControlPressed]}
                      accessibilityRole="button"
                      accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
                    >
                      {isPlaying ? <PauseIcon size={34} color="#0b0b0b" /> : <PlayIcon size={34} color="#0b0b0b" />}
                    </Pressable>
                    <PlayerSkipButton
                      amount={10}
                      direction="forward"
                      onPress={() => skipBy(10)}
                      style={styles.playerSkipForwardControl}
                    />
                  </View>
                </View>

              <View style={styles.playerBottomBlock} pointerEvents="box-none">
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.playerTitle}>
                  {displayLabels.bottomTitle}
                </Text>
                <Pressable
                  style={styles.playerSeekTrackHit}
                  onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
                  onPress={(event) => {
                    if (trackWidth > 0) seekToFraction(event.nativeEvent.locationX / trackWidth);
                  }}
                  accessibilityRole="adjustable"
                  accessibilityLabel="Seek"
                >
                  <View style={styles.playerSeekTrack}>
                    <View style={[styles.playerSeekFill, { width: `${progressFractionValue * 100}%` }]} />
                    <View style={[styles.playerSeekThumb, { left: `${progressFractionValue * 100}%` }]} />
                  </View>
                </Pressable>
                <View style={styles.playerTimesRow}>
                  <Text style={styles.playerTime}>{formatClock(position)}</Text>
                  <Text style={styles.playerTime}>-{formatClock(Math.max(0, duration - position))}</Text>
                </View>
              </View>

              {menu !== 'none' ? (
                <View
                  style={[
                    styles.playerMenuPanel,
                    { right: Math.max(insets.right, 20), top: Math.max(insets.top, 16) + 56 },
                  ]}
                >
                  <Text style={styles.playerMenuTitle}>
                    {menu === 'speed' ? 'Playback Speed' : menu === 'audio' ? 'Audio' : 'Subtitles'}
                  </Text>
                  <ScrollView style={styles.playerMenuScroll}>
                    {menu === 'speed' ? (
                      [0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                        <PlayerMenuRow
                          key={rate}
                          label={rate === 1 ? 'Normal' : `${rate}×`}
                          selected={playbackRate === rate}
                          onPress={() => selectRate(rate)}
                        />
                      ))
                    ) : menu === 'audio' ? (
                      audioOptions.length <= 1 ? (
                        <Text style={styles.playerMenuEmpty}>This stream has a single audio track.</Text>
                      ) : (
                        audioOptions.map((option) => (
                          <PlayerMenuRow
                            key={option.key}
                            label={option.label}
                            selected={activeAudioKey ? activeAudioKey === option.key : audioOptions[0]?.key === option.key}
                            onPress={() => selectAudioOption(option)}
                          />
                        ))
                      )
                    ) : (
                      <>
                        <PlayerMenuRow
                          label="Off"
                          selected={activeSubtitleKey === 'off'}
                          onPress={() => selectSubtitleOption(null)}
                        />
                        {subtitleOptions.map((option) => (
                          <PlayerMenuRow
                            key={option.key}
                            label={option.label}
                            selected={activeSubtitleKey === option.key}
                            onPress={() => selectSubtitleOption(option)}
                          />
                        ))}
                        {subtitleOptions.length === 0 ? (
                          <Text style={styles.playerMenuEmpty}>No subtitle tracks in this stream.</Text>
                        ) : null}
                      </>
                    )}
                  </ScrollView>
                </View>
              ) : null}
              </View>
          </Animated.View>
        </>
      ) : (
        <>
          <View style={styles.playerStatus}>
            {isPreparing ? <ActivityIndicator color={accent} size="large" /> : null}
            <Text selectable style={styles.playerStatusText}>
              {error || (isPreparing ? 'Preparing stream…' : 'Starting playback…')}
            </Text>
            <Text selectable numberOfLines={2} style={styles.playerStatusTitle}>{target.title}</Text>
            {error ? (
              <>
                <Text selectable style={styles.playerRecoveryText}>
                  The desktop may be offline, the NAS share may need to reconnect, or this file may require a transcode the host could not start.
                </Text>
                <Pressable style={({ pressed }) => [styles.playerStatusButton, pressed && styles.pressed]} onPress={onClose}>
                  <Text style={styles.playerStatusButtonText}>Back to library</Text>
                </Pressable>
              </>
            ) : null}
          </View>
          <Pressable
            style={({ pressed }) => [styles.playerClose, { top: insets.top + 8 }, pressed && styles.pressed]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close player"
          >
            <CloseIcon size={24} color={text} />
          </Pressable>
        </>
      )}
    </Animated.View>
  );
}

function SettingsScreen({
  connection,
  counts,
  isTablet,
  isRefreshing,
  onDisconnect,
  onRefresh,
}: {
  connection: Connection;
  counts: Record<'anime' | 'tv' | 'movies' | 'others', number>;
  isTablet: boolean;
  isRefreshing: boolean;
  onDisconnect: () => void;
  onRefresh: () => void;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSection | null>(null);
  const active = settingsSections.find((section) => section.id === activeSection);

  if (active) {
    return (
      <View style={styles.settingsPage}>
        <View style={styles.settingsDetailHeader}>
          <Pressable
            style={({ pressed }) => [styles.settingsBackButton, pressed && styles.pressed]}
            onPress={() => setActiveSection(null)}
            accessibilityRole="button"
            accessibilityLabel="Back to settings"
          >
            <BackIcon size={26} color={accent} />
          </Pressable>
          <Text selectable numberOfLines={1} style={styles.settingsDetailTitle}>{active.label}</Text>
        </View>
        <SettingsDetail
          section={active}
          connection={connection}
          counts={counts}
          isTablet={isTablet}
          isRefreshing={isRefreshing}
          onDisconnect={onDisconnect}
          onRefresh={onRefresh}
        />
      </View>
    );
  }

  return (
    <View style={styles.settingsPage}>
      <View style={styles.settingsProfile}>
        <View style={styles.settingsAvatar}>
          <Text style={styles.settingsAvatarText}>LT</Text>
        </View>
        <Text selectable style={styles.settingsProfileTitle}>Loom Media Player</Text>
        <Text selectable style={styles.settingsProfileCopy}>
          Refresh your library or manage the paired desktop connection.
        </Text>
      </View>
      <View style={styles.settingsList}>
        {settingsSections.map((section) => (
          <Pressable
            key={section.id}
            style={({ pressed }) => [styles.settingsListItem, pressed && styles.pressed]}
            onPress={() => setActiveSection(section.id)}
            accessibilityRole="button"
          >
            <Text selectable style={styles.settingsListText}>{section.label}</Text>
            <ChevronRightIcon size={22} color="rgba(255,255,255,0.55)" />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function SettingsDetail({
  section,
  connection,
  counts,
  isTablet,
  isRefreshing,
  onDisconnect,
  onRefresh,
}: {
  section: { id: SettingsSection; label: string; description: string };
  connection: Connection;
  counts: Record<'anime' | 'tv' | 'movies' | 'others', number>;
  isTablet: boolean;
  isRefreshing: boolean;
  onDisconnect: () => void;
  onRefresh: () => void;
}) {
  const { width, fontScale } = useWindowDimensions();
  const availableSettingsWidth = Math.min(
    settingsContentMaxWidth,
    Math.max(0, width - (isTablet ? 220 : 0) - settingsPageHorizontalPadding),
  );
  const cardInnerWidth = Math.max(0, availableSettingsWidth - settingsCardHorizontalPadding);
  const metricColumns = cardInnerWidth < 260 || fontScale >= 1.5
    ? 1
    : cardInnerWidth >= 560 && fontScale < 1.2
      ? 4
      : 2;
  const libraryMetrics: LibraryMetric[] = [
    { key: 'anime', label: 'Anime', value: counts.anime, Icon: navIcons.anime },
    { key: 'tv', label: 'TV Shows', value: counts.tv, Icon: navIcons.tv },
    { key: 'movies', label: 'Movies', value: counts.movies, Icon: navIcons.movies },
    { key: 'others', label: 'Others', value: counts.others, Icon: FolderIcon },
  ];
  const metricRows = Array.from({ length: Math.ceil(libraryMetrics.length / metricColumns) }, (_, index) =>
    libraryMetrics.slice(index * metricColumns, index * metricColumns + metricColumns));

  if (section.id === 'library') {
    return (
      <View style={styles.settingsCards}>
        <View style={styles.settingsCard}>
          <Text selectable style={styles.settingsCardTitle}>Library</Text>
          <Text selectable style={styles.settingsCardCopy}>Synced from {connection.hostDeviceName}.</Text>
          <View style={styles.settingsMetricRows}>
            {metricRows.map((row) => (
              <View key={row.map((metric) => metric.key).join('-')} style={styles.settingsMetricRow}>
                {row.map((metric) => (
                  <SettingsMetric key={metric.key} metric={metric} />
                ))}
              </View>
            ))}
          </View>
          <Pressable style={[styles.settingsPrimaryButton, isRefreshing && styles.disabledButton]} onPress={onRefresh} disabled={isRefreshing}>
            <Text style={styles.settingsPrimaryButtonText}>{isRefreshing ? 'Refreshing...' : 'Refresh library'}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (section.id === 'network') {
    return (
      <View style={styles.settingsCards}>
        <View style={styles.settingsCard}>
          <Text selectable style={styles.settingsCardTitle}>Paired Desktop</Text>
          <Text selectable style={styles.settingsCardCopy}>{connection.hostDeviceName}</Text>
          <Text selectable style={styles.settingsValue}>{connection.baseUrl}</Text>
        </View>
        <Pressable style={styles.settingsDangerButton} onPress={onDisconnect}>
          <Text style={styles.settingsDangerButtonText}>Disconnect device</Text>
        </Pressable>
      </View>
    );
  }

  return null;
}

function SettingsMetric({ metric }: { metric: LibraryMetric }) {
  const Icon = metric.Icon;
  return (
    <View style={styles.settingsMetric}>
      <View style={styles.settingsMetricIcon}>
        <Icon size={19} color={accent} />
      </View>
      <View style={styles.settingsMetricCopy}>
        <Text selectable style={styles.settingsMetricValue}>{metric.value}</Text>
        <Text selectable numberOfLines={1} style={styles.settingsMetricLabel}>{metric.label}</Text>
      </View>
    </View>
  );
}

function HomeSections({
  artworkCacheBusters,
  baseUrl,
  continueWatching,
  grouped,
  isTablet,
  onOpenKind,
  onSelect,
}: {
  artworkCacheBusters: Record<string, string>;
  baseUrl: string;
  continueWatching: MediaItem[];
  grouped: ReturnType<typeof collections>;
  isTablet: boolean;
  onOpenKind: (kind: LibraryKind) => void;
  onSelect: (item: MediaItem) => void;
}) {
  const hasItems = grouped.anime.length > 0 || grouped.tv.length > 0 || grouped.movies.length > 0 || grouped.others.length > 0;

  return (
    <View style={styles.sections}>
      {continueWatching.length > 0 ? (
        <Rail title="Continue Watching" artworkCacheBusters={artworkCacheBusters} items={continueWatching} baseUrl={baseUrl} onSelect={onSelect} />
      ) : null}
      <Rail title="Anime" artworkCacheBusters={artworkCacheBusters} items={grouped.anime.slice(0, 24)} baseUrl={baseUrl} onSelect={onSelect} onPressTitle={() => onOpenKind('anime')} />
      <Rail title="TV Shows" artworkCacheBusters={artworkCacheBusters} items={grouped.tv.slice(0, 24)} baseUrl={baseUrl} onSelect={onSelect} onPressTitle={() => onOpenKind('tv')} />
      <Rail title="Movies" artworkCacheBusters={artworkCacheBusters} items={grouped.movies.slice(0, 24)} baseUrl={baseUrl} onSelect={onSelect} onPressTitle={() => onOpenKind('movies')} />
      {!hasItems ? <EmptyLibrary isTablet={isTablet} /> : null}
    </View>
  );
}

function Rail({
  artworkCacheBusters,
  baseUrl,
  items,
  onPressTitle,
  onSelect,
  title,
}: {
  artworkCacheBusters: Record<string, string>;
  baseUrl: string;
  items: MediaItem[];
  onPressTitle?: () => void;
  onSelect: (item: MediaItem) => void;
  title: string;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.rail}>
      <Pressable
        disabled={!onPressTitle}
        onPress={onPressTitle}
        style={({ pressed }) => [styles.railTitleRow, pressed && styles.pressed]}
        accessibilityRole={onPressTitle ? 'button' : undefined}
        accessibilityLabel={onPressTitle ? `Open ${title}` : undefined}
      >
        <Text numberOfLines={1} style={styles.sectionTitle}>{title}</Text>
        {onPressTitle ? <ChevronRightIcon size={24} color={text} /> : null}
      </Pressable>
      <FlatList
        contentContainerStyle={styles.railContent}
        data={items}
        horizontal
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <PosterCard baseUrl={baseUrl} cacheBust={artworkCacheBusters[item.id]} item={item} onSelect={onSelect} width={128} />
        )}
        showsHorizontalScrollIndicator={false}
        // Poster cells are a fixed 128px wide with a 14px gap, so the list can
        // size rows without measuring and only keep a small window mounted.
        getItemLayout={(_data, index) => ({ length: 128, offset: (128 + 14) * index, index })}
        initialNumToRender={5}
        maxToRenderPerBatch={6}
        windowSize={5}
        removeClippedSubviews
      />
    </View>
  );
}

// The single scroller for every non-settings view. It virtualizes the poster
// grid (only a small window of rows stays mounted, instead of the old
// `items.map` that mounted every poster up front) while keeping the search
// `Header` and — in home mode — the rails inside `ListHeaderComponent`. Because
// it's one persistent FlatList, the Header never remounts when the query toggles
// between rails and grid, so search keeps keyboard focus.
function LibraryList({
  artworkCacheBusters,
  baseUrl,
  contentContainerStyle,
  header = null,
  isTablet,
  items,
  listRef,
  onScroll,
  onSelect,
  refreshControl,
  showEmpty = true,
}: {
  artworkCacheBusters: Record<string, string>;
  baseUrl: string;
  contentContainerStyle?: StyleProp<ViewStyle>;
  header?: ReactElement | null;
  isTablet: boolean;
  items: MediaItem[];
  listRef?: Ref<FlatList<MediaItem>>;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onSelect: (item: MediaItem) => void;
  refreshControl?: ReactElement<RefreshControlProps>;
  showEmpty?: boolean;
}) {
  const { width } = useWindowDimensions();
  const gap = 14;
  // Side nav (tablet) is 220px wide; account for the 16px content padding on each side.
  const available = (isTablet ? width - 220 : width) - 32;
  const columns = isTablet ? Math.max(3, Math.floor(available / 180)) : 3;
  const itemWidth = Math.floor((available - gap * (columns - 1)) / columns);
  return (
    <FlatList
      ref={listRef}
      // numColumns can't change without remounting the list; key by it so a
      // rotation that changes the column count rebuilds cleanly (losing scroll
      // position on rotate is acceptable).
      key={columns}
      data={items}
      numColumns={columns}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <PosterCard baseUrl={baseUrl} cacheBust={artworkCacheBusters[item.id]} item={item} onSelect={onSelect} width={itemWidth} />
      )}
      columnWrapperStyle={columns > 1 ? { gap } : undefined}
      contentContainerStyle={[contentContainerStyle, { gap }]}
      ListHeaderComponent={header}
      ListEmptyComponent={showEmpty ? (
        <View style={styles.emptyInline}>
          <Text selectable style={styles.emptyTitle}>No local matches found</Text>
          <Text selectable style={styles.emptyCopy}>Try another search or refresh the shared desktop library.</Text>
        </View>
      ) : null}
      refreshControl={refreshControl}
      // The content padding already includes the safe-area top inset; letting
      // iOS also apply automatic content insets doubles the gap under the
      // Dynamic Island (Android ignores this prop, which hid the mismatch).
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      onScroll={onScroll}
      scrollEventThrottle={120}
      showsVerticalScrollIndicator={false}
      initialNumToRender={9}
      maxToRenderPerBatch={9}
      windowSize={7}
      removeClippedSubviews
    />
  );
}

// Memoized: a poster is rendered in every rail and across the whole grid, and
// its props (item, stable onSelect setter, baseUrl, width) don't change when the
// app re-renders for unrelated reasons — e.g. the periodic progress sync during
// playback. Without memo, every such re-render walks hundreds of posters.
const PosterCard = memo(function PosterCard({
  baseUrl,
  cacheBust,
  item,
  onSelect,
  width,
}: {
  baseUrl: string;
  cacheBust?: string;
  item: MediaItem;
  onSelect: (item: MediaItem) => void;
  width: number;
}) {
  const posterCandidates = useMemo(
    () => [
      item.poster,
      ...(item.posterCandidates || []),
      item.backdrop,
      ...(item.backdropCandidates || []),
    ].map((source) => imageUrlFor(baseUrl, source, cacheBust)).filter(Boolean),
    [baseUrl, cacheBust, item.backdrop, item.backdropCandidates, item.poster, item.posterCandidates],
  );
  const [posterIndex, setPosterIndex] = useState(0);
  const poster = posterCandidates[posterIndex] || '';

  useEffect(() => {
    setPosterIndex(0);
  }, [item.id, posterCandidates]);

  // Plex-style single meta line: year for movies, season count for series.
  const meta = item.type === 'movie'
    ? (item.year ? String(item.year) : 'Movie')
    : seasonCountLabel(item);
  return (
    <PressableScale
      style={[styles.posterCard, { width }]}
      onPress={() => onSelect(item)}
      accessibilityRole="button"
      accessibilityLabel={item.title}
    >
      <View style={styles.posterFrame}>
        {poster ? (
          <FadeInImage
            uri={poster}
            style={styles.posterImage}
            onError={() => setPosterIndex((current) => current + 1)}
          />
        ) : (
          <View style={styles.posterFallback}>
            <PlayMark size={26} color={accent} />
          </View>
        )}
      </View>
      <Text selectable numberOfLines={2} ellipsizeMode="tail" style={styles.posterTitle}>{item.title}</Text>
      <Text selectable numberOfLines={1} style={styles.metaText}>{meta}</Text>
    </PressableScale>
  );
});

function EmptyLibrary({ isTablet }: { isTablet: boolean }) {
  return (
    <View style={[styles.emptyLibrary, isTablet && styles.emptyLibraryTablet]}>
      <View style={styles.emptyIcon}>
        <Text style={styles.emptyIconText}>＋</Text>
      </View>
      <Text selectable style={styles.emptyTitle}>Add your first library folder on desktop</Text>
      <Text selectable style={styles.emptyCopy}>
        Pairing worked. Add movies, TV shows, or anime folders in Loom Media Player desktop, then refresh here.
      </Text>
    </View>
  );
}

function createStyles(theme: MobileThemeColors) {
  const { accent, accentSoft, accentBorder, accentForeground, bg, panel, panel2, border, text, muted, faint } = theme;
  return StyleSheet.create({
  app: {
    backgroundColor: bg,
    flex: 1,
  },
  imageLoadFrame: {
    backgroundColor: panel2,
    overflow: 'hidden',
  },
  shimmerBase: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: panel2,
    overflow: 'hidden',
  },
  shimmerBand: {
    // The width and gradient sheen are applied at runtime; the vertical overflow
    // keeps the skewed edges clipped off-frame.
    bottom: -40,
    position: 'absolute',
    top: -40,
  },
  pairingAvoider: {
    flex: 1,
  },
  pairingContent: {
    flexGrow: 1,
    gap: 28,
    justifyContent: 'center',
    paddingBottom: 64,
    paddingHorizontal: 24,
    paddingTop: 48,
  },
  pairingContentKeyboard: {
    justifyContent: 'flex-start',
    paddingBottom: 32,
    paddingTop: 24,
  },
  pairingHero: {
    alignItems: 'center',
    gap: 14,
  },
  pairingSubtitle: {
    color: muted,
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 320,
    textAlign: 'center',
  },
  helpToggle: {
    alignItems: 'center',
    minHeight: 40,
    justifyContent: 'center',
  },
  helpToggleText: {
    color: accent,
    fontSize: 14,
    fontWeight: '600',
  },
  brandRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  formBlock: {
    gap: 11,
    paddingTop: 8,
  },
  discoveryBlock: {
    gap: 10,
  },
  discoveryHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 28,
  },
  discoveryTitle: {
    color: text,
    fontSize: 15,
    fontWeight: '700',
  },
  refreshDiscoveryButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 4,
  },
  hostCard: {
    alignItems: 'center',
    backgroundColor: '#080808',
    borderColor: border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 72,
    paddingHorizontal: 15,
    paddingVertical: 12,
  },
  hostCardSelected: {
    backgroundColor: accentSoft,
    borderColor: accent,
  },
  hostCardCopy: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  hostName: {
    color: text,
    fontSize: 16,
    fontWeight: '700',
  },
  hostAddress: {
    color: faint,
    fontSize: 12,
  },
  hostConnectLabel: {
    color: accent,
    fontSize: 13,
    fontWeight: '700',
  },
  emptyDiscoveryCard: {
    alignItems: 'center',
    backgroundColor: '#080808',
    borderColor: border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 5,
    padding: 20,
  },
  emptyDiscoveryTitle: {
    color: text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyDiscoveryCopy: {
    color: muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  codePrompt: {
    gap: 9,
    paddingTop: 4,
  },
  codePromptTitle: {
    color: muted,
    fontSize: 13,
    lineHeight: 18,
  },
  manualForm: {
    gap: 11,
  },
  manualDivider: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginVertical: 4,
  },
  manualDividerLine: {
    backgroundColor: border,
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  manualDividerText: {
    color: faint,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  manualHint: {
    color: faint,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  savedHostCard: {
    backgroundColor: '#080808',
    borderColor: border,
    borderRadius: 14,
    borderWidth: 1,
    gap: 5,
    padding: 18,
  },
  hostStatusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 7,
  },
  hostStatusDot: {
    backgroundColor: '#ef6a5b',
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  hostStatusDotSearching: {
    backgroundColor: accent,
  },
  savedHostStatus: {
    color: muted,
    fontSize: 12,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#080808',
    borderColor: border,
    borderRadius: 10,
    borderWidth: 1,
    color: text,
    fontSize: 16,
    minHeight: 50,
    paddingHorizontal: 14,
  },
  codeInput: {
    fontVariant: ['tabular-nums'],
    letterSpacing: 4,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: accent,
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 50,
  },
  disabledButton: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: accentForeground,
    fontSize: 16,
    fontWeight: '700',
  },
  reconnectButton: {
    backgroundColor: panel2,
    borderColor: border,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 8,
    minHeight: 42,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  reconnectButtonText: {
    color: text,
    fontSize: 14,
    fontWeight: '700',
  },
  errorText: {
    color: '#ff8c78',
    fontSize: 14,
    lineHeight: 20,
  },
  errorCard: {
    backgroundColor: 'rgba(255, 120, 92, 0.10)',
    borderColor: 'rgba(255, 140, 120, 0.25)',
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  shell: {
    flex: 1,
  },
  shellTablet: {
    flexDirection: 'row',
  },
  sideNav: {
    backgroundColor: '#080808',
    borderRightColor: border,
    borderRightWidth: 1,
    gap: 18,
    padding: 18,
    width: 220,
  },
  sideHost: {
    color: faint,
    fontSize: 13,
    lineHeight: 18,
  },
  sideNavItems: {
    gap: 6,
  },
  sideNavButton: {
    alignItems: 'center',
    borderRadius: 10,
    flexDirection: 'row',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  sideNavButtonActive: {
    backgroundColor: panel2,
  },
  navGlyph: {
    alignItems: 'center',
    width: 24,
  },
  sideNavLabel: {
    color: muted,
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
  },
  sideNavLabelActive: {
    color: text,
  },
  sideNavCount: {
    color: faint,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  refreshButton: {
    alignItems: 'center',
    borderColor: border,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 'auto',
    minHeight: 42,
    justifyContent: 'center',
  },
  refreshButtonText: {
    color: text,
    fontSize: 13,
    fontWeight: '600',
  },
  main: {
    flex: 1,
  },
  scrollContent: {
    gap: 18,
    padding: 16,
    paddingBottom: 108,
    paddingTop: 20,
  },
  header: {
    gap: 14,
  },
  topBarRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  topBarIconButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  railTitleRow: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 4,
    minHeight: 32,
  },
  headerTop: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
  },
  screenTitle: {
    color: text,
    fontSize: 32,
    fontWeight: '700',
    lineHeight: 36,
  },
  headerMeta: {
    color: faint,
    fontSize: 13,
    marginTop: 4,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: panel,
    borderColor: border,
    borderRadius: 12,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  searchBox: {
    alignItems: 'center',
    backgroundColor: panel,
    borderColor: border,
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  searchInput: {
    color: text,
    flex: 1,
    fontSize: 16,
  },
  metaText: {
    color: muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  sections: {
    gap: 20,
  },
  rail: {
    gap: 10,
  },
  sectionTitle: {
    color: text,
    fontSize: 22,
    fontWeight: '600',
  },
  railContent: {
    gap: 14,
    paddingRight: 20,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  posterCard: {
  },
  posterFrame: {
    aspectRatio: 2 / 3,
    backgroundColor: panel2,
    borderRadius: 8,
    overflow: 'hidden',
  },
  posterImage: {
    height: '100%',
    width: '100%',
  },
  posterFallback: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 10,
  },
  posterTitle: {
    color: text,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
    marginTop: 8,
  },
  emptyLibrary: {
    alignItems: 'center',
    backgroundColor: panel,
    borderColor: border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 24,
  },
  emptyLibraryTablet: {
    maxWidth: 520,
  },
  emptyIcon: {
    alignItems: 'center',
    backgroundColor: panel2,
    borderColor: border,
    borderRadius: 24,
    borderWidth: 1,
    height: 72,
    justifyContent: 'center',
    width: 72,
  },
  emptyIconText: {
    color: accent,
    fontSize: 30,
    fontWeight: '600',
  },
  emptyInline: {
    alignItems: 'center',
    backgroundColor: panel,
    borderColor: border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 24,
  },
  emptyTitle: {
    color: text,
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptyCopy: {
    color: muted,
    fontSize: 14,
    lineHeight: 21,
    maxWidth: 420,
    textAlign: 'center',
  },
  settingsPage: {
    alignSelf: 'center',
    gap: 16,
    maxWidth: settingsContentMaxWidth,
    width: '100%',
  },
  settingsProfile: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 22,
  },
  settingsAvatar: {
    alignItems: 'center',
    backgroundColor: accent,
    borderColor: accentBorder,
    borderRadius: 36,
    borderWidth: 1,
    height: 72,
    justifyContent: 'center',
    shadowColor: accent,
    shadowOpacity: 0.22,
    shadowRadius: 18,
    width: 72,
  },
  settingsAvatarText: {
    color: accentForeground,
    fontSize: 18,
    fontWeight: '700',
  },
  settingsProfileTitle: {
    color: text,
    fontSize: 25,
    fontWeight: '700',
    lineHeight: 31,
    marginTop: 12,
  },
  settingsProfileCopy: {
    color: muted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
    maxWidth: 300,
    textAlign: 'center',
  },
  settingsList: {
    paddingTop: 2,
  },
  settingsListItem: {
    alignItems: 'center',
    borderBottomColor: 'rgba(148,163,184,0.18)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 16,
    minHeight: 56,
  },
  settingsListText: {
    color: text,
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
  },
  settingsDetailHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 4,
  },
  settingsBackButton: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    marginLeft: -7,
    width: 32,
  },
  settingsDetailTitle: {
    color: text,
    flex: 1,
    fontSize: 25,
    fontWeight: '700',
    lineHeight: 31,
  },
  settingsCards: {
    gap: 12,
    width: '100%',
  },
  settingsCard: {
    backgroundColor: panel,
    borderColor: border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  settingsCardTitle: {
    color: text,
    fontSize: 18,
    fontWeight: '600',
  },
  settingsCardCopy: {
    color: muted,
    flexShrink: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  settingsValue: {
    backgroundColor: '#080808',
    borderColor: border,
    borderRadius: 10,
    borderWidth: 1,
    color: text,
    fontSize: 13,
    lineHeight: 18,
    padding: 12,
  },
  settingsMetricRows: {
    gap: settingsMetricGap,
  },
  settingsMetricRow: {
    flexDirection: 'row',
    gap: settingsMetricGap,
  },
  settingsMetric: {
    alignItems: 'center',
    backgroundColor: panel2,
    borderColor: border,
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 11,
    minHeight: 70,
    minWidth: 0,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  settingsMetricIcon: {
    alignItems: 'center',
    backgroundColor: accentSoft,
    borderColor: accentBorder,
    borderRadius: 11,
    borderWidth: 1,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  settingsMetricCopy: {
    flex: 1,
    minWidth: 0,
  },
  settingsMetricValue: {
    color: accent,
    fontSize: 21,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    lineHeight: 25,
  },
  settingsMetricLabel: {
    color: muted,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
  },
  settingsPrimaryButton: {
    alignItems: 'center',
    backgroundColor: accent,
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 16,
  },
  settingsPrimaryButtonText: {
    color: accentForeground,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
    textAlign: 'center',
  },
  settingsDangerButton: {
    alignItems: 'center',
    borderColor: 'rgba(239,68,68,0.45)',
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
  },
  settingsDangerButtonText: {
    color: '#ff9a8f',
    fontSize: 14,
    fontWeight: '700',
  },
  bottomNav: {
    backgroundColor: 'rgba(18,18,18,0.98)',
    borderColor: '#252525',
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    paddingHorizontal: 6,
    paddingTop: 8,
    position: 'absolute',
    right: 0,
    zIndex: 24,
  },
  bottomNavBlur: {
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  bottomNavRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-evenly',
  },
  bottomNavButton: {
    alignItems: 'center',
    flex: 1,
    gap: 4,
    minHeight: 52,
    justifyContent: 'center',
  },
  bottomNavIconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 26,
    minWidth: 32,
  },
  bottomNavLabel: {
    color: faint,
    fontSize: 10,
    fontWeight: '600',
  },
  bottomNavLabelActive: {
    color: text,
  },
  miniPlayerWrap: {
    left: 12,
    position: 'absolute',
    right: 12,
    zIndex: 26,
  },
  miniPlayerStrip: {
    alignItems: 'center',
    backgroundColor: 'rgba(34,34,34,0.88)',
    borderColor: 'rgba(255,255,255,0.13)',
    borderRadius: 14,
    borderWidth: 1,
    elevation: 8,
    flexDirection: 'row',
    minHeight: 62,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.34,
    shadowRadius: 18,
  },
  miniPlayerBlur: {
    backgroundColor: 'rgba(36,36,36,0.58)',
  },
  miniPlayerMain: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 62,
    minWidth: 0,
    paddingLeft: 10,
    paddingVertical: 8,
  },
  miniPlayerThumb: {
    alignItems: 'center',
    backgroundColor: panel2,
    borderRadius: 9,
    height: 42,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 56,
  },
  miniPlayerThumbImage: {
    height: '100%',
    width: '100%',
  },
  miniPlayerThumbFallback: {
    alignItems: 'center',
    backgroundColor: accent,
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  miniPlayerThumbBadge: {
    alignItems: 'center',
    backgroundColor: accent,
    borderRadius: 999,
    bottom: 4,
    height: 18,
    justifyContent: 'center',
    position: 'absolute',
    right: 4,
    width: 18,
  },
  miniPlayerText: {
    flex: 1,
    minWidth: 0,
  },
  miniPlayerTitle: {
    color: text,
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 19,
  },
  miniPlayerMeta: {
    color: muted,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
    marginTop: 1,
  },
  miniPlayerDismiss: {
    alignItems: 'center',
    height: 54,
    justifyContent: 'center',
    width: 48,
  },
  pressed: {
    opacity: 0.6,
  },
  playerControlPressed: {
    transform: [{ scale: 0.96 }],
  },
  overlay: {
    backgroundColor: bg,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 20,
  },
  detailScroll: {
    paddingBottom: 48,
  },
  detailHero: {
    position: 'relative',
    width: '100%',
  },
  detailBackdrop: {
    height: '100%',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    width: '100%',
  },
  detailBack: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.9)',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    left: 16,
    position: 'absolute',
    width: 44,
    zIndex: 5,
  },
  detailRefreshPosterButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(16,16,16,0.9)',
    borderColor: border,
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 16,
    width: 44,
    zIndex: 5,
  },
  posterSheetOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
    zIndex: 35,
  },
  posterSheet: {
    backgroundColor: panel,
    borderColor: border,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderWidth: 1,
    maxHeight: '86%',
    paddingHorizontal: 18,
    paddingTop: 10,
  },
  posterSheetHandle: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.28)',
    borderRadius: 999,
    height: 4,
    marginBottom: 14,
    width: 42,
  },
  posterSheetHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  posterSheetTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  posterSheetEyebrow: {
    color: accent,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  posterSheetTitle: {
    color: text,
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 25,
    marginTop: 2,
  },
  posterSheetClose: {
    alignItems: 'center',
    backgroundColor: panel2,
    borderColor: border,
    borderRadius: 20,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  posterSheetError: {
    color: '#ff9b8d',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 10,
  },
  posterCandidateList: {
    gap: 12,
    paddingBottom: 10,
  },
  posterCandidateCard: {
    backgroundColor: panel2,
    borderColor: border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 10,
  },
  posterCandidateTop: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
  posterCandidateImage: {
    backgroundColor: '#0d0d0d',
    borderRadius: 10,
    height: 112,
    overflow: 'hidden',
    width: 76,
  },
  posterCandidateInfo: {
    flex: 1,
    minWidth: 0,
  },
  posterCandidateTitle: {
    color: text,
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 20,
  },
  posterCandidateDetails: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  posterCandidateYear: {
    color: muted,
    fontSize: 12,
    fontWeight: '700',
  },
  posterCandidateSource: {
    borderColor: border,
    borderRadius: 999,
    borderWidth: 1,
    color: muted,
    fontSize: 11,
    fontWeight: '800',
    lineHeight: 16,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  posterCandidateRating: {
    alignItems: 'center',
    backgroundColor: 'rgba(245,196,81,0.15)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  posterCandidateRatingText: {
    color: '#f5c451',
    fontSize: 11,
    fontWeight: '900',
    lineHeight: 14,
  },
  posterCandidateSummary: {
    color: muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 7,
  },
  posterCandidateCover: {
    backgroundColor: '#0d0d0d',
    borderRadius: 9,
    height: 52,
    overflow: 'hidden',
    width: '100%',
  },
  posterCandidateCoverFallback: {
    alignItems: 'center',
    backgroundColor: '#0d0d0d',
    borderRadius: 9,
    height: 52,
    justifyContent: 'center',
    width: '100%',
  },
  posterCandidateCoverFallbackText: {
    color: faint,
    fontSize: 11,
    fontWeight: '700',
  },
  posterCandidateEpisodes: {
    backgroundColor: panel,
    borderColor: border,
    borderRadius: 10,
    borderWidth: 1,
    gap: 3,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  posterCandidateEpisodesLabel: {
    color: faint,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    lineHeight: 14,
    textTransform: 'uppercase',
  },
  posterCandidateEpisodeName: {
    color: muted,
    fontSize: 12,
    lineHeight: 16,
  },
  posterCandidateGenres: {
    flex: 1,
    color: muted,
    fontSize: 11,
    lineHeight: 16,
  },
  posterCandidateFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  posterCandidateFooterSpacer: {
    flex: 1,
  },
  posterCandidateApply: {
    alignItems: 'center',
    backgroundColor: accent,
    borderRadius: 999,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 40,
    minWidth: 84,
    paddingHorizontal: 12,
  },
  posterCandidateApplyText: {
    color: accentForeground,
    fontSize: 13,
    fontWeight: '900',
  },
  posterCandidateEmpty: {
    alignItems: 'center',
    borderColor: border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
    padding: 22,
  },
  posterCandidateEmptyTitle: {
    color: text,
    fontSize: 16,
    fontWeight: '800',
  },
  posterCandidateEmptyCopy: {
    color: muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  detailTitle: {
    color: text,
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 35,
    textAlign: 'center',
  },
  detailMeta: {
    color: muted,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  detailRatingRow: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(245,196,81,0.15)',
    borderColor: 'rgba(245,196,81,0.24)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  detailRatingText: {
    color: '#f5c451',
    fontSize: 14,
    fontWeight: '800',
  },
  detailBody: {
    gap: 16,
    marginTop: -32,
    paddingHorizontal: 20,
  },
  playButton: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    marginTop: 6,
    minHeight: 56,
  },
  playButtonText: {
    color: '#0b0b0b',
    fontSize: 18,
    fontWeight: '700',
  },
  detailErrorText: {
    color: '#ff8c78',
    fontSize: 13,
    lineHeight: 18,
  },
  detailSummary: {
    color: muted,
    fontSize: 14,
    lineHeight: 21,
  },
  detailSummaryBlock: {
    gap: 8,
  },
  detailSummaryToggle: {
    alignSelf: 'flex-start',
    minHeight: 32,
    justifyContent: 'center',
  },
  detailSummaryToggleText: {
    color: accent,
    fontSize: 14,
    fontWeight: '800',
  },
  episodesSection: {
    gap: 12,
    paddingTop: 4,
  },
  episodesHeading: {
    color: text,
    fontSize: 21,
    fontWeight: '700',
  },
  episodesSubheading: {
    color: text,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 4,
  },
  seasonRailContent: {
    gap: 12,
    paddingRight: 20,
  },
  seasonCard: {
    gap: 6,
    width: 148,
  },
  seasonCardFrame: {
    aspectRatio: 16 / 9,
    backgroundColor: panel2,
    borderColor: 'transparent',
    borderRadius: 10,
    borderWidth: 2,
    overflow: 'hidden',
  },
  seasonCardFrameActive: {
    borderColor: accent,
  },
  seasonCardImage: {
    height: '100%',
    width: '100%',
  },
  seasonCardFallback: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  seasonCardFallbackText: {
    color: accent,
    fontSize: 24,
    fontWeight: '800',
  },
  seasonCardTitle: {
    color: muted,
    fontSize: 13,
    fontWeight: '700',
  },
  seasonCardTitleActive: {
    color: text,
  },
  seasonCardMeta: {
    color: faint,
    fontSize: 11,
    fontWeight: '600',
  },
  episodeList: {
    gap: 8,
  },
  episodeRow: {
    alignItems: 'center',
    backgroundColor: panel,
    borderColor: border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  episodeRowWatched: {
    opacity: 0.62,
  },
  episodeThumb: {
    backgroundColor: panel2,
    borderRadius: 8,
    height: 54,
    overflow: 'hidden',
    position: 'relative',
    width: 86,
  },
  episodeThumbImage: {
    height: '100%',
    width: '100%',
  },
  episodeThumbFallback: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  episodeIndex: {
    alignItems: 'center',
    backgroundColor: panel2,
    borderRadius: 8,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  episodeIndexText: {
    color: accent,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  episodeInfo: {
    flex: 1,
    gap: 3,
  },
  episodeTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  episodeTitle: {
    color: text,
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
  },
  episodeTitleWatched: {
    color: muted,
  },
  episodeMeta: {
    color: faint,
    fontSize: 12,
    fontWeight: '600',
  },
  resumePill: {
    color: accent,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  watchedBadge: {
    alignItems: 'center',
    backgroundColor: '#20c55d',
    borderRadius: 999,
    height: 20,
    justifyContent: 'center',
    position: 'absolute',
    right: 5,
    top: 5,
    width: 20,
  },
  episodeProgressTrack: {
    backgroundColor: 'rgba(255,255,255,0.24)',
    bottom: 0,
    height: 3,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  episodeProgressFill: {
    backgroundColor: accent,
    height: '100%',
  },
  emptyEpisodesCard: {
    backgroundColor: panel,
    borderColor: border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
    padding: 14,
  },
  emptyEpisodesTitle: {
    color: text,
    fontSize: 15,
    fontWeight: '600',
  },
  emptyEpisodesCopy: {
    color: muted,
    fontSize: 13,
    lineHeight: 18,
  },
  playerRoot: {
    alignItems: 'center',
    backgroundColor: '#000000',
    justifyContent: 'center',
    zIndex: 30,
  },
  playerVideo: {
    flex: 1,
    width: '100%',
  },
  playerStatus: {
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 32,
  },
  playerStatusText: {
    color: muted,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  playerStatusTitle: {
    color: text,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  playerRecoveryText: {
    color: faint,
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 420,
    textAlign: 'center',
  },
  playerStatusButton: {
    alignItems: 'center',
    borderColor: border,
    borderRadius: 11,
    borderWidth: 1,
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  playerStatusButtonText: {
    color: text,
    fontSize: 14,
    fontWeight: '700',
  },
  playerClose: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 16,
    width: 44,
  },
  playerControls: {
    backgroundColor: 'rgba(0,0,0,0.42)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  playerTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'space-between',
  },
  playerTopTitle: {
    color: muted,
    flex: 1,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
  },
  playerTitle: {
    color: text,
    fontSize: 21,
    fontWeight: '800',
  },
  playerIconButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  playerOptionsPill: {
    alignItems: 'center',
    backgroundColor: 'rgba(18,18,18,0.72)',
    borderRadius: 999,
    flexDirection: 'row',
    paddingHorizontal: 6,
  },
  playerCenterOverlay: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  playerCenterRow: {
    alignItems: 'center',
    height: 104,
    justifyContent: 'center',
    position: 'relative',
    width: 392,
  },
  playerSkipButton: {
    alignItems: 'center',
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  playerSkipBackControl: {
    left: '50%',
    marginLeft: -176,
    marginTop: -32,
    position: 'absolute',
    top: '50%',
  },
  playerSkipForwardControl: {
    left: '50%',
    marginLeft: 112,
    marginTop: -32,
    position: 'absolute',
    top: '50%',
  },
  playerSkipLabel: {
    color: text,
    fontSize: 9,
    fontWeight: '800',
    marginTop: 1,
    position: 'absolute',
  },
  playerPlayButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 999,
    height: 76,
    justifyContent: 'center',
    width: 76,
  },
  playerPlayCenterControl: {
    left: '50%',
    marginLeft: -38,
    marginTop: -38,
    position: 'absolute',
    top: '50%',
  },
  playerBottomBlock: {
    bottom: 28,
    gap: 6,
    left: 28,
    position: 'absolute',
    right: 28,
  },
  playerTimesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  playerTime: {
    color: text,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  playerSeekTrackHit: {
    justifyContent: 'center',
    minHeight: 32,
  },
  playerMenuPanel: {
    backgroundColor: 'rgba(14,14,14,0.96)',
    borderColor: 'rgba(255,255,255,0.09)',
    borderRadius: 16,
    borderWidth: 1,
    maxHeight: 260,
    minWidth: 250,
    paddingBottom: 6,
    position: 'absolute',
  },
  playerMenuScroll: {
    paddingHorizontal: 6,
  },
  playerMenuTitle: {
    color: muted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    textTransform: 'uppercase',
  },
  playerMenuRow: {
    alignItems: 'center',
    borderRadius: 10,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 44,
    paddingHorizontal: 12,
  },
  playerMenuRowText: {
    color: text,
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 19,
  },
  playerMenuRowTextActive: {
    color: accent,
  },
  playerMenuEmpty: {
    color: faint,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  playerSeekTrack: {
    backgroundColor: 'rgba(255,255,255,0.28)',
    borderRadius: 2,
    height: 4,
  },
  playerSeekFill: {
    backgroundColor: accent,
    borderRadius: 2,
    height: '100%',
  },
  playerSeekThumb: {
    backgroundColor: accent,
    borderRadius: 7,
    height: 14,
    marginLeft: -7,
    position: 'absolute',
    top: -5,
    width: 14,
  },
  playerGestureHint: {
    alignItems: 'center',
    backgroundColor: 'rgba(12,12,12,0.82)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 16,
    borderWidth: 1,
    left: '50%',
    marginLeft: -82,
    marginTop: -43,
    paddingHorizontal: 18,
    paddingVertical: 12,
    position: 'absolute',
    top: '50%',
    width: 164,
  },
  playerGestureTitle: {
    color: text,
    fontSize: 13,
    fontWeight: '800',
  },
  playerGestureTrack: {
    backgroundColor: 'rgba(255,255,255,0.24)',
    borderRadius: 99,
    height: 5,
    marginTop: 10,
    overflow: 'hidden',
    width: '100%',
  },
  playerGestureFill: {
    backgroundColor: accent,
    borderRadius: 99,
    height: '100%',
  },
  playerGestureValue: {
    color: muted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 6,
  },
});
}

let styles = createStyles(DEFAULT_MOBILE_THEME);
