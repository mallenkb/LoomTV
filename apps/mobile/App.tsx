import { StatusBar } from 'expo-status-bar';
import * as Brightness from 'expo-brightness';
import * as Device from 'expo-device';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  type AppStateStatus,
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
  Switch,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image as ExpoImage, type ImageContentFit } from 'expo-image';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as SecureStore from 'expo-secure-store';
import {
  VideoView,
  useVideoPlayer,
  type AudioTrack,
  type PlayerError,
  type SubtitleTrack,
  type VideoPlayerStatus,
  type VideoSource,
} from 'expo-video';
import Zeroconf, { type ZeroconfService } from 'react-native-zeroconf';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect as SvgRect, Stop } from 'react-native-svg';
import {
  AudioTracksIcon,
  AutoThemeIcon,
  BackIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  FilterIcon,
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
  MoonIcon,
  SunIcon,
  StarIcon,
  SubtitlesIcon,
  UserCircleIcon,
  UserCircleSolidIcon,
  navIcons,
  type IconProps,
} from './components/LoomIcons';
import {
  playbackFailureFromResponse,
  playbackFailureFromUnknown,
  playbackLoadFailure,
  recoveryActionFor,
  restorePortraitWithRetry,
  type PlaybackFailure,
} from './playbackRecovery';
import { mobileAbsoluteMediaSeconds, mobilePlayerSecondsForAbsolute } from './playbackClock';
import {
  createStyles,
  settingsContentMaxWidth,
  type MobileThemeColors,
} from './mobileStyles';
import { createMobileLanClient } from './mobileLanClient';
import {
  configureSecureLanTransport,
  probeLanCertificate,
  secureLanUrl,
} from './mobileSecureTransport';
import {
  mobileReconnectDelayMs,
  rebuildMobileDetailItemCache,
  rememberMobileDetailItem,
} from './mobileDomain';
import { MobileThemeProvider, useMobileTheme } from './mobileThemeContext';
import {
  MOBILE_THEME_COLOR_OPTIONS,
  mobileThemeFromSettings,
  type MobileThemeColor,
  type MobileThemeMode,
  type ResolvedMobileThemeMode,
} from './mobileTheme';
import {
  allItems,
  collections,
  episodeCode,
  episodePlayTarget,
  filePathFromUrl,
  libraryWithPlayedItem,
  matchesMobileLibraryFilter,
  matchesMobileSearchScope,
  matchesQuery,
  playTargetForItem,
  progressStateFor,
  shouldTranscode,
  sortedEpisodes,
  streamPathFor,
} from './mobileLibrary';
import type {
  ApiResult,
  Connection,
  DiscoveredHost,
  EpisodeFile,
  HlsSession,
  LibraryKind,
  LibraryPayload,
  LocalMediaTrack,
  MediaItem,
  MediaSegment,
  MobileActiveProfile,
  MobileProfile,
  MobileProfileListEntry,
  MobileProfilePreferences,
  MobileLibraryFilter,
  MobileSearchScope,
  OfficialArtworkResponse,
  OfficialMetadataCandidate,
  PairResponse,
  PlaybackTrackPreferences,
  PlayTarget,
  PosterCandidateSheetState,
  SavedConnection,
  SettingsSection,
  StoredProgress,
  StreamOptions,
  SubtitleRecord,
  TrackPreference,
} from './mobileDomain';
import { activeKnownMediaSegmentAt, mobileMediaSegmentLabel } from './mobileDomain';

type PlayerVerticalGesture = 'brightness' | 'volume';
type PlayerAspectRatio = 'default' | '4 / 3' | '16 / 9' | '16 / 10' | '21 / 9' | '5 / 4';
type PlayerCropMode = 'none' | '4 / 3' | '16 / 9' | '16 / 10' | '21 / 9' | '5 / 4' | 'custom';
type PlayerRotation = 0 | 90 | 180 | 270;

const PLAYER_ASPECT_OPTIONS: { value: PlayerAspectRatio; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: '4 / 3', label: '4:3' },
  { value: '16 / 9', label: '16:9' },
  { value: '16 / 10', label: '16:10' },
  { value: '21 / 9', label: '21:9' },
  { value: '5 / 4', label: '5:4' },
];

const PLAYER_CROP_OPTIONS: { value: PlayerCropMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: '4 / 3', label: '4:3' },
  { value: '16 / 9', label: '16:9' },
  { value: '16 / 10', label: '16:10' },
  { value: '21 / 9', label: '21:9' },
  { value: '5 / 4', label: '5:4' },
  { value: 'custom', label: 'Custom…' },
];

const PLAYER_ROTATION_OPTIONS: { value: PlayerRotation; label: string }[] = [
  { value: 0, label: '0°' },
  { value: 90, label: '90°' },
  { value: 180, label: '180°' },
  { value: 270, label: '270°' },
];

const SAVED_CONNECTION_KEY = 'loomtv.saved-connection.v2';
const MOBILE_DEVICE_ID_KEY = 'loomtv.mobile-device-id.v1';
const MOBILE_THEME_MODE_KEY = 'loomtv.mobile-theme-mode.v1';
const MOBILE_THEME_COLOR_KEY = 'loomtv.mobile-theme-color.v1';
const MOBILE_SUBTITLE_FONT_SIZE_KEY = 'loomtv.mobile-subtitle-font-size.v1';
const DEFAULT_MOBILE_SUBTITLE_FONT_SIZE = 64;
const MOBILE_SUBTITLE_SIZE_OPTIONS = [
  { value: 32, label: '100%' },
  { value: 48, label: '150%' },
  { value: 64, label: '200%' },
  { value: 80, label: '250%' },
  { value: 96, label: '300%' },
];
const mobileLanClient = createMobileLanClient();
const PROFILE_COLOR_HEX: Record<string, string> = {
  ember: 'f97316',
  gold: 'f59e0b',
  crimson: 'dc3f4f',
  ocean: '207ce5',
  violet: '8551dc',
  teal: '24a9a1',
  rose: 'de3d72',
  slate: '64748b',
};

function mobileProfileAvatarUri(profile: Pick<MobileProfile, 'avatarKey' | 'colorKey'>): string {
  if (profile.avatarKey.startsWith('data:image/')) return profile.avatarKey;
  const match = /(?:glyph|weave)-(\d+)$/.exec(profile.avatarKey);
  const parsed = match ? Number.parseInt(match[1], 10) : 1;
  const variantNumber = Number.isFinite(parsed) && parsed > 0 ? ((parsed - 1) % 12) + 1 : 1;
  const variant = String(variantNumber).padStart(2, '0');
  const color = PROFILE_COLOR_HEX[profile.colorKey] || PROFILE_COLOR_HEX.ember;
  const params = new URLSearchParams({
    seed: `loomtv-glyph-${variant}`,
    shapeVariant: `variant${variant}`,
    backgroundColor: color,
    backgroundColorFill: 'solid',
    glyphColor: color,
    glyphColorFill: 'solid',
    size: '256',
  });
  return `https://api.dicebear.com/10.x/glyphs/png?${params.toString()}`;
}

function mobileDeviceName(): string {
  return Device.deviceName?.trim()
    || Device.modelName?.trim()
    || (Platform.OS === 'android' ? 'LoomTV Android' : 'LoomTV iOS');
}

type LibraryMetric = {
  key: string;
  label: string;
  value: number;
  Icon: (props: IconProps) => ReactElement;
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

const settingsPageHorizontalPadding = 32;
const settingsCardHorizontalPadding = 32;
const imageLoadTimeoutMs = 8000;
const imageRetryDelayMs = 12000;
const imageCacheBustQueryParam = 'loomtvImageBust';
const serverOfflineHint = 'The desktop app or Local Network Sharing may be off. LoomTV will reconnect automatically when it becomes available.';

// Coupang Play-style top category tabs shown under the logo on library pages.
// The bottom nav shrinks to Home / Search / Settings; these tabs carry the
// library kinds instead.
const settingsSections: { id: SettingsSection; label: string; description: string }[] = [
  { id: 'library', label: 'Library', description: 'Refresh and review the paired desktop library.' },
  { id: 'network', label: 'Network', description: 'Pairing status and desktop connection details.' },
  { id: 'appearance', label: 'Appearance', description: 'Choose a light or dark theme for this device.' },
  { id: 'about', label: 'About', description: 'App information and third-party attribution.' },
];

const MOBILE_OPEN_SOURCE_NOTICES = [
  { name: 'Expo', license: 'MIT' },
  { name: '@expo/vector-icons', license: 'MIT' },
  { name: 'expo-blur', license: 'MIT' },
  { name: 'expo-brightness', license: 'MIT' },
  { name: 'expo-build-properties', license: 'MIT' },
  { name: 'expo-device', license: 'MIT' },
  { name: 'expo-image', license: 'MIT' },
  { name: 'expo-screen-orientation', license: 'MIT' },
  { name: 'expo-secure-store', license: 'MIT' },
  { name: 'expo-status-bar', license: 'MIT' },
  { name: 'expo-video', license: 'MIT' },
  { name: 'React', license: 'MIT' },
  { name: 'React Native', license: 'MIT' },
  { name: 'react-native-safe-area-context', license: 'MIT' },
  { name: 'react-native-svg', license: 'MIT' },
  { name: 'react-native-zeroconf', license: 'MIT' },
] as const;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter the desktop app address.');
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'https:') throw new Error('Enter a secure HTTPS desktop address.');
  return parsed.origin;
}

