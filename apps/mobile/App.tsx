import { StatusBar } from 'expo-status-bar';
import * as Device from 'expo-device';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  Easing,
  FlatList,
  type ImageStyle,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  type PressableProps,
  RefreshControl,
  type RefreshControlProps,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  Share,
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
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect as SvgRect, Stop } from 'react-native-svg';
import type { LanPairApprovalRequest } from '@loom-media-server/lan-protocol';
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
import { MobileErrorBoundary } from './components/MobileErrorBoundary';
import {
  clearMobileDiagnostics,
  exportMobileDiagnostics,
  listMobileDiagnostics,
  reportNonFatal,
  type MobileDiagnosticEvent,
} from './mobileDiagnostics';
import {
  playbackFailureFromResponse,
  playbackFailureFromUnknown,
  playbackLoadFailure,
  recoveryActionFor,
  restorePortraitWithRetry,
  type PlaybackFailure,
} from './playbackRecovery';
import { useMobilePlayerGestures } from './useMobilePlayerGestures';
import { useMobilePlayerSession } from './useMobilePlayerSession';
import { useMobileConnectionSessionController, type MobileProfilePickerMode } from './useMobileConnectionSessionController';
import { useMobileNavigationController } from './useMobileNavigationController';
import { useMobilePlaybackController } from './useMobilePlaybackController';
import {
  createStyles,
  settingsContentMaxWidth,
  type MobileThemeColors,
} from './mobileStyles';
import { createMobileLanClient } from './mobileLanClient';
import { fetchMobileCatalog, synchronizeMobileCatalog } from './mobileCatalog';
import { captureMobileFocus, clearCapturedMobileFocus, topMobileModalLayer, useMobileModalLayer } from './mobileModalStack';
import { replaceMobilePlayerSource } from './mobileLifecycle';
import { validatePairIdentity } from './mobileHostIdentity';
import {
  connectionErrorFor,
  normalizeBaseUrl,
} from './mobileConnection';
import {
  configureSecureLanTransport,
  probeLanCertificate,
  secureLanUrl,
  stopSecureLanTransport,
} from './mobileSecureTransport';
import {
  mobileDetailCacheKey,
  mobileCatalogIdentity,
  mobileReconnectDelayMs,
  normalizeCertFingerprint,
  rememberMobileDetailItem,
} from './mobileDomain';
import {
  automaticDiscoveredHost,
  automaticHostAttemptDelay,
  automaticHostAttemptKey,
} from './mobileDiscoveryExperience';
import { MobileThemeProvider, useMobileTheme } from './mobileThemeContext';
import { reconcileSavedHost } from './mobileHostIdentity';
import {
  canRestoreMobileOfflineSnapshot,
  clearMobileOfflineSnapshot,
  loadMobileOfflineSnapshot,
} from './mobileOfflineCache';
import { mediaIdForPlayTarget, useMobileDownloadsController } from './useMobileDownloadsController';
import { MobileReducedMotionProvider, useMobileReducedMotion } from './mobileReducedMotion';
import {
  MOBILE_THEME_COLOR_OPTIONS,
  mobileThemeFromSettings,
  type MobileThemeColor,
  type MobileThemeMode,
  type ResolvedMobileThemeMode,
} from './mobileTheme';
import {
  allItems,
  coreItems,
  collections,
  episodeCode,
  episodePlayTarget,
  filePathFromUrl,
  libraryWithPlayedItem,
  matchesMobileLibraryFilter,
  matchesMobileSearchScope,
  matchesQuery,
  orderedSeasonNumbers,
  playTargetForItem,
  progressStateFor,
  sortedEpisodes,
  streamPathFor,
} from './mobileLibrary';
import type {
  Connection,
  DiscoveredHost,
  EpisodeFile,
  LibraryKind,
  LibraryPayload,
  LocalMediaTrack,
  MediaItem,
  MediaSegment,
  MobileActiveProfile,
  MobileProfile,
  MobileLibraryFilter,
  MobileSearchScope,
  OfficialMetadataCandidate,
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
import {
  hlsSessionResultSchema,
  mediaSegmentsPayloadSchema,
  mobileActiveProfileSchema,
  mobileLibraryItemDetailsSchema,
  mobileLibrarySchema,
  mobilePairApprovalRequestSchema,
  mobilePairResponseSchema,
  mobileProfileListSchema,
  mobileProfilePreferencesSchema,
  mobileProfilesPayloadSchema,
  mobileProfileSelectionSchema,
  mobileProgressMapSchema,
  mobileStoredProgressSchema,
  officialArtworkResponseSchema,
  officialMetadataCandidatesSchema,
  playbackTrackPreferencesSchema,
  readErrorResponse,
  readJsonResponse,
  refreshedCredentialsSchema,
  savedConnectionSchema,
} from './mobileDecoders';

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
const MOBILE_ONBOARDING_OFFLINE_MESSAGE = 'Server unavailable right now. Choose a LoomTV server to reconnect.';
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
const mobileLanClient = createMobileLanClient((input, init) => fetch(secureLanUrl(input), init));

class MobileCredentialRefreshError extends Error {
  constructor(readonly status: number) {
    super(`Credential refresh failed (${status}).`);
    this.name = 'MobileCredentialRefreshError';
  }
}

function isCredentialAuthorizationFailure(error: unknown): boolean {
  return error instanceof MobileCredentialRefreshError
    && (error.status === 400 || error.status === 401 || error.status === 403);
}

function formatOfflineSnapshotTime(savedAt: number): string {
  try {
    return new Date(savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return 'an earlier sync';
  }
}

const mobileEpisodeAirDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric',
});

function formatMobileEpisodeAirDate(value?: string): string {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return mobileEpisodeAirDateFormatter.format(date);
}

function mobileSeasonLabel(season: number): string {
  return season === 0 ? 'Specials' : `Season ${season}`;
}

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
  const glyph = Number.isFinite(parsed) && parsed > 0 ? ((parsed - 1) % 12) + 1 : 1;
  const variant = String(glyph).padStart(2, '0');
  const color = PROFILE_COLOR_HEX[profile.colorKey] || PROFILE_COLOR_HEX.ember;
  return `https://api.dicebear.com/10.x/glyphs/png?seed=loomtv-glyph-${variant}&shapeVariant=variant${variant}&backgroundColor=${color}&backgroundColorFill=solid&glyphColor=${color}&glyphColorFill=solid&size=256`;
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

// Coupang Play-style top category tabs shown under the logo on library pages.
// The bottom nav shrinks to Home / Search / Settings; these tabs carry the
// library kinds instead.
const settingsSections: { id: SettingsSection; label: string; description: string }[] = [
  { id: 'library', label: 'Library', description: 'Refresh and review the connected server library.' },
  { id: 'network', label: 'Network', description: 'Pairing status and server connection details.' },
  { id: 'appearance', label: 'Appearance', description: 'Choose a light or dark theme for this device.' },
  { id: 'about', label: 'About', description: 'App information and third-party attribution.' },
];

const MOBILE_OPEN_SOURCE_NOTICES = [
  { name: 'Expo', license: 'MIT' },
  { name: '@expo/vector-icons', license: 'MIT' },
  { name: 'expo-blur', license: 'MIT' },
  { name: 'expo-brightness', license: 'MIT' },
  { name: 'expo-build-properties', license: 'MIT' },
  { name: 'expo-dev-client', license: 'MIT' },
  { name: 'expo-device', license: 'MIT' },
  { name: 'expo-file-system', license: 'MIT' },
  { name: 'expo-image', license: 'MIT' },
  { name: 'expo-screen-orientation', license: 'MIT' },
  { name: 'expo-secure-store', license: 'MIT' },
  { name: 'expo-sqlite', license: 'MIT' },
  { name: 'expo-status-bar', license: 'MIT' },
  { name: 'expo-video', license: 'MIT' },
  { name: 'React', license: 'MIT' },
  { name: 'React Native', license: 'MIT' },
  { name: 'react-native-safe-area-context', license: 'MIT' },
  { name: 'react-native-svg', license: 'MIT' },
  { name: 'react-native-zeroconf', license: 'MIT' },
  { name: 'Zod', license: 'MIT' },
] as const;

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

// Stable empty list so the library feed keeps the same `data` reference in rails
// mode (rails render in the header; the grid data is intentionally empty).
const EMPTY_ITEMS: MediaItem[] = [];
const LIBRARY_SECTION_APPLY_DELAY_MS = 45;

function isHlsPlaybackUrl(playbackUrl: string): boolean {
  return playbackUrl.includes('.m3u8') || playbackUrl.includes('/hls/');
}

function videoSourceFor(playbackUrl: string, target?: PlayTarget | null, deviceToken?: string): VideoSource {
  const isLocalFile = playbackUrl.startsWith('file:');
  return {
    uri: secureLanUrl(playbackUrl),
    contentType: isHlsPlaybackUrl(playbackUrl) ? 'hls' : 'auto',
    headers: deviceToken && !isLocalFile ? { Authorization: `LoomDevice ${deviceToken}` } : undefined,
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

function mobileSeekAccessibilityText(position: number, duration: number): string {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safePosition = Math.max(0, Math.min(position, safeDuration || Math.max(0, position)));
  return `Elapsed ${formatClock(safePosition)}; remaining -${formatClock(Math.max(0, safeDuration - safePosition))}; total ${formatClock(safeDuration)}`;
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPairingApproval(
  baseUrl: string,
  request: LanPairApprovalRequest,
): Promise<Response> {
  if (
    !request.requestId
    || !request.requestSecret
    || !Number.isFinite(request.expiresAt)
    || request.expiresAt <= Date.now()
  ) {
    throw new Error('The server returned an invalid approval request. Start pairing again.');
  }

  const deadline = Math.min(request.expiresAt, Date.now() + 65_000);
  while (Date.now() < deadline) {
    await wait(750);
    const response = await mobileLanClient.pairingApprovalStatus(baseUrl, {
      requestId: request.requestId,
      requestSecret: request.requestSecret,
    });
    if (response.status !== 202) return response;
  }
  throw new Error('The server approval request expired. Tap Connect to try again.');
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
  const reduceMotion = useMobileReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);

  useEffect(() => {
    progress.stopAnimation();
    if (reduceMotion) {
      progress.setValue(0);
      return;
    }
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
  }, [progress, reduceMotion]);

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
      {!reduceMotion && width > 0 ? (
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
  onFocus,
  onPress,
  scaleTo = 0.96,
  style,
}: {
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'tab' | 'menuitem' | 'adjustable';
  accessibilityState?: { selected?: boolean; disabled?: boolean };
  children: ReactNode;
  disabled?: boolean;
  onFocus?: PressableProps['onFocus'];
  onPress?: PressableProps['onPress'];
  scaleTo?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useMobileReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!reduceMotion) return;
    scale.stopAnimation();
    scale.setValue(1);
  }, [reduceMotion, scale]);
  const springTo = (toValue: number) => {
    if (reduceMotion) {
      scale.stopAnimation();
      scale.setValue(1);
      return;
    }
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      speed: 45,
      bounciness: toValue < 1 ? 0 : 7,
    }).start();
  };
  return (
    <AnimatedPressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onFocus={onFocus}
      onPress={(event) => {
        captureMobileFocus(event);
        onPress?.(event);
      }}
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
  const reduceMotion = useMobileReducedMotion();
  const progress = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const hasEntered = useRef(false);
  useEffect(() => {
    progress.stopAnimation();
    if (reduceMotion || hasEntered.current) {
      progress.setValue(1);
      hasEntered.current = true;
      return;
    }
    hasEntered.current = true;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reduceMotion]);
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
  mode,
  onSelect,
  onClose,
  pin,
  pinTarget,
  profiles,
  setPin,
  setPinTarget,
}: {
  activeProfile: MobileProfile | null;
  error: string;
  mode: MobileProfilePickerMode;
  onSelect: (profile: MobileProfile, pin?: string) => void | Promise<void>;
  onClose?: () => void;
  pin: string;
  pinTarget: MobileProfile | null;
  profiles: MobileProfile[];
  setPin: (value: string) => void;
  setPinTarget: (profile: MobileProfile | null) => void;
}) {
  const { colors } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const isDismissible = mode === 'voluntary';
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const chooseProfile = (profile: MobileProfile, selectedPin?: string) => {
    if (pendingProfileId) return;
    if (profile.hasPin && selectedPin === undefined) {
      setPinTarget(profile);
      setPin('');
      return;
    }
    setPendingProfileId(profile.id);
    void Promise.resolve()
      .then(() => onSelect(profile, selectedPin))
      .finally(() => setPendingProfileId(null));
  };
  useMobileModalLayer({
    priority: 70,
    onBack: () => {
      if (pinTarget) {
        setPinTarget(null);
        setPin('');
        return;
      }
      if (isDismissible) onClose?.();
    },
  });
  if (pinTarget) {
    const append = (digit: string) => {
      const next = `${pin}${digit}`.slice(0, 4);
      setPin(next);
      if (next.length === 4) chooseProfile(pinTarget, next);
    };
    return (
      <View
        accessibilityViewIsModal
        importantForAccessibility="yes"
        style={[mobileProfileStyles.screen, { backgroundColor: colors.bg }]}
      >
        <SubpageBackButton
          accessibilityLabel="Back to profiles"
          onPress={() => {
            setPinTarget(null);
            setPin('');
          }}
          style={[mobileProfileStyles.pinBackButton, { top: insets.top + 12 }]}
        />
        <Text style={[mobileProfileStyles.title, { color: colors.text }]}>Enter PIN</Text>
        <Text style={{ color: colors.muted }}>Unlock {pinTarget.name}</Text>
        <View
          accessible
          accessibilityLabel={`${pin.length} of 4 PIN digits entered`}
          accessibilityLiveRegion="polite"
          style={mobileProfileStyles.dots}
        >
          {[0, 1, 2, 3].map((index) => <View key={index} style={[mobileProfileStyles.dot, { backgroundColor: index < pin.length ? colors.text : colors.border }]} />)}
        </View>
        <View style={mobileProfileStyles.pinGrid}>
          {'123456789'.split('').map((digit) => (
            <Pressable accessibilityLabel={`Digit ${digit}`} accessibilityRole="button" disabled={Boolean(pendingProfileId)} key={digit} onPress={() => append(digit)} style={[mobileProfileStyles.pinKey, { backgroundColor: colors.panel }]}>
              <Text style={[mobileProfileStyles.pinText, { color: colors.text }]}>{digit}</Text>
            </Pressable>
          ))}
          <View style={mobileProfileStyles.pinKey} />
          <Pressable accessibilityLabel="Digit 0" accessibilityRole="button" disabled={Boolean(pendingProfileId)} onPress={() => append('0')} style={[mobileProfileStyles.pinKey, { backgroundColor: colors.panel }]}><Text style={[mobileProfileStyles.pinText, { color: colors.text }]}>0</Text></Pressable>
          <Pressable accessibilityLabel="Delete last digit" accessibilityRole="button" disabled={Boolean(pendingProfileId)} onPress={() => setPin(pin.slice(0, -1))} style={mobileProfileStyles.pinKey}><Text style={{ color: colors.muted }}>Delete</Text></Pressable>
        </View>
        {pendingProfileId ? <ActivityIndicator color={colors.accent} size="small" /> : null}
        {error ? <Text accessibilityLiveRegion="assertive" role="alert" style={mobileProfileStyles.error}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <ScrollView
      accessibilityViewIsModal
      importantForAccessibility="yes"
      contentContainerStyle={[mobileProfileStyles.screen, { backgroundColor: colors.bg }]}
    >
      <LoomLogo width={132} height={44} wordColor={colors.text} />
      <Text style={[mobileProfileStyles.title, { color: colors.text }]}>Who’s watching?</Text>
      {isDismissible ? null : (
        <Text accessibilityRole="text" style={{ color: colors.muted, textAlign: 'center' }}>
          Choose a profile to continue.
        </Text>
      )}
      {pendingProfileId ? <Text accessibilityRole="text" style={{ color: colors.muted, textAlign: 'center' }}>Opening profile…</Text> : null}
      <View style={mobileProfileStyles.grid}>
        {profiles.map((profile) => (
          <Pressable
            disabled={Boolean(pendingProfileId)}
            hitSlop={14}
            key={profile.id}
            accessibilityRole="button"
            accessibilityLabel={`${profile.name}${profile.hasPin ? ', PIN protected' : ''}`}
            accessibilityState={{
              busy: pendingProfileId === profile.id,
              disabled: Boolean(pendingProfileId),
              selected: profile.id === activeProfile?.id,
            }}
            onPress={() => chooseProfile(profile)}
            style={({ pressed }) => [mobileProfileStyles.card, pressed && mobileProfileStyles.cardPressed]}
          >
            <View style={[
              mobileProfileStyles.avatar,
              { backgroundColor: colors.panel, borderColor: colors.border },
            ]}>
              <ExpoImage
        cachePolicy="memory-disk" source={{ uri: mobileProfileAvatarUri(profile) }} style={mobileProfileStyles.avatarImage} contentFit="cover" />
            </View>
            <Text numberOfLines={1} style={[mobileProfileStyles.name, { color: colors.text }]}>{profile.name}</Text>
            {pendingProfileId === profile.id ? <ActivityIndicator color={colors.accent} size="small" /> : profile.id === activeProfile?.id ? (
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
  cardPressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
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
      <MobileReducedMotionProvider>
        <MobileErrorBoundary
          scope="app-root.render"
          title="LoomTV needs to recover"
          message="Your saved library and progress are safe. Retry to reopen the app."
        >
          <AppRoot />
        </MobileErrorBoundary>
      </MobileReducedMotionProvider>
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

  const {
    activeProfile,
    appState,
    appStateRef,
    automaticProfileSignIn,
    automaticHostAttemptRef,
    baseUrl,
    checkDesktopConnectionHandlerRef,
    connection,
    connectionHealthCheckRef,
    connectionLifecycleAction,
    credentialRefreshKeyRef,
    credentialRefreshPromiseRef,
    discoveredHosts,
    discoveryError,
    error,
    isCheckingConnection,
    isDiscoveringHosts,
    isOnboarding,
    isPairing,
    isRestoringConnection,
    isServerOffline,
    offlineSnapshotSavedAt,
    pairWithDesktopHandlerRef,
    profileError,
    profileHydrationGenerationRef,
    profileLists,
    profilePickerMode,
    profilePin,
    profilePinTarget,
    profiles,
    progress,
    reconnectingSavedConnectionRef,
    reconnectSavedConnectionHandlerRef,
    refreshDiscovery,
    requestedHostRepairRef,
    savedReconnectCompletionRef,
    savedConnection,
    setActiveProfile,
    setAutomaticProfileSignIn,
    setBaseUrl,
    setConnection,
    setError,
    setIsCheckingConnection,
    setIsOnboarding,
    setIsPairing,
    setIsRestoringConnection,
    setIsServerOffline,
    setOfflineSnapshotSavedAt,
    setProfileError,
    setProfileLists,
    setProfilePickerMode,
    setProfilePin,
    setProfilePinTarget,
    setProfiles,
    setProgress,
    setSavedConnection,
    setShareCode,
    showProfilePicker,
  } = useMobileConnectionSessionController({
    cancelActiveRequests: mobileLanClient.cancelActiveRequests,
    stopSecureTransport: stopSecureLanTransport,
  });
  const {
    activeKind,
    detailItem,
    filterOpen,
    homeHeaderPinned,
    homeHeaderOpacity,
    homeHeaderScale,
    homeHeaderTranslateY,
    lastDetailByKindRef,
    libraryFilter,
    libraryListRef,
    navigateToKind,
    query,
    rememberMainScroll,
    searchOpen,
    searchScope,
    settingsScrollRef,
    settingsSection,
    setActiveKind,
    setDetailItem,
    setFilterOpen,
    setLibraryFilter,
    setQuery,
    setSearchOpen,
    setSearchScope,
    setSettingsSection,
  } = useMobileNavigationController({ cancelActiveRequests: mobileLanClient.cancelActiveRequests });
  const {
    appliedOrientationLockRef,
    autoAdvancedEpisodeRef,
    closingPlayerRef,
    desiredOrientationLockRef,
    isPreparingStream,
    mandatoryPlayerTeardownRef,
    miniPlayerTarget,
    orientationLockQueueRef,
    pendingSeekRef,
    playbackFailure,
    playbackUrl,
    player,
    playerReturnItemRef,
    playTarget,
    setIsPreparingStream,
    setMiniPlayerTarget,
    setPlaybackFailure,
    setPlaybackUrl,
    setPlayTarget,
    setStreamOptions,
    setStreamRetryNonce,
    shouldAutoplayRef,
    streamOptions,
    streamRetryNonce,
    userPausedRef,
    windowSizeRef,
  } = useMobilePlaybackController({ appState, height, width });
  const detailItemCacheRef = useRef(new Map<string, MediaItem>());
  const detailItemRequestsRef = useRef(new Map<string, Promise<MediaItem>>());
  const activeCatalogIdentityRef = useRef('profile:none:-1');
  const legacyCatalogFallbackCountRef = useRef(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshingArtworkId, setRefreshingArtworkId] = useState('');
  const [artworkRefreshError, setArtworkRefreshError] = useState('');
  const [artworkCacheBusters, setArtworkCacheBusters] = useState<Record<string, string>>({});
  const [posterCandidateSheet, setPosterCandidateSheet] = useState<PosterCandidateSheetState | null>(null);
  const [applyingPosterCandidateId, setApplyingPosterCandidateId] = useState('');
  const {
    downloads: mobileDownloads,
    downloadingMediaId,
    downloadPlayTarget,
    removeDownloadedTarget,
    targetWithOfflineDownload,
  } = useMobileDownloadsController({
    activeProfile,
    client: mobileLanClient,
    connection,
    isServerOffline,
  });

  const enterProfilePicker = (mode: MobileProfilePickerMode, nextConnection?: Connection, selectionRevision?: number): void => {
    profileHydrationGenerationRef.current += 1;
    setProfilePinTarget(null);
    setProfilePin('');
    setProfileError('');
    if (mode !== 'voluntary') {
      clearCapturedMobileFocus();
      mandatoryPlayerTeardownRef.current();
      activeCatalogIdentityRef.current = 'profile:none:-1';
      detailItemCacheRef.current.clear();
      detailItemRequestsRef.current.clear();
      lastDetailByKindRef.current.clear();
      setDetailItem(null);
      setPosterCandidateSheet(null);
      setApplyingPosterCandidateId('');
      setMiniPlayerTarget(null);
      playerReturnItemRef.current = null;
      closingPlayerRef.current = false;
      setPlayTarget(null);
      setPlaybackUrl(null);
      setPlaybackFailure(null);
      setIsPreparingStream(false);
      setStreamOptions({});
      shouldAutoplayRef.current = false;
      userPausedRef.current = false;
      pendingSeekRef.current = 0;
      autoAdvancedEpisodeRef.current = null;
      setActiveProfile(null);
      setAutomaticProfileSignIn(false);
      setProfileLists([]);
      setProgress({});
      setConnection((current) => {
        const base = nextConnection || current;
        return base
          ? { ...base, library: {}, libraryEtag: '', selectionRevision: selectionRevision ?? base.selectionRevision }
          : current;
      });
    }
    setProfilePickerMode(mode);
  };
  const initialResolvedThemeMode: ResolvedMobileThemeMode = 'dark';
  const [mobileTheme, setMobileTheme] = useState<MobileThemeColors>(() => (
    mobileThemeFromSettings(undefined, initialResolvedThemeMode)
  ));
  const [mobileThemeMode, setMobileThemeMode] = useState<MobileThemeMode>('dark');
  const [mobileThemeColor, setMobileThemeColor] = useState<MobileThemeColor>('yellow');
  const resolvedMobileThemeMode: ResolvedMobileThemeMode = mobileThemeMode === 'auto'
    ? (systemColorScheme === 'light' ? 'light' : 'dark')
    : mobileThemeMode;
  reconnectSavedConnectionHandlerRef.current = reconnectSavedConnection;
  pairWithDesktopHandlerRef.current = pairWithDesktop;
  checkDesktopConnectionHandlerRef.current = checkDesktopConnection;
  const themedStyles = useMemo(() => createStyles(mobileTheme), [mobileTheme]);
  const themeContextValue = useMemo(() => ({ colors: mobileTheme, styles: themedStyles }), [mobileTheme, themedStyles]);
  const styles = themedStyles;
  const { accent, panel, text, muted } = mobileTheme;

  const selectMobileTheme = useCallback((next: MobileThemeMode) => {
    setMobileThemeMode(next);
    void SecureStore.setItemAsync(MOBILE_THEME_MODE_KEY, next).catch(() => {});
  }, []);

  const selectMobileThemeColor = useCallback((next: MobileThemeColor) => {
    setMobileThemeColor(next);
    void SecureStore.setItemAsync(MOBILE_THEME_COLOR_KEY, next).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
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
        const parsed = savedConnectionSchema.safeParse(JSON.parse(stored));
        if (!parsed.success) return;
        const saved = parsed.data;
        const certFingerprint = normalizeCertFingerprint(saved.certFingerprint);
        if (!certFingerprint || !saved.hostDeviceId) {
          invalidateCredentialRefresh();
          void SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
          if (saved.hostDeviceId) void clearMobileOfflineSnapshot(saved.hostDeviceId);
          setBaseUrl(saved.baseUrl);
          setError('This saved connection predates secure host identity. Select the server and approve pairing again.');
          setIsServerOffline(true);
          return;
        }
        const normalizedSaved = { ...saved, certFingerprint };
        setSavedConnection(normalizedSaved);
        setBaseUrl(normalizedSaved.baseUrl);
        void reconnectSavedConnectionHandlerRef.current(normalizedSaved);
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
    if (!savedConnection || (connection && !isServerOffline)) return;
    const discoveredSavedHost = discoveredHosts.find((host) => host.deviceId === savedConnection.hostDeviceId);
    if (discoveredSavedHost) {
      const reconciliation = reconcileSavedHost(savedConnection, discoveredSavedHost);
      if (reconciliation.kind === 'identity-mismatch') {
        setIsServerOffline(true);
        setError('Approve the refreshed connection on your LoomTV server.');
        return;
      }
      if (reconciliation.kind === 'unchanged') return;
      const updated = reconciliation.connection;
      invalidateCredentialRefresh();
      setSavedConnection(updated);
      setBaseUrl(updated.baseUrl);
      void SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(updated));
      void reconnectSavedConnectionHandlerRef.current(updated);
    }
    // Keep the reconnect cadence tied to saved-session state, not callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, discoveredHosts, isServerOffline, savedConnection]);

  useEffect(() => {
    if (appState !== 'active' || isPairing || isRestoringConnection || (connection && !isServerOffline)) return;
    const host = automaticDiscoveredHost(discoveredHosts, savedConnection);
    if (!host) return;
    if (savedConnection && reconcileSavedHost(savedConnection, host).kind !== 'identity-mismatch') return;

    const attemptKey = automaticHostAttemptKey(host);
    const delay = automaticHostAttemptDelay(automaticHostAttemptRef.current.get(attemptKey));
    const timer = setTimeout(() => {
      automaticHostAttemptRef.current.set(attemptKey, Date.now());
      setBaseUrl(host.baseUrl);
      setError('');
      void pairWithDesktopHandlerRef.current(host);
    }, delay);
    return () => clearTimeout(timer);
  }, [appState, automaticHostAttemptRef, connection, discoveredHosts, isPairing, isRestoringConnection, isServerOffline, pairWithDesktopHandlerRef, savedConnection, setBaseUrl, setError]);

  useEffect(() => {
    // Keep retrying a saved credential while the onboarding screen is visible.
    // A desktop restart can briefly fail the first request while its HTTPS
    // listener is coming back; onboarding must not turn that transient outage
    // into a new pairing/approval flow.
    if (!savedConnection || connectionLifecycleAction !== 'retry-saved') return;
    let cancelled = false;
    let failedAttempts = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delayMs: number) => {
      retry = setTimeout(() => { void tryReconnect(); }, delayMs);
    };
    const tryReconnect = async () => {
      if (cancelled || appStateRef.current !== 'active') return;
      const connected = await reconnectSavedConnectionHandlerRef.current(savedConnection);
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
  }, [appState, appStateRef, connectionLifecycleAction, reconnectSavedConnectionHandlerRef, savedConnection]);

  useEffect(() => {
    if (!connection || connectionLifecycleAction !== 'health-check') return;
    const healthCheck = setInterval(() => void checkDesktopConnectionHandlerRef.current(), 5_000);
    return () => clearInterval(healthCheck);
  }, [checkDesktopConnectionHandlerRef, connection, connectionLifecycleAction]);

  useEffect(() => {
    if (!savedConnection || !connection) return undefined;
    const delay = Math.max(0, connection.accessTokenExpiresAt - Date.now() - 60_000);
    const timer = setTimeout(() => {
      void refreshSavedCredentials(savedConnection).catch(async (nextError) => {
        if (isCredentialAuthorizationFailure(nextError)) {
          invalidateCredentialRefresh();
          await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
          await clearMobileOfflineSnapshot(savedConnection.hostDeviceId);
          setSavedConnection(null);
          setConnection(null);
          void stopSecureLanTransport();
          setOfflineSnapshotSavedAt(null);
          setIsServerOffline(false);
          setError('Your secure session expired. Pair with the LoomTV server again.');
          return;
        }
        setIsServerOffline(true);
        setError(MOBILE_ONBOARDING_OFFLINE_MESSAGE);
      });
    }, delay);
    return () => clearTimeout(timer);
    // The refresh timer is keyed to connection state; refresh helpers are intentionally non-reactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, savedConnection]);

  useEffect(() => {
    setMobileTheme(mobileThemeFromSettings({ appThemeColor: mobileThemeColor }, resolvedMobileThemeMode));
  }, [mobileThemeColor, resolvedMobileThemeMode]);

  const library = useMemo(() => connection?.library || {}, [connection?.library]);
  const grouped = useMemo(() => collections(library), [library]);
  const everything = useMemo(() => coreItems(library), [library]);

  useEffect(() => {
    if (!connection?.baseUrl || isServerOffline) return;
    const media = [...grouped.anime, ...grouped.tv, ...grouped.movies, ...grouped.others];
    const urls = Array.from(new Set(media.flatMap((item) => imageUrlsFor(connection.baseUrl, [
      item.poster,
      ...(item.posterCandidates || []),
      item.backdrop,
      ...(item.backdropCandidates || []),
      ...(item.episodeFiles || []).flatMap((episode) => [episode.still, episode.thumbnail]),
    ])))).slice(0, 240);
    if (urls.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (let index = 0; index < urls.length && !cancelled; index += 24) {
        await ExpoImage.prefetch(urls.slice(index, index + 24), 'disk');
      }
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [connection?.baseUrl, connection?.catalogRevision, grouped, isServerOffline]);
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

  const activeCatalogIdentity = mobileCatalogIdentity(activeProfile?.id, connection?.catalogRevision);
  activeCatalogIdentityRef.current = activeCatalogIdentity;
  const catalogCacheKeyFor = useCallback((mediaId: string): string => (
    `${activeCatalogIdentity}:${mediaId}`
  ), [activeCatalogIdentity]);

  const resolveMobileDetailItem = useCallback(async (item: MediaItem): Promise<MediaItem> => {
    if (isServerOffline || !connection || item.catalogRevision === undefined || connection.catalogRevision === undefined) return item;
    const key = catalogCacheKeyFor(item.id);
    const cached = detailItemCacheRef.current.get(key);
    if (cached) {
      rememberMobileDetailItem(detailItemCacheRef.current, cached, key);
      return cached;
    }
    const pending = detailItemRequestsRef.current.get(key);
    if (pending) return pending;
    const requestIdentity = activeCatalogIdentityRef.current;

    const request = (async () => {
      const response = await mobileLanClient.getLibraryItem(
        connection.baseUrl,
        connection.deviceToken,
        item.id,
      );
      if (response.ok) {
        const payload = await readJsonResponse(response, mobileLibraryItemDetailsSchema, 'Library item details');
        if (payload.catalogVersion === 1 && payload.revision === connection.catalogRevision) {
          if (activeCatalogIdentityRef.current !== requestIdentity) return item;
          rememberMobileDetailItem(detailItemCacheRef.current, payload.item, key);
          return payload.item;
        }
        return item;
      }
      if (response.status !== 403 && response.status !== 404 && response.status !== 410 && response.status !== 501) {
        throw new Error(`Could not load media details (${response.status}).`);
      }

      legacyCatalogFallbackCountRef.current += 1;
      console.warn(`[catalog] Item details unavailable; using legacy library payload (fallback ${legacyCatalogFallbackCountRef.current}).`);
      const legacyResponse = await mobileLanClient.getLibrary(connection.baseUrl, connection.deviceToken);
      if (!legacyResponse.ok) return item;
      const legacyLibrary = await readJsonResponse(legacyResponse, mobileLibrarySchema, 'Legacy library');
      const detail = allItems(legacyLibrary).find((candidate) => candidate.id === item.id) || item;
      if (activeCatalogIdentityRef.current !== requestIdentity) return item;
      rememberMobileDetailItem(detailItemCacheRef.current, detail, key);
      return detail;
    })().finally(() => detailItemRequestsRef.current.delete(key));
    detailItemRequestsRef.current.set(key, request);
    return request;
  }, [catalogCacheKeyFor, connection, isServerOffline]);

  useEffect(() => {
    const activePrefix = `${activeProfile?.id || 'profile:none'}:${connection?.catalogRevision ?? -1}:`;
    for (const key of detailItemCacheRef.current.keys()) {
      if (!key.startsWith(activePrefix)) detailItemCacheRef.current.delete(key);
    }
    const currentDetails = new Map<LibraryKind, MediaItem>();
    for (const [kind, item] of lastDetailByKindRef.current) {
      const currentItem = itemsById.get(item.id);
      const cached = detailItemCacheRef.current.get(catalogCacheKeyFor(item.id));
      if (cached || currentItem) currentDetails.set(kind, cached || currentItem as MediaItem);
    }
    lastDetailByKindRef.current = currentDetails;
  }, [activeProfile?.id, catalogCacheKeyFor, connection?.catalogRevision, itemsById, lastDetailByKindRef]);

  const openDetailItem = useCallback((item: MediaItem) => {
    const key = catalogCacheKeyFor(item.id);
    const requestIdentity = activeCatalogIdentityRef.current;
    const cached = detailItemCacheRef.current.get(key) || item;
    lastDetailByKindRef.current.set(activeKind, cached);
    setFilterOpen(false);
    setDetailItem(cached);
    if (cached.catalogRevision !== undefined) {
      void resolveMobileDetailItem(cached)
        .then((details) => {
          if (activeCatalogIdentityRef.current !== requestIdentity) return;
          lastDetailByKindRef.current.set(activeKind, details);
          setDetailItem((current) => current?.id === details.id ? details : current);
        })
        .catch((nextError) => setError(nextError instanceof Error ? nextError.message : 'Could not load media details.'));
    }
  }, [activeKind, catalogCacheKeyFor, lastDetailByKindRef, resolveMobileDetailItem, setDetailItem, setError, setFilterOpen]);

  useEffect(() => {
    if (!detailItem || detailItem.catalogRevision === undefined) return;
    let cancelled = false;
    const requestIdentity = activeCatalogIdentityRef.current;
    void resolveMobileDetailItem(detailItem)
      .then((details) => {
        if (cancelled || activeCatalogIdentityRef.current !== requestIdentity) return;
        lastDetailByKindRef.current.set(activeKind, details);
        setDetailItem((current) => current?.id === details.id ? details : current);
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : 'Could not load media details.');
      });
    return () => { cancelled = true; };
  }, [activeKind, detailItem, lastDetailByKindRef, resolveMobileDetailItem, setDetailItem, setError]);

  const closeDetail = useCallback(() => {
    lastDetailByKindRef.current.delete(activeKind);
    setDetailItem(null);
  }, [activeKind, lastDetailByKindRef, setDetailItem]);

  const setMobileProfileListEntry = useCallback(async (
    mediaId: string,
    kind: 'watchlist' | 'favorite',
    present: boolean,
  ) => {
    if (!connection) return;
    if (isServerOffline) throw new Error('Reconnect to the LoomTV server before changing My List.');
    let response = await mobileLanClient.setProfileList(
      connection.baseUrl,
      connection.deviceToken,
      mediaId,
      kind,
      present,
      connection.selectionRevision,
    );
    if (!response.ok) throw new Error('The profile list could not be updated.');
    let nextLists = await readJsonResponse(response, mobileProfileListSchema, 'Profile list update');
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
      nextLists = await readJsonResponse(response, mobileProfileListSchema, 'Profile list update');
    }
    setProfileLists(nextLists);
  }, [connection, isServerOffline, setProfileLists]);

  const playHomeItem = useCallback((item: MediaItem) => {
    if (isServerOffline) {
      const offlineTarget = targetWithOfflineDownload(playTargetForItem(item, progress));
      if (!offlineTarget) {
        setError('This title is not downloaded. Reconnect to the LoomTV server to play it.');
        return;
      }
      playerReturnItemRef.current = item;
      setDetailItem(null);
      setMiniPlayerTarget(null);
      setStreamOptions({});
      setPlayTarget(offlineTarget);
      return;
    }
    const requestIdentity = activeCatalogIdentityRef.current;
    void resolveMobileDetailItem(item)
      .then((details) => {
        if (activeCatalogIdentityRef.current !== requestIdentity) return;
        playerReturnItemRef.current = details;
        setDetailItem(null);
        setMiniPlayerTarget(null);
        setStreamOptions({});
        setPlayTarget(playTargetForItem(details, progress));
      })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : 'Could not prepare playback.'));
  }, [isServerOffline, playerReturnItemRef, progress, resolveMobileDetailItem, setDetailItem, setError, setMiniPlayerTarget, setPlayTarget, setStreamOptions, targetWithOfflineDownload]);

  const connectionBaseUrl = connection?.baseUrl;
  const connectionDeviceToken = connection?.deviceToken;
  const connectionSelectionRevision = connection?.selectionRevision;
  const syncPlaybackProgress = useCallback(async (target = playTarget) => {
    if (!connectionBaseUrl || !connectionDeviceToken || !target) return;
    let position: number;
    let duration: number;
    try {
      position = Number(player.currentTime || 0);
      duration = Number(player.duration || 0);
    } catch {
      return;
    }
    if (!Number.isFinite(position) || position <= 0) return;

    try {
      const response = await mobileLanClient.saveProgress(connectionBaseUrl, connectionDeviceToken, {
        mediaId: mediaIdForPlayTarget(target),
        position,
        duration: Number.isFinite(duration) ? duration : 0,
        selectionRevision: connectionSelectionRevision,
      });
      if (!response.ok) return;

      const stored = await readJsonResponse(response, mobileStoredProgressSchema, 'Playback progress');
      const playedAt = Date.now();
      setProgress((current) => ({
        ...current,
        [filePathFromUrl(target.streamPath)]: stored,
      }));
      setConnection((current) => current
        ? { ...current, library: libraryWithPlayedItem(current.library, target.streamPath, playedAt) }
        : current);
    } catch (error) {
      // Progress sync should never interrupt playback.
      reportNonFatal('progress.local-sync', error);
    }
  }, [connectionBaseUrl, connectionDeviceToken, connectionSelectionRevision, playTarget, player, setConnection, setProgress]);

  useEffect(() => {
    if (playbackUrl) {
      shouldAutoplayRef.current = true;
      userPausedRef.current = false;
      pendingSeekRef.current = streamOptions.startSeconds ?? playTarget?.startPosition ?? 0;
    } else {
      shouldAutoplayRef.current = false;
      pendingSeekRef.current = 0;
    }
  }, [pendingSeekRef, playbackUrl, playTarget?.startPosition, shouldAutoplayRef, streamOptions.startSeconds, userPausedRef]);

  useEffect(() => {
    const currentFilePath = playTarget ? filePathFromUrl(playTarget.streamPath) : null;
    if (autoAdvancedEpisodeRef.current !== currentFilePath) {
      autoAdvancedEpisodeRef.current = null;
    }
  }, [autoAdvancedEpisodeRef, playTarget]);

  useEffect(() => {
    let cancelled = false;

    async function loadSource() {
      const source = playbackUrl
        ? videoSourceFor(playbackUrl, playTarget, connection?.deviceToken)
        : null;
      const result = await replaceMobilePlayerSource(
        (nextSource) => player.replaceAsync(nextSource),
        source,
        () => !cancelled,
      );
      if (result === 'failed') setPlaybackFailure(playbackLoadFailure());
    }

    void loadSource();
    return () => {
      cancelled = true;
    };
  }, [connection?.deviceToken, playbackUrl, playTarget, player, setPlaybackFailure]);

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
        } catch (error) {
          // Native player readiness can lag behind this callback on some devices.
          reportNonFatal('player.autoplay', error);
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
  }, [autoAdvancedEpisodeRef, connection?.library, pendingSeekRef, playbackUrl, playerReturnItemRef, playTarget, player, progress, setPlayTarget, setPlaybackFailure, setPlaybackUrl, setStreamOptions, shouldAutoplayRef, streamOptions.forceTranscode, syncPlaybackProgress, userPausedRef]);

  useEffect(() => {
    if (!playbackUrl) return;

    if (shouldAutoplayRef.current && !userPausedRef.current) {
      try {
        player.play();
      } catch (error) {
        // player may not be ready yet; the status listener will retry when ready.
        reportNonFatal('player.retry-play', error);
      }
    }
  }, [playbackUrl, player, shouldAutoplayRef, userPausedRef]);

  // Only prepare/transcode a stream when the user actually opens the player —
  // browsing the library no longer kicks off a transcode for every tap.
  useEffect(() => {
    let cancelled = false;
    const requestController = new AbortController();

    async function prepareStream() {
      if (!playTarget) {
        setPlaybackUrl(null);
        return;
      }

      if (playTarget.offlineUri) {
        setPlaybackFailure(null);
        setIsPreparingStream(false);
        setPlaybackUrl(playTarget.offlineUri);
        return;
      }

      if (!connection?.baseUrl || !connection.deviceToken) {
        setPlaybackUrl(null);
        return;
      }

      setPlaybackFailure(null);
      setIsPreparingStream(true);
      try {
        const startSeconds = streamOptions.startSeconds ?? playTarget.startPosition ?? 0;
        const options: StreamOptions = {
          ...streamOptions,
          forceTranscode: playTarget.transcode || hasStreamOptions(streamOptions),
          ...(startSeconds > 2 ? { startSeconds } : {}),
        };
        const response = await mobileLanClient.startHls(
          connection.baseUrl,
          connection.deviceToken,
          mediaIdForPlayTarget(playTarget),
          options,
          connection.selectionRevision,
          requestController.signal,
        );
        const result = await readJsonResponse(response, hlsSessionResultSchema, 'HLS session');
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
      requestController.abort();
    };
  }, [connection?.baseUrl, connection?.deviceToken, connection?.selectionRevision, playTarget, setIsPreparingStream, setPlaybackFailure, setPlaybackUrl, streamOptions, streamRetryNonce]);

  const retryPlayback = useCallback(() => {
    setPlaybackFailure(null);
    setPlaybackUrl(null);
    setStreamRetryNonce((current) => current + 1);
  }, [setPlaybackFailure, setPlaybackUrl, setStreamRetryNonce]);

  const closePlayer = useCallback(async () => {
    if (closingPlayerRef.current) return;
    closingPlayerRef.current = true;

    // Keep the player mounted until Expo confirms the portrait lock. This
    // prevents the library from being revealed in a stale landscape layout.
    let resumePosition = 0;
    try {
      resumePosition = Number(player.currentTime || 0);
      player.pause();
    } catch (error) {
      // ignore — player may already be torn down
      reportNonFatal('player.close-pause', error);
    }
    const target = playTarget;
    const returnItem = playerReturnItemRef.current;
    const returnItemId = returnItem?.id || target?.mediaId || '';
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
        const cachedReturnItem = returnItem
          || detailItemCacheRef.current.get(catalogCacheKeyFor(returnItemId))
          || itemsById.get(returnItemId);
        if (cachedReturnItem) {
          lastDetailByKindRef.current.set(activeKind, cachedReturnItem);
          setDetailItem(cachedReturnItem);
        }
      }
    } finally {
      closingPlayerRef.current = false;
    }
  }, [activeKind, appliedOrientationLockRef, catalogCacheKeyFor, closingPlayerRef, desiredOrientationLockRef, detailItem?.id, itemsById, lastDetailByKindRef, orientationLockQueueRef, playerReturnItemRef, playTarget, playbackFailure, player, setDetailItem, setMiniPlayerTarget, setPlayTarget, setPlaybackFailure, setPlaybackUrl, setStreamOptions, syncPlaybackProgress, windowSizeRef]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const topModal = topMobileModalLayer();
      if (topModal) {
        topModal.onBack();
        return true;
      }
      if (playTarget) {
        void closePlayer();
        return true;
      }
      if (detailItem) {
        closeDetail();
        return true;
      }
      if (activeKind !== 'home') {
        setActiveKind('home');
        return true;
      }
      return false;
    });

    return () => subscription.remove();
  }, [activeKind, closeDetail, closePlayer, detailItem, playTarget, setActiveKind]);

  useEffect(() => {
    if (!playTarget || !playbackUrl) return undefined;
    const interval = setInterval(() => {
      void syncPlaybackProgress(playTarget);
    }, 15000);
    return () => clearInterval(interval);
  }, [playTarget, playbackUrl, syncPlaybackProgress]);

  function invalidateCredentialRefresh(): void {
    credentialRefreshKeyRef.current = '';
    credentialRefreshPromiseRef.current = null;
  }

  async function hydrateProgress(nextConnection = connection) {
    if (!nextConnection) return;
    try {
      const response = await mobileLanClient.getProgress(nextConnection.baseUrl, nextConnection.deviceToken);
      if (!response.ok) return;
      setProgress(await readJsonResponse(response, mobileProgressMapSchema, 'Playback progress'));
    } catch (error) {
      // Progress is additive UI state; pairing and browsing should still work without it.
      reportNonFatal('progress.remote-load', error);
    }
  }

  async function refreshSavedCredentials(saved: SavedConnection): Promise<SavedConnection> {
    const refreshKey = `${saved.hostDeviceId}:${saved.deviceId}:${saved.baseUrl}:${saved.refreshToken}`;
    if (credentialRefreshPromiseRef.current?.key === refreshKey) {
      return credentialRefreshPromiseRef.current.promise;
    }
    credentialRefreshKeyRef.current = refreshKey;

    const refresh = (async () => {
      const currentDeviceName = mobileDeviceName();
      const response = await mobileLanClient.refreshCredentials(saved.baseUrl, saved.refreshToken, currentDeviceName);
      if (!response.ok) throw new MobileCredentialRefreshError(response.status);
      const payload = await readJsonResponse(response, refreshedCredentialsSchema, 'Credential refresh');
      const updated: SavedConnection = {
        ...saved,
        deviceToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
        refreshToken: payload.refreshToken,
        refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
        clientDeviceName: currentDeviceName,
      };
      if (credentialRefreshKeyRef.current !== refreshKey) {
        throw new Error('Credential refresh was superseded by another connection.');
      }
      await SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(updated));
      setSavedConnection(updated);
      setConnection((current) => current && current.deviceId === updated.deviceId
        ? { ...current, ...updated }
        : current);
      return updated;
    })();
    const tracked = refresh.finally(() => {
      if (credentialRefreshPromiseRef.current?.key === refreshKey) credentialRefreshPromiseRef.current = null;
    });
    credentialRefreshPromiseRef.current = { key: refreshKey, promise: tracked };
    return tracked;
  }

  const requestMobileCatalog = (nextConnection: Connection, etag = '') => fetchMobileCatalog(
    mobileLanClient,
    nextConnection,
    {
      etag,
      onLegacyFallback: () => {
        legacyCatalogFallbackCountRef.current += 1;
        console.warn(`[catalog] Compact index unavailable; using legacy library payload (fallback ${legacyCatalogFallbackCountRef.current}).`);
      },
    },
  );

  async function hydrateSelectedProfile(
    nextConnection: Connection,
    profile: MobileProfile,
    activeState?: MobileActiveProfile,
    selectionGeneration?: number,
  ): Promise<boolean> {
    const generation = selectionGeneration ?? ++profileHydrationGenerationRef.current;
    const [catalog, progressResponse, preferencesResponse, listsResponse] = await Promise.all([
      requestMobileCatalog(nextConnection),
      mobileLanClient.getProgress(nextConnection.baseUrl, nextConnection.deviceToken),
      mobileLanClient.getProfilePreferences(nextConnection.baseUrl, nextConnection.deviceToken),
      mobileLanClient.getProfileLists(nextConnection.baseUrl, nextConnection.deviceToken),
    ]);
    const nextProgress = progressResponse.ok
      ? await readJsonResponse(progressResponse, mobileProgressMapSchema, 'Playback progress')
      : {};
    const nextPreferences = preferencesResponse.ok
      ? await readJsonResponse(preferencesResponse, mobileProfilePreferencesSchema, 'Profile preferences')
      : null;
    const nextLists = listsResponse.ok
      ? await readJsonResponse(listsResponse, mobileProfileListSchema, 'Profile lists')
      : [];
    if (generation !== profileHydrationGenerationRef.current) return false;
    if (catalog.status !== 'ok') {
      if (catalog.status === 'profile-required') {
        enterProfilePicker('profile-required', nextConnection, activeState?.selectionRevision);
        setError('Choose a profile to continue.');
        setIsOnboarding(false);
        setIsServerOffline(false);
        return false;
      }
      throw new Error('Desktop sharing is unavailable.');
    }
    const hydratedConnection = {
      ...nextConnection,
      library: catalog.library,
      libraryEtag: catalog.etag,
      catalogRevision: catalog.revision,
      catalogTransport: catalog.transport,
      selectionRevision: activeState?.selectionRevision ?? nextConnection.selectionRevision,
    };
    setConnection(hydratedConnection);
    setIsOnboarding(false);
    setIsServerOffline(false);
    setOfflineSnapshotSavedAt(null);
    setActiveProfile(profile);
    setAutomaticProfileSignIn(Boolean(activeState?.automaticSignIn));
    setProfilePickerMode(null);
    setProfilePinTarget(null);
    setProfilePin('');
    setProfileError('');
    setProgress(nextProgress);
    if (nextPreferences) {
      const preferences = nextPreferences;
      if (preferences.appThemeMode) setMobileThemeMode(preferences.appThemeMode);
      if (preferences.appThemeColor && MOBILE_THEME_COLOR_OPTIONS.some((option) => option.value === preferences.appThemeColor)) {
        setMobileThemeColor(preferences.appThemeColor as MobileThemeColor);
      }
    }
    setProfileLists(nextLists);
    return true;
  }

  async function selectMobileProfile(nextConnection: Connection, profile: MobileProfile, pin?: string): Promise<void> {
    const selectionGeneration = ++profileHydrationGenerationRef.current;
    setProfileError('');
    const response = await mobileLanClient.selectProfile(nextConnection.baseUrl, nextConnection.deviceToken, {
      profileId: profile.id,
      ...(pin ? { pin } : {}),
    });
    if (!response.ok) {
      const payload = await readErrorResponse(response, 'Profile selection');
      if (payload.error === 'profile_locked') {
        const wait = payload.retryAfterMs ? ` Try again in ${Math.ceil(payload.retryAfterMs / 1000)} seconds.` : '';
        throw new Error(`That PIN could not be accepted.${wait}`);
      }
      throw new Error('That profile could not be selected.');
    }
    const payload = await readJsonResponse(response, mobileProfileSelectionSchema, 'Profile selection');
    if (selectionGeneration !== profileHydrationGenerationRef.current) return;
    await hydrateSelectedProfile(nextConnection, payload.profile, payload.active, selectionGeneration);
  }

  async function initializeProfiles(nextConnection: Connection): Promise<boolean> {
    const configResponse = await mobileLanClient.getClientConfig(nextConnection.baseUrl, nextConnection.deviceToken);
    if (!configResponse.ok) return false;
    const profilesResponse = await mobileLanClient.getProfiles(nextConnection.baseUrl, nextConnection.deviceToken);
    if (!profilesResponse.ok) return false;
    const payload = await readJsonResponse(profilesResponse, mobileProfilesPayloadSchema, 'Profiles');
    setProfiles(payload.profiles);
    const activeResponse = await mobileLanClient.getActiveProfile(nextConnection.baseUrl, nextConnection.deviceToken);
    const activeState = activeResponse.ok
      ? await readJsonResponse(activeResponse, mobileActiveProfileSchema, 'Active profile')
      : null;
    const selected = payload.profiles.find((profile) => profile.id === activeState?.profileId);
    if (selected && activeState?.automaticSignIn) {
      await hydrateSelectedProfile(nextConnection, selected, activeState || undefined);
      return true;
    }
    enterProfilePicker('startup', nextConnection, activeState?.selectionRevision);
    return true;
  }

  async function refreshProfiles(nextConnection: Connection): Promise<void> {
    try {
      const response = await mobileLanClient.getProfiles(nextConnection.baseUrl, nextConnection.deviceToken);
      if (!response.ok) return;
      const payload = await readJsonResponse(response, mobileProfilesPayloadSchema, 'Profiles');
      setProfiles(payload.profiles);
      setActiveProfile((current) => current
        ? payload.profiles.find((profile) => profile.id === current.id) || current
        : current);
    } catch (error) {
      // Profile updates are opportunistic; the existing connection check reports real outages.
      reportNonFatal('profile.opportunistic-update', error);
    }
  }

  async function restoreOfflineConnection(saved: SavedConnection): Promise<boolean> {
    if (saved.refreshTokenExpiresAt <= Date.now()) {
      await clearMobileOfflineSnapshot(saved.hostDeviceId);
      return false;
    }
    const snapshot = await loadMobileOfflineSnapshot(saved.hostDeviceId);
    if (!snapshot) return false;
    if (!canRestoreMobileOfflineSnapshot(snapshot)) {
      await clearMobileOfflineSnapshot(saved.hostDeviceId);
      return false;
    }

    setConnection({
      ...saved,
      library: snapshot.library,
      libraryEtag: snapshot.libraryEtag,
      catalogRevision: snapshot.catalogRevision,
      catalogTransport: snapshot.catalogTransport,
      selectionRevision: snapshot.selectionRevision,
    });
    setProfiles(snapshot.profiles);
    setActiveProfile(snapshot.activeProfile);
    setAutomaticProfileSignIn(snapshot.automaticProfileSignIn);
    setProfileLists(snapshot.profileLists);
    setProgress(snapshot.progress);
    setProfilePickerMode(null);
    setIsOnboarding(false);
    setBaseUrl(saved.baseUrl);
    setOfflineSnapshotSavedAt(snapshot.savedAt);
    setIsServerOffline(true);
    setError(`Offline library from ${formatOfflineSnapshotTime(snapshot.savedAt)}. Reconnecting.`);
    return true;
  }

  async function reconnectSavedConnection(saved: SavedConnection): Promise<boolean> {
    if (appStateRef.current !== 'active' || reconnectingSavedConnectionRef.current) return false;
    reconnectingSavedConnectionRef.current = true;
    setIsRestoringConnection(true);
    let finishReconnect: (() => void) | undefined;
    const reconnectCompletion = new Promise<void>((resolve) => { finishReconnect = resolve; });
    savedReconnectCompletionRef.current = reconnectCompletion;
    try {
      const certFingerprint = saved.certFingerprint;
      // The native loopback proxy can be reclaimed while iOS backgrounds the
      // app even though its old URL remains cached in JavaScript. Rebuild it
      // for every offline recovery so retries never stay pinned to a dead port.
      await stopSecureLanTransport();
      await configureSecureLanTransport(saved.baseUrl, certFingerprint);
      let activeSaved = saved.accessTokenExpiresAt <= Date.now() + 60_000
        || saved.clientDeviceName !== mobileDeviceName()
        ? await refreshSavedCredentials(saved)
        : saved;
      let baseConnection: Connection = { ...activeSaved, library: {}, libraryEtag: '' };
      const profileInitialized = await initializeProfiles(baseConnection);
      if (profileInitialized) {
        setBaseUrl(baseConnection.baseUrl);
        setError('');
        setIsOnboarding(false);
        setIsServerOffline(false);
        setOfflineSnapshotSavedAt(null);
        return true;
      }
      let catalog = await requestMobileCatalog(baseConnection);
      if (catalog.status === 'unauthorized') {
        activeSaved = await refreshSavedCredentials(activeSaved);
        baseConnection = { ...activeSaved, library: {}, libraryEtag: '' };
        if (await initializeProfiles(baseConnection)) {
          setBaseUrl(baseConnection.baseUrl);
          setError('');
          setIsOnboarding(false);
          setIsServerOffline(false);
          setOfflineSnapshotSavedAt(null);
          return true;
        }
        catalog = await requestMobileCatalog(baseConnection);
      }
      if (catalog.status === 'unauthorized') {
        invalidateCredentialRefresh();
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        await clearMobileOfflineSnapshot(saved.hostDeviceId);
        setSavedConnection(null);
        setOfflineSnapshotSavedAt(null);
        setIsServerOffline(false);
        setError('This device is no longer authorized. Select the server and approve pairing again.');
        return true;
      }
      if (catalog.status === 'profile-required') {
        enterProfilePicker('profile-required', baseConnection);
        setBaseUrl(baseConnection.baseUrl);
        setError('Choose a profile to continue.');
        setIsOnboarding(false);
        setIsServerOffline(false);
        return true;
      }
      if (catalog.status !== 'ok') throw new Error('Desktop sharing is unavailable.');
      const nextConnection: Connection = {
        ...activeSaved,
        library: catalog.library,
        libraryEtag: catalog.etag,
        catalogRevision: catalog.revision,
        catalogTransport: catalog.transport,
      };
      setConnection(nextConnection);
      setBaseUrl(nextConnection.baseUrl);
      setError('');
      setIsOnboarding(false);
      setIsServerOffline(false);
      setOfflineSnapshotSavedAt(null);
      void hydrateProgress(nextConnection);
      return true;
    } catch (nextError) {
      if (isCredentialAuthorizationFailure(nextError)) {
        invalidateCredentialRefresh();
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        await clearMobileOfflineSnapshot(saved.hostDeviceId);
        setSavedConnection(null);
        setConnection(null);
        void stopSecureLanTransport();
        setOfflineSnapshotSavedAt(null);
        setError('Your secure session expired. Select the server and approve pairing again.');
        setIsServerOffline(false);
        return true;
      }
      const connectionError = connectionErrorFor(nextError, 'The paired LoomTV server is unavailable.');
      if (connectionError.isOffline && await restoreOfflineConnection(saved)) return false;
      returnToOnboarding();
      setIsServerOffline(connectionError.isOffline);
      setError(connectionError.isOffline ? '' : connectionError.message);
      return false;
    } finally {
      reconnectingSavedConnectionRef.current = false;
      finishReconnect?.();
      if (savedReconnectCompletionRef.current === reconnectCompletion) savedReconnectCompletionRef.current = null;
      setIsRestoringConnection(false);
    }
  }

  async function pairWithDesktop(discoveredHost?: DiscoveredHost) {
    const preserveOfflineSnapshot = Boolean(connection && isServerOffline);
    setError('');
    if (!preserveOfflineSnapshot) setIsServerOffline(false);
    setIsPairing(true);
    try {
      const host = discoveredHost && typeof discoveredHost.baseUrl === 'string' ? discoveredHost : undefined;
      const nextBaseUrl = normalizeBaseUrl(host?.baseUrl || baseUrl);
      const observedFingerprint = host?.certFingerprint
        ? host.certFingerprint.replace(/[^0-9a-f]/gi, '').toLowerCase()
        : await probeLanCertificate(nextBaseUrl);
      await configureSecureLanTransport(nextBaseUrl, observedFingerprint);

      let response = await mobileLanClient.pair(nextBaseUrl, {
        approvalRequested: true,
        deviceName: mobileDeviceName(),
      });
      if (response.status === 202) {
        setShareCode('');
        const approval = await readJsonResponse(
          response,
          mobilePairApprovalRequestSchema,
          'Pairing approval',
        );
        response = await waitForPairingApproval(nextBaseUrl, approval);
      }
      if (!response.ok) {
        const failure = await readErrorResponse(response, 'Pairing');
        const failureMessage = failure.message || failure.error;
        if (response.status === 403 && failure.status === 'denied') {
          throw new Error('Connection was not approved.');
        }
        if (response.status === 401) {
          throw new Error(host
            ? 'Update the LoomTV server, or connect manually.'
            : 'The server did not accept this pairing request.');
        }
        if (response.status === 429) {
          if (failureMessage) throw new Error(failureMessage);
          const retryAfterSeconds = Number.parseInt(response.headers.get('Retry-After') || '', 10);
          const waitMinutes = Number.isFinite(retryAfterSeconds) ? Math.max(1, Math.ceil(retryAfterSeconds / 60)) : 5;
          throw new Error(`Too many failed attempts. Wait ${waitMinutes} minutes, then request approval again.`);
        }
        throw new Error(failureMessage || `Could not pair with the LoomTV server (${response.status}).`);
      }

      const payload = await readJsonResponse(response, mobilePairResponseSchema, 'Pairing');
      const discoveredPairHost = host || discoveredHosts.find((candidate) => candidate.baseUrl === nextBaseUrl);
      const certFingerprint = validatePairIdentity(payload, observedFingerprint, discoveredPairHost);
      const nextConnection = {
        baseUrl: nextBaseUrl,
        deviceId: payload.deviceId,
        deviceToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
        refreshToken: payload.refreshToken,
        refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
        certFingerprint,
        hostDeviceId: payload.hostDeviceId || discoveredPairHost?.deviceId || '',
        hostDeviceName: payload.hostDeviceName || 'LoomTV server',
        clientDeviceName: mobileDeviceName(),
        library: payload.library || {},
        libraryEtag: payload.libraryEtag,
      } satisfies Connection;
      const nextSavedConnection = {
        baseUrl: nextConnection.baseUrl,
        deviceId: nextConnection.deviceId,
        deviceToken: nextConnection.deviceToken,
        accessTokenExpiresAt: nextConnection.accessTokenExpiresAt,
        refreshToken: nextConnection.refreshToken,
        refreshTokenExpiresAt: nextConnection.refreshTokenExpiresAt,
        certFingerprint: nextConnection.certFingerprint,
        hostDeviceId: nextConnection.hostDeviceId,
        hostDeviceName: nextConnection.hostDeviceName,
        clientDeviceName: nextConnection.clientDeviceName,
      } satisfies SavedConnection;
      credentialRefreshPromiseRef.current = null;
      credentialRefreshKeyRef.current = `${nextSavedConnection.hostDeviceId}:${nextSavedConnection.deviceId}:${nextSavedConnection.baseUrl}:${nextSavedConnection.refreshToken}`;
      await SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(nextSavedConnection));
      setSavedConnection(nextSavedConnection);
      setShareCode('');
      setIsOnboarding(false);
      setIsServerOffline(false);
      setOfflineSnapshotSavedAt(null);
      if (!await initializeProfiles(nextConnection)) {
        setConnection(nextConnection);
        void hydrateProgress(nextConnection);
      }
    } catch (nextError) {
      const connectionError = connectionErrorFor(nextError, 'Pairing failed.');
      setError(connectionError.isOffline ? '' : connectionError.message);
      setIsServerOffline(preserveOfflineSnapshot || connectionError.isOffline);
    } finally {
      setIsPairing(false);
    }
  }

  async function applyLibraryInSections(
    nextLibrary: LibraryPayload,
    libraryEtag = '',
    catalogRevision?: number,
    catalogTransport: 'compact' | 'legacy' = 'compact',
  ): Promise<Map<string, MediaItem>> {
    const expectedIdentity = activeCatalogIdentityRef.current;
    const sections: Array<keyof LibraryPayload> = ['movies', 'tvShows', 'animeShows', 'others'];
    for (const section of sections) {
      await wait(LIBRARY_SECTION_APPLY_DELAY_MS);
      if (activeCatalogIdentityRef.current !== expectedIdentity) return new Map();
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
    if (activeCatalogIdentityRef.current !== expectedIdentity) return new Map();
    setConnection((current) => current
      ? {
        ...current,
        library: nextLibrary,
        libraryEtag,
        catalogRevision,
        catalogTransport,
      }
      : current);

    const nextItems = allItems(nextLibrary);
    const nextItemsById = new Map(nextItems.map((item) => [item.id, item]));
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
    setIsRefreshing(true);
    try {
      const result = await synchronizeMobileCatalog({
        connection,
        savedConnection,
        isServerOffline,
        refreshCredentials: refreshSavedCredentials,
        initializeProfiles,
        refreshProfiles,
        fetchCatalog: requestMobileCatalog,
      });
      if (result.status === 'profile-initialized') {
        setIsServerOffline(false);
        setOfflineSnapshotSavedAt(null);
        setError('');
        return;
      }
      if (result.status === 'not-modified') {
        setIsServerOffline(false);
        setOfflineSnapshotSavedAt(null);
        return;
      }
      if (result.status === 'unauthorized') {
        invalidateCredentialRefresh();
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        await clearMobileOfflineSnapshot(connection.hostDeviceId);
        setSavedConnection(null);
        setConnection(null);
        void stopSecureLanTransport();
        setOfflineSnapshotSavedAt(null);
        setIsServerOffline(false);
        setError('This device is no longer authorized. Enter the current 6-digit pairing PIN to pair again.');
        return;
      }
      if (result.status === 'profile-required') {
        enterProfilePicker('profile-required', result.connection);
        setError('Choose a profile to continue.');
        setIsServerOffline(false);
        return;
      }
      const { catalog } = result;
      const nextLibrary = catalog.library;
      const libraryEtag = catalog.etag;
      setIsRefreshing(false);
      await applyLibraryInSections(nextLibrary, libraryEtag, catalog.revision, catalog.transport);
      void hydrateProgress({
        ...result.connection,
        library: nextLibrary,
        libraryEtag,
        catalogRevision: catalog.revision,
        catalogTransport: catalog.transport,
      });
      setIsServerOffline(false);
      setOfflineSnapshotSavedAt(null);
    } catch (nextError) {
      if (isCredentialAuthorizationFailure(nextError)) {
        invalidateCredentialRefresh();
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        await clearMobileOfflineSnapshot(connection.hostDeviceId);
        setSavedConnection(null);
        setConnection(null);
        void stopSecureLanTransport();
        setOfflineSnapshotSavedAt(null);
        setIsServerOffline(false);
        setError('Your secure session expired. Enter the current 6-digit pairing PIN to pair again.');
        return;
      }
      const connectionError = connectionErrorFor(nextError, 'Refresh failed.');
      if (connectionError.isOffline && savedConnection && await restoreOfflineConnection(savedConnection)) return;
      if (connectionError.isOffline) returnToOnboarding();
      setError(connectionError.message);
      setIsServerOffline(connectionError.isOffline);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function checkDesktopConnection() {
    if (!connection || connectionHealthCheckRef.current || isRefreshing) return;
    connectionHealthCheckRef.current = true;
    setIsCheckingConnection(true);
    try {
      const result = await synchronizeMobileCatalog({
        connection,
        savedConnection,
        isServerOffline,
        refreshCredentials: refreshSavedCredentials,
        initializeProfiles,
        refreshProfiles,
        fetchCatalog: requestMobileCatalog,
      });
      if (result.status === 'profile-initialized') {
        setIsServerOffline(false);
        setOfflineSnapshotSavedAt(null);
        setError('');
        return;
      }
      if (result.status === 'unauthorized') {
        invalidateCredentialRefresh();
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        await clearMobileOfflineSnapshot(connection.hostDeviceId);
        setSavedConnection(null);
        setConnection(null);
        void stopSecureLanTransport();
        setOfflineSnapshotSavedAt(null);
        setIsServerOffline(false);
        setError('This device is no longer authorized. Enter the current 6-digit pairing PIN to pair again.');
        return;
      }
      if (result.status === 'profile-required') {
        enterProfilePicker('profile-required', result.connection);
        setError('Choose a profile to continue.');
        setIsServerOffline(false);
        return;
      }
      if (result.status === 'not-modified') {
        setIsServerOffline(false);
        setOfflineSnapshotSavedAt(null);
        setError('');
        return;
      }
      const { catalog } = result;
      await applyLibraryInSections(
        catalog.library,
        catalog.etag,
        catalog.revision,
        catalog.transport,
      );
      setIsServerOffline(false);
      setOfflineSnapshotSavedAt(null);
      setError('');
    } catch (nextError) {
      if (isCredentialAuthorizationFailure(nextError)) {
        invalidateCredentialRefresh();
        await SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
        await clearMobileOfflineSnapshot(connection.hostDeviceId);
        setSavedConnection(null);
        setConnection(null);
        void stopSecureLanTransport();
        setOfflineSnapshotSavedAt(null);
        setIsServerOffline(false);
        setError('Your secure session expired. Enter the current 6-digit pairing PIN to pair again.');
        return;
      }
      const connectionError = connectionErrorFor(nextError, MOBILE_ONBOARDING_OFFLINE_MESSAGE);
      if (connectionError.isOffline && savedConnection && await restoreOfflineConnection(savedConnection)) return;
      returnToOnboarding();
      setError(connectionError.message);
    } finally {
      connectionHealthCheckRef.current = false;
      setIsCheckingConnection(false);
    }
  }

  function requestServerReconnect() {
    // A retry should also restart Bonjour. This covers NAS/desktop hosts whose
    // DHCP address changed while the mobile app was showing its cached library.
    const interruptedReconnect = savedReconnectCompletionRef.current;
    mobileLanClient.cancelActiveRequests();
    if (savedConnection) {
      const discoveredSavedHost = discoveredHosts.find((host) => host.deviceId === savedConnection.hostDeviceId);
      if (discoveredSavedHost && reconcileSavedHost(savedConnection, discoveredSavedHost).kind === 'identity-mismatch') {
        // The desktop's certificate changed, so the old pin cannot be reused.
        // Request a fresh approval from the discovered host; this keeps the
        // security boundary intact while making Reconnect self-healing.
        requestedHostRepairRef.current = null;
        void pairWithDesktop(discoveredSavedHost);
        return;
      }
      requestedHostRepairRef.current = savedConnection.hostDeviceId;
    }
    refreshDiscovery();
    if (savedConnection) {
      setIsRestoringConnection(true);
      void (async () => {
        if (interruptedReconnect) await interruptedReconnect;
        await reconnectSavedConnection(savedConnection);
      })();
      return;
    }
    void checkDesktopConnection();
  }

  async function connectToDiscoveredHost(host?: DiscoveredHost): Promise<void> {
    if (!host || !savedConnection) {
      await pairWithDesktop(host);
      return;
    }

    const reconciliation = reconcileSavedHost(savedConnection, host);
    if (reconciliation.kind === 'identity-mismatch') {
      // A changed certificate is the one case where the saved pin cannot be
      // reused. Pairing through the discovered host requests desktop approval
      // and stores the replacement credential for future reconnects.
      await pairWithDesktop(host);
      return;
    }

    const updated = reconciliation.connection;
    if (updated !== savedConnection) {
      invalidateCredentialRefresh();
      setSavedConnection(updated);
      setBaseUrl(updated.baseUrl);
      await SecureStore.setItemAsync(SAVED_CONNECTION_KEY, JSON.stringify(updated));
    }
    setIsRestoringConnection(true);
    await reconnectSavedConnection(updated);
  }

  function returnToOnboarding(): void {
    // Keep the encrypted saved connection and offline snapshot on disk, but
    // remove the stale live connection so onboarding can show the host that
    // Bonjour currently discovers.
    setConnection(null);
    void stopSecureLanTransport();
    setIsOnboarding(true);
    setIsServerOffline(false);
    setOfflineSnapshotSavedAt(null);
    setProfilePickerMode(null);
    setPlayTarget(null);
    setMiniPlayerTarget(null);
    setPlaybackUrl(null);
    setStreamOptions({});
  }

  function disconnectFromDesktop(): void {
    const hostDeviceId = connection?.hostDeviceId;
    profileHydrationGenerationRef.current += 1;
    invalidateCredentialRefresh();
    void SecureStore.deleteItemAsync(SAVED_CONNECTION_KEY);
    if (hostDeviceId) void clearMobileOfflineSnapshot(hostDeviceId);
    setSavedConnection(null);
    setConnection(null);
    void stopSecureLanTransport();
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
    setProfilePickerMode(null);
    setSearchOpen(false);
    setQuery('');
    setSearchScope('all');
    setActiveKind('home');
    setArtworkCacheBusters({});
    setError('');
    setIsServerOffline(false);
    setOfflineSnapshotSavedAt(null);
  }

  function confirmDisconnectFromDesktop(): void {
    Alert.alert(
      'Disconnect this server?',
      'You will need to pair again to use this server. The saved connection and offline library data will be removed from this device; media files on the server will not be deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: disconnectFromDesktop },
      ],
    );
  }

  async function syncLibraryAfterArtworkChange(itemId: string, appliedCandidate?: OfficialMetadataCandidate): Promise<void> {
    if (!connection) return;
    const requestIdentity = activeCatalogIdentityRef.current;
    const catalog = await requestMobileCatalog({ ...connection, libraryEtag: '' });
    if (catalog.status !== 'ok') throw new Error('Poster updated, but mobile sync failed.');
    if (activeCatalogIdentityRef.current !== requestIdentity) return;
    const nextItemsById = await applyLibraryInSections(
      catalog.library,
      catalog.etag,
      catalog.revision,
      catalog.transport,
    );
    setArtworkCacheBusters((current) => ({ ...current, [itemId]: String(Date.now()) }));
    let refreshedItem = nextItemsById.get(itemId);
    if (refreshedItem && catalog.transport === 'compact' && catalog.revision !== undefined) {
      const detailResponse = await mobileLanClient.getLibraryItem(connection.baseUrl, connection.deviceToken, itemId);
      if (detailResponse.ok) {
        const payload = await readJsonResponse(detailResponse, mobileLibraryItemDetailsSchema, 'Library item details');
        if (activeCatalogIdentityRef.current !== requestIdentity) return;
        if (payload.catalogVersion === 1 && payload.revision === catalog.revision) refreshedItem = payload.item;
      }
    }
    if (refreshedItem) {
      const nextItem = appliedCandidate ? mergeCandidateArtwork(refreshedItem, appliedCandidate) : refreshedItem;
      const key = mobileDetailCacheKey(activeProfile?.id || 'profile:none', catalog.revision ?? -1, itemId);
      rememberMobileDetailItem(detailItemCacheRef.current, nextItem, key);
      setDetailItem(nextItem);
    }
  }

  async function refreshPosterOnHost(item: MediaItem) {
    if (!connection) return;
    if (isServerOffline) {
      setArtworkRefreshError('Reconnect to the LoomTV server before changing artwork.');
      return;
    }
    setArtworkRefreshError('');
    setRefreshingArtworkId(item.id);
    try {
      const response = await mobileLanClient.getOfficialArtworkCandidates(
        connection.baseUrl,
        connection.deviceToken,
        item.id,
        connection.selectionRevision,
      );
      if (!response.ok) {
        const failure = await readErrorResponse(response, 'Poster choices');
        throw new Error(failure.error || failure.message || `Could not load poster choices (${response.status}).`);
      }
      const result = await readJsonResponse(response, officialMetadataCandidatesSchema, 'Poster choices');
      setPosterCandidateSheet({ item, candidates: result });
    } catch (nextError) {
      setArtworkRefreshError(nextError instanceof Error ? nextError.message : 'Poster refresh failed.');
    } finally {
      setRefreshingArtworkId('');
    }
  }

  async function applyPosterCandidate(candidate: OfficialMetadataCandidate, candidateKey: string) {
    if (!connection || !posterCandidateSheet) return;
    if (isServerOffline) {
      setArtworkRefreshError('Reconnect to the LoomTV server before changing artwork.');
      return;
    }
    const itemId = posterCandidateSheet.item.id;
    setArtworkRefreshError('');
    setApplyingPosterCandidateId(candidateKey);
    try {
      const response = await mobileLanClient.applyOfficialArtwork(
        connection.baseUrl,
        connection.deviceToken,
        itemId,
        candidate,
        connection.selectionRevision,
      );
      const result = await readJsonResponse(response, officialArtworkResponseSchema, 'Apply poster');
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
  const topMobileSurface: 'detail' | 'poster' | 'player' | null = playTarget
    ? 'player'
    : posterCandidateSheet
      ? 'poster'
      : detailItem
        ? 'detail'
        : null;

  return (
    <MobileThemeProvider value={themeContextValue}>
    <View style={styles.app}>
      <StatusBar style={showStartupSplash || text !== '#000000' ? 'light' : 'dark'} />
      {!connection || isOnboarding ? (
        <PairingScreen
          baseUrl={baseUrl}
          discoveredHosts={discoveredHosts}
          discoveryError={discoveryError}
          error={error}
          isDiscoveringHosts={isDiscoveringHosts}
          isPairing={isPairing}
          isRestoringConnection={isRestoringConnection}
          isServerOffline={isServerOffline}
          onRefreshDiscovery={refreshDiscovery}
          // Returning to onboarding keeps the saved credential in SecureStore,
          // but lets Bonjour present the current host instead of exposing a
          // stale address or a manual-IP form first.
          savedConnection={savedConnection}
          setBaseUrl={(value) => {
            setBaseUrl(value);
            if (error) setError('');
          }}
          setShareCode={(value) => {
            setShareCode(value);
            if (error) setError('');
          }}
          onPair={connectToDiscoveredHost}
        />
      ) : showProfilePicker ? (
        <MobileProfilePicker
          activeProfile={activeProfile}
          error={profileError}
          mode={profilePickerMode || 'startup'}
          onClose={profilePickerMode === 'voluntary' ? () => setProfilePickerMode(null) : undefined}
          pin={profilePin}
          pinTarget={profilePinTarget}
          profiles={profiles}
          setPin={setProfilePin}
          setPinTarget={(profile) => { setProfilePinTarget(profile); setProfilePin(''); setProfileError(''); }}
          onSelect={async (profile, pin) => {
            try {
              await selectMobileProfile(connection, profile, pin);
            } catch (nextError) {
              setProfilePin('');
              setProfileError(nextError instanceof Error ? nextError.message : 'That profile could not be selected.');
            }
          }}
        />
      ) : (
        <View
          accessibilityElementsHidden={topMobileSurface !== null}
          importantForAccessibility={topMobileSurface !== null ? 'no-hide-descendants' : 'auto'}
          style={styles.shell}
        >
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
                {isServerOffline ? (
                  <OfflineNotice
                    message={error}
                    onRetry={requestServerReconnect}
                    onOpenSettings={() => {
                      navigateToKind('settings');
                      setSettingsSection('network');
                    }}
                    savedAt={offlineSnapshotSavedAt}
                    isRetrying={isCheckingConnection || isRefreshing}
                  />
                ) : error ? (
                  <View style={styles.errorCard}>
                    <Text selectable style={styles.errorText}>{error}</Text>
                  </View>
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
                    void clearMobileOfflineSnapshot(connection.hostDeviceId);
                    enterProfilePicker('lock', connection);
                    void mobileLanClient.lockProfile(connection.baseUrl, connection.deviceToken).catch(() => {});
                  }}
                  onSetAutomaticSignIn={(enabled) => {
                    if (!enabled) {
                      setAutomaticProfileSignIn(false);
                      void clearMobileOfflineSnapshot(connection.hostDeviceId);
                    }
                    void mobileLanClient.setAutomaticSignIn(connection.baseUrl, connection.deviceToken, enabled).then(async (response) => {
                      if (!response.ok) throw new Error('Automatic sign-in update failed.');
                      const state = await readJsonResponse(response, mobileActiveProfileSchema, 'Automatic sign-in');
                      setAutomaticProfileSignIn(state.automaticSignIn);
                      if (!state.automaticSignIn) void clearMobileOfflineSnapshot(connection.hostDeviceId);
                    }).catch(() => {
                      setError('Automatic sign-in could not be updated while the server is offline.');
                    });
                  }}
                  onSwitchProfile={() => enterProfilePicker('voluntary')}
                  onDisconnect={confirmDisconnectFromDesktop}
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
                  onSelect={activeKind === 'others' ? playHomeItem : openDetailItem}
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
                    {isServerOffline && !offlineSnapshotSavedAt ? (
                      <OfflineNotice
                        message={error}
                        onRetry={requestServerReconnect}
                        onOpenSettings={() => {
                          navigateToKind('settings');
                          setSettingsSection('network');
                        }}
                        savedAt={offlineSnapshotSavedAt}
                        isRetrying={isCheckingConnection || isRefreshing}
                      />
                    ) : error ? (
                      <View style={styles.errorCard}>
                        <Text selectable style={styles.errorText}>{error}</Text>
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
                    onPress={(event) => {
                      captureMobileFocus(event);
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
                    onPress={(event) => {
                      captureMobileFocus(event);
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

      {!showProfilePicker ? (
      <Fragment>
      <DetailModal
        activeProfile={activeProfile}
        activeKind={activeKind}
        artworkCacheBusters={artworkCacheBusters}
        baseUrl={connection?.baseUrl || ''}
        hasMiniPlayer={Boolean(miniPlayerTarget)}
        accessibilityHidden={topMobileSurface !== 'detail'}
        isTablet={isTablet}
        item={detailItem}
        isWatchlisted={Boolean(detailItem && profileLists.some((entry) => entry.mediaId === detailItem.id && (entry.kind === 'watchlist' || entry.kind === 'favorite')))}
        progress={progress}
        artworkRefreshError={artworkRefreshError}
        isRefreshingArtwork={Boolean(detailItem && refreshingArtworkId === detailItem.id)}
        downloadedMediaIds={new Set(Object.keys(mobileDownloads))}
        downloadingMediaId={downloadingMediaId}
        onClose={closeDetail}
        onOpenKind={navigateToKind}
        onToggleList={async (kind, present) => {
          if (!detailItem) return;
          try {
            await setMobileProfileListEntry(detailItem.id, kind, present);
            setArtworkRefreshError('');
          } catch (nextError) {
            setArtworkRefreshError(nextError instanceof Error ? nextError.message : 'My List could not be updated.');
          }
        }}
        onPlay={(target) => {
          if (!detailItem) return;
          if (isServerOffline) {
            const offlineTarget = targetWithOfflineDownload(target);
            if (!offlineTarget) {
              setError('This title is not downloaded. Reconnect to the LoomTV server to play it.');
              return;
            }
            playerReturnItemRef.current = detailItem;
            setMiniPlayerTarget(null);
            setStreamOptions({});
            setPlayTarget(offlineTarget);
            return;
          }
          const requestIdentity = activeCatalogIdentityRef.current;
          void resolveMobileDetailItem(detailItem)
            .then((details) => {
              if (activeCatalogIdentityRef.current !== requestIdentity) return;
              const episode = typeof target.season === 'number' && typeof target.episode === 'number'
                ? details.episodeFiles?.find((candidate) => (
                    candidate.season === target.season && candidate.episode === target.episode
                  ))
                : undefined;
              playerReturnItemRef.current = details;
              setMiniPlayerTarget(null);
              setStreamOptions({});
              setPlayTarget(episode ? episodePlayTarget(details, episode, progress) : playTargetForItem(details, progress));
            })
            .catch((nextError) => setError(nextError instanceof Error ? nextError.message : 'Could not prepare playback.'));
        }}
        onDownload={async (target) => {
          try {
            await downloadPlayTarget(target);
            setArtworkRefreshError('Downloaded for offline playback.');
          } catch (nextError) {
            setArtworkRefreshError(nextError instanceof Error ? nextError.message : 'The download failed.');
          }
        }}
        onRemoveDownload={async (target) => {
          try {
            await removeDownloadedTarget(target);
            setArtworkRefreshError('Offline copy removed.');
          } catch (nextError) {
            setArtworkRefreshError(nextError instanceof Error ? nextError.message : 'The offline copy could not be removed.');
          }
        }}
        onRefreshArtwork={refreshPosterOnHost}
      />
      <PosterCandidateSheet
        applyingCandidateId={applyingPosterCandidateId}
        accessibilityHidden={topMobileSurface !== 'poster'}
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
          accessibilityHidden={topMobileSurface !== null}
          baseUrl={connection?.baseUrl || ''}
          cacheBust={miniPlayerTarget?.mediaId ? artworkCacheBusters[miniPlayerTarget.mediaId] : undefined}
          target={miniPlayerTarget}
          bottomOffset={isTablet || searchOpen ? Math.max(insets.bottom, 12) : Math.max(insets.bottom, 10) + 70}
          onDismiss={() => setMiniPlayerTarget(null)}
          onOpen={() => {
            if (!miniPlayerTarget) return;
            if (isServerOffline) {
              setError('This title is not downloaded. Reconnect to the LoomTV server to play it.');
              return;
            }
            playerReturnItemRef.current = detailItem;
            setStreamOptions({});
            setPlayTarget(miniPlayerTarget);
            setMiniPlayerTarget(null);
            setDetailItem(null);
          }}
        />
      ) : null}
      <MobileErrorBoundary
        scope="player.render"
        title="Playback stopped"
        message="The player could not continue. Close it and retry from the title page."
        resetKey={playTarget?.streamPath || ''}
        onReset={() => { void closePlayer(); }}
      >
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
      </MobileErrorBoundary>
      </Fragment>
      ) : null}
      {showStartupSplash && !showProfilePicker ? (
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
  onPair: (host?: DiscoveredHost) => Promise<void>;
}) {
  const { colors: { accent, accentForeground, faint, text }, styles } = useMobileTheme();
  const canPair = Boolean(baseUrl.trim());
  const [showManual, setShowManual] = useState(false);
  const [connectingHostDeviceId, setConnectingHostDeviceId] = useState<string | null>(null);
  const isConnecting = isPairing || isRestoringConnection;
  const automaticallyConnectingHost = isConnecting
    ? automaticDiscoveredHost(discoveredHosts, savedConnection)
    : null;
  const activeConnectingHostDeviceId = connectingHostDeviceId || automaticallyConnectingHost?.deviceId || null;
  const manualVisible = showManual;
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
        scrollEnabled
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pairingHero}>
          <LoomLogo width={118} height={33} accent={accent} wordColor={text} />
          <Text selectable style={styles.pairingSubtitle}>
            {savedConnection ? savedConnection.hostDeviceName : 'Finding your LoomTV server…'}
          </Text>
        </View>
        <View style={styles.formBlock}>
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
                    disabled={isConnecting}
                    onPress={() => {
                      setShareCode('');
                      setBaseUrl(host.baseUrl);
                      setShowManual(false);
                      setConnectingHostDeviceId(host.deviceId);
                      void onPair(host).finally(() => {
                        setConnectingHostDeviceId((current) => current === host.deviceId ? null : current);
                      });
                    }}
                    style={({ pressed }) => [
                      styles.hostCard,
                      activeConnectingHostDeviceId === host.deviceId && isConnecting && styles.hostCardSelected,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Connect to ${host.deviceName}`}
                    accessibilityHint="Uses the saved secure pairing when available; first-time devices may need administrator approval"
                    accessibilityState={{ busy: isConnecting, disabled: isConnecting }}
                  >
                    <View style={styles.hostCardCopy}>
                      <Text selectable numberOfLines={1} style={styles.hostName}>{host.deviceName}</Text>
                    </View>
                    {activeConnectingHostDeviceId === host.deviceId && isConnecting
                      ? <ActivityIndicator size="small" color={accent} />
                      : <Text style={styles.hostConnectLabel}>Ready</Text>}
                </Pressable>
            ))}
            {!discoveredHosts.length ? (
              <View style={styles.emptyDiscoveryCard}>
                {isDiscoveringHosts ? (
                  <ActivityIndicator size="small" color={accent} />
                ) : (
                  <>
                    <Text style={styles.emptyDiscoveryTitle}>Still looking…</Text>
                    <Text style={styles.emptyDiscoveryCopy}>
                      {discoveryError
                        ? discoveryError
                        : 'Start LoomTV on your desktop or NAS.'}
                    </Text>
                  </>
                )}
              </View>
            ) : null}
          </View>

          {manualVisible ? (
            <View style={styles.manualForm}>
              <View style={styles.inputField}>
                <Text nativeID="desktop-address-label" style={styles.inputLabel}>Server address</Text>
                <TextInput
                  accessibilityLabel="Server address"
                  accessibilityLabelledBy="desktop-address-label"
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
              </View>
            </View>
          ) : null}
          {error && !isServerOffline ? (
            <View style={styles.errorCard}>
              <Text
                accessibilityLiveRegion="assertive"
                accessibilityRole="alert"
                selectable
                style={styles.errorText}
              >
                {error}
              </Text>
            </View>
          ) : null}
          {manualVisible ? (
            <PressableScale
              scaleTo={0.97}
              style={[styles.primaryButton, (!canPair || isConnecting) && styles.disabledButton]}
              onPress={() => onPair()}
              disabled={!canPair || isConnecting}
              accessibilityRole="button"
              accessibilityLabel="Connect"
            >
              {isPairing ? <ActivityIndicator color={accentForeground} /> : <Text style={styles.primaryButtonText}>Connect</Text>}
            </PressableScale>
          ) : null}
          {isConnecting && !manualVisible ? (
            <Text selectable style={styles.manualHint}>
              Connecting…
            </Text>
          ) : isServerOffline && !manualVisible ? (
            <Text selectable style={styles.manualHint}>Reconnecting…</Text>
          ) : manualVisible ? (
            <Text selectable style={styles.manualHint}>
              {'Enter the HTTPS address shown by LoomTV, then approve this device on the server.'}
            </Text>
          ) : null}
          <Pressable
            accessibilityLabel={showManual ? 'Cancel manual connection' : 'Connect manually'}
            accessibilityRole="button"
            accessibilityState={{ disabled: isConnecting }}
            disabled={isConnecting}
            onPress={() => {
              if (showManual) {
                Keyboard.dismiss();
                setShowManual(false);
                return;
              }
              setShowManual(true);
            }}
            style={[styles.helpToggle, isConnecting && styles.disabledButton]}
          >
            <Text style={styles.helpToggleText}>{showManual ? 'Cancel' : 'Use address and PIN'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function OfflineNotice({
  isRetrying,
  message,
  onOpenSettings,
  onRetry,
  savedAt,
}: {
  isRetrying: boolean;
  message: string;
  onOpenSettings?: () => void;
  onRetry: () => void;
  savedAt?: number | null;
}) {
  const { colors: { accent, accentForeground, text }, styles } = useMobileTheme();
  const normalizedMessage = message.toLowerCase();
  const isGenericMessage = !message
    || normalizedMessage.includes('desktop app offline')
    || normalizedMessage.includes('could not reach the desktop')
    || normalizedMessage.includes('desktop is offline')
    || normalizedMessage.includes('sharing is off')
    || normalizedMessage.includes('reconnect automatically');
  const body = !isGenericMessage
    ? message
    : savedAt
      ? `Your saved library is available from ${formatOfflineSnapshotTime(savedAt)}. Downloaded titles can play now; other playback and changes resume when the server reconnects. LoomTV will keep trying automatically.`
      : 'The LoomTV server is unavailable. Check that it is running and reachable from this device. LoomTV will keep trying automatically.';

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={styles.offlineNotice}
    >
      <View style={styles.offlineNoticeHeader}>
        <View style={styles.offlineNoticeIcon}>
          <Ionicons name="cloud-offline-outline" size={19} color={accent} />
        </View>
        <View style={styles.offlineNoticeCopy}>
          <Text style={styles.offlineNoticeTitle}>{savedAt ? 'Saved library' : 'Server unavailable'}</Text>
          <Text selectable style={styles.offlineNoticeBody}>{body}</Text>
        </View>
      </View>
      <View style={styles.offlineNoticeActions}>
        <Pressable
          accessibilityLabel={isRetrying ? 'Reconnecting to the server' : 'Reconnect to the server'}
          accessibilityRole="button"
          accessibilityState={{ busy: isRetrying, disabled: isRetrying }}
          disabled={isRetrying}
          onPress={onRetry}
          style={({ pressed }) => [
            styles.offlineNoticeAction,
            styles.offlineNoticeActionPrimary,
            pressed && styles.pressed,
          ]}
        >
          {isRetrying
            ? <ActivityIndicator color={accentForeground} size="small" />
            : <Ionicons name="refresh-outline" size={17} color={accentForeground} />}
          <Text style={[styles.offlineNoticeActionText, styles.offlineNoticeActionTextPrimary]}>
            {isRetrying ? 'Reconnecting…' : 'Reconnect'}
          </Text>
        </Pressable>
        {onOpenSettings ? (
          <Pressable
            accessibilityLabel="Open connection settings"
            accessibilityRole="button"
            onPress={onOpenSettings}
            style={({ pressed }) => [styles.offlineNoticeAction, pressed && styles.pressed]}
          >
            <Ionicons name="settings-outline" size={17} color={text} />
            <Text style={styles.offlineNoticeActionText}>Connection settings</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
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
  const searchTriggerRef = useRef<View | null>(null);
  useMobileModalLayer({
    open: searchOpen,
    priority: 11,
    onBack: () => {
      setSearchOpen(false);
      setQuery('');
      setSearchScope('all');
    },
    restoreFocusRef: searchTriggerRef,
  });
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
              onPress={(event) => {
                captureMobileFocus(event);
                setFilterOpen(!filterOpen);
              }}
              accessibilityRole="button"
              accessibilityLabel={filterOpen ? 'Close filters' : 'Open filters'}
              accessibilityState={{ expanded: filterOpen }}
              style={({ pressed }) => [styles.topBarIconButton, filterOpen && styles.filterButtonActive, pressed && styles.pressed]}
            >
              <FilterIcon size={20} color={filterOpen || hasActiveFilters ? accent : text} />
            </Pressable>
          ) : null}
          <Pressable
            ref={searchTriggerRef}
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
        cachePolicy="memory-disk"
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
  accessibilityHidden,
  baseUrl,
  bottomOffset,
  cacheBust,
  onDismiss,
  onOpen,
  target,
}: {
  accessibilityHidden?: boolean;
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
        onPress={(event) => {
          captureMobileFocus(event);
          onOpen();
        }}
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
    <View
      accessibilityElementsHidden={accessibilityHidden}
      importantForAccessibility={accessibilityHidden ? 'no-hide-descendants' : 'auto'}
      style={[styles.miniPlayerWrap, { bottom: bottomOffset }]}
    >
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
  accessibilityHidden,
  isRefreshingArtwork,
  isTablet,
  item,
  isWatchlisted,
  progress,
  onClose,
  onOpenKind,
  onToggleList,
  onPlay,
  onDownload,
  onRemoveDownload,
  downloadedMediaIds,
  downloadingMediaId,
  onRefreshArtwork,
}: {
  activeProfile: MobileProfile | null;
  activeKind: LibraryKind;
  artworkCacheBusters: Record<string, string>;
  artworkRefreshError: string;
  baseUrl: string;
  hasMiniPlayer: boolean;
  accessibilityHidden?: boolean;
  isRefreshingArtwork: boolean;
  isTablet: boolean;
  item: MediaItem | null;
  isWatchlisted: boolean;
  progress: Record<string, StoredProgress>;
  onClose: () => void;
  onOpenKind: (kind: LibraryKind) => void;
  onToggleList: (kind: 'watchlist' | 'favorite', present: boolean) => Promise<void>;
  onPlay: (target: PlayTarget) => void;
  onDownload: (target: PlayTarget) => Promise<void>;
  onRemoveDownload: (target: PlayTarget) => Promise<void>;
  downloadedMediaIds: ReadonlySet<string>;
  downloadingMediaId: string;
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
      accessibilityHidden={accessibilityHidden}
      isRefreshingArtwork={isRefreshingArtwork}
      isTablet={isTablet}
      item={item}
      isWatchlisted={isWatchlisted}
      progress={progress}
      onClose={onClose}
      onOpenKind={onOpenKind}
      onToggleList={onToggleList}
      onPlay={onPlay}
      onDownload={onDownload}
      onRemoveDownload={onRemoveDownload}
      downloadedMediaIds={downloadedMediaIds}
      downloadingMediaId={downloadingMediaId}
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
  accessibilityHidden,
  isRefreshingArtwork,
  isTablet,
  item,
  isWatchlisted,
  progress,
  onClose,
  onOpenKind,
  onToggleList,
  onPlay,
  onDownload,
  onRemoveDownload,
  downloadedMediaIds,
  downloadingMediaId,
  onRefreshArtwork,
}: {
  activeProfile: MobileProfile | null;
  activeKind: LibraryKind;
  artworkCacheBusters: Record<string, string>;
  artworkRefreshError: string;
  baseUrl: string;
  hasMiniPlayer: boolean;
  accessibilityHidden?: boolean;
  isRefreshingArtwork: boolean;
  isTablet: boolean;
  item: MediaItem;
  isWatchlisted: boolean;
  progress: Record<string, StoredProgress>;
  onClose: () => void;
  onOpenKind: (kind: LibraryKind) => void;
  onToggleList: (kind: 'watchlist' | 'favorite', present: boolean) => Promise<void>;
  onPlay: (target: PlayTarget) => void;
  onDownload: (target: PlayTarget) => Promise<void>;
  onRemoveDownload: (target: PlayTarget) => Promise<void>;
  downloadedMediaIds: ReadonlySet<string>;
  downloadingMediaId: string;
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
  const seasonNumbers = useMemo(() => orderedSeasonNumbers(item), [item]);
  const [selectedSeason, setSelectedSeason] = useState(seasonNumbers[0] ?? 1);
  const [seasonPickerOpen, setSeasonPickerOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<'episodes' | 'details'>(hasEpisodeTab ? 'episodes' : 'details');
  const seasonEpisodes = episodes.filter((ep) => ep.season === selectedSeason);
  useMobileModalLayer({
    priority: 20,
    onBack: onClose,
  });
  useMobileModalLayer({
    open: seasonPickerOpen,
    priority: 30,
    onBack: () => setSeasonPickerOpen(false),
  });

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
  const primaryPlayTarget = isSeries && nextUp
    ? episodePlayTarget(item, nextUp.ep, progress)
    : playTargetForItem(item, progress);
  const primaryMediaId = mediaIdForPlayTarget(primaryPlayTarget);
  const isDownloaded = downloadedMediaIds.has(primaryMediaId);
  const isDownloading = downloadingMediaId === primaryMediaId;

  const watchProgress = isSeries && nextUp ? nextUp.state : movieState;
  const watchPrimaryLabel = watchProgress.inProgress ? 'Resume' : isSeries ? 'Watch' : 'Watch Now';
  const watchEpisodeLabel = isSeries && nextUp ? episodeCode(nextUp.ep.season, nextUp.ep.episode) : '';
  const watchProgressCopy = watchProgress.inProgress && watchProgress.duration > 0
    ? `${formatShortMinutes(watchProgress.position)} of ${formatShortMinutes(watchProgress.duration)}`
    : '';
  const watchMetaLabel = [watchEpisodeLabel, watchProgressCopy].filter(Boolean).join(' · ');
  const watchProgressWidth = `${Math.round(watchProgress.fraction * 100)}%` as `${number}%`;
  const onPressPlay = () => {
    onPlay(primaryPlayTarget);
  };

  const contentRating = item.contentRating
    || Object.values(item.contentRatings || {}).find((rating) => rating.code.trim())?.code;
  const reportedEpisodeCount = item.episodeCount || episodes.length || 0;
  const reportedSeasonCount = item.seasonCount || new Set(episodes.map((episode) => episode.season)).size;
  const metaLine = [
    item.year ? String(item.year) : null,
    item.format || null,
    contentRating || null,
    item.type === 'movie'
      ? (item.localMetadata?.durationSeconds
        ? formatDuration(item.localMetadata.durationSeconds)
        : item.runtime || null)
      : [
          reportedSeasonCount > 0 ? `${reportedSeasonCount} season${reportedSeasonCount === 1 ? '' : 's'}` : null,
          reportedEpisodeCount > 0 ? `${reportedEpisodeCount} episode${reportedEpisodeCount === 1 ? '' : 's'}` : null,
        ].filter(Boolean).join(' · ') || 'Episodes',
    item.genres?.slice(0, 2).join(', ') || null,
  ].filter(Boolean).join('   ');
  const detailBottomPadding = 48
    + (!isTablet ? Math.max(insets.bottom, 10) + 70 : 0)
    + (hasMiniPlayer ? 82 : 0);

  return (
    <Animated.View
      accessibilityViewIsModal
      accessibilityElementsHidden={accessibilityHidden}
      importantForAccessibility={accessibilityHidden ? 'no-hide-descendants' : 'yes'}
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isDownloaded ? `Remove downloaded ${primaryPlayTarget.title}` : `Download ${primaryPlayTarget.title}`}
            accessibilityState={{ disabled: isDownloading }}
            disabled={isDownloading}
            onPress={() => void (isDownloaded ? onRemoveDownload(primaryPlayTarget) : onDownload(primaryPlayTarget))}
            style={({ pressed }) => [styles.detailTabButton, isDownloading && styles.disabledButton, pressed && styles.pressed]}
          >
            {isDownloading ? <ActivityIndicator color={accent} size="small" /> : <Ionicons name={isDownloaded ? 'checkmark-circle' : 'download-outline'} size={20} color={accent} />}
            <Text style={styles.detailTabLabel}>{isDownloaded ? 'Remove download' : isDownloading ? 'Downloading…' : 'Download'}</Text>
          </Pressable>
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
                  <Text style={styles.seasonPickerText}>{mobileSeasonLabel(selectedSeason)}</Text>
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
                        <Text style={[styles.seasonPickerOptionText, season === selectedSeason && styles.seasonPickerOptionTextActive]}>{mobileSeasonLabel(season)}</Text>
                        <Text style={styles.seasonPickerOptionMeta}>
                          {episodes.filter((ep) => ep.season === season).length} {episodes.filter((ep) => ep.season === season).length === 1 ? 'episode' : 'episodes'}
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
                      airDate={episodeDetails?.airDate}
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
                <Text style={styles.emptyEpisodesCopy}>Refresh the server library or rescan this show folder.</Text>
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
            onPress={(event) => {
              captureMobileFocus(event);
              onRefreshArtwork(item);
            }}
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
  accessibilityHidden,
  baseUrl,
  candidates,
  error,
  item,
  onApply,
  onClose,
}: {
  applyingCandidateId: string;
  accessibilityHidden?: boolean;
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
  useMobileModalLayer({
    open: Boolean(item),
    priority: 40,
    onBack: () => {
      if (!applyingCandidateId) onClose();
    },
  });
  if (!item) return null;

  return (
    <View
      accessibilityViewIsModal
      accessibilityElementsHidden={accessibilityHidden}
      importantForAccessibility={accessibilityHidden ? 'no-hide-descendants' : 'yes'}
      style={styles.posterSheetOverlay}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => {
          if (!applyingCandidateId) onClose();
        }}
        accessibilityLabel="Close poster choices"
      />
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
              <Text style={styles.posterCandidateEmptyCopy}>The server metadata search did not return poster choices for this title.</Text>
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
  airDate,
  summary,
  onPress,
}: {
  baseUrl: string;
  cacheBust?: string;
  episode: EpisodeFile;
  fallbackSources: Array<string | undefined>;
  progress: ReturnType<typeof progressStateFor>;
  airDate?: string;
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
  const episodeAirDate = formatMobileEpisodeAirDate(airDate);
  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.98}
      style={[styles.episodeRow, progress.watched && styles.episodeRowWatched]}
      accessibilityRole="button"
      accessibilityLabel={`Play ${episodeCode(episode.season, episode.episode)} ${episode.title || ''}${episodeAirDate ? `, released ${episodeAirDate}` : ''}`}
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
            {[episodeAirDate, episode.localMetadata?.durationSeconds ? formatDuration(episode.localMetadata.durationSeconds) : 'Runtime unknown'].filter(Boolean).join('  •  ')}
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
      accessibilityLabel={label}
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
              accessibilityLabel={option.label}
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
  const [showLongPreparation, setShowLongPreparation] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<PlayerAspectRatio>('default');
  const [cropMode, setCropMode] = useState<PlayerCropMode>('none');
  const [rotation, setRotation] = useState<PlayerRotation>(0);
  const entrance = useEntrance();
  const [trackWidth, setTrackWidth] = useState(0);
  const [menu, setMenu] = useState<'none' | 'video' | 'speed' | 'audio' | 'subtitles'>('none');
  const playerMenuOpen = menu !== 'none';
  const {
    controlsOpacity,
    controlsVisible,
    duration,
    isPlaying,
    markInteraction,
    nativeAudioTracks,
    nativeSubtitleTracks,
    position,
    seekToFraction,
    seekToSeconds,
    setControlsVisible,
    showControls,
    skipBy,
    toggleControls,
    togglePlay,
  } = useMobilePlayerSession({ menuOpen: playerMenuOpen, playbackUrl, player });
  const { gestureLevel, panHandlers } = useMobilePlayerGestures({
    closeMenu: () => setMenu('none'),
    markInteraction,
    player,
    playerWidth,
    setControlsVisible,
  });
  const playerUnderlayAccessibilityProps = {
    accessibilityElementsHidden: playerMenuOpen,
    importantForAccessibility: playerMenuOpen ? 'no-hide-descendants' as const : 'auto' as const,
  };
  useEffect(() => {
    if (!isPreparing) {
      setShowLongPreparation(false);
      return undefined;
    }
    const timer = setTimeout(() => setShowLongPreparation(true), 2_000);
    return () => clearTimeout(timer);
  }, [isPreparing, target.streamPath]);
  useMobileModalLayer({
    priority: 50,
    onBack: () => {
      if (menu !== 'none') setMenu('none');
      else onClose();
    },
  });
  useMobileModalLayer({
    open: menu !== 'none',
    priority: 60,
    onBack: () => setMenu('none'),
  });
  const [playbackRate, setPlaybackRate] = useState(1);
  const [activeAudioKey, setActiveAudioKey] = useState('');
  const [activeSubtitleKey, setActiveSubtitleKey] = useState('off');
  const [subtitleFontSize, setSubtitleFontSize] = useState(DEFAULT_MOBILE_SUBTITLE_FONT_SIZE);
  const [mediaSegments, setMediaSegments] = useState<MediaSegment[]>([]);
  const recoveryAction = failure ? recoveryActionFor(failure) : null;
  const [trackPreferences, setTrackPreferences] = useState<PlaybackTrackPreferences>({});
  const preferenceScope = useMemo(
    () => playbackPreferenceScope({ mediaId: target.mediaId, streamPath: target.streamPath }),
    [target.mediaId, target.streamPath],
  );
  const appliedPreferenceKeyRef = useRef('');

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
      .then((response) => (response.ok
        ? readJsonResponse(response, playbackTrackPreferencesSchema, 'Playback track preferences')
        : {}))
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
        const payload = await readJsonResponse(response, mediaSegmentsPayloadSchema, 'Skip markers');
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
    if (!controlsVisible) setMenu('none');
  }, [controlsVisible]);

  const toggleMenu = (nextMenu: 'video' | 'speed' | 'audio' | 'subtitles') => {
    showControls();
    setMenu((current) => (current === nextMenu ? 'none' : nextMenu));
  };

  const selectRate = (rate: number) => {
    showControls();
    try {
      player.playbackRate = rate;
    } catch (error) {
      // Rate changes can be rejected while the stream is loading.
      reportNonFatal('player.playback-rate', error);
    }
    setPlaybackRate(rate);
  };

  const streamOptionsForSelection = useCallback((
    audioKey: string,
    subtitleKey: string,
    startSeconds: number,
  ): StreamOptions | null => {
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
  }, [audioOptions, subtitleFontSize, subtitleOptions, target.transcode]);

  const requestSelectionStream = (audioKey: string, subtitleKey: string) => {
    const startSeconds = Number(player.currentTime || position || 0);
    onStreamOptionsChange(streamOptionsForSelection(audioKey, subtitleKey, startSeconds) || {});
  };

  const selectSubtitleFontSize = (fontSize: number) => {
    showControls();
    setSubtitleFontSize(fontSize);
    void SecureStore.setItemAsync(MOBILE_SUBTITLE_FONT_SIZE_KEY, String(fontSize))
      .catch((error) => reportNonFatal('secure-store.subtitle-font-size', error));

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

  const applyNativeTrackSelection = useCallback((audioKey: string, subtitleKey: string) => {
    const audioOption = audioOptions.find((option) => option.key === audioKey);
    const subtitleOption = subtitleOptions.find((option) => option.key === subtitleKey);
    const hasServerSubtitle = Boolean(subtitleOption?.localTrack || subtitleOption?.sidecar);

    if (audioOption?.nativeTrack && localAudioTracks.length === 0 && !hasServerSubtitle) {
      try {
        player.audioTrack = audioOption.nativeTrack;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.audio-track-apply', error);
      }
    }

    if (subtitleOption?.nativeTrack && localSubtitleTracks.length === 0 && !target.subtitles?.length) {
      try {
        player.subtitleTrack = subtitleOption.nativeTrack;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.subtitle-track-apply', error);
      }
    } else if (subtitleKey === 'off') {
      try {
        player.subtitleTrack = null;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.subtitle-track-clear', error);
      }
    }
  }, [audioOptions, localAudioTracks.length, localSubtitleTracks.length, player, subtitleOptions, target.subtitles?.length]);

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
  }, [
    activeAudioKey,
    activeSubtitleKey,
    applyNativeTrackSelection,
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
    mobileLanClient.saveTrackPreferences(baseUrl, deviceToken, preferenceScope, nextPreferences, selectionRevision)
      .catch((error) => reportNonFatal('player.track-preferences-save', error));
  };

  const selectAudioOption = (option: PlayerAudioOption) => {
    showControls();
    setActiveAudioKey(option.key);
    saveTrackPreferences({ audio: audioPreference(option, true) });
    const activeSubtitleOption = subtitleOptions.find((candidate) => candidate.key === activeSubtitleKey);
    const hasServerSubtitle = Boolean(activeSubtitleOption?.localTrack || activeSubtitleOption?.sidecar);
    if (option.nativeTrack && localAudioTracks.length === 0 && !hasServerSubtitle) {
      try {
        player.audioTrack = option.nativeTrack;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.audio-track-select', error);
      }
      return;
    }
    requestSelectionStream(option.key, activeSubtitleKey);
  };

  const selectSubtitleOption = (option: PlayerSubtitleOption | null) => {
    showControls();
    const nextSubtitleKey = option?.key || 'off';
    setActiveSubtitleKey(nextSubtitleKey);
    saveTrackPreferences({ subtitle: subtitlePreference(option, Boolean(option)) });

    if (option?.nativeTrack && localSubtitleTracks.length === 0 && !target.subtitles?.length) {
      try {
        player.subtitleTrack = option.nativeTrack;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.subtitle-track-select', error);
      }
      return;
    }

    if (!option) {
      try {
        player.subtitleTrack = null;
      } catch (error) {
        // Track selection can be rejected while the stream is loading.
        reportNonFatal('player.subtitle-track-disable', error);
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
    <Animated.View
      accessibilityViewIsModal
      importantForAccessibility="yes"
      style={[styles.overlay, styles.playerRoot, entrance]}
    >
      <StatusBar style="light" hidden />
      {playbackUrl ? (
        <>
          <View
            {...playerUnderlayAccessibilityProps}
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
            {...playerUnderlayAccessibilityProps}
            style={StyleSheet.absoluteFill}
            onPress={toggleControls}
            accessibilityLabel={controlsVisible ? 'Hide player controls' : 'Show player controls'}
            {...panHandlers}
          />
          {gestureLevel ? (
            <View {...playerUnderlayAccessibilityProps} style={styles.playerGestureHint} pointerEvents="none">
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
              {...playerUnderlayAccessibilityProps}
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
                {...playerUnderlayAccessibilityProps}
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
                    onPress={(event) => {
                      captureMobileFocus(event);
                      toggleMenu('video');
                    }}
                    style={({ pressed }) => [styles.playerFitButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Video framing settings"
                    accessibilityState={{ expanded: menu === 'video' }}
                  >
                    <Text style={[styles.playerFitLabel, (menu === 'video' || cropMode !== 'none') && styles.playerFitLabelActive]}>
                      {cropMode === 'none' ? 'Fit' : 'Crop'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={(event) => {
                      captureMobileFocus(event);
                      toggleMenu('subtitles');
                    }}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Subtitles"
                    accessibilityState={{ expanded: menu === 'subtitles' }}
                  >
                    <SubtitlesIcon size={22} color={menu === 'subtitles' ? accent : '#ffffff'} />
                  </Pressable>
                  <Pressable
                    onPress={(event) => {
                      captureMobileFocus(event);
                      toggleMenu('audio');
                    }}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Audio tracks"
                    accessibilityState={{ expanded: menu === 'audio' }}
                  >
                    <AudioTracksIcon size={22} color={menu === 'audio' ? accent : '#ffffff'} />
                  </Pressable>
                  <Pressable
                    onPress={(event) => {
                      captureMobileFocus(event);
                      toggleMenu('speed');
                    }}
                    style={({ pressed }) => [styles.playerIconButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Playback speed"
                    accessibilityState={{ expanded: menu === 'speed' }}
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
                  accessibilityValue={{
                    min: 0,
                    max: duration,
                    now: Math.min(position, duration || 0),
                    text: mobileSeekAccessibilityText(position, duration),
                  }}
                  accessibilityActions={[
                    { name: 'decrement', label: 'Seek backward 10 seconds' },
                    { name: 'increment', label: 'Seek forward 10 seconds' },
                  ]}
                  onAccessibilityAction={({ nativeEvent }) => {
                    if (nativeEvent.actionName === 'decrement') seekToSeconds(position - 10);
                    if (nativeEvent.actionName === 'increment') seekToSeconds(position + 10);
                  }}
                >
                  <View style={styles.playerSeekTrack}>
                    <View style={[styles.playerSeekFill, { width: `${progressFractionValue * 100}%` }]} />
                    <View style={[styles.playerSeekThumb, { left: `${progressFractionValue * 100}%` }]} />
                  </View>
                </Pressable>
                <View style={styles.playerTimesRow}>
                  <Text style={styles.playerTime}>{formatClock(position)}</Text>
                  <Text style={styles.playerTime}>{formatClock(duration)}</Text>
                  <Text style={styles.playerTime}>-{formatClock(Math.max(0, duration - position))}</Text>
                </View>
              </View>
              </View>

              {menu !== 'none' ? (
                <View
                  style={[
                    styles.playerMenuPanel,
                    menu === 'video' && { width: menuWidth },
                    { right: Math.max(insets.right, 20), top: Math.max(insets.top, 16) + 56 },
                  ]}
                  accessibilityViewIsModal
                  importantForAccessibility="yes"
                >
                  <Text style={styles.playerMenuTitle}>
                    {menu === 'video' ? 'Video' : menu === 'speed' ? 'Playback Speed' : menu === 'audio' ? 'Audio' : 'Subtitles'}
                  </Text>
                  <ScrollView
                    accessibilityLabel={`${menu === 'video' ? 'Video' : menu === 'speed' ? 'Playback speed' : menu === 'audio' ? 'Audio' : 'Subtitles'} options`}
                    accessibilityRole="menu"
                    style={styles.playerMenuScroll}
                  >
                    {menu === 'video' ? (
                      <View style={styles.playerVideoSettings}>
                        <View style={styles.playerSettingBlock}>
                          <Text style={styles.playerSettingLabel}>Aspect ratio:</Text>
                          <PlayerSegmentedControl
                            options={PLAYER_ASPECT_OPTIONS}
                            value={aspectRatio}
                            onChange={(value) => {
                              showControls();
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
                              showControls();
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
                              showControls();
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
              {failure?.message || (isPreparing
                ? (showLongPreparation ? 'Preparing stream…' : 'Connecting to server…')
                : 'Starting playback…')}
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
            <ExpoImage
        cachePolicy="memory-disk" source={{ uri: mobileProfileAvatarUri(activeProfile) }} style={StyleSheet.absoluteFill} contentFit="cover" />
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
  onPress?: PressableProps['onPress'];
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
      onPress={(event) => {
        if (label === 'Switch profile') captureMobileFocus(event);
        onPress(event);
      }}
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
  const [diagnostics, setDiagnostics] = useState<MobileDiagnosticEvent[]>([]);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const refreshDiagnostics = useCallback(() => {
    void listMobileDiagnostics()
      .then(setDiagnostics)
      .catch((error) => reportNonFatal('diagnostics.list', error));
  }, []);

  useEffect(() => {
    if (section.id === 'about') refreshDiagnostics();
  }, [refreshDiagnostics, section.id]);
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
          <Text selectable style={styles.settingsCardTitle}>Diagnostics</Text>
          <Text selectable style={styles.settingsCardCopy}>
            LoomTV keeps up to 100 sanitized diagnostic events for seven days. Credentials and private paths are removed.
          </Text>
          <Text selectable style={styles.settingsValue}>
            {diagnostics.length === 1 ? '1 recent event' : `${diagnostics.length} recent events`}
          </Text>
          {diagnostics.slice(0, 5).map((event) => (
            <Text key={event.id} selectable numberOfLines={2} style={styles.settingsValue}>
              {event.scope} · {event.name}: {event.message}
            </Text>
          ))}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Export diagnostics"
              disabled={diagnosticsBusy || diagnostics.length === 0}
              style={[{ minHeight: 44, minWidth: 96, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 10, paddingHorizontal: 16 }, { borderColor: 'rgba(255,255,255,0.2)' }, (diagnosticsBusy || diagnostics.length === 0) && styles.disabledButton]}
              onPress={() => {
                setDiagnosticsBusy(true);
                void exportMobileDiagnostics()
                  .then((message) => Share.share({ title: 'LoomTV diagnostics', message }))
                  .catch((error) => reportNonFatal('diagnostics.export', error))
                  .finally(() => setDiagnosticsBusy(false));
              }}
            >
              <Text style={styles.settingsValue}>Export</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear diagnostics"
              disabled={diagnosticsBusy || diagnostics.length === 0}
              style={[{ minHeight: 44, minWidth: 96, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 10, paddingHorizontal: 16 }, { borderColor: 'rgba(255,255,255,0.2)' }, (diagnosticsBusy || diagnostics.length === 0) && styles.disabledButton]}
              onPress={() => {
                setDiagnosticsBusy(true);
                void clearMobileDiagnostics()
                  .then(() => setDiagnostics([]))
                  .catch((error) => reportNonFatal('diagnostics.clear', error))
                  .finally(() => setDiagnosticsBusy(false));
              }}
            >
              <Text style={styles.settingsValue}>Clear</Text>
            </Pressable>
          </View>
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
  const hasItems = grouped.anime.length > 0 || grouped.tv.length > 0 || grouped.movies.length > 0;

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
    <View style={[styles.heroCard, { height, width }]}>
      <PressableScale
        accessibilityLabel={`Open ${item.title}`}
        accessibilityRole="button"
        onPress={onSelect}
        scaleTo={0.98}
        style={StyleSheet.absoluteFill}
      >
        <View pointerEvents="none" style={StyleSheet.absoluteFill} />
      </PressableScale>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
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
        <View style={[styles.heroCardFooter, { paddingBottom: 84 }]}>
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
        </View>
      </View>
      <Pressable
        accessibilityLabel={`${resume ? 'Resume' : 'Play'} ${item.title}`}
        accessibilityRole="button"
        onPress={(event) => {
          captureMobileFocus(event);
          onPlay();
        }}
        style={({ pressed }) => [
          styles.heroPlayButton,
          { bottom: 16, left: 16, position: 'absolute', right: 16, width: undefined, zIndex: 3 },
          pressed && styles.heroPlayButtonPressed,
        ]}
      >
        <PlayIcon size={22} color={accentForeground} />
        <Text style={styles.heroPlayButtonText}>{resume ? 'Resume' : 'Play'}</Text>
      </Pressable>
    </View>
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
          <Text selectable style={styles.emptyCopy}>Try another search or refresh the server library.</Text>
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
      <Text selectable style={styles.emptyTitle}>Add your first library folder on the server</Text>
      <Text selectable style={styles.emptyCopy}>
        Pairing worked. Add video folders on your LoomTV server, then refresh here.
      </Text>
    </View>
  );
}