function discoveredHostFromService(service: ZeroconfService): DiscoveredHost | null {
  const txt = service.txt || {};
  if (String(txt.protocolVersion || '') !== '2') return null;
  const deviceId = String(txt.instanceId || '').trim();
  const deviceName = String(service.name || '').trim();
  const certFingerprint = String(txt.certFingerprint || '').trim();
  const port = Number(service.port || 0);
  if (!deviceId || !Number.isInteger(port) || port <= 0 || !/^[0-9a-f]{64}$/i.test(certFingerprint)) return null;

  const serviceName = String(service.name || '').trim();
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
    baseUrl: `https://${resolvedHost}:${port}`,
    certFingerprint,
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

function formatShortMinutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// Stable empty list so the library feed keeps the same `data` reference in rails
// mode (rails render in the header; the grid data is intentionally empty).
const EMPTY_ITEMS: MediaItem[] = [];
const LIBRARY_SECTION_APPLY_DELAY_MS = 45;

function isHlsPlaybackUrl(playbackUrl: string): boolean {
  return playbackUrl.includes('.m3u8') || playbackUrl.includes('/hls/');
}

function videoSourceFor(playbackUrl: string, target?: PlayTarget | null, deviceToken?: string): VideoSource {
  return {
    uri: secureLanUrl(playbackUrl),
    contentType: isHlsPlaybackUrl(playbackUrl) ? 'hls' : 'auto',
    headers: deviceToken ? { Authorization: `Bearer ${deviceToken}` } : undefined,
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
  return Boolean(options.forceTranscode)
    || typeof options.audioTrackIndex === 'number'
    || typeof options.subtitleTrackIndex === 'number'
    || Boolean(options.subtitleFilePath);
}

function normalizeTrackField(value?: string): string {
  return (value || '').trim().toLowerCase();
}

function playbackPreferenceScope(target: Pick<PlayTarget, 'mediaId' | 'streamPath'>): string {
  return target.mediaId ? `media:${target.mediaId}` : `file:${filePathFromUrl(target.streamPath)}`;
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
  return secureLanUrl(appendImageCacheBust(url, cacheBust));
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
  const { styles } = useMobileTheme();
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
  const { styles } = useMobileTheme();
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

function SubpageBackButton({
  accessibilityLabel = 'Back',
  onPress,
  style,
}: {
  accessibilityLabel?: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { styles } = useMobileTheme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.subpageBackButton, style, pressed && styles.pressed]}
    >
      <BackIcon size={24} color="#ffffff" />
    </Pressable>
  );
}

function MobileProfilePicker({
  activeProfile,
  error,
  onSelect,
  pin,
  pinTarget,
  profiles,
  setPin,
  setPinTarget,
}: {
  activeProfile: MobileProfile | null;
  error: string;
  onSelect: (profile: MobileProfile, pin?: string) => void;
  pin: string;
  pinTarget: MobileProfile | null;
  profiles: MobileProfile[];
  setPin: (value: string) => void;
  setPinTarget: (profile: MobileProfile | null) => void;
}) {
  const { colors } = useMobileTheme();
  const insets = useSafeAreaInsets();
  if (pinTarget) {
    const append = (digit: string) => {
      const next = `${pin}${digit}`.slice(0, 4);
      setPin(next);
      if (next.length === 4) onSelect(pinTarget, next);
    };
    return (
      <View style={[mobileProfileStyles.screen, { backgroundColor: colors.bg }]}>
        <SubpageBackButton
          accessibilityLabel="Back to profiles"
          onPress={() => setPinTarget(null)}
          style={[mobileProfileStyles.pinBackButton, { top: insets.top + 12 }]}
        />
        <Text style={[mobileProfileStyles.title, { color: colors.text }]}>Enter PIN</Text>
        <Text style={{ color: colors.muted }}>Unlock {pinTarget.name}</Text>
        <View style={mobileProfileStyles.dots}>
          {[0, 1, 2, 3].map((index) => <View key={index} style={[mobileProfileStyles.dot, { backgroundColor: index < pin.length ? colors.text : colors.border }]} />)}
        </View>
        <View style={mobileProfileStyles.pinGrid}>
          {'123456789'.split('').map((digit) => (
            <Pressable key={digit} onPress={() => append(digit)} style={[mobileProfileStyles.pinKey, { backgroundColor: colors.panel }]}>
              <Text style={[mobileProfileStyles.pinText, { color: colors.text }]}>{digit}</Text>
            </Pressable>
          ))}
          <View style={mobileProfileStyles.pinKey} />
          <Pressable onPress={() => append('0')} style={[mobileProfileStyles.pinKey, { backgroundColor: colors.panel }]}><Text style={[mobileProfileStyles.pinText, { color: colors.text }]}>0</Text></Pressable>
          <Pressable onPress={() => setPin(pin.slice(0, -1))} style={mobileProfileStyles.pinKey}><Text style={{ color: colors.muted }}>Delete</Text></Pressable>
        </View>
        {error ? <Text style={mobileProfileStyles.error}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={[mobileProfileStyles.screen, { backgroundColor: colors.bg }]}>
      <LoomLogo width={132} height={44} wordColor={colors.text} />
      <Text style={[mobileProfileStyles.title, { color: colors.text }]}>Who’s watching?</Text>
      <View style={mobileProfileStyles.grid}>
        {profiles.map((profile) => (
          <Pressable
            key={profile.id}
            accessibilityRole="button"
            accessibilityLabel={`${profile.name}${profile.hasPin ? ', PIN protected' : ''}`}
            accessibilityState={{ selected: profile.id === activeProfile?.id }}
            onPress={() => profile.hasPin ? setPinTarget(profile) : onSelect(profile)}
            style={mobileProfileStyles.card}
          >
            <View style={[
              mobileProfileStyles.avatar,
              { backgroundColor: colors.panel, borderColor: colors.border },
            ]}>
              <ExpoImage source={{ uri: mobileProfileAvatarUri(profile) }} style={mobileProfileStyles.avatarImage} contentFit="cover" />
            </View>
            <Text numberOfLines={1} style={[mobileProfileStyles.name, { color: colors.text }]}>{profile.name}</Text>
            {profile.id === activeProfile?.id ? (
              <Text style={[mobileProfileStyles.activeProfileLabel, { color: colors.accent }]}>Active</Text>
            ) : null}
            {profile.hasPin ? <Text style={{ color: colors.muted, fontSize: 11 }}>PIN protected</Text> : null}
          </Pressable>
        ))}
      </View>
      {error ? <Text style={mobileProfileStyles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const mobileProfileStyles = StyleSheet.create({
  screen: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 56, gap: 12 },
  title: { fontSize: 30, fontWeight: '800', marginTop: 24 },
  grid: { width: '100%', maxWidth: 560, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 22, marginTop: 28 },
  card: { width: 116, alignItems: 'center', gap: 8 },
  avatar: { width: 104, height: 104, borderRadius: 52, borderWidth: 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%', borderRadius: 52 },
  avatarText: { fontSize: 42, fontWeight: '800' },
  name: { maxWidth: 116, fontSize: 15, fontWeight: '700' },
  activeProfileLabel: { fontSize: 12, fontWeight: '700', marginTop: -5 },
  pinBackButton: { left: 16, position: 'absolute' },
  dots: { flexDirection: 'row', gap: 14, marginVertical: 20 },
  dot: { width: 14, height: 14, borderRadius: 7 },
  pinGrid: { width: 276, flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  pinKey: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center' },
  pinText: { fontSize: 28, fontWeight: '700' },
  error: { color: '#f87171', textAlign: 'center', marginTop: 8 },
  settingsActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  settingsAction: { borderWidth: 1, borderRadius: 10, minHeight: 42, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  autoSignInRow: { width: '100%', maxWidth: 340, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, paddingHorizontal: 12 },
});

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
      <AppRoot />
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

  const [baseUrl, setBaseUrl] = useState('');
  const [shareCode, setShareCode] = useState('');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [profiles, setProfiles] = useState<MobileProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<MobileProfile | null>(null);
  const [automaticProfileSignIn, setAutomaticProfileSignIn] = useState(false);
  const [showProfilePicker, setShowProfilePicker] = useState(false);
  const [profilePinTarget, setProfilePinTarget] = useState<MobileProfile | null>(null);
  const [profilePin, setProfilePin] = useState('');
  const [profileError, setProfileError] = useState('');
  const [profileLists, setProfileLists] = useState<MobileProfileListEntry[]>([]);
  const profileHydrationGenerationRef = useRef(0);
  const [savedConnection, setSavedConnection] = useState<SavedConnection | null>(null);
  const [discoveredHosts, setDiscoveredHosts] = useState<DiscoveredHost[]>([]);
  const [isDiscoveringHosts, setIsDiscoveringHosts] = useState(true);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryScanNonce, setDiscoveryScanNonce] = useState(0);
  const [isRestoringConnection, setIsRestoringConnection] = useState(true);
  const [activeKind, setActiveKind] = useState<LibraryKind>('home');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchScope, setSearchScope] = useState<MobileSearchScope>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [libraryFilter, setLibraryFilter] = useState<MobileLibraryFilter>('all');
  const [detailItem, setDetailItem] = useState<MediaItem | null>(null);
  const [playTarget, setPlayTarget] = useState<PlayTarget | null>(null);
  const [miniPlayerTarget, setMiniPlayerTarget] = useState<PlayTarget | null>(null);
  const orientationLockQueueRef = useRef<Promise<void>>(Promise.resolve());
  const desiredOrientationLockRef = useRef<ScreenOrientation.OrientationLock | null>(null);
  const appliedOrientationLockRef = useRef<ScreenOrientation.OrientationLock | null>(null);
  const playerReturnItemRef = useRef<MediaItem | null>(null);
  const closingPlayerRef = useRef(false);
  const windowSizeRef = useRef({ height, width });
  windowSizeRef.current = { height, width };
  const detailItemCacheRef = useRef(new Map<string, MediaItem>());
  const lastDetailByKindRef = useRef(new Map<LibraryKind, MediaItem>());
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [streamOptions, setStreamOptions] = useState<StreamOptions>({});
  const shouldAutoplayRef = useRef(false);
  const userPausedRef = useRef(false);
  const pendingSeekRef = useRef(0);
  const autoAdvancedEpisodeRef = useRef<string | null>(null);
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
  const [playbackFailure, setPlaybackFailure] = useState<PlaybackFailure | null>(null);
  const [streamRetryNonce, setStreamRetryNonce] = useState(0);
  const [progress, setProgress] = useState<Record<string, StoredProgress>>({});
  const [homeHeaderPinned, setHomeHeaderPinned] = useState(false);
  const homeHeaderPinnedRef = useRef(false);
  const updateHomeHeaderPinned = useCallback((pinned: boolean) => {
    if (homeHeaderPinnedRef.current === pinned) return;
    homeHeaderPinnedRef.current = pinned;
    setHomeHeaderPinned(pinned);
  }, []);
  const homeHeaderAnimation = useRef(new Animated.Value(0)).current;
  const homeHeaderOpacity = homeHeaderAnimation.interpolate({
    inputRange: [0, 0.35, 1],
    outputRange: [0, 0.45, 1],
    extrapolate: 'clamp',
  });
  const homeHeaderTranslateY = homeHeaderAnimation.interpolate({
    inputRange: [0, 1],
    outputRange: [-14, 0],
    extrapolate: 'clamp',
  });
  const homeHeaderScale = homeHeaderAnimation.interpolate({
    inputRange: [0, 1],
    outputRange: [0.985, 1],
    extrapolate: 'clamp',
  });
  const initialResolvedThemeMode: ResolvedMobileThemeMode = 'dark';
  const [mobileTheme, setMobileTheme] = useState<MobileThemeColors>(() => (
    mobileThemeFromSettings(undefined, initialResolvedThemeMode)
  ));
  const [mobileThemeMode, setMobileThemeMode] = useState<MobileThemeMode>('dark');
  const [mobileThemeColor, setMobileThemeColor] = useState<MobileThemeColor>('yellow');
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const resolvedMobileThemeMode: ResolvedMobileThemeMode = mobileThemeMode === 'auto'
    ? (systemColorScheme === 'light' ? 'light' : 'dark')
    : mobileThemeMode;
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
  const reconnectingSavedConnectionRef = useRef(false);
  const connectionHealthCheckRef = useRef(false);
  const mobileDeviceIdRef = useRef('');
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const themedStyles = useMemo(() => createStyles(mobileTheme), [mobileTheme]);
  const themeContextValue = useMemo(() => ({ colors: mobileTheme, styles: themedStyles }), [mobileTheme, themedStyles]);
  const styles = themedStyles;
  const { accent, panel, text, muted } = mobileTheme;

  const navigateToKind = useCallback((kind: LibraryKind) => {
    if (kind === activeKind) {
      lastDetailByKindRef.current.delete(kind);
      setDetailItem(null);
      setSearchOpen(false);
      setQuery('');
      setSearchScope('all');
      setFilterOpen(false);
      setLibraryFilter('all');
      if (kind === 'settings') setSettingsSection(null);
      scrollOffsetsRef.current[kind] = 0;
      if (kind === 'settings') {
        settingsScrollRef.current?.scrollTo({ y: 0, animated: true });
      } else {
        libraryListRef.current?.scrollToOffset({ offset: 0, animated: true });
      }
      updateHomeHeaderPinned(false);
      return;
    }
    if (detailItem) lastDetailByKindRef.current.set(activeKind, detailItem);
    setDetailItem(kind === 'settings' ? null : lastDetailByKindRef.current.get(kind) || null);
    setSearchOpen(false);
    setQuery('');
    setSearchScope('all');
    setFilterOpen(false);
    setLibraryFilter('all');
    setActiveKind(kind);
    updateHomeHeaderPinned(false);
  }, [activeKind, detailItem, updateHomeHeaderPinned]);

  const selectMobileTheme = useCallback((next: MobileThemeMode) => {
    setMobileThemeMode(next);
    void SecureStore.setItemAsync(MOBILE_THEME_MODE_KEY, next).catch(() => {});
  }, []);

  const selectMobileThemeColor = useCallback((next: MobileThemeColor) => {
    setMobileThemeColor(next);
    void SecureStore.setItemAsync(MOBILE_THEME_COLOR_KEY, next).catch(() => {});
  }, []);

  const rememberMainScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = event.nativeEvent.contentOffset.y;
    if (query) return;
    scrollOffsetsRef.current[activeKind] = offset;
    if (activeKind === 'settings') {
      updateHomeHeaderPinned(false);
      return;
    }
    const shouldPin = offset > (homeHeaderPinnedRef.current ? 84 : 112);
    updateHomeHeaderPinned(shouldPin);
  }, [activeKind, query, updateHomeHeaderPinned]);

  useEffect(() => {
    const animation = homeHeaderPinned
      ? Animated.spring(homeHeaderAnimation, {
          damping: 22,
          isInteraction: false,
          mass: 0.72,
          stiffness: 250,
          toValue: 1,
          useNativeDriver: true,
        })
      : Animated.timing(homeHeaderAnimation, {
          duration: 150,
          easing: Easing.out(Easing.cubic),
          isInteraction: false,
          toValue: 0,
          useNativeDriver: true,
        });
    animation.start();
    return () => animation.stop();
  }, [homeHeaderAnimation, homeHeaderPinned]);

  useEffect(() => {
    if (activeKind !== 'settings' && !query) return;
    updateHomeHeaderPinned(false);
  }, [activeKind, query, updateHomeHeaderPinned]);

  useEffect(() => {
    if (!searchOpen) return;
    updateHomeHeaderPinned(false);
    const frame = requestAnimationFrame(() => {
      libraryListRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchOpen, updateHomeHeaderPinned]);

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
    const subscription = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;
      setAppState(nextState);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void SecureStore.getItemAsync(MOBILE_DEVICE_ID_KEY)
      .then((deviceId) => { if (!cancelled && deviceId) mobileDeviceIdRef.current = deviceId; })
      .catch(() => {});
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
        const saved = JSON.parse(stored) as SavedConnection;
        if (
          !saved.baseUrl
          || !saved.deviceId
          || !saved.deviceToken
          || !saved.refreshToken
          || !Number.isFinite(saved.accessTokenExpiresAt)
          || !Number.isFinite(saved.refreshTokenExpiresAt)
        ) return;
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
    // This runs once to restore the saved session; the callback only uses refs,
    // setters, and the saved value, so it is intentionally not reactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      try { zeroconf.stop(); } catch { /* Zeroconf may already be stopped. */ }
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
    // Keep the reconnect cadence tied to saved-session state, not callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, discoveredHosts, savedConnection]);

  useEffect(() => {
    if (!savedConnection || connection || appState !== 'active') return;
    let cancelled = false;
    let failedAttempts = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delayMs: number) => {
      retry = setTimeout(() => { void tryReconnect(); }, delayMs);
    };
    const tryReconnect = async () => {
      if (cancelled || appStateRef.current !== 'active') return;
      const connected = await reconnectSavedConnection(savedConnection);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState, connection, savedConnection]);

  useEffect(() => {
    if (!connection || appState !== 'active') return;
    const healthCheck = setInterval(() => void checkDesktopConnection(), 10000);
    return () => clearInterval(healthCheck);
    // These connection fields intentionally own the health-check lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState, connection?.baseUrl, connection?.deviceToken, connection?.libraryEtag]);

  useEffect(() => {
    if (!savedConnection || !connection) return undefined;
    const delay = Math.max(0, connection.accessTokenExpiresAt - Date.now() - 60_000);
    const timer = setTimeout(() => {
      void refreshSavedCredentials(savedConnection).catch(async () => {
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        setSavedConnection(null);
        setConnection(null);
        setError('Your secure session expired. Pair with the desktop again.');
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [connection, savedConnection]);

  // Browsing is portrait; video playback is locked to either landscape direction.
  // Serialize and deduplicate native lock requests: overlapping lockAsync calls can
  // deadlock Expo's iOS orientation registry while it dispatches an orientation event.
  useEffect(() => {
    const lock = playTarget ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP;
    if (desiredOrientationLockRef.current === lock && appliedOrientationLockRef.current === lock) return;

    desiredOrientationLockRef.current = lock;
    orientationLockQueueRef.current = orientationLockQueueRef.current
      .catch(() => {})
      .then(async () => {
        if (desiredOrientationLockRef.current !== lock || appliedOrientationLockRef.current === lock) return;
        await ScreenOrientation.lockAsync(lock);
        appliedOrientationLockRef.current = lock;
      })
      .catch(() => {});
  }, [playTarget]);

  useEffect(() => {
    setMobileTheme(mobileThemeFromSettings({ appThemeColor: mobileThemeColor }, resolvedMobileThemeMode));
  }, [mobileThemeColor, resolvedMobileThemeMode]);

  const library = useMemo(() => connection?.library || {}, [connection?.library]);
  const grouped = useMemo(() => collections(library), [library]);
  const everything = useMemo(() => allItems(library), [library]);
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

  useEffect(() => {
    detailItemCacheRef.current = rebuildMobileDetailItemCache(detailItemCacheRef.current, itemsById);
    const currentDetails = new Map<LibraryKind, MediaItem>();
    for (const [kind, item] of lastDetailByKindRef.current) {
      const currentItem = itemsById.get(item.id);
      if (currentItem) currentDetails.set(kind, currentItem);
    }
    lastDetailByKindRef.current = currentDetails;
  }, [itemsById]);

  const openDetailItem = useCallback((item: MediaItem) => {
    const cached = detailItemCacheRef.current.get(item.id) || item;
    rememberMobileDetailItem(detailItemCacheRef.current, cached);
    lastDetailByKindRef.current.set(activeKind, cached);
    setFilterOpen(false);
    setDetailItem(cached);
  }, [activeKind]);

  const closeDetail = useCallback(() => {
    lastDetailByKindRef.current.delete(activeKind);
    setDetailItem(null);
  }, [activeKind]);

  const setMobileProfileListEntry = useCallback(async (
    mediaId: string,
    kind: 'watchlist' | 'favorite',
    present: boolean,
  ) => {
    if (!connection) return;
    let response = await mobileLanClient.setProfileList(
      connection.baseUrl,
      connection.deviceToken,
      mediaId,
      kind,
      present,
      connection.selectionRevision,
    );
    if (!response.ok) throw new Error('The profile list could not be updated.');
    let nextLists = await response.json() as MobileProfileListEntry[];
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
      nextLists = await response.json() as MobileProfileListEntry[];
    }
    setProfileLists(nextLists);
  }, [connection]);

  const playHomeItem = useCallback((item: MediaItem) => {
    playerReturnItemRef.current = item;
    setDetailItem(null);
    setMiniPlayerTarget(null);
    setStreamOptions({});
    setPlayTarget(playTargetForItem(item, progress));
  }, [progress]);

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
    const currentFilePath = playTarget ? filePathFromUrl(playTarget.streamPath) : null;
    if (autoAdvancedEpisodeRef.current !== currentFilePath) {
      autoAdvancedEpisodeRef.current = null;
    }
  }, [playTarget]);

  useEffect(() => {
    let cancelled = false;

    async function loadSource() {
      try {
        if (!playbackUrl) {
          await player.replaceAsync(null);
          return;
        }

        await player.replaceAsync(videoSourceFor(playbackUrl, playTarget, connection?.deviceToken));
      } catch {
        if (!cancelled) {
          setPlaybackFailure(playbackLoadFailure());
        }
      }
    }

    void loadSource();
    return () => {
      cancelled = true;
    };
  }, [connection?.deviceToken, playbackUrl, playTarget, player]);

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
        } catch {
          // Native player readiness can lag behind this callback on some devices.
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
    // The listener intentionally captures the current progress callback for this
    // player session instead of re-registering on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.library, playbackUrl, playTarget, player, progress, streamOptions.forceTranscode]);

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

      setPlaybackFailure(null);
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
        const response = await mobileLanClient.startHls(
          connection.baseUrl,
          connection.deviceToken,
          filePathFromUrl(playTarget.streamPath),
          options,
          connection.selectionRevision,
        );
        const result = (await response.json()) as ApiResult<HlsSession>;
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
    };
    // streamOptionsKey is the stable serialized dependency for this preparation flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.baseUrl, connection?.deviceToken, connection?.selectionRevision, playTarget, streamOptionsKey, streamRetryNonce]);

  const retryPlayback = useCallback(() => {
    setPlaybackFailure(null);
    setPlaybackUrl(null);
    setStreamRetryNonce((current) => current + 1);
  }, []);

  async function syncPlaybackProgress(target = playTarget) {
    if (!connection || !target) return;
    let position: number;
    let duration: number;
    try {
      position = Number(player.currentTime || 0);
      duration = Number(player.duration || 0);
    } catch {
      return; // player already torn down — nothing to report
    }
    if (!Number.isFinite(position) || position <= 0) return;

    try {
      const response = await mobileLanClient.saveProgress(connection.baseUrl, connection.deviceToken, {
          mediaId: filePathFromUrl(target.streamPath),
          position,
          duration: Number.isFinite(duration) ? duration : 0,
          selectionRevision: connection.selectionRevision,
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

  const closePlayer = useCallback(async () => {
    if (closingPlayerRef.current) return;
    closingPlayerRef.current = true;

    // Keep the player mounted until Expo confirms the portrait lock. This
    // prevents the library from being revealed in a stale landscape layout.
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
        const cachedReturnItem = detailItemCacheRef.current.get(returnItemId) || itemsById.get(returnItemId);
        if (cachedReturnItem) {
          lastDetailByKindRef.current.set(activeKind, cachedReturnItem);
          setDetailItem(cachedReturnItem);
        }
      }
    } finally {
      closingPlayerRef.current = false;
    }
    // closePlayer intentionally keeps its current player-session callback stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKind, detailItem?.id, itemsById, playTarget, playbackFailure, player]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (playTarget) {
        void closePlayer();
        return true;
      }
      if (detailItem) {
        closeDetail();
        return true;
      }
      if (filterOpen) {
        setFilterOpen(false);
        return true;
      }
      if (searchOpen) {
        setSearchOpen(false);
        setQuery('');
        setSearchScope('all');
        return true;
      }
      if (activeKind !== 'home') {
        setActiveKind('home');
        return true;
      }
      return false;
    });

    return () => subscription.remove();
  }, [activeKind, closeDetail, closePlayer, detailItem, filterOpen, playTarget, searchOpen]);

  useEffect(() => {
    if (!playTarget || !playbackUrl) return undefined;
    const interval = setInterval(() => {
      void syncPlaybackProgress(playTarget);
    }, 15000);
    return () => clearInterval(interval);
    // The interval is keyed to the active player session, not callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playTarget, playbackUrl, connection?.baseUrl, connection?.deviceToken, connection?.selectionRevision, player]);

  async function hydrateProgress(nextConnection = connection) {
    if (!nextConnection) return;
    try {
      const response = await mobileLanClient.getProgress(nextConnection.baseUrl, nextConnection.deviceToken);
      if (!response.ok) return;
      setProgress((await response.json()) as Record<string, StoredProgress>);
    } catch {
      // Progress is additive UI state; pairing and browsing should still work without it.
    }
  }

  async function refreshSavedCredentials(saved: SavedConnection): Promise<SavedConnection> {
    const currentDeviceName = mobileDeviceName();
    const response = await mobileLanClient.refreshCredentials(saved.baseUrl, saved.refreshToken, currentDeviceName);
    if (!response.ok) throw new Error(`Credential refresh failed (${response.status}).`);
    const payload = (await response.json()) as Pick<PairResponse,
      'accessToken' | 'accessTokenExpiresAt' | 'refreshToken' | 'refreshTokenExpiresAt'>;
    const updated: SavedConnection = {
      ...saved,
      deviceToken: payload.accessToken,
      accessTokenExpiresAt: payload.accessTokenExpiresAt,
      refreshToken: payload.refreshToken,
      refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
      clientDeviceName: currentDeviceName,
    };
    await SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(updated));
    setSavedConnection(updated);
    setConnection((current) => current && current.deviceId === updated.deviceId
      ? { ...current, ...updated }
      : current);
    return updated;
  }

  async function hydrateSelectedProfile(nextConnection: Connection, profile: MobileProfile, activeState?: MobileActiveProfile): Promise<void> {
    const generation = ++profileHydrationGenerationRef.current;
    const [libraryResponse, progressResponse, preferencesResponse, listsResponse] = await Promise.all([
      mobileLanClient.getLibrary(nextConnection.baseUrl, nextConnection.deviceToken),
      mobileLanClient.getProgress(nextConnection.baseUrl, nextConnection.deviceToken),
      mobileLanClient.getProfilePreferences(nextConnection.baseUrl, nextConnection.deviceToken),
      mobileLanClient.getProfileLists(nextConnection.baseUrl, nextConnection.deviceToken),
    ]);
    if (generation !== profileHydrationGenerationRef.current) return;
    if (!libraryResponse.ok) throw new Error(`Desktop sharing is unavailable (${libraryResponse.status}).`);
    const library = await libraryResponse.json() as LibraryPayload;
    const hydratedConnection = {
      ...nextConnection,
      library,
      libraryEtag: libraryResponse.headers.get('ETag') || '',
      selectionRevision: activeState?.selectionRevision ?? nextConnection.selectionRevision,
    };
    setConnection(hydratedConnection);
    setActiveProfile(profile);
    setShowProfilePicker(false);
    setProfilePinTarget(null);
    setProfilePin('');
    setProfileError('');
    setProgress(progressResponse.ok ? await progressResponse.json() as Record<string, StoredProgress> : {});
    if (preferencesResponse.ok) {
      const preferences = await preferencesResponse.json() as MobileProfilePreferences;
      if (preferences.appThemeMode) setMobileThemeMode(preferences.appThemeMode);
      if (preferences.appThemeColor && MOBILE_THEME_COLOR_OPTIONS.some((option) => option.value === preferences.appThemeColor)) {
        setMobileThemeColor(preferences.appThemeColor as MobileThemeColor);
      }
    }
    setProfileLists(listsResponse.ok ? await listsResponse.json() as MobileProfileListEntry[] : []);
  }

  async function selectMobileProfile(nextConnection: Connection, profile: MobileProfile, pin?: string): Promise<void> {
    setProfileError('');
    const response = await mobileLanClient.selectProfile(nextConnection.baseUrl, nextConnection.deviceToken, {
      profileId: profile.id,
      ...(pin ? { pin } : {}),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string; retryAfterMs?: number };
      if (payload.error === 'profile_locked') {
        const wait = payload.retryAfterMs ? ` Try again in ${Math.ceil(payload.retryAfterMs / 1000)} seconds.` : '';
        throw new Error(`That PIN could not be accepted.${wait}`);
      }
      throw new Error('That profile could not be selected.');
    }
    const payload = await response.json() as { profile: MobileProfile; active: MobileActiveProfile };
    setAutomaticProfileSignIn(payload.active.automaticSignIn);
    await hydrateSelectedProfile(nextConnection, payload.profile, payload.active);
  }

  async function initializeProfiles(nextConnection: Connection): Promise<boolean> {
    const configResponse = await mobileLanClient.getClientConfig(nextConnection.baseUrl, nextConnection.deviceToken);
    if (!configResponse.ok) return false;
    const profilesResponse = await mobileLanClient.getProfiles(nextConnection.baseUrl, nextConnection.deviceToken);
    if (!profilesResponse.ok) return false;
    const payload = await profilesResponse.json() as { profiles: MobileProfile[] };
    setProfiles(payload.profiles);
    const activeResponse = await mobileLanClient.getActiveProfile(nextConnection.baseUrl, nextConnection.deviceToken);
    const activeState = activeResponse.ok ? await activeResponse.json() as MobileActiveProfile : null;
    setAutomaticProfileSignIn(Boolean(activeState?.automaticSignIn));
    const selected = payload.profiles.find((profile) => profile.id === activeState?.profileId);
    if (selected && activeState?.automaticSignIn) {
      await hydrateSelectedProfile(nextConnection, selected, activeState || undefined);
      return true;
    }
    setConnection({ ...nextConnection, library: {}, libraryEtag: '', selectionRevision: activeState?.selectionRevision });
    setActiveProfile(selected || null);
    setShowProfilePicker(true);
    return true;
  }

  async function refreshProfiles(nextConnection: Connection): Promise<void> {
    try {
      const response = await mobileLanClient.getProfiles(nextConnection.baseUrl, nextConnection.deviceToken);
      if (!response.ok) return;
      const payload = await response.json() as { profiles: MobileProfile[] };
      setProfiles(payload.profiles);
      setActiveProfile((current) => current
        ? payload.profiles.find((profile) => profile.id === current.id) || current
        : current);
    } catch {
      // Profile updates are opportunistic; the existing connection check reports real outages.
    }
  }

  async function reconnectSavedConnection(saved: SavedConnection): Promise<boolean> {
    if (appStateRef.current !== 'active' || reconnectingSavedConnectionRef.current) return false;
    reconnectingSavedConnectionRef.current = true;
    setIsServerOffline(false);
    try {
      const certFingerprint = String((saved as SavedConnection & { certFingerprint?: string }).certFingerprint || '');
      await configureSecureLanTransport(saved.baseUrl, certFingerprint);
      const activeSaved = saved.accessTokenExpiresAt <= Date.now() + 60_000
        || saved.clientDeviceName !== mobileDeviceName()
        ? await refreshSavedCredentials(saved)
        : saved;
      const baseConnection: Connection = { ...activeSaved, library: {}, libraryEtag: '' };
      const profileInitialized = await initializeProfiles(baseConnection);
      if (profileInitialized) {
        setBaseUrl(baseConnection.baseUrl);
        setError('');
        setIsServerOffline(false);
        return true;
      }
      const response = await mobileLanClient.getLibrary(activeSaved.baseUrl, activeSaved.deviceToken);
      if (response.status === 401) {
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        setSavedConnection(null);
        setError('This device is no longer authorized. Select the desktop and enter its current 6-digit pairing PIN.');
        return true;
      }
      if (!response.ok) throw new Error(`Desktop sharing is unavailable (${response.status}).`);
      const nextConnection: Connection = {
        ...activeSaved,
        library: (await response.json()) as LibraryPayload,
        libraryEtag: response.headers.get('ETag') || '',
      };
      setConnection(nextConnection);
      setBaseUrl(nextConnection.baseUrl);
      setError('');
      setIsServerOffline(false);
      void hydrateProgress(nextConnection);
      return true;
    } catch {
      setIsServerOffline(true);
      setError('');
      return false;
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
      const code = shareCode.trim();
      if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit pairing PIN from the desktop app.');
      const observedFingerprint = host?.certFingerprint
        ? host.certFingerprint.replace(/[^0-9a-f]/gi, '').toLowerCase()
        : await probeLanCertificate(nextBaseUrl);
      await configureSecureLanTransport(nextBaseUrl, observedFingerprint);

      const response = await mobileLanClient.pair(nextBaseUrl, {
          code,
          deviceId: mobileDeviceIdRef.current || undefined,
          deviceName: mobileDeviceName(),
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error('The sharing code was not accepted.');
        if (response.status === 429) {
          const retryAfterSeconds = Number.parseInt(response.headers.get('Retry-After') || '', 10);
          const waitMinutes = Number.isFinite(retryAfterSeconds) ? Math.max(1, Math.ceil(retryAfterSeconds / 60)) : 5;
          throw new Error(`Too many failed attempts. Wait ${waitMinutes} minutes, then use the current PIN from desktop Settings.`);
        }
        throw new Error(`Could not pair with the desktop app (${response.status}).`);
      }

      const payload = (await response.json()) as PairResponse;
      const pairedFingerprint = String((payload as PairResponse & { certFingerprint?: string }).certFingerprint || '')
        .replace(/[^0-9a-f]/gi, '').toLowerCase();
      if (pairedFingerprint !== observedFingerprint) {
        throw new Error('The desktop TLS identity changed during pairing. Refresh discovery and try again.');
      }
      const nextConnection = {
        baseUrl: nextBaseUrl,
        certFingerprint: pairedFingerprint,
        deviceId: payload.deviceId,
        deviceToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
        refreshToken: payload.refreshToken,
        refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
        hostDeviceId: payload.hostDeviceId || discoveredHosts.find((host) => host.baseUrl === nextBaseUrl)?.deviceId || '',
        hostDeviceName: payload.hostDeviceName || 'Loom Media Player Desktop',
        clientDeviceName: mobileDeviceName(),
        library: payload.library || {},
        libraryEtag: payload.libraryEtag,
      } as Connection & { certFingerprint: string };
      const nextSavedConnection = {
        baseUrl: nextConnection.baseUrl,
        certFingerprint: nextConnection.certFingerprint,
        deviceId: nextConnection.deviceId,
        deviceToken: nextConnection.deviceToken,
        accessTokenExpiresAt: nextConnection.accessTokenExpiresAt,
        refreshToken: nextConnection.refreshToken,
        refreshTokenExpiresAt: nextConnection.refreshTokenExpiresAt,
        hostDeviceId: nextConnection.hostDeviceId,
        hostDeviceName: nextConnection.hostDeviceName,
        clientDeviceName: nextConnection.clientDeviceName,
      } as SavedConnection & { certFingerprint: string };
      mobileDeviceIdRef.current = nextConnection.deviceId;
      await SecureStore.setItemAsync(MOBILE_DEVICE_ID_KEY, nextConnection.deviceId);
      await SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(nextSavedConnection));
      setSavedConnection(nextSavedConnection);
      setShareCode('');
      setIsServerOffline(false);
      if (!await initializeProfiles(nextConnection)) {
        setConnection(nextConnection);
        void hydrateProgress(nextConnection);
      }
    } catch (nextError) {
      const connectionError = connectionErrorFor(nextError, 'Pairing failed.');
      setError(connectionError.message);
      setIsServerOffline(connectionError.isOffline);
    } finally {
      setIsPairing(false);
    }
  }

  async function applyLibraryInSections(nextLibrary: LibraryPayload, libraryEtag = ''): Promise<Map<string, MediaItem>> {
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
    const nextItemsById = new Map(nextItems.map((item) => [item.id, item]));
    detailItemCacheRef.current = rebuildMobileDetailItemCache(detailItemCacheRef.current, nextItemsById);
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
    setIsServerOffline(false);
    setIsRefreshing(true);
    try {
      void refreshProfiles(connection);
      const response = await mobileLanClient.getLibrary(
        connection.baseUrl,
        connection.deviceToken,
        connection.libraryEtag,
      );
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
      void refreshProfiles(connection);
      const response = await mobileLanClient.getLibrary(
        connection.baseUrl,
        connection.deviceToken,
        connection.libraryEtag,
      );
      if (response.status === 401) {
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        setSavedConnection(null);
        setConnection(null);
        setError('This device is no longer authorized. Enter the current 6-digit pairing PIN to pair again.');
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
    const libraryResponse = await mobileLanClient.getLibrary(connection.baseUrl, connection.deviceToken);
    if (!libraryResponse.ok) {
      throw new Error(`Poster updated, but mobile sync failed (${libraryResponse.status}).`);
    }
    const nextLibrary = await readJsonResponse<LibraryPayload>(
      libraryResponse,
      `Poster updated, but mobile sync failed (${libraryResponse.status}).`,
    );
    const libraryEtag = libraryResponse.headers.get('ETag') || '';
    const nextItemsById = await applyLibraryInSections(nextLibrary, libraryEtag);
    setArtworkCacheBusters((current) => ({ ...current, [itemId]: String(Date.now()) }));
    const refreshedItem = nextItemsById.get(itemId);
    if (refreshedItem) {
      const nextItem = appliedCandidate ? mergeCandidateArtwork(refreshedItem, appliedCandidate) : refreshedItem;
      rememberMobileDetailItem(detailItemCacheRef.current, nextItem);
      setDetailItem(nextItem);
    }
  }

  async function refreshPosterOnHost(item: MediaItem) {
    if (!connection) return;
    setArtworkRefreshError('');
    setRefreshingArtworkId(item.id);
    try {
      const response = await mobileLanClient.getOfficialArtworkCandidates(
        connection.baseUrl,
        connection.deviceToken,
        item.id,
      );
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
      const response = await mobileLanClient.applyOfficialArtwork(
        connection.baseUrl,
        connection.deviceToken,
        itemId,
        candidate,
      );
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
  const canRetryPairing = isServerOffline && Boolean(baseUrl.trim()) && /^\d{6}$/.test(shareCode.trim());
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

  return (
    <MobileThemeProvider value={themeContextValue}>
    <View style={styles.app}>
      <StatusBar style={showStartupSplash || text !== '#000000' ? 'light' : 'dark'} />
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
      ) : showProfilePicker ? (
        <MobileProfilePicker
          activeProfile={activeProfile}
          error={profileError}
          pin={profilePin}
          pinTarget={profilePinTarget}
          profiles={profiles}
          setPin={setProfilePin}
          setPinTarget={(profile) => { setProfilePinTarget(profile); setProfilePin(''); setProfileError(''); }}
          onSelect={(profile, pin) => {
            void selectMobileProfile(connection, profile, pin).catch((nextError) => {
              setProfilePin('');
              setProfileError(nextError instanceof Error ? nextError.message : 'That profile could not be selected.');
            });
          }}
        />
      ) : (
        <View style={styles.shell}>
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
                    void mobileLanClient.lockProfile(connection.baseUrl, connection.deviceToken).then(() => {
                      profileHydrationGenerationRef.current += 1;
                      setActiveProfile(null);
                      setAutomaticProfileSignIn(false);
                      setProfileLists([]);
                      setProgress({});
                      setConnection((current) => current ? { ...current, library: {} } : current);
                      setShowProfilePicker(true);
                    });
                  }}
                  onSetAutomaticSignIn={(enabled) => {
                    void mobileLanClient.setAutomaticSignIn(connection.baseUrl, connection.deviceToken, enabled).then(async (response) => {
                      if (!response.ok) return;
                      const state = await response.json() as MobileActiveProfile;
                      setAutomaticProfileSignIn(state.automaticSignIn);
                    });
                  }}
                  onSwitchProfile={() => setShowProfilePicker(true)}
                  onDisconnect={() => {
                    profileHydrationGenerationRef.current += 1;
                    void SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
                    setSavedConnection(null);
                    setConnection(null);
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
                    setSearchOpen(false);
                    setQuery('');
                    setSearchScope('all');
                    setActiveKind('home');
                    setArtworkCacheBusters({});
                    setError('');
                    setIsServerOffline(false);
                  }}
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
                  onSelect={openDetailItem}
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
                    onPress={() => {
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
                    onPress={() => {
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

      <DetailModal
        activeProfile={activeProfile}
        activeKind={activeKind}
        artworkCacheBusters={artworkCacheBusters}
        baseUrl={connection?.baseUrl || ''}
        hasMiniPlayer={Boolean(miniPlayerTarget)}
        isTablet={isTablet}
        item={detailItem}
        isWatchlisted={Boolean(detailItem && profileLists.some((entry) => entry.mediaId === detailItem.id && (entry.kind === 'watchlist' || entry.kind === 'favorite')))}
        progress={progress}
        artworkRefreshError={artworkRefreshError}
        isRefreshingArtwork={Boolean(detailItem && refreshingArtworkId === detailItem.id)}
        onClose={closeDetail}
        onOpenKind={navigateToKind}
        onToggleList={(kind, present) => detailItem ? setMobileProfileListEntry(detailItem.id, kind, present) : Promise.resolve()}
        onPlay={(target) => {
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
      {activeKind !== 'settings' ? (
        <MiniPlayerStrip
          baseUrl={connection?.baseUrl || ''}
          cacheBust={miniPlayerTarget?.mediaId ? artworkCacheBusters[miniPlayerTarget.mediaId] : undefined}
          target={miniPlayerTarget}
          bottomOffset={isTablet || searchOpen ? Math.max(insets.bottom, 12) : Math.max(insets.bottom, 10) + 70}
          onDismiss={() => setMiniPlayerTarget(null)}
          onOpen={() => {
            if (!miniPlayerTarget) return;
            playerReturnItemRef.current = detailItem;
            setStreamOptions({});
            setPlayTarget(miniPlayerTarget);
            setMiniPlayerTarget(null);
            setDetailItem(null);
          }}
        />
      ) : null}
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
      {showStartupSplash ? (
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
  const { colors: { accent, accentForeground, faint, text }, styles } = useMobileTheme();
  const canPair = Boolean(baseUrl.trim()) && /^\d{6}$/.test(shareCode.trim());
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
                      setShowManual(true);
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
                placeholder="https://192.168.1.25:3848"
                placeholderTextColor={faint}
                returnKeyType="next"
                style={styles.input}
                value={baseUrl}
              />
              <TextInput
                accessibilityLabel="One-time pairing PIN"
                autoCapitalize="none"
                autoCorrect={false}
                inputMode="numeric"
                keyboardType="number-pad"
                maxLength={6}
                onChangeText={(value) => setShareCode(value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit pairing PIN"
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
  filterOpen,
  hasActiveFilters,
  query,
  searchScope,
  searchOpen,
  setFilterOpen,
  setQuery,
  setSearchScope,
  setSearchOpen,
}: {
  activeKind: LibraryKind;
  filterOpen: boolean;
  hasActiveFilters: boolean;
  query: string;
  searchScope: MobileSearchScope;
  searchOpen: boolean;
  setFilterOpen: (value: boolean) => void;
  setQuery: (value: string) => void;
  setSearchScope: (value: MobileSearchScope) => void;
  setSearchOpen: (value: boolean) => void;
}) {
  const { colors: { accent, faint, muted, text }, styles } = useMobileTheme();
  const canFilter = activeKind !== 'settings';
  if (searchOpen) {
    return (
      <View style={styles.searchHeader}>
        <View style={styles.searchHeaderRow}>
          <View style={styles.searchBox}>
            <SearchIcon size={19} color={muted} />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onChangeText={setQuery}
              placeholder="Search titles, genres, or years"
              placeholderTextColor={faint}
              returnKeyType="search"
              style={styles.searchInput}
              value={query}
            />
            {query ? (
              <Pressable
                hitSlop={8}
                onPress={() => setQuery('')}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                style={({ pressed }) => [styles.searchClearButton, pressed && styles.pressed]}
              >
                <CloseIcon size={16} color={muted} />
              </Pressable>
            ) : null}
          </View>
          <Pressable
            onPress={() => {
              setSearchOpen(false);
              setQuery('');
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel search"
            style={({ pressed }) => [styles.searchCancelButton, pressed && styles.pressed]}
          >
            <Text style={styles.searchCancelText}>Cancel</Text>
          </Pressable>
        </View>
        <SearchScopeFilters activeScope={searchScope} onChange={setSearchScope} />
      </View>
    );
  }

  return (
    <View style={styles.header}>
      <View style={styles.topBarRow}>
        <View style={styles.brandRow}>
          <LoomLogo width={86} height={24} accent={accent} wordColor={text} />
        </View>
        <View style={styles.headerActions}>
          {canFilter ? (
            <Pressable
              onPress={() => setFilterOpen(!filterOpen)}
              accessibilityRole="button"
              accessibilityLabel={filterOpen ? 'Close filters' : 'Open filters'}
              accessibilityState={{ expanded: filterOpen }}
              style={({ pressed }) => [styles.topBarIconButton, filterOpen && styles.filterButtonActive, pressed && styles.pressed]}
            >
              <FilterIcon size={20} color={filterOpen || hasActiveFilters ? accent : text} />
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => setSearchOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Search"
            style={({ pressed }) => [styles.topBarIconButton, pressed && styles.pressed]}
          >
            <SearchIcon size={23} color={text} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function SearchScopeFilters({
  activeScope,
  onChange,
}: {
  activeScope: MobileSearchScope;
  onChange: (value: MobileSearchScope) => void;
}) {
  const { styles } = useMobileTheme();
  const options: { id: MobileSearchScope; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'genre:drama', label: 'Drama' },
    { id: 'genre:animation', label: 'Animation' },
    { id: 'genre:action-adventure', label: 'Action & Adventure' },
    { id: 'genre:comedy', label: 'Comedy' },
  ];
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.filterChipRow}
    >
      {options.map((option) => {
        const selected = activeScope === option.id;
        return (
            <Pressable
              key={option.id}
              onPress={() => onChange(option.id)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={({ pressed }) => [styles.filterChip, selected && styles.filterChipSelected, pressed && styles.pressed]}
            >
              <Text style={[styles.filterChipText, selected && styles.filterChipTextSelected]}>{option.label}</Text>
            </Pressable>
        );
      })}
    </ScrollView>
  );
}

function LibraryFilters({
  activeFilter,
  onChange,
}: {
  activeFilter: MobileLibraryFilter;
  onChange: (value: MobileLibraryFilter) => void;
}) {
  const { styles } = useMobileTheme();
  const options: { id: MobileLibraryFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'in-progress', label: 'In Progress' },
    { id: 'unwatched', label: 'Unwatched' },
    { id: 'watched', label: 'Watched' },
  ];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.filterChipRow}
    >
      {options.map((option) => {
        const selected = activeFilter === option.id;
        return (
          <Pressable
            key={option.id}
            onPress={() => onChange(option.id)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ pressed }) => [styles.filterChip, selected && styles.filterChipSelected, pressed && styles.pressed]}
          >
            <Text style={[styles.filterChipText, selected && styles.filterChipTextSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function BottomNavItem({
  item,
  isActive,
  onPress,
}: {
  item: { id: string; label: string; Icon: (props: IconProps) => ReactElement; ActiveIcon?: (props: IconProps) => ReactElement; avatarUri?: string };
  isActive: boolean;
  onPress: () => void;
}) {
  const { colors: { accent, faint }, styles } = useMobileTheme();
  const active = useRef(new Animated.Value(isActive ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(active, {
      toValue: isActive ? 1 : 0,
      useNativeDriver: true,
      speed: 18,
      bounciness: 9,
    }).start();
  }, [active, isActive]);
  const iconScale = active.interpolate({ inputRange: [0, 1], outputRange: [1, 1] });
  const Icon = isActive ? (item.ActiveIcon || item.Icon) : item.Icon;
  return (
    <Pressable
      style={styles.bottomNavButton}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={item.label}
    >
      <Animated.View style={[styles.bottomNavIconWrap, { transform: [{ scale: iconScale }] }]}>
        {item.avatarUri ? (
          <ExpoImage
            source={{ uri: item.avatarUri }}
            style={styles.bottomNavAvatar}
            contentFit="cover"
          />
        ) : (
          <Icon size={24} color={isActive ? accent : faint} />
        )}
      </Animated.View>
      <Text style={[styles.bottomNavLabel, isActive && styles.bottomNavLabelActive]} numberOfLines={1}>{item.label}</Text>
    </Pressable>
  );
}

// The bottom nav mirrors the primary library destinations and settings.
function BottomNav({
  activeProfile,
  activeKind,
  setActiveKind,
}: {
  activeProfile?: MobileProfile | null;
  activeKind: LibraryKind;
  setActiveKind: (kind: LibraryKind) => void;
}) {
  const { colors: { themeLabel }, styles } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const isAndroid = Platform.OS === 'android';
  const androidGlassBackground = themeLabel === 'Light'
    ? 'rgba(255,255,255,0.42)'
    : 'rgba(10,10,10,0.88)';
  const bottomItems: { id: string; label: string; Icon: (props: IconProps) => ReactElement; ActiveIcon?: (props: IconProps) => ReactElement; avatarUri?: string; isActive: boolean; onPress: () => void }[] = [
    { id: 'home', label: 'Home', Icon: navIcons.home, ActiveIcon: navIcons.homeActive, isActive: activeKind === 'home', onPress: () => setActiveKind('home') },
    { id: 'anime', label: 'Anime', Icon: navIcons.anime, ActiveIcon: navIcons.animeActive, isActive: activeKind === 'anime', onPress: () => setActiveKind('anime') },
    { id: 'tv', label: 'TV Shows', Icon: navIcons.tv, ActiveIcon: navIcons.tvActive, isActive: activeKind === 'tv', onPress: () => setActiveKind('tv') },
    { id: 'movies', label: 'Movies', Icon: navIcons.movies, ActiveIcon: navIcons.moviesActive, isActive: activeKind === 'movies', onPress: () => setActiveKind('movies') },
    { id: 'settings', label: 'Settings', Icon: UserCircleIcon, ActiveIcon: UserCircleSolidIcon, avatarUri: activeProfile ? mobileProfileAvatarUri(activeProfile) : undefined, isActive: activeKind === 'settings', onPress: () => setActiveKind('settings') },
  ];
  const items = (
    <View style={styles.bottomNavRow}>
      {bottomItems.map((item) => (
        <BottomNavItem
          key={item.id}
          item={item}
          isActive={item.isActive}
          onPress={item.onPress}
        />
      ))}
    </View>
  );

  return (
    <BlurView
      intensity={isAndroid ? 54 : 36}
      tint={themeLabel === 'Light' ? 'light' : 'dark'}
      blurReductionFactor={isAndroid ? 1.5 : 4}
      experimentalBlurMethod={isAndroid ? 'dimezisBlurView' : 'none'}
      style={[
        styles.bottomNav,
        isAndroid && { backgroundColor: androidGlassBackground },
        { paddingBottom: Math.max(insets.bottom, 10) },
      ]}
    >
      {items}
    </BlurView>
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
  const { colors: { accentForeground }, styles } = useMobileTheme();
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
      <View pointerEvents="none" style={styles.miniPlayerArtworkBackdrop}>
        <FallbackImage
          sources={thumbnailSources}
          style={styles.miniPlayerArtworkBackdropImage}
          resizeMode="cover"
          altFallback={<View style={styles.miniPlayerArtworkBackdropFallback} />}
        />
      </View>
      <Svg pointerEvents="none" style={styles.miniPlayerArtworkScrim} width="100%" height="100%">
        <Defs>
          <SvgLinearGradient id="miniPlayerScrim" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#171717" stopOpacity="0.98" />
            <Stop offset="0.58" stopColor="#171717" stopOpacity="0.88" />
            <Stop offset="1" stopColor="#171717" stopOpacity="0.64" />
          </SvgLinearGradient>
        </Defs>
        <SvgRect width="100%" height="100%" fill="url(#miniPlayerScrim)" />
      </Svg>
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
            <PlayIcon size={13} color={accentForeground} />
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
        <CloseIcon size={20} color="#ffffff" />
      </Pressable>
    </>
  );

  return (
    <View style={[styles.miniPlayerWrap, { bottom: bottomOffset }]}>
      <BlurView
        experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : 'none'}
        intensity={46}
        tint="dark"
        style={[styles.miniPlayerStrip, styles.miniPlayerBlur]}
      >
        {content}
      </BlurView>
    </View>
  );
}

function DetailModal({
  activeProfile,
  activeKind,
  artworkCacheBusters,
  artworkRefreshError,
  baseUrl,
  hasMiniPlayer,
  isRefreshingArtwork,
  isTablet,
  item,
  isWatchlisted,
  progress,
  onClose,
  onOpenKind,
  onToggleList,
  onPlay,
  onRefreshArtwork,
}: {
  activeProfile: MobileProfile | null;
  activeKind: LibraryKind;
  artworkCacheBusters: Record<string, string>;
  artworkRefreshError: string;
  baseUrl: string;
  hasMiniPlayer: boolean;
  isRefreshingArtwork: boolean;
  isTablet: boolean;
  item: MediaItem | null;
  isWatchlisted: boolean;
  progress: Record<string, StoredProgress>;
  onClose: () => void;
  onOpenKind: (kind: LibraryKind) => void;
  onToggleList: (kind: 'watchlist' | 'favorite', present: boolean) => Promise<void>;
  onPlay: (target: PlayTarget) => void;
  onRefreshArtwork: (item: MediaItem) => void;
}) {
  if (!item) return null;
  // Keyed so per-show state (selected season) resets when a different title opens.
  return (
    <DetailContent
      key={item.id}
      activeProfile={activeProfile}
      activeKind={activeKind}
      artworkCacheBusters={artworkCacheBusters}
      artworkRefreshError={artworkRefreshError}
      baseUrl={baseUrl}
      hasMiniPlayer={hasMiniPlayer}
      isRefreshingArtwork={isRefreshingArtwork}
      isTablet={isTablet}
      item={item}
      isWatchlisted={isWatchlisted}
      progress={progress}
      onClose={onClose}
      onOpenKind={onOpenKind}
      onToggleList={onToggleList}
      onPlay={onPlay}
      onRefreshArtwork={onRefreshArtwork}
    />
  );
}

const HeroGradient = memo(function HeroGradient() {
  const { colors: { bg } } = useMobileTheme();
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
  activeProfile,
  activeKind,
  artworkCacheBusters,
  artworkRefreshError,
  baseUrl,
  hasMiniPlayer,
  isRefreshingArtwork,
  isTablet,
  item,
  isWatchlisted,
  progress,
  onClose,
  onOpenKind,
  onToggleList,
  onPlay,
  onRefreshArtwork,
}: {
  activeProfile: MobileProfile | null;
  activeKind: LibraryKind;
  artworkCacheBusters: Record<string, string>;
  artworkRefreshError: string;
  baseUrl: string;
  hasMiniPlayer: boolean;
  isRefreshingArtwork: boolean;
  isTablet: boolean;
  item: MediaItem;
  isWatchlisted: boolean;
  progress: Record<string, StoredProgress>;
  onClose: () => void;
  onOpenKind: (kind: LibraryKind) => void;
  onToggleList: (kind: 'watchlist' | 'favorite', present: boolean) => Promise<void>;
  onPlay: (target: PlayTarget) => void;
  onRefreshArtwork: (item: MediaItem) => void;
}) {
  const { colors: { accent, accentForeground, text }, styles } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const isLightTheme = text === '#000000';
  const entrance = useEntrance(16);
  const detailScrollY = useRef(new Animated.Value(0)).current;
  const stickyHeaderOpacity = detailScrollY.interpolate({
    inputRange: [90, 160],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const stickyHeaderTitleTranslateY = detailScrollY.interpolate({
    inputRange: [90, 160],
    outputRange: [-6, 0],
    extrapolate: 'clamp',
  });
  const episodes = useMemo(() => sortedEpisodes(item), [item]);
  const cacheBust = artworkCacheBusters[item.id];
  const heroSources = useMemo(() => {
    const episodeArtwork = episodes.flatMap((episode) => [episode.still, episode.thumbnail]);
    return imageUrlsFor(baseUrl, [
      item.backdrop,
      ...(item.backdropCandidates || []),
      item.poster,
      ...(item.posterCandidates || []),
      ...episodeArtwork,
    ], cacheBust);
  }, [baseUrl, cacheBust, episodes, item.backdrop, item.backdropCandidates, item.poster, item.posterCandidates]);
  const isSeries = item.type !== 'movie' && episodes.length > 0;
  const hasEpisodeTab = item.type !== 'movie';
  const seasonNumbers = Array.from(new Set(episodes.map((ep) => ep.season))).sort((a, b) => a - b);
  const [selectedSeason, setSelectedSeason] = useState(seasonNumbers[0] ?? 1);
  const [seasonPickerOpen, setSeasonPickerOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<'episodes' | 'details'>(hasEpisodeTab ? 'episodes' : 'details');
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
      if (!state.watched) return { ep, state };
    }
    return episodes.length > 0
      ? { ep: episodes[0], state: progressStateFor(progress, episodes[0].filePath, episodes[0].localMetadata?.durationSeconds) }
      : null;
  }, [episodes, progress]);
  const movieState = progressStateFor(progress, streamPathFor(item), item.localMetadata?.durationSeconds);

  const watchProgress = isSeries && nextUp ? nextUp.state : movieState;
  const watchPrimaryLabel = watchProgress.inProgress ? 'Resume' : isSeries ? 'Watch' : 'Watch Now';
  const watchEpisodeLabel = isSeries && nextUp ? episodeCode(nextUp.ep.season, nextUp.ep.episode) : '';
  const watchProgressCopy = watchProgress.inProgress && watchProgress.duration > 0
    ? `${formatShortMinutes(watchProgress.position)} of ${formatShortMinutes(watchProgress.duration)}`
    : '';
  const watchMetaLabel = [watchEpisodeLabel, watchProgressCopy].filter(Boolean).join(' · ');
  const watchProgressWidth = `${Math.round(watchProgress.fraction * 100)}%` as `${number}%`;
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
    <Animated.View
      onTouchStart={() => {
        if (seasonPickerOpen) setSeasonPickerOpen(false);
      }}
      style={[styles.overlay, entrance]}
    >
      <StatusBar style={text !== '#000000' ? 'light' : 'dark'} />
      <Animated.ScrollView
        contentContainerStyle={[styles.detailScroll, { paddingBottom: detailBottomPadding }]}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: detailScrollY } } }],
          { useNativeDriver: true },
        )}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.detailHero}>
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
            accessibilityLabel={`${watchPrimaryLabel}${watchMetaLabel ? ` ${watchMetaLabel}` : ''} ${item.title}`}
          >
            {watchProgress.fraction > 0 ? (
              <View pointerEvents="none" style={[styles.playButtonProgress, { width: watchProgressWidth }]} />
            ) : null}
            <View style={styles.playButtonContent}>
              <PlayIcon size={22} color={accentForeground} />
              <View style={styles.playButtonCopy}>
                <Text style={styles.playButtonText}>{watchPrimaryLabel}</Text>
                {watchMetaLabel ? <Text style={styles.playButtonMeta}>{watchMetaLabel}</Text> : null}
              </View>
            </View>
          </PressableScale>
          {artworkRefreshError ? <Text selectable style={styles.detailErrorText}>{artworkRefreshError}</Text> : null}

          {hasEpisodeTab ? (
            <View style={styles.detailTabs} accessibilityRole="tablist">
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: detailTab === 'episodes' }}
                onPress={() => setDetailTab('episodes')}
                style={({ pressed }) => [styles.detailTabButton, pressed && styles.pressed]}
              >
                <Text style={[styles.detailTabLabel, detailTab === 'episodes' && styles.detailTabLabelActive]}>Episodes</Text>
                {detailTab === 'episodes' ? <View style={styles.detailTabIndicator} /> : null}
              </Pressable>
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: detailTab === 'details' }}
                onPress={() => setDetailTab('details')}
                style={({ pressed }) => [styles.detailTabButton, pressed && styles.pressed]}
              >
                <Text style={[styles.detailTabLabel, detailTab === 'details' && styles.detailTabLabelActive]}>Details</Text>
                {detailTab === 'details' ? <View style={styles.detailTabIndicator} /> : null}
              </Pressable>
            </View>
          ) : null}

          {detailTab === 'details' || !hasEpisodeTab ? (
            <DetailInfo baseUrl={baseUrl} cacheBust={cacheBust} item={item} />
          ) : isSeries ? (
            <View style={styles.episodesSection}>
              <View
                onTouchStart={(event) => event.stopPropagation()}
                style={styles.seasonPickerContainer}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Choose season"
                  accessibilityState={{ expanded: seasonPickerOpen }}
                  onPress={() => setSeasonPickerOpen((current) => !current)}
                  style={({ pressed }) => [styles.seasonPicker, pressed && styles.pressed]}
                >
                  <Text style={styles.seasonPickerText}>Season {selectedSeason}</Text>
                  <View style={[styles.seasonPickerChevron, seasonPickerOpen && styles.seasonPickerChevronOpen]}>
                    <ChevronRightIcon size={20} color={text} />
                  </View>
                </Pressable>
                {seasonPickerOpen ? (
                  <View style={styles.seasonPickerMenu}>
                    {seasonNumbers.map((season) => (
                      <Pressable
                        key={season}
                        accessibilityRole="menuitem"
                        accessibilityState={{ selected: season === selectedSeason }}
                        onPress={() => {
                          setSelectedSeason(season);
                          setSeasonPickerOpen(false);
                        }}
                        style={({ pressed }) => [styles.seasonPickerOption, season === selectedSeason && styles.seasonPickerOptionActive, pressed && styles.pressed]}
                      >
                        <Text style={[styles.seasonPickerOptionText, season === selectedSeason && styles.seasonPickerOptionTextActive]}>Season {season}</Text>
                        <Text style={styles.seasonPickerOptionMeta}>
                          {episodes.filter((ep) => ep.season === season).length} episodes
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
              <View style={styles.episodeList}>
                {seasonEpisodes.map((ep) => {
                  const episodeDetails = item.episodes?.find((candidate) =>
                    candidate.season === ep.season && candidate.number === ep.episode,
                  );
                  return (
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
                      summary={episodeDetails?.summary}
                      onPress={() => onPlay(episodePlayTarget(item, ep, progress))}
                    />
                  );
                })}
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
      </Animated.ScrollView>
      <Animated.View
        pointerEvents="box-none"
        style={[styles.detailTopBar, { paddingTop: insets.top + 8 }]}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.detailTopBarBackground,
            {
              backgroundColor: isLightTheme ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)',
              borderBottomWidth: 0,
              opacity: stickyHeaderOpacity,
            },
          ]}
        />
        <SubpageBackButton onPress={onClose} />
        <Animated.Text
          numberOfLines={1}
          style={[
            styles.detailStickyTitle,
            {
              color: isLightTheme ? '#000000' : '#ffffff',
              opacity: stickyHeaderOpacity,
              transform: [{ translateY: stickyHeaderTitleTranslateY }],
            },
          ]}
        >
          {item.title}
        </Animated.Text>
        <View style={styles.detailTopActions}>
          <Pressable
            accessibilityLabel={isWatchlisted ? `Remove ${item.title} from My List` : `Add ${item.title} to My List`}
            accessibilityRole="button"
            accessibilityState={{ selected: isWatchlisted }}
            onPress={() => void onToggleList('watchlist', !isWatchlisted)}
            style={({ pressed }) => [styles.detailTopAction, pressed && styles.pressed]}
          >
            <Ionicons name={isWatchlisted ? 'bookmark' : 'bookmark-outline'} size={22} color={isWatchlisted ? accent : '#ffffff'} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.detailTopAction, isRefreshingArtwork && styles.disabledButton, pressed && styles.pressed]}
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
        </View>
      </Animated.View>
      {!isTablet ? (
        <BottomNav activeProfile={activeProfile} activeKind={activeKind} setActiveKind={onOpenKind} />
      ) : null}
    </Animated.View>
  );
}

function DetailInfo({
  baseUrl,
  cacheBust,
  item,
}: {
  baseUrl: string;
  cacheBust?: string;
  item: MediaItem;
}) {
  const { styles } = useMobileTheme();
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const cast = (item.cast || []).filter((actor) => actor.name.trim()).slice(0, 8);

  return (
    <View style={styles.detailsPanel}>
      {item.summary ? (
        <View style={styles.detailSummaryBlock}>
          <Text selectable numberOfLines={summaryExpanded ? undefined : 4} style={styles.detailSummary}>
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

      {cast.length > 0 ? (
        <View style={styles.castSection}>
          <Text style={styles.detailsSectionHeading}>Cast</Text>
          <FlatList
            contentContainerStyle={styles.castRailContent}
            data={cast}
            horizontal
            keyExtractor={(actor) => `${actor.name}-${actor.character || ''}`}
            renderItem={({ item: actor }) => {
              const actorSources = imageUrlsFor(baseUrl, [actor.image], cacheBust);
              return (
                <View style={styles.castCard}>
                  <View style={styles.castAvatar}>
                    <FallbackImage
                      sources={actorSources}
                      style={styles.castAvatarImage}
                      resizeMode="cover"
                      altFallback={(
                        <View style={styles.castAvatarFallback}>
                          <Text style={styles.castAvatarFallbackText}>{actor.name.charAt(0).toUpperCase()}</Text>
                        </View>
                      )}
                    />
                  </View>
                  <Text numberOfLines={1} style={styles.castName}>{actor.name}</Text>
                  {actor.character ? <Text numberOfLines={1} style={styles.castCharacter}>{actor.character}</Text> : null}
                </View>
              );
            }}
            showsHorizontalScrollIndicator={false}
          />
        </View>
      ) : null}

      {!item.summary && cast.length === 0 ? (
        <Text style={styles.detailsEmpty}>No additional details available.</Text>
      ) : null}
    </View>
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
  const { colors: { accent, accentForeground, text }, styles } = useMobileTheme();
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
  summary,
  onPress,
}: {
  baseUrl: string;
  cacheBust?: string;
  episode: EpisodeFile;
  fallbackSources: Array<string | undefined>;
  progress: ReturnType<typeof progressStateFor>;
  summary?: string;
  onPress: () => void;
}) {
  const { styles } = useMobileTheme();
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
        <View style={styles.episodePlayBadge}>
          <PlayIcon size={16} color="#ffffff" />
        </View>
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
        <Text numberOfLines={2} style={[styles.episodeTitle, progress.watched && styles.episodeTitleWatched]}>
          {episode.episode}. {episode.title || `Episode ${episode.episode}`}
        </Text>
        <View style={styles.episodeMetaRow}>
          <Text style={styles.episodeMeta}>
            {episode.localMetadata?.durationSeconds ? formatDuration(episode.localMetadata.durationSeconds) : 'Runtime unknown'}
          </Text>
          {progress.inProgress ? <Text style={styles.resumePill}>Resume</Text> : null}
        </View>
        {summary ? <Text numberOfLines={1} ellipsizeMode="tail" style={styles.episodeSummary}>{summary}</Text> : null}
      </View>
    </PressableScale>
  );
}

function PlayerModal({
  baseUrl,
  deviceToken,
  selectionRevision,
  failure,
  isPreparing,
  target,
  onClose,
  onRetry,
  onStreamOptionsChange,
  playbackUrl,
  player,
}: {
  baseUrl: string;
  deviceToken: string;
  selectionRevision?: number;
  failure: PlaybackFailure | null;
  isPreparing: boolean;
  target: PlayTarget | null;
  onClose: () => void;
  onRetry: () => void;
  onStreamOptionsChange: (options: StreamOptions) => void;
  playbackUrl: string | null;
  player: ReturnType<typeof useVideoPlayer>;
}) {
  if (!target) return null;
  // Keyed so playback position/controls state resets per title.
  return (
    <PlayerContent
      key={target.streamPath}
      baseUrl={baseUrl}
      deviceToken={deviceToken}
      selectionRevision={selectionRevision}
      failure={failure}
      isPreparing={isPreparing}
      target={target}
      onClose={onClose}
      onRetry={onRetry}
      onStreamOptionsChange={onStreamOptionsChange}
      playbackUrl={playbackUrl}
      player={player}
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
  const { styles } = useMobileTheme();
  const Icon = direction === 'back' ? SkipBackIcon : SkipForwardIcon;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.playerSkipButton, style, pressed && styles.playerControlPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${direction === 'back' ? 'Back' : 'Forward'} ${amount} seconds`}
    >
      <Icon size={iconSize} color="#ffffff" />
      <Text style={styles.playerSkipLabel}>{amount}</Text>
    </Pressable>
  );
}

function PlayerMenuRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors: { accent }, styles } = useMobileTheme();
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

function PlayerSegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { styles } = useMobileTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.playerSegmentScroll}
    >
      <View style={styles.playerSegmented}>
        {options.map((option, index) => (
          <Fragment key={String(option.value)}>
            {index > 0 ? <View style={styles.playerSegmentDivider} /> : null}
            <Pressable
              onPress={() => onChange(option.value)}
              style={({ pressed }) => [
                styles.playerSegment,
                value === option.value && styles.playerSegmentActive,
                pressed && styles.pressed,
              ]}
              accessibilityRole="radio"
              accessibilityState={{ selected: value === option.value }}
            >
              <Text style={[styles.playerSegmentText, value === option.value && styles.playerSegmentTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          </Fragment>
        ))}
      </View>
    </ScrollView>
  );
}

function PlayerContent({
  baseUrl,
  deviceToken,
  selectionRevision,
  failure,
  isPreparing,
  target,
  onClose,
  onRetry,
  onStreamOptionsChange,
  playbackUrl,
  player,
}: {
  baseUrl: string;
  deviceToken: string;
  selectionRevision?: number;
  failure: PlaybackFailure | null;
  isPreparing: boolean;
  target: PlayTarget;
  onClose: () => void;
  onRetry: () => void;
  onStreamOptionsChange: (options: StreamOptions) => void;
  playbackUrl: string | null;
  player: ReturnType<typeof useVideoPlayer>;
}) {
  const { colors: { accent }, styles } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const { width: playerWidth } = useWindowDimensions();
  const [controlsVisible, setControlsVisible] = useState(true);
  const [aspectRatio, setAspectRatio] = useState<PlayerAspectRatio>('default');
  const [cropMode, setCropMode] = useState<PlayerCropMode>('none');
  const [rotation, setRotation] = useState<PlayerRotation>(0);
  const entrance = useEntrance();
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const [isPlaying, setIsPlaying] = useState(() => Boolean(player.playing));
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [trackWidth, setTrackWidth] = useState(0);
  const [interactionTick, setInteractionTick] = useState(0);
  const [menu, setMenu] = useState<'none' | 'video' | 'speed' | 'audio' | 'subtitles'>('none');
  const [playbackRate, setPlaybackRate] = useState(1);
  const [nativeAudioTracks, setNativeAudioTracks] = useState<AudioTrack[]>([]);
  const [nativeSubtitleTracks, setNativeSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [activeAudioKey, setActiveAudioKey] = useState('');
  const [activeSubtitleKey, setActiveSubtitleKey] = useState('off');
  const [subtitleFontSize, setSubtitleFontSize] = useState(DEFAULT_MOBILE_SUBTITLE_FONT_SIZE);
  const [mediaSegments, setMediaSegments] = useState<MediaSegment[]>([]);
  const recoveryAction = failure ? recoveryActionFor(failure) : null;
  const [trackPreferences, setTrackPreferences] = useState<PlaybackTrackPreferences>({});
  const [gestureLevel, setGestureLevel] = useState<{ kind: PlayerVerticalGesture; value: number } | null>(null);
  const preferenceScope = useMemo(
    () => playbackPreferenceScope({ mediaId: target.mediaId, streamPath: target.streamPath }),
    [target.mediaId, target.streamPath],
  );
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
    let cancelled = false;
    void SecureStore.getItemAsync(MOBILE_SUBTITLE_FONT_SIZE_KEY).then((storedValue) => {
      if (cancelled) return;
      const parsedValue = Number(storedValue);
      if (MOBILE_SUBTITLE_SIZE_OPTIONS.some((option) => option.value === parsedValue)) {
        setSubtitleFontSize(parsedValue);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

    mobileLanClient.getTrackPreferences(baseUrl, deviceToken, preferenceScope)
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
    setMediaSegments([]);
    if (!baseUrl || !deviceToken || !target.mediaId) return;
    const controller = new AbortController();
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const retryDelays = [5000, 15000];
    const params = new URLSearchParams({ mediaId: target.mediaId });
    if (target.mediaType !== 'movie' && typeof target.season === 'number' && typeof target.episode === 'number') {
      params.set('season', String(target.season));
      params.set('episode', String(target.episode));
    }
    const load = async (attempt = 0) => {
      try {
        const response = await mobileLanClient.getPlaybackSegments(
          baseUrl,
          deviceToken,
          params,
          controller.signal,
        );
        if (!response.ok) throw new Error(`Skip marker lookup failed (${response.status}).`);
        const payload = await response.json() as { segments?: MediaSegment[] };
        if (cancelled) return;
        const segments = Array.isArray(payload.segments) ? payload.segments : [];
        setMediaSegments(segments);
        if (segments.length === 0 && attempt < retryDelays.length) {
          refreshTimer = setTimeout(() => void load(attempt + 1), retryDelays[attempt]);
        }
      } catch (error) {
        if (!cancelled && !(error instanceof Error && error.name === 'AbortError')) {
          console.warn('[mobile-player] skip marker lookup failed', error);
        }
        if (!cancelled && attempt < retryDelays.length) {
          refreshTimer = setTimeout(() => void load(attempt + 1), retryDelays[attempt]);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      controller.abort();
    };
  }, [baseUrl, deviceToken, target.episode, target.mediaId, target.mediaType, target.season]);

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
      setPosition(mobileAbsoluteMediaSeconds(Number(event.currentTime) || 0));
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
    const absoluteTime = Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds);
    const nextTime = mobilePlayerSecondsForAbsolute(absoluteTime);
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
    // Gesture handlers intentionally use the current render's player controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [playerWidth, player]);

  const toggleMenu = (nextMenu: 'video' | 'speed' | 'audio' | 'subtitles') => {
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
      options.subtitleStyle = { fontSize: subtitleFontSize };
    } else if (subtitleOption?.sidecar) {
      options.subtitleFilePath = filePathFromUrl(subtitleOption.sidecar.url);
      options.subtitleStyle = { fontSize: subtitleFontSize };
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

  const selectSubtitleFontSize = (fontSize: number) => {
    bumpControls();
    setSubtitleFontSize(fontSize);
    void SecureStore.setItemAsync(MOBILE_SUBTITLE_FONT_SIZE_KEY, String(fontSize)).catch(() => {});

    const subtitleOption = subtitleOptions.find((option) => option.key === activeSubtitleKey);
    if (!subtitleOption?.localTrack && !subtitleOption?.sidecar) return;
    const startSeconds = Number(player.currentTime || position || 0);
    const nextOptions = streamOptionsForSelection(
      activeAudioKey || audioOptions[0]?.key || '',
      activeSubtitleKey,
      startSeconds,
    );
    if (nextOptions?.subtitleStyle) nextOptions.subtitleStyle.fontSize = fontSize;
    onStreamOptionsChange(nextOptions || {});
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
      subtitleFontSize,
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
    // Track application intentionally runs once per resolved option set; the
    // helper functions are local to that player render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    subtitleFontSize,
    target.subtitles?.length,
    trackPreferences,
  ]);

  const saveTrackPreferences = (nextPreference: PlaybackTrackPreferences) => {
    const nextPreferences = { ...trackPreferences, ...nextPreference };
    setTrackPreferences(nextPreferences);
    if (!baseUrl || !deviceToken || !preferenceScope) return;
    mobileLanClient.saveTrackPreferences(baseUrl, deviceToken, preferenceScope, nextPreferences, selectionRevision).catch(() => {});
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
  const activeMediaSegment = useMemo(() => activeKnownMediaSegmentAt(mediaSegments, position), [mediaSegments, position]);
  const activeSegmentLabel = activeMediaSegment ? mobileMediaSegmentLabel(activeMediaSegment.type, target.mediaType === 'movie') : '';
  const displayLabels = playerDisplayLabels(target);
  const controlVerticalPadding = Math.max(insets.top, insets.bottom, 16);
  const aspectRatioValue = aspectRatio === 'default' ? undefined : aspectRatio;
  const cropRatio = cropMode !== 'none' && cropMode !== 'custom' ? cropMode : undefined;
  const videoFrameRatio = cropRatio || aspectRatioValue;
  const menuWidth = Math.max(
    250,
    Math.min(360, playerWidth - Math.max(insets.left, 20) - Math.max(insets.right, 20) - 16),
  );

  return (
    <Animated.View style={[styles.overlay, styles.playerRoot, entrance]}>
      <StatusBar style="light" hidden />
      {playbackUrl ? (
        <>
          <View
            style={[
              styles.playerVideoFrame,
              videoFrameRatio ? { aspectRatio: videoFrameRatio, maxHeight: '100%', width: '100%' } : styles.playerVideoFrameFill,
            ]}
          >
            <VideoView
              contentFit={cropMode === 'none' ? 'contain' : 'cover'}
              nativeControls={false}
              player={player}
              style={[styles.playerVideo, rotation === 0 ? null : { transform: [{ rotate: `${rotation}deg` }] }]}
            />
          </View>
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
          {activeMediaSegment ? (
            <Pressable
              onPress={() => seekToSeconds(activeMediaSegment.endMs === null
                ? Math.max(activeMediaSegment.startMs / 1000, activeMediaSegment.mediaDurationMs / 1000 - 1)
                : activeMediaSegment.endMs / 1000)}
              style={({ pressed }) => [styles.playerSegmentSkip, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Skip ${activeSegmentLabel}`}
            >
              <Text style={styles.playerSegmentSkipText}>Skip {activeSegmentLabel}</Text>
            </Pressable>
          ) : null}
          <Animated.View
            style={[StyleSheet.absoluteFill, { opacity: controlsOpacity }]}
            pointerEvents={controlsVisible ? 'box-none' : 'none'}
          >
            <View
              style={[
                styles.playerControls,
                {
                  paddingBottom: controlVerticalPadding,
                  paddingLeft: Math.max(insets.left, 18),
                  paddingRight: Math.max(insets.right, 18),
                  paddingTop: controlVerticalPadding,
                },
              ]}
              pointerEvents="box-none"
            >
              <View
                style={[
                  styles.playerTopRow,
                  {
                    marginHorizontal: -Math.max(insets.left, 18),
                    marginTop: -controlVerticalPadding,
                  },
                ]}
              >
                <Pressable
                  style={({ pressed }) => [styles.playerIconButton, styles.playerCloseControl, pressed && styles.pressed]}
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Close player"
                >
                  <CloseIcon size={26} color="#ffffff" />
                </Pressable>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.playerTopTitle}>
                  {displayLabels.topTitle}
                </Text>
                <View style={styles.playerOptionsPill}>
                  <Pressable
                    onPress={() => toggleMenu('video')}
                    style={({ pressed }) => [styles.playerFitButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Video framing settings"
                  >
                    <Text style={[styles.playerFitLabel, (menu === 'video' || cropMode !== 'none') && styles.playerFitLabelActive]}>
                      {cropMode === 'none' ? 'Fit' : 'Crop'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => toggleMenu('subtitles')}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Subtitles"
                  >
                    <SubtitlesIcon size={22} color={menu === 'subtitles' ? accent : '#ffffff'} />
                  </Pressable>
                  <Pressable
                    onPress={() => toggleMenu('audio')}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Audio tracks"
                  >
                    <AudioTracksIcon size={22} color={menu === 'audio' ? accent : '#ffffff'} />
                  </Pressable>
                  <Pressable
                    onPress={() => toggleMenu('speed')}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Playback speed"
                  >
                    <SpeedIcon size={22} color={menu === 'speed' ? accent : '#ffffff'} />
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

              <View style={[styles.playerBottomBlock, { bottom: controlVerticalPadding }]} pointerEvents="box-none">
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
                    menu === 'video' && { width: menuWidth },
                    { right: Math.max(insets.right, 20), top: Math.max(insets.top, 16) + 56 },
                  ]}
                >
                  <Text style={styles.playerMenuTitle}>
                    {menu === 'video' ? 'Video' : menu === 'speed' ? 'Playback Speed' : menu === 'audio' ? 'Audio' : 'Subtitles'}
                  </Text>
                  <ScrollView style={styles.playerMenuScroll}>
                    {menu === 'video' ? (
                      <View style={styles.playerVideoSettings}>
                        <View style={styles.playerSettingBlock}>
                          <Text style={styles.playerSettingLabel}>Aspect ratio:</Text>
                          <PlayerSegmentedControl
                            options={PLAYER_ASPECT_OPTIONS}
                            value={aspectRatio}
                            onChange={(value) => {
                              bumpControls();
                              setAspectRatio(value);
                            }}
                          />
                        </View>
                        <View style={styles.playerSettingBlock}>
                          <Text style={styles.playerSettingLabel}>Crop:</Text>
                          <PlayerSegmentedControl
                            options={PLAYER_CROP_OPTIONS}
                            value={cropMode}
                            onChange={(value) => {
                              bumpControls();
                              setCropMode(value);
                            }}
                          />
                        </View>
                        <View>
                          <Text style={styles.playerSettingLabel}>Rotation:</Text>
                          <PlayerSegmentedControl
                            options={PLAYER_ROTATION_OPTIONS}
                            value={rotation}
                            onChange={(value) => {
                              bumpControls();
                              setRotation(value);
                            }}
                          />
                        </View>
                      </View>
                    ) : menu === 'speed' ? (
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
                        <View style={styles.playerSettingBlock}>
                          <Text style={styles.playerSettingLabel}>Subtitle size:</Text>
                          <PlayerSegmentedControl
                            options={MOBILE_SUBTITLE_SIZE_OPTIONS}
                            value={subtitleFontSize}
                            onChange={selectSubtitleFontSize}
                          />
                        </View>
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
              {failure?.message || (isPreparing ? 'Preparing stream…' : 'Starting playback…')}
            </Text>
            <Text selectable numberOfLines={2} style={styles.playerStatusTitle}>{target.title}</Text>
            {failure ? (
              <>
                {recoveryAction ? (
                  <Text selectable style={styles.playerRecoveryText}>{recoveryAction.description}</Text>
                ) : null}
                <View style={styles.playerRecoveryActions}>
                  {recoveryAction ? (
                    <Pressable
                      style={({ pressed }) => [styles.playerStatusButton, styles.playerStatusButtonPrimary, pressed && styles.pressed]}
                      onPress={onRetry}
                      accessibilityRole="button"
                      accessibilityLabel={recoveryAction.label}
                    >
                      <Text style={styles.playerStatusButtonPrimaryText}>{recoveryAction.label}</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    style={({ pressed }) => [styles.playerStatusButton, pressed && styles.pressed]}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel="Back to library"
                  >
                    <Text style={styles.playerStatusButtonText}>Back to library</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
          </View>
          <Pressable
            style={({ pressed }) => [styles.playerClose, { top: insets.top + 8 }, pressed && styles.pressed]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close player"
          >
            <CloseIcon size={24} color="#ffffff" />
          </Pressable>
        </>
      )}
    </Animated.View>
  );
}

function SettingsScreen({
  activeProfile,
  automaticProfileSignIn,
  activeSection,
  connection,
  counts,
  isTablet,
  isRefreshing,
  mobileThemeColor,
  mobileThemeMode,
  onLockProfile,
  onSetAutomaticSignIn,
  onSwitchProfile,
  onDisconnect,
  onRefresh,
  onSelectTheme,
  onSelectThemeColor,
  showDetailHeader,
  setActiveSection,
}: {
  activeProfile: MobileProfile | null;
  automaticProfileSignIn: boolean;
  activeSection: SettingsSection | null;
  connection: Connection;
  counts: Record<'anime' | 'tv' | 'movies' | 'others', number>;
  isTablet: boolean;
  isRefreshing: boolean;
  mobileThemeColor: MobileThemeColor;
  mobileThemeMode: MobileThemeMode;
  onLockProfile: () => void;
  onSetAutomaticSignIn: (enabled: boolean) => void;
  onSwitchProfile: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onSelectTheme: (mode: MobileThemeMode) => void;
  onSelectThemeColor: (color: MobileThemeColor) => void;
  showDetailHeader: boolean;
  setActiveSection: (section: SettingsSection | null) => void;
}) {
  const { colors: { accent, muted, panel }, styles } = useMobileTheme();
  const active = settingsSections.find((section) => section.id === activeSection);

  if (active) {
    return (
      <View style={styles.settingsPage}>
        {showDetailHeader ? (
          <SettingsDetailHeader label={active.label} onBack={() => setActiveSection(null)} />
        ) : null}
        <SettingsDetail
          section={active}
          connection={connection}
          counts={counts}
          isTablet={isTablet}
          isRefreshing={isRefreshing}
          mobileThemeColor={mobileThemeColor}
          mobileThemeMode={mobileThemeMode}
          onRefresh={onRefresh}
          onSelectTheme={onSelectTheme}
          onSelectThemeColor={onSelectThemeColor}
        />
      </View>
    );
  }

  const themeModeLabel = mobileThemeMode === 'auto' ? 'Auto' : mobileThemeMode === 'light' ? 'Light' : 'Dark';
  const themeColorLabel = MOBILE_THEME_COLOR_OPTIONS.find((option) => option.value === mobileThemeColor)?.label;
  const showAutomaticSignIn = Boolean(activeProfile && !activeProfile.hasPin && !activeProfile.isGuest);

  return (
    <View style={styles.settingsPage}>
      <View style={styles.settingsProfile}>
        <View style={styles.settingsAvatar}>
          {activeProfile ? (
            <ExpoImage source={{ uri: mobileProfileAvatarUri(activeProfile) }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <Text style={styles.settingsAvatarText}>LT</Text>
          )}
        </View>
        <Text selectable style={styles.settingsProfileTitle}>{activeProfile?.name || 'LoomTV profile'}</Text>
        <Text selectable style={styles.settingsProfileCopy}>
          {activeProfile?.type === 'owner' ? 'Owner profile' : activeProfile?.type === 'kid' ? 'Kids profile' : 'Personal profile'}
        </Text>
      </View>

      <View>
        <Text selectable style={styles.settingsGroupTitle}>Profile</Text>
        <View style={styles.settingsGroup}>
          <SettingsRow label="Switch profile" onPress={onSwitchProfile} />
          {showAutomaticSignIn && (
            <SettingsRow
              label="Automatic sign-in"
              right={(
                <Switch
                  accessibilityLabel="Automatic sign-in"
                  value={automaticProfileSignIn}
                  onValueChange={onSetAutomaticSignIn}
                  ios_backgroundColor={muted}
                  thumbColor={automaticProfileSignIn ? '#ffffff' : panel}
                  trackColor={{ false: muted, true: accent }}
                  style={{ transform: [{ translateY: 4 }] }}
                />
              )}
            />
          )}
          <SettingsRow label="Lock profile" onPress={onLockProfile} last />
        </View>
      </View>

      <View>
        <Text selectable style={styles.settingsGroupTitle}>Server</Text>
        <View style={styles.settingsGroup}>
          <SettingsRow label="Library" onPress={() => setActiveSection('library')} />
          <SettingsRow label="Network" onPress={() => setActiveSection('network')} last />
        </View>
      </View>

      <View>
        <Text selectable style={styles.settingsGroupTitle}>Appearance</Text>
        <View style={styles.settingsGroup}>
          <SettingsRow
            label="Theme"
            value={themeColorLabel ? `${themeModeLabel} · ${themeColorLabel}` : themeModeLabel}
            onPress={() => setActiveSection('appearance')}
            last
          />
        </View>
      </View>

      <View style={styles.settingsGroup}>
        <SettingsRow label="About" onPress={() => setActiveSection('about')} />
        <SettingsRow label="Disconnect device" onPress={onDisconnect} danger last />
      </View>
    </View>
  );
}

function SettingsRow({
  label,
  value,
  right,
  onPress,
  danger,
  last,
}: {
  label: string;
  value?: string;
  right?: ReactElement;
  onPress?: () => void;
  danger?: boolean;
  last?: boolean;
}) {
  const { colors: { muted }, styles } = useMobileTheme();
  const content = (
    <>
      {danger
        ? <Text style={styles.settingsRowDangerText}>{label}</Text>
        : <Text selectable style={styles.settingsListText}>{label}</Text>}
      {value ? <Text selectable style={styles.settingsListValue}>{value}</Text> : null}
      {right}
      {onPress && !danger ? <ChevronRightIcon size={20} color={muted} /> : null}
    </>
  );

  if (!onPress) {
    return <View style={[styles.settingsGroupRow, last && styles.settingsGroupRowLast]}>{content}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.settingsGroupRow, last && styles.settingsGroupRowLast, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

function MobileThemePicker({
  color,
  mode,
  onSelectColor,
  onSelectTheme,
}: {
  color: MobileThemeColor;
  mode: MobileThemeMode;
  onSelectColor: (color: MobileThemeColor) => void;
  onSelectTheme: (mode: MobileThemeMode) => void;
}) {
  const { colors: { accent, muted }, styles } = useMobileTheme();
  const options: { value: MobileThemeMode; label: string; Icon: (props: IconProps) => ReactElement }[] = [
    { value: 'auto', label: 'Auto', Icon: AutoThemeIcon },
    { value: 'light', label: 'Light mode', Icon: SunIcon },
    { value: 'dark', label: 'Dark mode', Icon: MoonIcon },
  ];

  return (
    <View style={styles.settingsThemePicker}>
      <View style={styles.settingsThemeOptions}>
        {options.map((option) => {
          const selected = mode === option.value;
          const Icon = option.Icon;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={`${option.label} theme`}
              accessibilityState={{ selected }}
              onPress={() => onSelectTheme(option.value)}
              style={({ pressed }) => [
                styles.settingsThemeOption,
                selected && styles.settingsThemeOptionActive,
                pressed && styles.pressed,
              ]}
            >
              <Icon size={24} color={selected ? accent : muted} />
              <Text selectable style={[styles.settingsThemeOptionText, selected && styles.settingsThemeOptionTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.settingsThemeDivider} />
      <Text selectable style={styles.settingsThemeColorTitle}>Theme</Text>
      <View style={styles.settingsThemeColorOptions}>
        {MOBILE_THEME_COLOR_OPTIONS.map((option) => {
          const selected = color === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={`${option.label} theme color`}
              accessibilityState={{ selected }}
              onPress={() => onSelectColor(option.value)}
              style={({ pressed }) => [
                styles.settingsThemeColorOption,
                selected && styles.settingsThemeColorOptionActive,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.settingsThemeColorSwatch, { backgroundColor: option.color }]} />
              <Text selectable style={styles.settingsThemeColorLabel}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function SettingsDetailHeader({
  label,
  onBack,
  sticky = false,
}: {
  label: string;
  onBack: () => void;
  sticky?: boolean;
}) {
  const { styles } = useMobileTheme();

  return (
    <View style={[styles.settingsDetailHeader, sticky && styles.settingsDetailHeaderSticky]}>
      <SubpageBackButton accessibilityLabel="Back to settings" onPress={onBack} />
      <Text selectable numberOfLines={1} style={styles.settingsDetailTitle}>{label}</Text>
    </View>
  );
}

function SettingsDetail({
  section,
  connection,
  counts,
  isTablet,
  isRefreshing,
  mobileThemeColor,
  mobileThemeMode,
  onRefresh,
  onSelectTheme,
  onSelectThemeColor,
}: {
  section: { id: SettingsSection; label: string; description: string };
  connection: Connection;
  counts: Record<'anime' | 'tv' | 'movies' | 'others', number>;
  isTablet: boolean;
  isRefreshing: boolean;
  mobileThemeColor: MobileThemeColor;
  mobileThemeMode: MobileThemeMode;
  onRefresh: () => void;
  onSelectTheme: (mode: MobileThemeMode) => void;
  onSelectThemeColor: (color: MobileThemeColor) => void;
}) {
  const { styles } = useMobileTheme();
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
      </View>
    );
  }

  if (section.id === 'appearance') {
    return (
      <View style={styles.settingsCards}>
        <View style={styles.settingsCard}>
          <MobileThemePicker
            color={mobileThemeColor}
            mode={mobileThemeMode}
            onSelectColor={onSelectThemeColor}
            onSelectTheme={onSelectTheme}
          />
        </View>
      </View>
    );
  }

  if (section.id === 'about') {
    return (
      <View style={styles.settingsCards}>
        <View style={styles.settingsCard}>
          <Text selectable style={styles.settingsCardTitle}>Avatar attribution</Text>
          <Text selectable style={styles.settingsCardCopy}>
            DiceBear Glyphs remixes “Abstract Avatars for All Creative Profile Use” by Matt Houser, licensed under CC BY 4.0.
          </Text>
          <Text selectable style={styles.settingsValue}>dicebear.com/styles/glyphs</Text>
        </View>
        <View style={styles.settingsCard}>
          <Text selectable style={styles.settingsCardTitle}>Open-source notices</Text>
          <Text selectable style={styles.settingsCardCopy}>
            LoomTV Mobile includes the following runtime components.
          </Text>
          <View style={{ gap: 6 }}>
            {MOBILE_OPEN_SOURCE_NOTICES.map((notice) => (
              <Text key={notice.name} selectable style={styles.settingsValue}>
                {notice.name} · {notice.license}
              </Text>
            ))}
          </View>
        </View>
      </View>
    );
  }

  return null;
}

function SettingsMetric({ metric }: { metric: LibraryMetric }) {
  const { colors: { accent }, styles } = useMobileTheme();
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
  myList,
  onOpenKind,
  onResume,
  onSelect,
}: {
  artworkCacheBusters: Record<string, string>;
  baseUrl: string;
  continueWatching: MediaItem[];
  grouped: ReturnType<typeof collections>;
  isTablet: boolean;
  myList: MediaItem[];
  onOpenKind: (kind: LibraryKind) => void;
  onResume: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
}) {
  const { styles } = useMobileTheme();
  const hasItems = grouped.anime.length > 0 || grouped.tv.length > 0 || grouped.movies.length > 0 || grouped.others.length > 0;

  // Keep one featured title fixed while Home remains mounted. Playback progress
  // updates `lastPlayed`, but that should not replace the cover already shown.
  const heroCandidates = useMemo<MediaItem[]>(() => {
    const picked = new Set<string>();
    const items: MediaItem[] = [];
    for (const item of [...continueWatching, ...grouped.anime, ...grouped.tv, ...grouped.movies]) {
      if (picked.has(item.id)) continue;
      picked.add(item.id);
      items.push(item);
    }
    return items;
  }, [continueWatching, grouped]);
  const [heroItemId, setHeroItemId] = useState(() => heroCandidates[0]?.id || '');

  useEffect(() => {
    const availableIds = new Set(heroCandidates.map((item) => item.id));
    setHeroItemId((current) => availableIds.has(current) ? current : heroCandidates[0]?.id || '');
  }, [heroCandidates]);

  const heroItem = heroCandidates.find((item) => item.id === heroItemId);

  return (
    <View style={styles.sections}>
      {heroItem ? (
        <HomeHero
          artworkCacheBusters={artworkCacheBusters}
          baseUrl={baseUrl}
          isTablet={isTablet}
          item={heroItem}
          resume={continueWatching.some((item) => item.id === heroItem.id)}
          onPlay={onResume}
          onSelect={onSelect}
        />
      ) : null}
      {continueWatching.length > 0 ? (
        <Rail title="Continue Watching" artworkCacheBusters={artworkCacheBusters} items={continueWatching} baseUrl={baseUrl} onSelect={onSelect} />
      ) : null}
      {myList.length > 0 ? <Rail title="My List" artworkCacheBusters={artworkCacheBusters} items={myList} baseUrl={baseUrl} onSelect={onSelect} /> : null}
      <Rail title="Anime" artworkCacheBusters={artworkCacheBusters} items={grouped.anime.slice(0, 24)} baseUrl={baseUrl} onSelect={onSelect} onPressTitle={() => onOpenKind('anime')} />
      <Rail title="TV Shows" artworkCacheBusters={artworkCacheBusters} items={grouped.tv.slice(0, 24)} baseUrl={baseUrl} onSelect={onSelect} onPressTitle={() => onOpenKind('tv')} />
      <Rail title="Movies" artworkCacheBusters={artworkCacheBusters} items={grouped.movies.slice(0, 24)} baseUrl={baseUrl} onSelect={onSelect} onPressTitle={() => onOpenKind('movies')} />
      {!hasItems ? <EmptyLibrary isTablet={isTablet} /> : null}
    </View>
  );
}

// A fixed featured card. This deliberately is not horizontally scrollable:
// diagonal vertical gestures must never snap Home to a different cover.
function HomeHero({
  artworkCacheBusters,
  baseUrl,
  isTablet,
  item,
  resume,
  onPlay,
  onSelect,
}: {
  artworkCacheBusters: Record<string, string>;
  baseUrl: string;
  isTablet: boolean;
  item: MediaItem;
  resume: boolean;
  onPlay: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
}) {
  const { styles } = useMobileTheme();
  const { width } = useWindowDimensions();
  const contentWidth = isTablet ? width - 220 : width;
  const cardWidth = isTablet ? Math.min(contentWidth - 56, 460) : contentWidth - 32;
  const cardHeight = Math.round(cardWidth * 1.42);

  return (
    <View style={styles.heroCarousel}>
      <HeroCard
        baseUrl={baseUrl}
        cacheBust={artworkCacheBusters[item.id]}
        height={cardHeight}
        item={item}
        resume={resume}
        onPlay={() => onPlay(item)}
        onSelect={() => onSelect(item)}
        width={cardWidth}
      />
    </View>
  );
}

function HeroCard({
  baseUrl,
  cacheBust,
  height,
  item,
  resume,
  onPlay,
  onSelect,
  width,
}: {
  baseUrl: string;
  cacheBust?: string;
  height: number;
  item: MediaItem;
  resume: boolean;
  onPlay: () => void;
  onSelect: () => void;
  width: number;
}) {
  const { colors: { accent, accentForeground }, styles } = useMobileTheme();
  const canonicalPoster = item.poster || item.posterCandidates?.[0];
  const sources = useMemo(
    () => imageUrlsFor(baseUrl, [canonicalPoster], cacheBust),
    [baseUrl, cacheBust, canonicalPoster],
  );
  const meta = [
    item.type === 'movie' ? 'Movie' : item.type === 'anime' ? 'Anime' : 'TV Show',
    item.year ? String(item.year) : null,
    item.type === 'movie' ? (item.localMetadata?.durationSeconds ? formatDuration(item.localMetadata.durationSeconds) : null) : seasonCountLabel(item),
  ].filter(Boolean).join(' · ');
  const rating = item.rating && item.rating > 0 ? item.rating : null;

  return (
    <PressableScale
      accessibilityLabel={`Open ${item.title}`}
      accessibilityRole="button"
      onPress={onSelect}
      scaleTo={0.98}
      style={[styles.heroCard, { height, width }]}
    >
      <FallbackImage
        sources={sources}
        style={styles.heroCardImage}
        resizeMode="cover"
        altFallback={(
          <View style={[styles.heroCardImage, styles.posterFallback]}>
            <PlayMark size={40} color={accent} />
          </View>
        )}
      />
      <Svg pointerEvents="none" style={styles.heroCardShade} viewBox="0 0 1 1" preserveAspectRatio="none">
        <Defs>
          <SvgLinearGradient id="heroCardBottomFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0.28" stopColor="#050505" stopOpacity={0.12} />
            <Stop offset="0.50" stopColor="#050505" stopOpacity={0.68} />
            <Stop offset="0.74" stopColor="#050505" stopOpacity={0.9} />
            <Stop offset="1" stopColor="#050505" stopOpacity={0.98} />
          </SvgLinearGradient>
        </Defs>
        <SvgRect x="0" y="0" width="1" height="1" fill="url(#heroCardBottomFade)" />
      </Svg>
      <View style={styles.heroCardFooter}>
        <Text numberOfLines={2} style={styles.heroCardTitle}>{item.title}</Text>
        {(meta || rating !== null) ? (
          <View style={styles.heroCardMetaRow}>
            {meta ? <Text numberOfLines={1} style={styles.heroCardMeta}>{meta}</Text> : null}
            {rating !== null ? (
              <View accessibilityLabel={`Rated ${rating.toFixed(1)} out of 10`} style={styles.heroCardRating}>
                <StarIcon size={13} color="#f5c451" />
                <Text style={styles.heroCardRatingText}>{rating.toFixed(1)}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        <Pressable
          accessibilityLabel={`${resume ? 'Resume' : 'Play'} ${item.title}`}
          accessibilityRole="button"
          onPress={onPlay}
          style={({ pressed }) => [styles.heroPlayButton, pressed && styles.heroPlayButtonPressed]}
        >
          <PlayIcon size={22} color={accentForeground} />
          <Text style={styles.heroPlayButtonText}>{resume ? 'Resume' : 'Play'}</Text>
        </Pressable>
      </View>
    </PressableScale>
  );
}

function Rail({
  artworkCacheBusters,
  badgeLabel,
  baseUrl,
  items,
  onPressTitle,
  onSelect,
  title,
}: {
  artworkCacheBusters: Record<string, string>;
  badgeLabel?: string;
  baseUrl: string;
  items: MediaItem[];
  onPressTitle?: () => void;
  onSelect: (item: MediaItem) => void;
  title: string;
}) {
  const { colors: { text }, styles } = useMobileTheme();
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
          <PosterCard badgeLabel={badgeLabel} baseUrl={baseUrl} cacheBust={artworkCacheBusters[item.id]} item={item} onSelect={onSelect} width={128} />
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
  const { styles } = useMobileTheme();
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
      scrollEventThrottle={16}
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
  badgeLabel,
  baseUrl,
  cacheBust,
  item,
  onSelect,
  width,
}: {
  badgeLabel?: string;
  baseUrl: string;
  cacheBust?: string;
  item: MediaItem;
  onSelect: (item: MediaItem) => void;
  width: number;
}) {
  const { colors: { accent }, styles } = useMobileTheme();
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
        {item.rating && item.rating > 0 ? (
          <View
            accessibilityLabel={`Rated ${item.rating.toFixed(1)} out of 10`}
            accessibilityRole="text"
            style={styles.posterRatingBadge}
          >
            <StarIcon size={11} color="#f5c451" />
            <Text style={styles.posterRatingText}>{item.rating.toFixed(1)}</Text>
          </View>
        ) : null}
        {badgeLabel ? (
          <View style={styles.posterBadge}>
            <View style={styles.posterBadgeDot} />
            <Text style={styles.posterBadgeText}>{badgeLabel}</Text>
          </View>
        ) : null}
      </View>
      <Text selectable numberOfLines={2} ellipsizeMode="tail" style={styles.posterTitle}>{item.title}</Text>
      <Text selectable numberOfLines={1} style={styles.metaText}>{meta}</Text>
    </PressableScale>
  );
});

function EmptyLibrary({ isTablet }: { isTablet: boolean }) {
  const { styles } = useMobileTheme();
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
