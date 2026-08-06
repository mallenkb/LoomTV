/**
 * VideoPlayer — in-app HTML5 player with stream fallback.
 *
 * Uses the local media server stream for native playback and attempts a
 * one-time H.264/AAC transcode fallback when direct playback fails.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Hls from 'hls.js';
import type { ErrorData } from 'hls.js';
import LoomLoader from '@/components/LoomLoader';
import { useTheme } from '@/components/ThemeProvider';
import { useLibrary } from '@/contexts/LibraryContext';
import {
  desktopApi,
  type ManagedMediaSegment,
  type MediaSegment,
  type MediaSegmentType,
} from '@/lib/desktopApi';
import { cleanEpisodeTitleForDisplay } from '@/lib/episodeTitles';
import { registerPlaybackShutdown } from '@/lib/playbackLifecycle';
import {
  getPlayableStartPosition,
  hydrateProgressFromDatabase,
  saveProgress as savePlaybackProgress,
} from '@/lib/progress';
import {
  DEFAULT_EPISODE_PANEL_WIDTH,
  DEFAULT_MEDIA_PANEL_WIDTH,
  DEFAULT_SKIP_BACK_SECONDS,
  DEFAULT_SKIP_FORWARD_SECONDS,
  END_COMPLETION_TOLERANCE_SECONDS,
  HLS_RECOVERY_ATTEMPTS,
  HLS_TRANSCODE_RESTART_ATTEMPTS,
  NEXT_EPISODE_COUNTDOWN_SECONDS,
  NEXT_EPISODE_PROMPT_REMAINING_SECONDS,
  REPLAY_FROM_START_REMAINING_SECONDS,
  SUBTITLE_DELAY_FINE_STEP_SECONDS,
  SUBTITLE_DELAY_STEP_SECONDS,
  TRANSCODE_SEEK_DEBOUNCE_MS,
  TRANSCODE_SEEK_HOLD_TIMEOUT_MS,
  WATCHED_THRESHOLD,
} from './VideoPlayer/constants';
import type {
  AspectMode,
  ControlTab,
  CropMode,
  EpisodeFile,
  EpisodeMeta,
  MediaTrack,
  PlaybackTrackPreferences,
  PlayerState,
  RotationMode,
  SubtitleStyleSettings,
  VideoPlayerProps,
} from './VideoPlayer/types';
export type { VideoPlayerProps } from './VideoPlayer/types';
import {
  cleanEpisodeTitle,
  clampSeconds,
  epCode,
  externalSubtitleOrdinal,
  firstSubtitleTrackIndex,
  firstTrackIndex,
  formatTime,
  getStoredDuration,
  hlsErrorSummary,
  isBitmapSubtitleCodec,
  isSignsOnlySubtitleTrack,
  loadSharedTrackPreferences,
  loadSubtitlesDefaultEnabled,
  mediaErrorMessage,
  parseVttCues,
  preferredTrackIndex,
  probeDurationSeconds,
  probeTracks,
  saveSubtitlesDefaultEnabled,
  saveTrackPreference,
  selectedEmbeddedSubtitle,
  shouldRestartMissingLocalHls,
  subtitleSource,
  trackPreferenceScope,
  transcodeErrorMessage,
  type SubtitleCue,
} from './VideoPlayer/helpers';
import PauseOverlay from './VideoPlayer/PauseOverlay';
import NextEpisodePrompt from './VideoPlayer/NextEpisodePrompt';
import PlayerControlBar from './VideoPlayer/PlayerControlBar';
import PlayerEpisodePanel from './VideoPlayer/PlayerEpisodePanel';
import PlayerMarkerEditor from './VideoPlayer/PlayerMarkerEditor';
import PlayerSettingsPanel from './VideoPlayer/PlayerSettingsPanel';
import SubtitleOverlay from './VideoPlayer/SubtitleOverlay';
import TopPlayerControls from './VideoPlayer/TopPlayerControls';
import { loadSubtitleStyle, saveSubtitleStyle } from './VideoPlayer/subtitleStyleStorage';
import { absoluteMediaSeconds, playerSecondsForAbsolute } from './VideoPlayer/playbackClock';
import { activeSkipSegmentAt, shouldShowSkipPrompt, skipPromptLabel } from './VideoPlayer/skipPrompt';
import {
  groupEpisodesBySeason,
  nextPlayableEpisodeFile,
  sortedPlayableEpisodeFiles,
  sortedSeasonNumbers,
} from './VideoPlayer/episodeIndex';
import {
  clampSubtitleDelay,
  hasReachedInitialResumePosition,
  isEditableShortcutTarget,
  initialHlsStartPosition,
  initialStreamOffset,
  isTimeBuffered,
  isPlayerControlTarget,
  playbackProgressForExit,
  resolveInitialPlaybackPosition,
  shouldRestartUnseekableDirectStream,
  shouldRestartTranscodedSubtitleStyle,
  shouldShowSubtitleOverlay,
  shouldUseNativeSubtitleTracks,
  subtitleTrackPlaybackAction,
  transcodeSeekRestartOptions,
} from './VideoPlayer/playerControls';
import { usePlayerChrome } from './VideoPlayer/usePlayerChrome';
import { useSidePanelResize } from './VideoPlayer/useSidePanelResize';
import LibVlcPlaybackEngine from './VideoPlayer/engines/LibVlcPlaybackEngine';
import MpvPlaybackEngine from './VideoPlayer/engines/MpvPlaybackEngine';
import type { PlaybackEngine, PlaybackEngineKind, PlaybackEngineState } from './VideoPlayer/engines/PlaybackEngine';

const EMPTY_EPISODES: EpisodeMeta[] = [];
const EMPTY_EPISODE_FILES: EpisodeFile[] = [];
const EMPTY_SUBTITLES: NonNullable<VideoPlayerProps['subtitles']> = [];
const POSITION_UI_UPDATE_INTERVAL_MS = 1000;
const PROGRESS_SAVE_INTERVAL_MS = 2000;
const NATIVE_SCRUB_PREVIEW_INTERVAL_MS = 80;
const NATIVE_SEEK_GUARD_TIMEOUT_MS = 2500;
const NATIVE_SEEK_LANDING_TOLERANCE_SECONDS = 1.25;
// Keep the first surface click pending long enough for the macOS double-click
// interval to deliver its second click. This prevents a slow system double
// click from pausing before the fullscreen gesture is recognized.
const SURFACE_DOUBLE_CLICK_WINDOW_MS = 500;

function subtitleLanguageKey(language?: string): string {
  const normalized = (language || '').trim().toLowerCase().split(/[-_]/)[0];
  if (!normalized || normalized === 'und') return '';
  try {
    const DisplayNames = (Intl as typeof Intl & {
      DisplayNames?: new (locales: string[], options: { type: 'language' }) => { of: (code: string) => string | undefined };
    }).DisplayNames;
    if (!DisplayNames) return normalized;
    return (new DisplayNames(['en'], { type: 'language' }).of(normalized) || normalized).toLowerCase();
  } catch {
    return normalized;
  }
}

function compatibleTextSubtitleTrack(tracks: MediaTrack[], selectedIndex: number): MediaTrack | null {
  const selected = tracks.find((track) => track.type === 'subtitle' && track.index === selectedIndex);
  if (!selected || !isBitmapSubtitleCodec(selected.codec)) return null;

  const textTracks = tracks.filter((track) => track.type === 'subtitle' && !isBitmapSubtitleCodec(track.codec));
  const language = subtitleLanguageKey(selected.language);
  const languageMatches = textTracks.filter((track) => subtitleLanguageKey(track.language) === language);
  if (languageMatches.length === 0) return null;

  const forcedMatches = languageMatches.filter((track) => Boolean(track.forced) === Boolean(selected.forced));
  const forcedPool = forcedMatches.length > 0 ? forcedMatches : languageMatches;
  const signsOnly = isSignsOnlySubtitleTrack(selected);
  const intentMatches = forcedPool.filter((track) => isSignsOnlySubtitleTrack(track) === signsOnly);
  const intentPool = intentMatches.length > 0 ? intentMatches : forcedPool;
  const accessibilityIntent = /\b(?:sdh|cc|hearing[ -]?impaired)\b/i.test(selected.title || '');
  const accessibilityMatches = intentPool.filter((track) =>
    /\b(?:sdh|cc|hearing[ -]?impaired)\b/i.test(track.title || '') === accessibilityIntent,
  );
  const candidates = accessibilityMatches.length > 0 ? accessibilityMatches : intentPool;

  return candidates.find((track) => Boolean(track.default) === Boolean(selected.default))
    || candidates.find((track) => track.source === selected.source)
    || candidates[0]
    || null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function VideoPlayer({
  mediaId,
  filePath,
  title,
  artwork,
  subtitles = EMPTY_SUBTITLES,
  episodes = EMPTY_EPISODES,
  episodeFiles = EMPTY_EPISODE_FILES,
  currentSeason = 1,
  currentEpisode = 1,
  startPosition,
  onClose,
  onEpisodeChange,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { state: libraryState } = useLibrary();
  const playbackActivityKeyRef = useRef(`desktop-player:${crypto.randomUUID()}`);
  const { theme } = useTheme();
  const isModern = theme.homeStyle === 'modern';
  const containerRef = useRef<HTMLDivElement>(null);
  const videoViewportRef = useRef<HTMLDivElement>(null);
  const seekSliderRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const progressThumbRef = useRef<HTMLDivElement>(null);
  const scrubTimeHudRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const durationTimeTextRef = useRef<HTMLSpanElement>(null);
  const errorRetryButtonRef = useRef<HTMLButtonElement>(null);
  const errorCloseButtonRef = useRef<HTMLButtonElement>(null);
  const showRemainingTimeRef = useRef(false);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfaceSingleClickActionRef = useRef<{ wasPaused: boolean; executedAt: number } | null>(null);
  const surfaceDoubleClickGuardUntilMsRef = useRef(0);
  const hlsRef = useRef<Hls | null>(null);
  const transcodeSessionIdRef = useRef<string | null>(null);
  const pendingSourceSwapRef = useRef<{
    streamUrl: string;
    previousSessionId: string | null;
    nextSessionId: string;
    position: number;
    wasPaused: boolean;
    volume: number;
    muted: boolean;
    playbackRate: number;
    seekable: boolean;
    transcodeStartSeconds: number;
  } | null>(null);
  const trackChangeGenerationRef = useRef(0);
  const loadTokenRef = useRef(0);
  const sourceLoadTokenRef = useRef(0);
  const playerActiveRef = useRef(true);
  const userPausedRef = useRef(false);
  const suppressPauseIntentUntilMsRef = useRef(0);
  const didTryTranscodeRef = useRef(false);
  const hasPlayableDataRef = useRef(false);
  const transcodeStartSecondsRef = useRef(0);
  const hlsRecoveryAttemptsRef = useRef(0);
  const hlsTranscodeRestartAttemptsRef = useRef(0);
  const probedDurationRef = useRef(0);
  const probeTracksRef = useRef<MediaTrack[]>([]);
  const selectedVideoTrackIndexRef = useRef<number | undefined>(undefined);
  const selectedAudioTrackIndexRef = useRef<number | undefined>(undefined);
  const selectedSubtitleTrackIndexRef = useRef<number>(-1);
  const subtitleSelectionExplicitRef = useRef(false);
  const subtitlesDefaultEnabledRef = useRef(loadSubtitlesDefaultEnabled());
  const subtitleStyleRef = useRef<SubtitleStyleSettings>(loadSubtitleStyle());
  const audioDelayRef = useRef(0);
  const applyNativeTextTrackVisibilityRef = useRef<() => void>(() => undefined);
  const nextEpisodeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPositionUiUpdateRef = useRef(0);
  const lastProgressSaveRef = useRef(0);
  const playbackPositionRef = useRef(0);
  const playbackDurationRef = useRef(0);
  const initialResumePositionRef = useRef(0);
  const loadedFilePathRef = useRef('');
  const isScrubbingRef = useRef(false);
  const scrubPreviewRafRef = useRef<number | null>(null);
  const scrubListenerCleanupRef = useRef<(() => void) | null>(null);
  const scrubHudHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nativeScrubSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNativeScrubSeekRef = useRef<number | null>(null);
  const lastNativeScrubSeekAtRef = useRef(0);
  const nativeSeekGuardRef = useRef<{ target: number; expiresAt: number } | null>(null);
  const transcodeSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTranscodeSeekRef = useRef<number | null>(null);
  const transcodeSeekActiveRef = useRef(false);
  const transcodeSeekGenerationRef = useRef(0);
  const browserStreamGenerationRef = useRef(0);
  const transcodeSeekSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True when the active transcoded stream is a full-duration seekable VOD,
  // so seeking is a native currentTime change instead of an encoder restart.
  const streamIsSeekableRef = useRef(false);
  // Remux/direct-stream playback copies the original video whenever Chromium
  // can decode it. Seeking restarts that lightweight stream at the requested
  // timestamp instead of falling back to a full HLS video transcode.
  const streamUsesBrowserPipelineRef = useRef(false);
  const subtitleStyleApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nativeSubtitleFallbackRef = useRef(false);
  const libVlcSubtitleFallbackRef = useRef(false);
  const nativeSubtitleStyleRefreshRafRef = useRef<number | null>(null);
  // Set before handing control to the next episode so queued events from the
  // outgoing media element cannot restart that same episode during teardown.
  const pendingEpisodeTransitionRef = useRef<string | null>(null);
  // An open-ended credits marker means "finish this episode". Keep that
  // intent across the final seek so an ended event advances instead of being
  // treated as an interrupted transcode that should restart this file.
  const pendingCreditsCompletionRef = useRef(false);
  const playbackEngineRef = useRef<PlaybackEngine | null>(null);
  const nativeInitialTracksAppliedRef = useRef(false);

  const cancelPendingSurfaceClick = useCallback((preserveDoubleClickGuard = false) => {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    surfaceSingleClickActionRef.current = null;
    if (!preserveDoubleClickGuard) surfaceDoubleClickGuardUntilMsRef.current = 0;
  }, []);

  const [streamUrl, setStreamUrl] = useState<string>('');
  const [streamIsTranscoded, setStreamIsTranscoded] = useState(false);
  const [playerState, setPlayerState] = useState<PlayerState>('loading');
  const [statusMessage, setStatusMessage] = useState('Preparing player...');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [nativePlaybackActive, setNativePlaybackActive] = useState(false);
  const [nativeEngineKind, setNativeEngineKind] = useState<PlaybackEngineKind | null>(null);
  const libVlcSurfaceActive = nativePlaybackActive && nativeEngineKind === 'libvlc';

  const libraryDurationHint = useMemo(() => {
    const items = [...libraryState.movies, ...libraryState.tvShows, ...libraryState.animeShows];
    const media = (mediaId ? items.find((item) => item.id === mediaId) : undefined)
      || items.find((item) => item.filePath === filePath || item.episodeFiles?.some((episode) => episode.filePath === filePath));
    if (!media) return 0;
    if (media.filePath === filePath || media.type === 'movie') return media.localMetadata?.durationSeconds || 0;
    const episode = media.episodeFiles?.find((candidate) =>
      candidate.filePath === filePath
      || (candidate.season === currentSeason && candidate.episode === currentEpisode),
    );
    return episode?.localMetadata?.durationSeconds || 0;
  }, [currentEpisode, currentSeason, filePath, libraryState.animeShows, libraryState.movies, libraryState.tvShows, mediaId]);

  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showMediaPanel, setShowMediaPanel] = useState(false);
  const [episodePanelWidth, setEpisodePanelWidth] = useState(DEFAULT_EPISODE_PANEL_WIDTH);
  const [mediaPanelWidth, setMediaPanelWidth] = useState(DEFAULT_MEDIA_PANEL_WIDTH);
  const [mediaPanelTab, setMediaPanelTab] = useState<ControlTab>('subtitles');
  const [mediaTracks, setMediaTracks] = useState<MediaTrack[]>([]);
  const [serverBase, setServerBase] = useState('');
  const [selectedVideoTrackIndex, setSelectedVideoTrackIndex] = useState(-1);
  const [selectedAudioTrackIndex, setSelectedAudioTrackIndex] = useState(-1);
  const [selectedSubtitleTrackIndex, setSelectedSubtitleTrackIndex] = useState(-1);
  const [selectedSecondarySubtitleTrackIndex, setSelectedSecondarySubtitleTrackIndex] = useState(-1);
  const [subtitlesDefaultEnabled, setSubtitlesDefaultEnabled] = useState(subtitlesDefaultEnabledRef.current);
  const [openSubtitlesEnabled, setOpenSubtitlesEnabled] = useState(false);
  const autoplayNextEnabled = true;
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyleSettings>(() => subtitleStyleRef.current);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [aspectMode, setAspectMode] = useState<AspectMode>('default');
  const [cropMode, setCropMode] = useState<CropMode>('none');
  const [rotation, setRotation] = useState<RotationMode>(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [audioDelay, setAudioDelay] = useState(0);
  const [skipBackSeconds, setSkipBackSeconds] = useState(DEFAULT_SKIP_BACK_SECONDS);
  const [skipForwardSeconds, setSkipForwardSeconds] = useState(DEFAULT_SKIP_FORWARD_SECONDS);
  const [skipPromptTypes, setSkipPromptTypes] = useState<Record<MediaSegmentType, boolean>>({ intro: true, recap: true, outro: true, credits: true, preview: true });
  const [dismissedNextPromptKey, setDismissedNextPromptKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // force episode list re-render
  const [playbackLogoCandidates, setPlaybackLogoCandidates] = useState<string[]>([]);
  const [mediaSegments, setMediaSegments] = useState<MediaSegment[]>([]);
  const [showMarkerEditor, setShowMarkerEditor] = useState(false);
  const [markerType, setMarkerType] = useState<MediaSegmentType>('intro');
  const [markerStart, setMarkerStart] = useState('0');
  const [markerEnd, setMarkerEnd] = useState('90');
  const [markerSaving, setMarkerSaving] = useState(false);
  const [markerError, setMarkerError] = useState<string | null>(null);
  const [rejectedSegments, setRejectedSegments] = useState<ManagedMediaSegment[]>([]);
  const syncNativeViewport = useCallback(async () => {
    if (!libVlcSurfaceActive) return true;
    const element = videoViewportRef.current;
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return desktopApi.libvlc.setViewport({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, [libVlcSurfaceActive]);
  const playerStateRef = useRef<PlayerState>(playerState);
  const {
    fullscreen,
    handlePointerMove,
    showControls,
    showTopControls,
    toggleFullscreen: requestFullscreenToggle,
  } = usePlayerChrome(paused, containerRef, libVlcSurfaceActive, syncNativeViewport);
  const toggleFullscreen = useCallback(() => {
    cancelPendingSurfaceClick();
    requestFullscreenToggle();
  }, [cancelPendingSurfaceClick, requestFullscreenToggle]);
  const startSidePanelResize = useSidePanelResize();

  // Fullscreen can also change through the browser/system lifecycle. Any
  // pending surface click belongs to the previous gesture and must not pause
  // or resume playback after that transition has started.
  useEffect(() => {
    cancelPendingSurfaceClick(surfaceDoubleClickGuardUntilMsRef.current > Date.now());
  }, [cancelPendingSurfaceClick, fullscreen]);

  // titleBarStyle is 'hiddenInset', so the macOS traffic lights float over
  // whatever sits beneath them — in the player, the video. Fade them with the
  // player's own chrome instead of leaving them permanently on the picture,
  // and always restore them when the player unmounts.
  useEffect(() => {
    void desktopApi.setWindowChromeVisible(showTopControls);
  }, [showTopControls]);
  useEffect(() => () => { void desktopApi.setWindowChromeVisible(true); }, []);

  useEffect(() => {
    playerStateRef.current = playerState;
  }, [playerState]);

  useEffect(() => {
    if (playerState === 'error') errorRetryButtonRef.current?.focus();
  }, [playerState]);

  useEffect(() => {
    const key = playbackActivityKeyRef.current;
    void desktopApi.setPlaybackActivity(key, true, `desktop player: ${filePath}`);
    return () => {
      void desktopApi.setPlaybackActivity(key, false);
    };
  }, [filePath]);

  const syncPlaybackUi = useCallback((nextPosition: number, nextDuration: number) => {
    const safeDuration = Number.isFinite(nextDuration) ? Math.max(0, nextDuration) : 0;
    const safePosition = clampSeconds(nextPosition, safeDuration || undefined);
    const progressRatio = safeDuration > 0 ? Math.min(1, Math.max(0, safePosition / safeDuration)) : 0;
    const progressPercent = progressRatio * 100;

    if (progressFillRef.current) {
      progressFillRef.current.style.transform = `scaleX(${progressRatio})`;
    }
    if (progressThumbRef.current) {
      progressThumbRef.current.style.left = `${progressPercent}%`;
    }
    if (scrubTimeHudRef.current) {
      scrubTimeHudRef.current.style.left = `${progressPercent}%`;
      scrubTimeHudRef.current.textContent = `${formatTime(safePosition)} / ${formatTime(safeDuration)}`;
    }
    if (currentTimeTextRef.current) {
      const displayTime = showRemainingTimeRef.current
        ? `-${formatTime(Math.max(0, safeDuration - safePosition))}`
        : formatTime(safePosition);
      currentTimeTextRef.current.textContent = displayTime;
    }
    if (durationTimeTextRef.current) {
      durationTimeTextRef.current.textContent = formatTime(safeDuration);
    }
    if (seekSliderRef.current) {
      seekSliderRef.current.setAttribute('aria-valuemax', String(safeDuration || 0));
      seekSliderRef.current.setAttribute('aria-valuenow', String(Math.min(safePosition, safeDuration || safePosition)));
      seekSliderRef.current.setAttribute('aria-valuetext', `${formatTime(safePosition)} of ${formatTime(safeDuration)}`);
    }
  }, []);

  const toggleTimeDisplay = useCallback(() => {
    const nextShowRemainingTime = !showRemainingTimeRef.current;
    showRemainingTimeRef.current = nextShowRemainingTime;
    setShowRemainingTime(nextShowRemainingTime);
    syncPlaybackUi(playbackPositionRef.current, playbackDurationRef.current);
  }, [syncPlaybackUi]);

  const updatePlaybackSnapshot = useCallback((
    nextPosition: number,
    nextDuration = playbackDurationRef.current,
    options: { forceReact?: boolean } = {},
  ) => {
    const safeDuration = Number.isFinite(nextDuration) ? Math.max(0, nextDuration) : 0;
    const safePosition = clampSeconds(nextPosition, safeDuration || undefined);
    playbackPositionRef.current = safePosition;
    playbackDurationRef.current = safeDuration;
    syncPlaybackUi(safePosition, safeDuration);

    const now = performance.now();
    if (options.forceReact || now - lastPositionUiUpdateRef.current >= POSITION_UI_UPDATE_INTERVAL_MS) {
      lastPositionUiUpdateRef.current = now;
      setPosition(safePosition);
      setDuration(safeDuration);
    }
  }, [syncPlaybackUi]);

  const trackPreferenceScopeKey = useMemo(() => trackPreferenceScope(mediaId, filePath), [filePath, mediaId]);
  const sharedTrackPreferencesRef = useRef<PlaybackTrackPreferences>({});
  const trackPreferencesLoadRef = useRef<Promise<PlaybackTrackPreferences>>(Promise.resolve({}));
  useEffect(() => {
    let cancelled = false;
    sharedTrackPreferencesRef.current = {};
    const loadPreferences = loadSharedTrackPreferences(trackPreferenceScopeKey).then((preferences) => {
      const currentPreferences = sharedTrackPreferencesRef.current;
      return {
        ...preferences,
        ...(currentPreferences.audio ? { audio: currentPreferences.audio } : {}),
        ...(currentPreferences.subtitle ? { subtitle: currentPreferences.subtitle } : {}),
      };
    });
    trackPreferencesLoadRef.current = loadPreferences;
    void loadPreferences.then((mergedPreferences) => {
      if (!cancelled) {
        // A quick user selection can happen while the saved preferences are
        // still loading. Keep that newer in-session choice when the request
        // completes instead of overwriting it with the older stored value.
        sharedTrackPreferencesRef.current = mergedPreferences;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [trackPreferenceScopeKey]);
  const pauseLogoSources = useMemo(() =>
    Array.from(new Set([
      ...playbackLogoCandidates,
      ...(artwork?.logoCandidates || []),
      artwork?.logo,
    ].filter((source): source is string => Boolean(source)))),
  [artwork?.logo, artwork?.logoCandidates, playbackLogoCandidates]);
  useEffect(() => {
    void hydrateProgressFromDatabase().then(() => setTick((value) => value + 1));
  }, []);

  useEffect(() => {
    setPlaybackLogoCandidates([]);
    if (!mediaId) return;
    let cancelled = false;
    void desktopApi.getPlaybackLogo(mediaId)
      .then((result) => {
        if (cancelled) return;
        setPlaybackLogoCandidates(
          Array.from(new Set([...(result.logoCandidates || []), result.logo].filter((source): source is string => Boolean(source)))),
        );
      })
      .catch((error) => {
        console.warn('[VideoPlayer] playback logo lookup failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  useEffect(() => {
    setMediaSegments([]);
    if (!mediaId) return;
    let cancelled = false;
    const isEpisodePlayback = episodes.length > 0 && episodeFiles.length > 0;
    const request = isEpisodePlayback
      ? { mediaId, season: currentSeason, episode: currentEpisode }
      : { mediaId };
    let refreshTimer: number | null = null;
    const retryDelays = [5000, 15000];
    const load = async (attempt = 0) => {
      try {
        const response = await desktopApi.getMediaSegments(request);
        if (cancelled) return;
        setMediaSegments(response.segments);
        if (response.segments.length === 0 && attempt < retryDelays.length) {
          refreshTimer = window.setTimeout(() => void load(attempt + 1), retryDelays[attempt]);
        }
      } catch (error) {
        if (!cancelled) console.warn('[VideoPlayer] skip marker lookup failed', error);
        if (!cancelled && attempt < retryDelays.length) {
          refreshTimer = window.setTimeout(() => void load(attempt + 1), retryDelays[attempt]);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [currentEpisode, currentSeason, episodeFiles.length, episodes.length, filePath, mediaId]);

  useEffect(() => {
    pauseLogoSources.slice(0, 3).forEach((source) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = source;
    });
  }, [pauseLogoSources]);

  useEffect(() => {
    subtitleStyleRef.current = subtitleStyle;
    saveSubtitleStyle(subtitleStyle);
  }, [subtitleStyle]);

  useEffect(() => {
    setDismissedNextPromptKey(null);
    setRejectedSegments([]);
    subtitleSelectionExplicitRef.current = false;
    pendingEpisodeTransitionRef.current = null;
    pendingCreditsCompletionRef.current = false;
    nativeSeekGuardRef.current = null;
    pendingNativeScrubSeekRef.current = null;
  }, [filePath]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([desktopApi.getSettings(), desktopApi.getProfilePreferences()])
      .then(([settings, preferences]) => {
        if (cancelled) return;
        setSkipBackSeconds(
          Number.isFinite(preferences.playbackSkipBackSeconds ?? settings.playbackSkipBackSeconds)
            ? Number(preferences.playbackSkipBackSeconds ?? settings.playbackSkipBackSeconds)
            : DEFAULT_SKIP_BACK_SECONDS,
        );
        setSkipForwardSeconds(
          Number.isFinite(preferences.playbackSkipForwardSeconds ?? settings.playbackSkipForwardSeconds)
            ? Number(preferences.playbackSkipForwardSeconds ?? settings.playbackSkipForwardSeconds)
            : DEFAULT_SKIP_FORWARD_SECONDS,
        );
        if (settings.skipAnalysis?.promptTypes) setSkipPromptTypes(settings.skipAnalysis.promptTypes);
        setOpenSubtitlesEnabled(Boolean(settings.openSubtitlesAutoDownload));
      })
      .catch(() => {
        if (cancelled) return;
        setSkipBackSeconds(DEFAULT_SKIP_BACK_SECONDS);
        setSkipForwardSeconds(DEFAULT_SKIP_FORWARD_SECONDS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasEpisodes = episodes.length > 0 && episodeFiles.length > 0;
  const videoTracks = useMemo(() => mediaTracks.filter((track) => track.type === 'video'), [mediaTracks]);
  const audioTracks = useMemo(() => mediaTracks.filter((track) => track.type === 'audio'), [mediaTracks]);
  const visibleSubtitles = useMemo(
    () => subtitles.filter((subtitle) => subtitle.source !== 'opensubtitles' || openSubtitlesEnabled),
    [openSubtitlesEnabled, subtitles],
  );
  const visibleSubtitlesRef = useRef(visibleSubtitles);
  visibleSubtitlesRef.current = visibleSubtitles;
  const externalSubtitleTracks = useMemo<MediaTrack[]>(
    () => visibleSubtitles.map((subtitle, index) => ({
      index: -1000 - index,
      type: 'subtitle',
      codec: subtitle.format || 'external',
      language: subtitle.lang,
      title: subtitle.label,
      default: false,
      forced: false,
      source: subtitle.source || 'sidecar',
    })),
    [visibleSubtitles],
  );
  const subtitleTracks = useMemo(() => mediaTracks.filter((track) => track.type === 'subtitle'), [mediaTracks]);

  const groupedEpisodes = useMemo(() => groupEpisodesBySeason(episodes), [episodes]);

  const displayEpisodeTitle = useCallback((season: number, episode: number, rawTitle?: string, filePath?: string): string => {
    const metadataTitle = cleanEpisodeTitleForDisplay(rawTitle, title, season, episode);
    if (metadataTitle !== `Episode ${episode}`) return metadataTitle;
    if (!filePath) return metadataTitle;

    const fileTitle = cleanEpisodeTitle(filePath, season, episode);
    return fileTitle !== `Episode ${episode}` ? fileTitle : metadataTitle;
  }, [title]);

  const sortedSeasons = useMemo(() => sortedSeasonNumbers(groupedEpisodes), [groupedEpisodes]);

  const playableEpisodeFiles = useMemo(
    () => sortedPlayableEpisodeFiles(episodeFiles),
    [episodeFiles],
  );

  const nextEpisodeFile = useMemo(
    () => hasEpisodes
      ? nextPlayableEpisodeFile(playableEpisodeFiles, currentSeason, currentEpisode, filePath)
      : null,
    [currentEpisode, currentSeason, filePath, hasEpisodes, playableEpisodeFiles],
  );

  const stopTranscodeSession = useCallback(async () => {
    const sessionIds = new Set([
      transcodeSessionIdRef.current,
      pendingSourceSwapRef.current?.previousSessionId,
      pendingSourceSwapRef.current?.nextSessionId,
    ].filter((sessionId): sessionId is string => Boolean(sessionId)));
    transcodeSessionIdRef.current = null;
    pendingSourceSwapRef.current = null;
    for (const sessionId of sessionIds) {
      try {
        await desktopApi.media.stopTranscode(sessionId);
      } catch (_error) {
        // Non-fatal cleanup failure.
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void desktopApi.getServerBase()
      .then((base) => {
        if (!cancelled) setServerBase(base);
      })
      .catch(() => {
        if (!cancelled) setServerBase('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const index = selectedSubtitleTrackIndex;
    const resolveSubtitleUrl = async (): Promise<string> => {
      if (index <= -1000) {
        const external = visibleSubtitles[-1000 - index];
        return external ? subtitleSource(external.url, serverBase) : '';
      }
      if (index >= 0) {
        const embedded = selectedEmbeddedSubtitle(mediaTracks, index);
        if (embedded && !isBitmapSubtitleCodec(embedded.track.codec)) {
          const result = await desktopApi.getSubtitleUrl(filePath, embedded.ordinal);
          return result.url;
        }
      }
      return '';
    };

    setSubtitleCues([]);
    void (async () => {
      try {
        const url = await resolveSubtitleUrl();
        if (cancelled || !url) return;
        const response = await fetch(url, { signal: controller.signal });
        const text = response.ok ? await response.text() : '';
        if (!cancelled) setSubtitleCues(parseVttCues(text));
      } catch {
        if (!cancelled) setSubtitleCues([]);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [filePath, mediaTracks, selectedSubtitleTrackIndex, serverBase, visibleSubtitles]);

  const clearHls = useCallback(() => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.destroy();
    hlsRef.current = null;
  }, []);

  const clearVideoElement = useCallback((video: HTMLVideoElement) => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }, []);

  const applyNativeTextTrackVisibility = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const selectedExternalOrdinal = externalSubtitleOrdinal(externalSubtitleTracks, selectedSubtitleTrackIndexRef.current);
    Array.from(video.textTracks).forEach((track, index) => {
      try {
        track.mode = nativeSubtitleFallbackRef.current && selectedExternalOrdinal >= 0 && index === selectedExternalOrdinal
          ? 'showing'
          : 'disabled';
      } catch (_error) {
        // Some browser track implementations reject mode changes.
      }
    });
  }, [externalSubtitleTracks]);

  const refreshNativeSubtitleTrackStyles = useCallback(() => {
    const video = videoRef.current;
    if (!video || !nativeSubtitleFallbackRef.current) return;
    const selectedExternalOrdinal = externalSubtitleOrdinal(externalSubtitleTracks, selectedSubtitleTrackIndexRef.current);
    if (selectedExternalOrdinal < 0) return;
    const track = video.textTracks[selectedExternalOrdinal];
    if (!track) return;

    if (nativeSubtitleStyleRefreshRafRef.current !== null) {
      cancelAnimationFrame(nativeSubtitleStyleRefreshRafRef.current);
      nativeSubtitleStyleRefreshRafRef.current = null;
    }

    try {
      track.mode = 'disabled';
    } catch (_error) {
      return;
    }

    nativeSubtitleStyleRefreshRafRef.current = requestAnimationFrame(() => {
      nativeSubtitleStyleRefreshRafRef.current = null;
      applyNativeTextTrackVisibilityRef.current();
    });
  }, [externalSubtitleTracks]);

  useEffect(() => {
    applyNativeTextTrackVisibilityRef.current = applyNativeTextTrackVisibility;
  }, [applyNativeTextTrackVisibility]);

  useEffect(() => {
    refreshNativeSubtitleTrackStyles();
  }, [refreshNativeSubtitleTrackStyles, subtitleStyle]);

  const applyProbeData = useCallback((
    data: unknown,
    preferencesOverride?: PlaybackTrackPreferences,
  ) => {
    const nextDuration = probeDurationSeconds(data);
    const nextTracks = [
      ...probeTracks(data).map((track) => ({ ...track, source: 'embedded' as const })),
      ...externalSubtitleTracks,
    ];
    const preferences = preferencesOverride ?? sharedTrackPreferencesRef.current;
    const hasSubtitlePreference = preferences.subtitle !== undefined;
    const firstVideo = firstTrackIndex(nextTracks, 'video');
    const preferredAudio = preferredTrackIndex(nextTracks, 'audio', preferences.audio);
    const preferredSubtitle = preferredTrackIndex(nextTracks, 'subtitle', preferences.subtitle);
    const firstAudio = preferredAudio ?? firstTrackIndex(nextTracks, 'audio');
    const firstSubtitle = preferredSubtitle ?? (subtitlesDefaultEnabledRef.current ? firstSubtitleTrackIndex(nextTracks) : -1);
    const subtitlesEnabled = hasSubtitlePreference
      ? firstSubtitle !== -1
      : subtitlesDefaultEnabledRef.current;

    probedDurationRef.current = nextDuration;
    probeTracksRef.current = nextTracks;
    selectedVideoTrackIndexRef.current = firstVideo >= 0 ? firstVideo : undefined;
    selectedAudioTrackIndexRef.current = firstAudio >= 0 ? firstAudio : undefined;
    selectedSubtitleTrackIndexRef.current = firstSubtitle;
    subtitlesDefaultEnabledRef.current = subtitlesEnabled;

    if (nextDuration > 0) updatePlaybackSnapshot(playbackPositionRef.current, nextDuration, { forceReact: true });
    setMediaTracks(nextTracks);
    setSelectedVideoTrackIndex(firstVideo);
    setSelectedAudioTrackIndex(firstAudio);
    setSelectedSubtitleTrackIndex(firstSubtitle);
    setSubtitlesDefaultEnabled(subtitlesEnabled);
  }, [externalSubtitleTracks, updatePlaybackSnapshot]);

  // ─── Episode navigation ────────────────────────────────────────────────────

  const clearNextEpisodeCountdown = useCallback(() => {
    if (nextEpisodeTimerRef.current) {
      clearInterval(nextEpisodeTimerRef.current);
      nextEpisodeTimerRef.current = null;
    }
    setNextCountdown(null);
  }, []);

  const transitionToEpisode = useCallback((next: EpisodeFile) => {
    if (!onEpisodeChange || !next.filePath || next.filePath === filePath) return;

    pendingEpisodeTransitionRef.current = next.filePath;
    clearNextEpisodeCountdown();
    // Pause the outgoing element before changing its source. Suppress the
    // resulting pause event so the next episode is still allowed to autoplay.
    userPausedRef.current = false;
    suppressPauseIntentUntilMsRef.current = performance.now() + 2000;
    const video = videoRef.current;
    if (playbackEngineRef.current) void playbackEngineRef.current.pause();
    if (video) {
      video.autoplay = false;
      video.pause();
    }
    setPaused(true);
    onEpisodeChange(next.filePath, next.season, next.episode);
  }, [clearNextEpisodeCountdown, filePath, onEpisodeChange]);

  const goToEpisode = useCallback((season: number, episode: number) => {
    const next = episodeFiles.find((item) => item.season === season && item.episode === episode);
    if (next && onEpisodeChange) {
      transitionToEpisode(next);
    }
  }, [episodeFiles, onEpisodeChange, transitionToEpisode]);

  const handlePrevEpisode = useCallback(() => {
    const currentIndex = playableEpisodeFiles.findIndex((item) =>
      item.season === currentSeason && item.episode === currentEpisode,
    );
    const previous = currentIndex > 0 ? playableEpisodeFiles[currentIndex - 1] : null;
    if (previous) goToEpisode(previous.season, previous.episode);
  }, [currentEpisode, currentSeason, goToEpisode, playableEpisodeFiles]);

  const handleNextEpisode = useCallback(() => {
    if (nextEpisodeFile) goToEpisode(nextEpisodeFile.season, nextEpisodeFile.episode);
  }, [goToEpisode, nextEpisodeFile]);

  const markCurrentEpisodeComplete = useCallback(() => {
    const videoDuration = Number.isFinite(videoRef.current?.duration) ? Number(videoRef.current?.duration) : 0;
    const completeDuration = duration || playbackDurationRef.current || probedDurationRef.current || videoDuration;
    if (completeDuration <= 0) return;
    updatePlaybackSnapshot(completeDuration, completeDuration, { forceReact: true });
    void savePlaybackProgress(filePath, completeDuration, completeDuration);
    setTick((n) => n + 1);
  }, [duration, filePath, updatePlaybackSnapshot]);

  const playNextEpisodeNow = useCallback((forceComplete = false) => {
    if (!nextEpisodeFile) return;
    if (forceComplete || (duration > 0 && position / duration >= WATCHED_THRESHOLD)) {
      markCurrentEpisodeComplete();
    }
    goToEpisode(nextEpisodeFile.season, nextEpisodeFile.episode);
  }, [duration, goToEpisode, markCurrentEpisodeComplete, nextEpisodeFile, position]);

  const scheduleNextEpisode = useCallback(() => {
    if (!nextEpisodeFile || !onEpisodeChange || nextEpisodeFile.filePath === filePath) return;
    // HLS/native playback can emit more than one end notification while the
    // source is being released. Keep the original countdown instead of
    // restarting it on every notification.
    if (nextEpisodeTimerRef.current) return;
    clearNextEpisodeCountdown();
    let remainingSeconds = NEXT_EPISODE_COUNTDOWN_SECONDS;
    setNextCountdown(remainingSeconds);
    nextEpisodeTimerRef.current = setInterval(() => {
      remainingSeconds -= 1;
      if (remainingSeconds <= 0) {
        clearNextEpisodeCountdown();
        goToEpisode(nextEpisodeFile.season, nextEpisodeFile.episode);
        return;
      }
      setNextCountdown(remainingSeconds);
    }, 1000);
  }, [clearNextEpisodeCountdown, filePath, goToEpisode, nextEpisodeFile, onEpisodeChange]);

  const latestEpisodePlaybackRef = useRef({
    autoplayNextEnabled,
    nextEpisodeFile,
    markCurrentEpisodeComplete,
    scheduleNextEpisode,
  });

  useEffect(() => {
    latestEpisodePlaybackRef.current = {
      autoplayNextEnabled,
      nextEpisodeFile,
      markCurrentEpisodeComplete,
      scheduleNextEpisode,
    };
  }, [autoplayNextEnabled, markCurrentEpisodeComplete, nextEpisodeFile, scheduleNextEpisode]);

  const startTranscodedFallback = useCallback(async (
    startSeconds = 0,
    options: {
      force?: boolean;
      allowNearEnd?: boolean;
      showSeekingStatus?: boolean;
      keepReadyDuringRestart?: boolean;
      deferStopCurrent?: boolean;
      seekGeneration?: number;
      trackChangeGeneration?: number;
    } = {},
  ) => {
    if (!playerActiveRef.current) return;
    if (didTryTranscodeRef.current && !options.force) return;
    streamUsesBrowserPipelineRef.current = false;
    didTryTranscodeRef.current = true;
    const token = loadTokenRef.current;
    const durationHint = probedDurationRef.current || getStoredDuration(filePath);
    const clampedStartSeconds = clampSeconds(startSeconds, durationHint || undefined);
    const safeStartSeconds = durationHint > 0
      && !options.allowNearEnd
      && (clampedStartSeconds / durationHint >= WATCHED_THRESHOLD
        || durationHint - clampedStartSeconds <= REPLAY_FROM_START_REMAINING_SECONDS)
      ? 0
      : Math.floor(clampedStartSeconds);
    hlsRecoveryAttemptsRef.current = 0;
    const keepReady = Boolean(options.keepReadyDuringRestart && hasPlayableDataRef.current);
    if (!keepReady) {
      transcodeStartSecondsRef.current = safeStartSeconds;
      updatePlaybackSnapshot(safeStartSeconds, durationHint || playbackDurationRef.current, { forceReact: true });
    }
    if (!keepReady) {
      setPlayerState('loading');
      setStatusMessage(
        safeStartSeconds > 0 && options.showSeekingStatus
          ? 'Seeking local stream...'
          : 'Loading local stream...',
      );
    }
    setErrorMessage(null);
    const previousSessionId = transcodeSessionIdRef.current;
    if (!options.deferStopCurrent) {
      clearHls();
      await stopTranscodeSession();
    }

    try {
      if (probeTracksRef.current.length === 0 && probedDurationRef.current === 0) {
        const probeResult = await desktopApi.media.probe(filePath);
        if (!playerActiveRef.current || token !== loadTokenRef.current) return;
        if (options.seekGeneration !== undefined && options.seekGeneration !== transcodeSeekGenerationRef.current) return;
        if (probeResult.ok) applyProbeData(probeResult.data);
      }

      const subtitleIndex = selectedSubtitleTrackIndexRef.current;
      const embeddedSubtitle = selectedEmbeddedSubtitle(probeTracksRef.current, subtitleIndex);
      const burnInSubtitle = embeddedSubtitle && isBitmapSubtitleCodec(embeddedSubtitle.track.codec)
        ? embeddedSubtitle
        : null;
      const transcodeResult = await desktopApi.media.startTranscode(filePath, {
        forceTranscode: true,
        startSeconds: safeStartSeconds,
        ...(typeof selectedVideoTrackIndexRef.current === 'number' ? { videoTrackIndex: selectedVideoTrackIndexRef.current } : {}),
        ...(typeof selectedAudioTrackIndexRef.current === 'number' ? { audioTrackIndex: selectedAudioTrackIndexRef.current } : {}),
        ...(burnInSubtitle ? {
          subtitleTrackIndex: subtitleIndex,
          subtitleStreamOrdinal: burnInSubtitle.ordinal,
          subtitleCodec: burnInSubtitle.track.codec,
          subtitleStyle: subtitleStyleRef.current,
        } : {}),
      });
      if (!playerActiveRef.current || token !== loadTokenRef.current) return;
      if (!transcodeResult.ok || !transcodeResult.data?.playlistUrl) {
        throw new Error(transcodeResult.error || 'Unable to start local stream.');
      }
      if (options.seekGeneration !== undefined && options.seekGeneration !== transcodeSeekGenerationRef.current) {
        void desktopApi.media.stopTranscode(transcodeResult.data.sessionId);
        return;
      }
      if (
        options.trackChangeGeneration !== undefined
        && options.trackChangeGeneration !== trackChangeGenerationRef.current
      ) {
        void desktopApi.media.stopTranscode(transcodeResult.data.sessionId);
        return;
      }

      // Seekable streams expose the whole timeline on an absolute VOD playlist,
      // so there is no per-window offset and seeking is native. The linear
      // fallback (unknown duration) keeps the window-relative offset.
      const nextSeekable = Boolean(transcodeResult.data.seekable);
      const nextTranscodeStartSeconds = nextSeekable
        ? 0
        : (transcodeResult.data.startSeconds ?? safeStartSeconds);
      if (options.deferStopCurrent) {
        const video = videoRef.current;
        const swapPosition = clampSeconds(playbackPositionRef.current, durationHint || undefined);
        pendingSourceSwapRef.current = {
          streamUrl: transcodeResult.data.playlistUrl,
          previousSessionId: previousSessionId && previousSessionId !== transcodeResult.data.sessionId
            ? previousSessionId
            : null,
          nextSessionId: transcodeResult.data.sessionId,
          position: swapPosition,
          wasPaused: video?.paused ?? userPausedRef.current,
          volume: video?.volume ?? 1,
          muted: video?.muted ?? false,
          playbackRate: video?.playbackRate ?? 1,
          seekable: nextSeekable,
          transcodeStartSeconds: nextTranscodeStartSeconds,
        };
        suppressPauseIntentUntilMsRef.current = performance.now() + 2000;
      } else {
        transcodeSessionIdRef.current = transcodeResult.data.sessionId;
        streamIsSeekableRef.current = nextSeekable;
        transcodeStartSecondsRef.current = nextTranscodeStartSeconds;
      }
      setStreamIsTranscoded(true);
      setStreamUrl(transcodeResult.data.playlistUrl);
      if (!keepReady) {
        setPlayerState('loading');
        setStatusMessage('Loading local stream...');
      }
    } catch (error) {
      if (!playerActiveRef.current || token !== loadTokenRef.current) return;
      if (options.deferStopCurrent) {
        setPlayerState('ready');
        setStatusMessage('');
        setErrorMessage(null);
        return;
      }
      setPlayerState('error');
      setStatusMessage('Unable to play media');
      setErrorMessage(transcodeErrorMessage(error));
      setStreamIsTranscoded(false);
    }
  }, [applyProbeData, clearHls, filePath, stopTranscodeSession, updatePlaybackSnapshot]);

  const startBrowserStreamAt = useCallback(async (
    startSeconds = 0,
    options: {
      showSeekingStatus?: boolean;
      seekGeneration?: number;
      trackChangeGeneration?: number;
    } = {},
  ) => {
    if (!playerActiveRef.current) return;
    const loadToken = loadTokenRef.current;
    const requestGeneration = ++browserStreamGenerationRef.current;
    const durationHint = probedDurationRef.current || getStoredDuration(filePath);
    const safeStartSeconds = Math.floor(clampSeconds(startSeconds, durationHint || undefined));
    const selectedSubtitle = selectedEmbeddedSubtitle(
      probeTracksRef.current,
      selectedSubtitleTrackIndexRef.current,
    );
    const bitmapSubtitle = selectedSubtitle && isBitmapSubtitleCodec(selectedSubtitle.track.codec)
      ? selectedSubtitle
      : null;
    const videoTrackCount = probeTracksRef.current.filter((track) => track.type === 'video').length;
    const audioTrackCount = probeTracksRef.current.filter((track) => track.type === 'audio').length;

    if (options.showSeekingStatus) {
      setPlayerState('loading');
      setStatusMessage('Seeking local stream...');
      setErrorMessage(null);
    }

    try {
      const stream = await desktopApi.getStreamUrl(filePath, {
        ...(safeStartSeconds > 0 ? { startSeconds: safeStartSeconds } : {}),
        ...(videoTrackCount > 1 && typeof selectedVideoTrackIndexRef.current === 'number'
          ? { videoTrackIndex: selectedVideoTrackIndexRef.current }
          : {}),
        ...(audioTrackCount > 1 && typeof selectedAudioTrackIndexRef.current === 'number'
          ? { audioTrackIndex: selectedAudioTrackIndexRef.current }
          : {}),
        ...(bitmapSubtitle ? {
          subtitleTrackIndex: selectedSubtitleTrackIndexRef.current,
          subtitleStreamOrdinal: bitmapSubtitle.ordinal,
          subtitleCodec: bitmapSubtitle.track.codec,
          subtitleStyle: subtitleStyleRef.current,
        } : {}),
      });
      if (
        !playerActiveRef.current
        || loadToken !== loadTokenRef.current
        || requestGeneration !== browserStreamGenerationRef.current
      ) return;
      if (options.seekGeneration !== undefined && options.seekGeneration !== transcodeSeekGenerationRef.current) return;
      if (
        options.trackChangeGeneration !== undefined
        && options.trackChangeGeneration !== trackChangeGenerationRef.current
      ) return;

      if (stream.playbackMode === 'transcode') {
        streamUsesBrowserPipelineRef.current = false;
        const isTrackChange = options.trackChangeGeneration !== undefined;
        await startTranscodedFallback(safeStartSeconds, {
          force: true,
          allowNearEnd: true,
          showSeekingStatus: options.showSeekingStatus,
          keepReadyDuringRestart: isTrackChange,
          deferStopCurrent: isTrackChange,
          seekGeneration: options.seekGeneration,
          trackChangeGeneration: options.trackChangeGeneration,
        });
        return;
      }

      clearHls();
      await stopTranscodeSession();
      if (
        !playerActiveRef.current
        || loadToken !== loadTokenRef.current
        || requestGeneration !== browserStreamGenerationRef.current
      ) return;

      const requiresSeekRestart = Boolean(stream.isTranscoded);
      streamUsesBrowserPipelineRef.current = requiresSeekRestart;
      streamIsSeekableRef.current = false;
      transcodeStartSecondsRef.current = initialStreamOffset(safeStartSeconds, requiresSeekRestart);
      suppressPauseIntentUntilMsRef.current = performance.now() + 1500;
      setStreamIsTranscoded(requiresSeekRestart);
      setStreamUrl(stream.url);
    } catch (error) {
      if (!playerActiveRef.current || loadToken !== loadTokenRef.current) return;
      setPlayerState('error');
      setStatusMessage('Failed to resolve stream');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to resolve stream URL');
    }
  }, [clearHls, filePath, startTranscodedFallback, stopTranscodeSession]);

  const handleNativePlaybackState = useCallback((state: PlaybackEngineState) => {
    if (!playerActiveRef.current) return;

    const now = performance.now();
    const seekGuard = nativeSeekGuardRef.current;
    const reportedPosition = typeof state.position === 'number' ? state.position : null;
    let suppressSeekSnapshot = isScrubbingRef.current;
    if (!suppressSeekSnapshot && seekGuard) {
      const landed = reportedPosition !== null
        && Math.abs(reportedPosition - seekGuard.target) <= NATIVE_SEEK_LANDING_TOLERANCE_SECONDS;
      const expired = now >= seekGuard.expiresAt;
      const reportedDuration = state.duration ?? playbackDurationRef.current ?? probedDurationRef.current;
      const seekExpectedToEnd = reportedDuration > 0
        && reportedDuration - seekGuard.target <= NATIVE_SEEK_LANDING_TOLERANCE_SECONDS;
      const staleEndedState = state.status === 'ended' && !seekExpectedToEnd;
      if (landed || (state.status === 'ended' && seekExpectedToEnd)) {
        nativeSeekGuardRef.current = null;
      } else if (expired) {
        nativeSeekGuardRef.current = null;
        suppressSeekSnapshot = staleEndedState;
      } else {
        // LibVLC reports on a polling interval. A snapshot already in flight
        // before a seek must not pull Loom's optimistic timeline, subtitles,
        // pause state, or saved progress back to the old position.
        suppressSeekSnapshot = true;
      }
    }

    if (typeof state.duration === 'number' || typeof state.position === 'number') {
      const nextDuration = state.duration ?? playbackDurationRef.current ?? probedDurationRef.current;
      const nextPosition = state.position ?? playbackPositionRef.current;
      if (!suppressSeekSnapshot) {
        updatePlaybackSnapshot(nextPosition, nextDuration, {
          forceReact: state.status === 'ended',
        });
      } else if (typeof state.duration === 'number' && state.duration !== playbackDurationRef.current) {
        updatePlaybackSnapshot(playbackPositionRef.current, nextDuration);
      }
      const wallClockNow = Date.now();
      if (!suppressSeekSnapshot && nextPosition > 10 && nextDuration > 0 && wallClockNow - lastProgressSaveRef.current >= PROGRESS_SAVE_INTERVAL_MS) {
        lastProgressSaveRef.current = wallClockNow;
        void savePlaybackProgress(filePath, nextPosition, nextDuration);
      }
    }

    if (typeof state.paused === 'boolean' && !suppressSeekSnapshot) {
      setPaused(state.paused);
      if (state.paused && playbackPositionRef.current > 10 && playbackDurationRef.current > 0) {
        void savePlaybackProgress(filePath, playbackPositionRef.current, playbackDurationRef.current);
      }
    }
    if (typeof state.volume === 'number') setVolume(Math.max(0, Math.min(1, state.volume)));
    if (typeof state.muted === 'boolean') setMuted(state.muted);
    if (typeof state.speed === 'number') setPlaybackRate(state.speed);

    if (state.tracks) {
      const nextTracks: MediaTrack[] = state.tracks.map((track) => ({
        index: track.id,
        type: track.type,
        codec: track.codec,
        language: track.language,
        title: track.title,
        channels: track.channels,
        default: track.default,
        forced: track.forced,
        source: track.source,
      }));
      probeTracksRef.current = nextTracks;
      setMediaTracks(nextTracks);

      if (!nativeInitialTracksAppliedRef.current) {
        nativeInitialTracksAppliedRef.current = true;
        const preferences = sharedTrackPreferencesRef.current;
        const selectedVideo = state.tracks.find((track) => track.type === 'video' && track.selected)?.id
          ?? firstTrackIndex(nextTracks, 'video');
        const preferredAudio = preferredTrackIndex(nextTracks, 'audio', preferences.audio);
        const selectedAudio = preferredAudio ?? state.tracks.find((track) => track.type === 'audio' && track.selected)?.id
          ?? firstTrackIndex(nextTracks, 'audio');
        const preferredSubtitle = preferredTrackIndex(nextTracks, 'subtitle', preferences.subtitle);
        const selectedSubtitle = preferredSubtitle
          ?? (subtitlesDefaultEnabledRef.current
            ? state.tracks.find((track) => track.type === 'subtitle' && track.selected)?.id
              ?? firstSubtitleTrackIndex(nextTracks)
            : -1);

        selectedVideoTrackIndexRef.current = selectedVideo >= 0 ? selectedVideo : undefined;
        selectedAudioTrackIndexRef.current = selectedAudio >= 0 ? selectedAudio : undefined;
        selectedSubtitleTrackIndexRef.current = selectedSubtitle;
        setSelectedVideoTrackIndex(selectedVideo);
        setSelectedAudioTrackIndex(selectedAudio);
        setSelectedSubtitleTrackIndex(selectedSubtitle);
        void playbackEngineRef.current?.selectVideo(selectedVideo >= 0 ? selectedVideo : null);
        void playbackEngineRef.current?.selectAudio(selectedAudio >= 0 ? selectedAudio : null);
        // LibVLC SPU IDs are not the same namespace as Loom's probe IDs. Its
        // native path is therefore allowed to keep only the deterministic
        // bitmap/default track selected at media-open time; parseable text is
        // rendered by Loom's overlay instead of sending an arbitrary ID.
        if (playbackEngineRef.current?.kind !== 'libvlc') {
          void playbackEngineRef.current?.selectSubtitle(selectedSubtitle >= 0 ? selectedSubtitle : null);
        }
      } else {
        const selectedVideo = state.tracks.find((track) => track.type === 'video' && track.selected)?.id ?? -1;
        const selectedAudio = state.tracks.find((track) => track.type === 'audio' && track.selected)?.id ?? -1;
        selectedVideoTrackIndexRef.current = selectedVideo >= 0 ? selectedVideo : undefined;
        selectedAudioTrackIndexRef.current = selectedAudio >= 0 ? selectedAudio : undefined;
        setSelectedVideoTrackIndex(selectedVideo);
        setSelectedAudioTrackIndex(selectedAudio);
        // Loom owns parseable-text subtitle selection while LibVLC's native
        // SPU IDs live in a different namespace. Do not let recurring LibVLC
        // state snapshots overwrite the renderer-overlay selection with the
        // native fallback track (or "off").
        if (playbackEngineRef.current?.kind !== 'libvlc') {
          const selectedSubtitle = state.tracks.find((track) => track.type === 'subtitle' && track.selected)?.id ?? -1;
          selectedSubtitleTrackIndexRef.current = selectedSubtitle;
          setSelectedSubtitleTrackIndex(selectedSubtitle);
        }
      }
    }

    if (!suppressSeekSnapshot && (state.status === 'starting' || state.status === 'loading')) {
      setPlayerState('loading');
      setStatusMessage('Opening with native player...');
      setPaused(true);
    } else if (!suppressSeekSnapshot && state.status === 'ready') {
      setPlayerState('ready');
      setStatusMessage('');
      setErrorMessage(null);
      // A transient pause property while the native engine opens is engine state, not user
      // intent. Every explicit Play/Resume action enters with this ref false,
      // so reaffirm autoplay once the native file is actually ready.
      if (!userPausedRef.current) void playbackEngineRef.current?.play();
    } else if (!suppressSeekSnapshot && state.status === 'ended') {
      const totalDuration = state.duration || playbackDurationRef.current || probedDurationRef.current;
      if (totalDuration > 0) {
        updatePlaybackSnapshot(totalDuration, totalDuration, { forceReact: true });
        latestEpisodePlaybackRef.current.markCurrentEpisodeComplete();
      }
      setPaused(true);
      if (latestEpisodePlaybackRef.current.autoplayNextEnabled && latestEpisodePlaybackRef.current.nextEpisodeFile) {
        latestEpisodePlaybackRef.current.scheduleNextEpisode();
      }
    } else if (state.status === 'error') {
      const fallbackPosition = playbackPositionRef.current;
      const failedEngineKind = playbackEngineRef.current?.kind;
      const engine = playbackEngineRef.current;
      playbackEngineRef.current = null;
      void engine?.destroy();
      setNativePlaybackActive(false);
      setNativeEngineKind(null);
      document.documentElement.classList.remove('loom-native-active');
      void (async () => {
        if (failedEngineKind === 'libvlc' && await MpvPlaybackEngine.available().catch(() => false)) {
          const fallbackEngine = new MpvPlaybackEngine(handleNativePlaybackState);
          if (!playbackEngineRef.current && playerActiveRef.current) {
            playbackEngineRef.current = fallbackEngine;
            try {
              const style = subtitleStyleRef.current;
              const loaded = await fallbackEngine.load(filePath, {
                startSeconds: fallbackPosition,
                audioDelay: audioDelayRef.current,
                subtitleDelay: style.delaySeconds,
                subtitleStyle: {
                  fontSize: Math.round(style.fontSize * style.scale),
                  color: style.fontColor,
                  borderColor: style.borderColor,
                  borderWidth: style.borderEnabled ? style.borderWidth : 0,
                  backgroundColor: style.backgroundEnabled ? style.backgroundColor : '#00000000',
                  position: style.position,
                },
                subtitleFiles: visibleSubtitlesRef.current.flatMap((subtitle) => {
                  try {
                    const parsed = new URL(subtitle.url, 'http://127.0.0.1');
                    const subtitlePath = parsed.searchParams.get('path');
                    return subtitlePath ? [{ path: subtitlePath, source: subtitle.source || 'sidecar' as const }] : [];
                  } catch {
                    return [];
                  }
                }),
              });
              if (loaded && playerActiveRef.current && playbackEngineRef.current === fallbackEngine) {
                setNativePlaybackActive(true);
                setNativeEngineKind('mpv');
                document.documentElement.classList.add('loom-native-active');
                setStatusMessage('Opening with mpv...');
                setErrorMessage(null);
                return;
              }
            } catch (error) {
              console.warn('[player] MPV fallback after LibVLC failure could not start.', error);
            }
            if (playbackEngineRef.current === fallbackEngine) playbackEngineRef.current = null;
            await fallbackEngine.destroy();
          } else {
            await fallbackEngine.destroy();
          }
        }
        if (!playerActiveRef.current) return;
        setStatusMessage('Falling back to the compatible player...');
        setErrorMessage(state.error || null);
        void startBrowserStreamAt(fallbackPosition, { showSeekingStatus: true });
      })();
    }
  }, [filePath, startBrowserStreamAt, updatePlaybackSnapshot]);

  const handleRetry = useCallback(() => {
    didTryTranscodeRef.current = false;
    hlsRecoveryAttemptsRef.current = 0;
    hlsTranscodeRestartAttemptsRef.current = 0;
    setStreamIsTranscoded(false);
    setNativePlaybackActive(false);
    setNativeEngineKind(null);
    document.documentElement.classList.remove('loom-native-active');
    setSelectedSecondarySubtitleTrackIndex(-1);
    nativeInitialTracksAppliedRef.current = false;
    setPlayerState('loading');
    setStatusMessage('Retrying playback...');
    setErrorMessage(null);
    void stopTranscodeSession();
    setReloadToken((value) => value + 1);
  }, [stopTranscodeSession]);

  useEffect(() => {
    probedDurationRef.current = libraryDurationHint;
    probeTracksRef.current = externalSubtitleTracks;
    setMediaTracks(externalSubtitleTracks);
    const preferences = sharedTrackPreferencesRef.current;
    const preferredExternalSubtitle = preferredTrackIndex(externalSubtitleTracks, 'subtitle', preferences.subtitle);
    const firstExternalSubtitle = preferredExternalSubtitle ?? (subtitlesDefaultEnabledRef.current ? firstSubtitleTrackIndex(externalSubtitleTracks) : -1);
    const externalSubtitlesEnabled = preferences.subtitle !== undefined
      ? firstExternalSubtitle !== -1
      : subtitlesDefaultEnabledRef.current;
    subtitlesDefaultEnabledRef.current = externalSubtitlesEnabled;
    selectedSubtitleTrackIndexRef.current = firstExternalSubtitle;
    setSelectedSubtitleTrackIndex(firstExternalSubtitle);
    setSubtitlesDefaultEnabled(externalSubtitlesEnabled);
    updatePlaybackSnapshot(playbackPositionRef.current, libraryDurationHint, { forceReact: true });
  }, [externalSubtitleTracks, filePath, libraryDurationHint, updatePlaybackSnapshot]);

  // ─── Load media stream URL ────────────────────────────────────────────────
  useEffect(() => {
    cancelPendingSurfaceClick();
    const loadToken = ++loadTokenRef.current;
    const savedStartPosition = getPlayableStartPosition(filePath, probedDurationRef.current);
    const isReloadingSameFile = loadedFilePathRef.current === filePath;
    const requestedStartPosition = resolveInitialPlaybackPosition(
      isReloadingSameFile ? playbackPositionRef.current : startPosition,
      savedStartPosition,
    );
    loadedFilePathRef.current = filePath;
    if (!isReloadingSameFile) libVlcSubtitleFallbackRef.current = false;
    initialResumePositionRef.current = requestedStartPosition;
    playerActiveRef.current = true;
    userPausedRef.current = false;
    didTryTranscodeRef.current = false;
    transcodeStartSecondsRef.current = 0;
    hlsRecoveryAttemptsRef.current = 0;
    hlsTranscodeRestartAttemptsRef.current = 0;
    if (transcodeSeekTimerRef.current) {
      clearTimeout(transcodeSeekTimerRef.current);
      transcodeSeekTimerRef.current = null;
    }
    if (transcodeSeekSafetyRef.current) {
      clearTimeout(transcodeSeekSafetyRef.current);
      transcodeSeekSafetyRef.current = null;
    }
    pendingTranscodeSeekRef.current = null;
    transcodeSeekActiveRef.current = false;
    transcodeSeekGenerationRef.current += 1;
    browserStreamGenerationRef.current += 1;
    streamIsSeekableRef.current = false;
    streamUsesBrowserPipelineRef.current = false;
    setStreamIsTranscoded(false);
    setNativePlaybackActive(false);
    setNativeEngineKind(null);
    nativeInitialTracksAppliedRef.current = false;
    document.documentElement.classList.remove('loom-native-active');
    updatePlaybackSnapshot(
      requestedStartPosition,
      probedDurationRef.current || getStoredDuration(filePath),
      { forceReact: true },
    );
    setPlayerState('loading');
    setStatusMessage('Preparing stream...');
    setErrorMessage(null);
    setStreamUrl('');

    void stopTranscodeSession();

    (async () => {
      try {
        // Track selection affects the transcoder command itself. Resolve the
        // saved preference and this episode's actual stream indexes before
        // opening the source, otherwise the default audio can begin playing
        // and subtitles can be mapped against the previous episode.
        const preferences = await trackPreferencesLoadRef.current;
        if (!playerActiveRef.current || loadToken !== loadTokenRef.current) return;
        sharedTrackPreferencesRef.current = preferences;
        const probeResult = await desktopApi.media.probe(filePath);
        if (!playerActiveRef.current || loadToken !== loadTokenRef.current) return;
        if (probeResult.ok) applyProbeData(probeResult.data, preferences);

        const isLocalFile = !/^(?:https?|plexserver):/i.test(filePath);
        const libVlcAvailable = isLocalFile && await LibVlcPlaybackEngine.available().catch(() => false);
        // MPV is an optional fallback. Do not execute it just to probe its
        // version when LibVLC can already handle this file. If LibVLC later
        // fails, handleNativePlaybackState performs the MPV check on demand.
        const mpvAvailable = isLocalFile
          && !libVlcAvailable
          && await MpvPlaybackEngine.available().catch(() => false);
        if (!playerActiveRef.current || loadToken !== loadTokenRef.current) return;
        const allSubtitleFiles = visibleSubtitles.flatMap((subtitle) => {
          try {
            const parsed = new URL(subtitle.url, 'http://127.0.0.1');
            const subtitlePath = parsed.searchParams.get('path');
            return subtitlePath ? [{ path: subtitlePath, source: subtitle.source || 'sidecar' as const }] : [];
          } catch {
            return [];
          }
        });
        let selectedSubtitleIndex = selectedSubtitleTrackIndexRef.current;
        let selectedSubtitleTrack = probeTracksRef.current.find((track) =>
          track.type === 'subtitle' && track.index === selectedSubtitleIndex,
        );
        const textAlternative = compatibleTextSubtitleTrack(probeTracksRef.current, selectedSubtitleIndex);
        const preserveExactSubtitle = subtitleSelectionExplicitRef.current || preferences.subtitle !== undefined;
        if (libVlcAvailable && textAlternative && !preserveExactSubtitle) {
          // LibVLC cannot restyle image-based subtitles at runtime. For an
          // automatic/default selection, keep the same language and subtitle
          // intent while choosing a parseable text track that Loom can render.
          selectedSubtitleIndex = textAlternative.index;
          selectedSubtitleTrack = textAlternative;
          selectedSubtitleTrackIndexRef.current = textAlternative.index;
          setSelectedSubtitleTrackIndex(textAlternative.index);
        }
        const bitmapNeedsCompatibilityEngine = Boolean(
          libVlcAvailable
          && selectedSubtitleTrack
          && isBitmapSubtitleCodec(selectedSubtitleTrack.codec),
        );
        const nativeEngineFactories: Array<new (listener: (state: PlaybackEngineState) => void) => PlaybackEngine> = [];
        if (bitmapNeedsCompatibilityEngine && mpvAvailable) {
          // Preserve an explicit or bitmap-only choice through the old engine,
          // whose subtitle control path is implemented, instead of exposing
          // LibVLC controls that silently cannot apply visual styling.
          nativeEngineFactories.push(MpvPlaybackEngine);
          if (libVlcAvailable) nativeEngineFactories.push(LibVlcPlaybackEngine);
        } else {
          if (libVlcAvailable) nativeEngineFactories.push(LibVlcPlaybackEngine);
          if (mpvAvailable) nativeEngineFactories.push(MpvPlaybackEngine);
        }
        const selectedExternalSubtitle = (() => {
          if (selectedSubtitleIndex > -1000) return undefined;
          const selected = visibleSubtitles[-1000 - selectedSubtitleIndex];
          if (!selected) return undefined;
          try {
            const parsed = new URL(selected.url, 'http://127.0.0.1');
            const subtitlePath = parsed.searchParams.get('path');
            return subtitlePath ? { path: subtitlePath, source: selected.source || 'sidecar' as const } : undefined;
          } catch {
            return undefined;
          }
        })();
        const libVlcNativeSubtitleFallback = Boolean(
          selectedSubtitleTrack
          && isBitmapSubtitleCodec(selectedSubtitleTrack.codec),
        );
        for (const NativePlaybackEngine of nativeEngineFactories) {
          const engine = new NativePlaybackEngine(handleNativePlaybackState);
          playbackEngineRef.current = engine;
          const subtitleFiles = engine.kind === 'libvlc'
            ? (selectedExternalSubtitle ? [selectedExternalSubtitle] : [])
            : allSubtitleFiles;
          const initialSubtitleStyle = subtitleStyleRef.current;
          let loaded = false;
          try {
            loaded = await engine.load(filePath, {
              startSeconds: requestedStartPosition,
              audioDelay: audioDelayRef.current,
              subtitleDelay: initialSubtitleStyle.delaySeconds,
              subtitleStyle: {
                fontSize: Math.round(initialSubtitleStyle.fontSize * initialSubtitleStyle.scale),
                color: initialSubtitleStyle.fontColor,
                borderColor: initialSubtitleStyle.borderColor,
                borderWidth: initialSubtitleStyle.borderEnabled ? initialSubtitleStyle.borderWidth : 0,
                backgroundColor: initialSubtitleStyle.backgroundEnabled
                  ? initialSubtitleStyle.backgroundColor
                  : '#00000000',
                position: initialSubtitleStyle.position,
              },
              subtitleFiles,
              // Loom's text overlay owns parseable subtitles. LibVLC native
              // SPU output starts only for bitmap/unsupported tracks, where
              // the renderer cannot provide equivalent cues or styling.
              nativeSubtitles: engine.kind === 'libvlc'
                ? subtitlesDefaultEnabledRef.current && (libVlcNativeSubtitleFallback || libVlcSubtitleFallbackRef.current)
                : subtitlesDefaultEnabledRef.current && selectedSubtitleIndex !== -1,
            });
          } catch (error) {
            console.warn(`[player] Native ${engine.kind} startup failed; trying the next fallback.`, error);
          }
          if (!playerActiveRef.current || loadToken !== loadTokenRef.current) {
            await engine.destroy();
            return;
          }
          if (loaded) {
            setNativePlaybackActive(true);
            setNativeEngineKind(engine.kind);
            setStreamUrl('');
            document.documentElement.classList.add('loom-native-active');
            setStatusMessage(`Opening with ${engine.kind}...`);
            return;
          }
          playbackEngineRef.current = null;
          await engine.destroy();
        }

        setNativePlaybackActive(false);
        setNativeEngineKind(null);
        document.documentElement.classList.remove('loom-native-active');
        await startBrowserStreamAt(requestedStartPosition);
      } catch (error) {
        if (!playerActiveRef.current || loadToken !== loadTokenRef.current) return;
        setPlayerState('error');
        setStatusMessage('Failed to resolve stream');
        setErrorMessage(error instanceof Error ? error.message : 'Failed to resolve stream URL');
      }
    })();

    return () => {
      loadTokenRef.current += 1;
      sourceLoadTokenRef.current += 1;
      browserStreamGenerationRef.current += 1;
      const engine = playbackEngineRef.current;
      playbackEngineRef.current = null;
      void engine?.destroy();
      document.documentElement.classList.remove('loom-native-active');
      void stopTranscodeSession();
    };
  }, [
    applyProbeData,
    cancelPendingSurfaceClick,
    filePath,
    handleNativePlaybackState,
    reloadToken,
    startBrowserStreamAt,
    startPosition,
    stopTranscodeSession,
    updatePlaybackSnapshot,
    visibleSubtitles,
  ]);

  // ─── Player binding, events, and fallback ────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    const sourceToken = ++sourceLoadTokenRef.current;
    const pendingSwap = pendingSourceSwapRef.current?.streamUrl === streamUrl
      ? pendingSourceSwapRef.current
      : null;
    if (pendingSwap) {
      transcodeSessionIdRef.current = pendingSwap.nextSessionId;
      streamIsSeekableRef.current = pendingSwap.seekable;
      transcodeStartSecondsRef.current = pendingSwap.transcodeStartSeconds;
    }
    const isHlsSource = /\.m3u8(\?|$)/i.test(streamUrl);
    const resumeSeconds = pendingSwap?.position ?? initialResumePositionRef.current;
    // For a seekable VOD transcode, begin loading at the intended absolute
    // position (resume or the spot a track-change restart was issued from).
    const hlsStartPosition = pendingSwap
      ? Math.max(0, pendingSwap.seekable
        ? pendingSwap.position
        : pendingSwap.position - pendingSwap.transcodeStartSeconds)
      : initialHlsStartPosition({
        resumePosition: resumeSeconds,
        streamIsTranscoded,
        streamIsSeekable: streamIsSeekableRef.current,
      });

    clearHls();
    hlsRecoveryAttemptsRef.current = 0;
    hasPlayableDataRef.current = false;
    if (!pendingSwap) {
      setPlayerState('loading');
      setStatusMessage(streamIsTranscoded ? 'Loading local stream...' : 'Loading stream...');
      setPaused(true);
    }
    setErrorMessage(null);
    userPausedRef.current = pendingSwap?.wasPaused ?? userPausedRef.current;
    video.volume = pendingSwap?.volume ?? video.volume;
    video.muted = pendingSwap?.muted ?? video.muted;
    video.playbackRate = pendingSwap?.playbackRate ?? video.playbackRate;

    const completePendingSwap = () => {
      const pending = pendingSourceSwapRef.current;
      if (!pending || pending.streamUrl !== streamUrl) return;
      pendingSourceSwapRef.current = null;
      if (pending.previousSessionId && pending.previousSessionId !== transcodeSessionIdRef.current) {
        void desktopApi.media.stopTranscode(pending.previousSessionId);
      }
    };

    const playIfAllowed = () => {
      if (!playerActiveRef.current || userPausedRef.current) {
        setPaused(true);
        return;
      }
      void video.play().catch(() => setPaused(true));
    };

    let initialResumeApplied = Boolean(pendingSwap)
      || hasReachedInitialResumePosition(video.currentTime, resumeSeconds)
      || (streamIsTranscoded && !streamIsSeekableRef.current);
    const applyInitialResume = () => {
      if (initialResumeApplied || sourceToken !== sourceLoadTokenRef.current) return;
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      if (hasReachedInitialResumePosition(currentTime, resumeSeconds)) {
        initialResumeApplied = true;
        return;
      }
      try {
        const mediaDuration = Number.isFinite(video.duration) ? video.duration : 0;
        const targetPosition = mediaDuration > 0
          ? Math.min(resumeSeconds, Math.max(0, mediaDuration - 0.1))
          : resumeSeconds;
        video.currentTime = targetPosition;
        // Chromium can accept an early currentTime assignment but clamp it to
        // zero until metadata or a seekable range is ready. Keep retrying until
        // the media element confirms that the requested resume seek landed.
        initialResumeApplied = hasReachedInitialResumePosition(video.currentTime, targetPosition);
      } catch {
        // Some HLS engines reject a seek until a later readiness event.
      }
    };

    if (isHlsSource) {
      void import('hls.js').then(({ default: Hls, ErrorTypes, Events }) => {
        if (sourceToken !== sourceLoadTokenRef.current) return;

        if (!Hls.isSupported()) {
          if (video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')) {
            video.src = streamUrl;
            video.load();
            playIfAllowed();
          } else {
            setPlayerState('error');
            setErrorMessage('HLS streams are not supported in this build.');
          }
          return;
        }

        const remoteBufferProfile = desktopApi.isRemoteLibraryMode();
        const hls = new Hls({
          autoStartLoad: false,
          startPosition: hlsStartPosition,
          maxBufferLength: remoteBufferProfile ? 45 : 20,
          maxMaxBufferLength: remoteBufferProfile ? 90 : 45,
          backBufferLength: remoteBufferProfile ? 30 : 15,
          manifestLoadingMaxRetry: 20,
          manifestLoadingRetryDelay: 500,
          fragLoadingMaxRetry: 20,
          fragLoadingRetryDelay: 500,
        });
        hlsRef.current = hls;
        const markHlsPlayable = () => {
          if (sourceToken !== sourceLoadTokenRef.current) return;
          hlsRecoveryAttemptsRef.current = 0;
          hasPlayableDataRef.current = true;
          transcodeSeekActiveRef.current = false;
          setPlayerState('ready');
          setStatusMessage('');
          applyInitialResume();
          playIfAllowed();
        };
        hls.on(Events.MEDIA_ATTACHED, () => {
          if (sourceToken !== sourceLoadTokenRef.current) return;
          hls.loadSource(streamUrl);
        });
        hls.on(Events.MANIFEST_PARSED, () => {
          if (sourceToken !== sourceLoadTokenRef.current) return;
          hls.startLoad(hlsStartPosition);
        });
        hls.on(Events.FRAG_BUFFERED, markHlsPlayable);
        hls.attachMedia(video);
        hls.on(Events.ERROR, (_event, data: ErrorData) => {
          if (sourceToken !== sourceLoadTokenRef.current) return;
          console.warn(`[player] HLS error ${hlsErrorSummary(data)}`);
          const restartLocalHls = () => {
            if (!streamIsTranscoded || hlsTranscodeRestartAttemptsRef.current >= HLS_TRANSCODE_RESTART_ATTEMPTS) {
              return false;
            }

            hlsTranscodeRestartAttemptsRef.current += 1;
            hlsRecoveryAttemptsRef.current = 0;
            const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
            const restartAt = transcodeStartSecondsRef.current + currentTime;
            setPlayerState('loading');
            setStatusMessage('Restarting local stream...');
            setErrorMessage(null);
            void startTranscodedFallback(restartAt, { force: true, allowNearEnd: true });
            return true;
          };

          if (!data.fatal) return;
          if (shouldRestartMissingLocalHls(data) && !hasPlayableDataRef.current && restartLocalHls()) return;

          if (data.type === ErrorTypes.NETWORK_ERROR && hlsRecoveryAttemptsRef.current < HLS_RECOVERY_ATTEMPTS) {
            hlsRecoveryAttemptsRef.current += 1;
            setPlayerState('loading');
            setStatusMessage('Reconnecting stream...');
            setErrorMessage(null);
            const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
            hls.startLoad(Math.max(0, currentTime - 1));
            return;
          }

          if (data.type === ErrorTypes.MEDIA_ERROR && hlsRecoveryAttemptsRef.current < HLS_RECOVERY_ATTEMPTS) {
            hlsRecoveryAttemptsRef.current += 1;
            setPlayerState('loading');
            setStatusMessage('Recovering playback...');
            setErrorMessage(null);
            hls.recoverMediaError();
            return;
          }

          if (restartLocalHls()) return;

          if (!didTryTranscodeRef.current && !streamIsTranscoded) {
            setStatusMessage('Trying local compatible stream...');
            void startTranscodedFallback(getPlayableStartPosition(filePath, probedDurationRef.current), { force: true });
          } else {
            setPlayerState('error');
            setErrorMessage(data.details ? `HLS playback error: ${data.details}` : 'Unable to play HLS stream.');
          }
        });
      }).catch((error: unknown) => {
        if (sourceToken !== sourceLoadTokenRef.current) return;
        console.error('[player] Failed to load HLS runtime', error);
        setPlayerState('error');
        setErrorMessage('Unable to load HLS playback support.');
      });
    } else {
      video.src = streamUrl;
    }

    const onLoadStart = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      if (pendingSwap) return;
      if (hasPlayableDataRef.current || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
      setPlayerState('loading');
      setStatusMessage(streamIsTranscoded ? 'Loading local stream...' : 'Buffering...');
      setErrorMessage(null);
    };

    const onWaiting = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      if (pendingSwap) return;
      if (hasPlayableDataRef.current || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
      setPlayerState('loading');
      setStatusMessage('Buffering...');
    };

    const onPlay = () => {
      userPausedRef.current = false;
      setPaused(false);
    };

    const onPause = () => {
      if (performance.now() > suppressPauseIntentUntilMsRef.current) {
        userPausedRef.current = true;
      }
      setPaused(true);
    };

    const onDuration = () => {
      const mediaDuration = Number.isFinite(video.duration) ? video.duration : 0;
      updatePlaybackSnapshot(playbackPositionRef.current, probedDurationRef.current || mediaDuration, { forceReact: true });
      applyInitialResume();
    };

    const onTime = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      if (!initialResumeApplied) {
        applyInitialResume();
        if (!initialResumeApplied) return;
      }
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const totalDuration = probedDurationRef.current || (Number.isFinite(video.duration) ? video.duration : 0);
      const absolutePosition = absoluteMediaSeconds(currentTime, {
        mode: streamIsTranscoded && !streamIsSeekableRef.current ? 'offset' : 'absolute',
        offsetSeconds: transcodeStartSecondsRef.current,
      });
      const nextPosition = clampSeconds(absolutePosition, totalDuration || undefined);
      const now = Date.now();
      // While scrubbing, or while a transcoded seek is restarting, the on-screen
      // position is driven by the user's target — don't let the old/outgoing
      // stream's timeupdates pull it back.
      if (!isScrubbingRef.current && !transcodeSeekActiveRef.current) {
        updatePlaybackSnapshot(nextPosition, totalDuration, {
          forceReact: totalDuration > 0 && totalDuration - nextPosition <= END_COMPLETION_TOLERANCE_SECONDS,
        });
      }
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && playerStateRef.current === 'error') {
        hasPlayableDataRef.current = true;
        playerStateRef.current = 'ready';
        setPlayerState('ready');
        setErrorMessage(null);
      }
      if (nextPosition > 10 && totalDuration > 0 && now - lastProgressSaveRef.current >= PROGRESS_SAVE_INTERVAL_MS) {
        lastProgressSaveRef.current = now;
        void savePlaybackProgress(filePath, nextPosition, totalDuration);
      }
    };

    const onVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    const onLoadedMetadata = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      const mediaDuration = Number.isFinite(video.duration) ? video.duration : 0;
      updatePlaybackSnapshot(playbackPositionRef.current, probedDurationRef.current || mediaDuration, { forceReact: true });
      applyNativeTextTrackVisibilityRef.current();
      if (pendingSwap && resumeSeconds > 0 && mediaDuration) {
        const streamPosition = pendingSwap.seekable
          ? resumeSeconds
          : Math.max(0, resumeSeconds - pendingSwap.transcodeStartSeconds);
        video.currentTime = Math.min(streamPosition, Math.max(0, video.duration - 0.1));
      } else {
        applyInitialResume();
      }
    };

    const onPlayable = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      hlsRecoveryAttemptsRef.current = 0;
      hasPlayableDataRef.current = true;
      transcodeSeekActiveRef.current = false;
      setPlayerState('ready');
      setStatusMessage('');
      completePendingSwap();
      applyInitialResume();
      playIfAllowed();
    };

    const onPlaying = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      hlsRecoveryAttemptsRef.current = 0;
      hasPlayableDataRef.current = true;
      transcodeSeekActiveRef.current = false;
      setPlayerState('ready');
      setStatusMessage('');
      applyInitialResume();
      userPausedRef.current = false;
      setPaused(false);
      completePendingSwap();
    };

    const onEnded = () => {
      // The old source can still deliver an `ended` event after the parent has
      // requested another episode. Never let that stale event restart playback.
      if (sourceToken !== sourceLoadTokenRef.current || pendingEpisodeTransitionRef.current) return;
      const creditsCompletionRequested = pendingCreditsCompletionRef.current;
      pendingCreditsCompletionRef.current = false;
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const totalDuration = probedDurationRef.current || (Number.isFinite(video.duration) ? video.duration : 0);
      const eventPosition = clampSeconds(absoluteMediaSeconds(currentTime, {
        mode: streamIsTranscoded && !streamIsSeekableRef.current ? 'offset' : 'absolute',
        offsetSeconds: transcodeStartSecondsRef.current,
      }), totalDuration || undefined);
      // Chromium/HLS can briefly report a reset or stale currentTime while
      // dispatching `ended`. Keep the furthest confirmed playback snapshot so
      // a true media ending is not mistaken for an early transcode cutoff and
      // restarted from the beginning.
      const endedPosition = clampSeconds(
        Math.max(eventPosition, playbackPositionRef.current),
        totalDuration || undefined,
      );
      if (creditsCompletionRequested) {
        latestEpisodePlaybackRef.current.markCurrentEpisodeComplete();
        setPaused(true);
        // Pressing Skip Credits is an explicit request to finish this episode,
        // so advance even when the optional end-of-episode autoplay toggle is
        // disabled. Normal, unprompted endings still respect that toggle.
        if (latestEpisodePlaybackRef.current.nextEpisodeFile) {
          latestEpisodePlaybackRef.current.scheduleNextEpisode();
        }
        return;
      }
      const nearEnoughToComplete = totalDuration > 0
        && totalDuration - endedPosition <= Math.max(END_COMPLETION_TOLERANCE_SECONDS, REPLAY_FROM_START_REMAINING_SECONDS);
      if (nearEnoughToComplete) {
        latestEpisodePlaybackRef.current.markCurrentEpisodeComplete();
        setPaused(true);
        if (latestEpisodePlaybackRef.current.autoplayNextEnabled && latestEpisodePlaybackRef.current.nextEpisodeFile) {
          latestEpisodePlaybackRef.current.scheduleNextEpisode();
        }
        return;
      }
      if (totalDuration > 0 && endedPosition < totalDuration - END_COMPLETION_TOLERANCE_SECONDS) {
        hlsTranscodeRestartAttemptsRef.current = 0;
        void startTranscodedFallback(endedPosition, { force: true, allowNearEnd: true });
        return;
      }
      if (totalDuration > 0) {
        latestEpisodePlaybackRef.current.markCurrentEpisodeComplete();
      }
      setPaused(true);
      if (latestEpisodePlaybackRef.current.autoplayNextEnabled && latestEpisodePlaybackRef.current.nextEpisodeFile) {
        latestEpisodePlaybackRef.current.scheduleNextEpisode();
      }
    };

    const onError = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      transcodeSeekActiveRef.current = false;
      setPaused(true);
      if (!isHlsSource && !didTryTranscodeRef.current) {
        setStatusMessage('Trying local compatible stream...');
        const fallbackStart = video.currentTime > 0
          ? video.currentTime
          : getPlayableStartPosition(filePath, probedDurationRef.current);
        void startTranscodedFallback(fallbackStart, { force: true, allowNearEnd: true });
        return;
      }
      setPlayerState('error');
      setErrorMessage(mediaErrorMessage(video.error));
    };

    video.addEventListener('loadstart', onLoadStart);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('loadeddata', onPlayable);
    video.addEventListener('canplay', onPlayable);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.preload = 'auto';
    video.autoplay = !(pendingSwap?.wasPaused ?? userPausedRef.current);
    if (!isHlsSource) {
      video.load();
      playIfAllowed();
    }

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      onPlayable();
    }

    return () => {
      sourceLoadTokenRef.current += 1;
      video.autoplay = false;
      video.removeEventListener('loadstart', onLoadStart);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('loadeddata', onPlayable);
      video.removeEventListener('canplay', onPlayable);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      clearHls();
      clearVideoElement(video);
    };
  }, [
    filePath,
    streamUrl,
    streamIsTranscoded,
    clearHls,
    clearVideoElement,
    startTranscodedFallback,
    updatePlaybackSnapshot,
  ]);

  useEffect(() => () => {
    cancelPendingSurfaceClick();
    if (subtitleStyleApplyTimerRef.current) {
      clearTimeout(subtitleStyleApplyTimerRef.current);
      subtitleStyleApplyTimerRef.current = null;
    }
    if (nativeSubtitleStyleRefreshRafRef.current !== null) {
      cancelAnimationFrame(nativeSubtitleStyleRefreshRafRef.current);
      nativeSubtitleStyleRefreshRafRef.current = null;
    }
    if (scrubPreviewRafRef.current !== null) {
      cancelAnimationFrame(scrubPreviewRafRef.current);
      scrubPreviewRafRef.current = null;
    }
    if (scrubHudHideTimerRef.current) {
      clearTimeout(scrubHudHideTimerRef.current);
      scrubHudHideTimerRef.current = null;
    }
    if (nativeScrubSeekTimerRef.current) {
      clearTimeout(nativeScrubSeekTimerRef.current);
      nativeScrubSeekTimerRef.current = null;
    }
    pendingNativeScrubSeekRef.current = null;
    nativeSeekGuardRef.current = null;
    scrubListenerCleanupRef.current?.();
    scrubListenerCleanupRef.current = null;
    if (transcodeSeekTimerRef.current) {
      clearTimeout(transcodeSeekTimerRef.current);
      transcodeSeekTimerRef.current = null;
    }
    if (transcodeSeekSafetyRef.current) {
      clearTimeout(transcodeSeekSafetyRef.current);
      transcodeSeekSafetyRef.current = null;
    }
  }, [cancelPendingSurfaceClick]);

  useEffect(() => {
    clearNextEpisodeCountdown();
    return clearNextEpisodeCountdown;
  }, [clearNextEpisodeCountdown, filePath]);

  // Stop transcode session when component closes.
  useEffect(() => () => {
    playerActiveRef.current = false;
    userPausedRef.current = true;
    loadTokenRef.current += 1;
    sourceLoadTokenRef.current += 1;
    clearNextEpisodeCountdown();
    void stopTranscodeSession();
  }, [clearNextEpisodeCountdown, stopTranscodeSession]);

  // ─── Controls ──────────────────────────────────────────────────────────────

  const togglePlay = useCallback(() => {
    if (playerState === 'loading') return;
    if (playbackEngineRef.current) {
      userPausedRef.current = !paused;
      void (paused ? playbackEngineRef.current.play() : playbackEngineRef.current.pause());
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      userPausedRef.current = false;
      video.autoplay = true;
      void video.play().catch(() => setPaused(true));
      return;
    }
    userPausedRef.current = true;
    video.autoplay = false;
    video.pause();
  }, [paused, playerState]);

  const restorePlaybackStateAfterSurfaceDoubleClick = useCallback(() => {
    const action = surfaceSingleClickActionRef.current;
    surfaceSingleClickActionRef.current = null;
    if (!action || Date.now() - action.executedAt > SURFACE_DOUBLE_CLICK_WINDOW_MS + 750) return;

    userPausedRef.current = action.wasPaused;
    setPaused(action.wasPaused);
    const engine = playbackEngineRef.current;
    if (engine) {
      void (action.wasPaused ? engine.pause() : engine.play());
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.autoplay = !action.wasPaused;
    if (action.wasPaused) video.pause();
    else void video.play().catch(() => setPaused(true));
  }, []);

  const persistFinalPlaybackProgress = useCallback(async () => {
    if (playbackEngineRef.current) {
      const snapshotPosition = playbackPositionRef.current;
      const snapshotDuration = playbackDurationRef.current || probedDurationRef.current;
      if (snapshotPosition > 10 && snapshotDuration > 0) {
        await savePlaybackProgress(filePath, snapshotPosition, snapshotDuration);
      }
      return;
    }
    const video = videoRef.current;
    const snapshot = playbackProgressForExit({
      videoPosition: video?.currentTime ?? 0,
      snapshotPosition: playbackPositionRef.current,
      transcodeStartSeconds: transcodeStartSecondsRef.current,
      streamIsTranscoded,
      probedDuration: probedDurationRef.current,
      snapshotDuration: playbackDurationRef.current,
      videoDuration: video?.duration ?? 0,
    });
    if (snapshot.position <= 10 || snapshot.duration <= 0) return;
    updatePlaybackSnapshot(snapshot.position, snapshot.duration, { forceReact: true });
    await savePlaybackProgress(filePath, snapshot.position, snapshot.duration);
  }, [filePath, streamIsTranscoded, updatePlaybackSnapshot]);

  const shutdownPlayback = useCallback(async () => {
    cancelPendingSurfaceClick();
    await persistFinalPlaybackProgress();
    playerActiveRef.current = false;
    userPausedRef.current = true;
    loadTokenRef.current += 1;
    sourceLoadTokenRef.current += 1;
    clearNextEpisodeCountdown();
    clearHls();
    const engine = playbackEngineRef.current;
    playbackEngineRef.current = null;
    await engine?.destroy();
    setNativePlaybackActive(false);
    setNativeEngineKind(null);
    document.documentElement.classList.remove('loom-native-active');
    const video = videoRef.current;
    if (video) {
      video.autoplay = false;
      clearVideoElement(video);
    }
    await stopTranscodeSession();
  }, [cancelPendingSurfaceClick, clearHls, clearNextEpisodeCountdown, clearVideoElement, persistFinalPlaybackProgress, stopTranscodeSession]);

  useEffect(() => registerPlaybackShutdown(async () => {
    await shutdownPlayback();
    onClose();
  }), [onClose, shutdownPlayback]);

  const handleClose = useCallback(async (event?: React.SyntheticEvent) => {
    event?.preventDefault();
    await shutdownPlayback();
    onClose();
  }, [onClose, shutdownPlayback]);

  const handleBack = useCallback(async (event?: React.SyntheticEvent) => {
    event?.preventDefault();
    await shutdownPlayback();
    onClose();
  }, [onClose, shutdownPlayback]);

  const openMediaPanel = useCallback(() => {
    if (showMediaPanel && mediaPanelTab === 'video') {
      setShowMediaPanel(false);
      return;
    }

    setShowSidebar(false);
    setMediaPanelTab('video');
    setShowMediaPanel(true);
  }, [showMediaPanel, mediaPanelTab]);

  const openEpisodePanel = useCallback(() => {
    if (showSidebar) {
      setShowSidebar(false);
      return;
    }

    setShowMediaPanel(false);
    setShowSidebar(true);
  }, [showSidebar]);

  const openSubtitlesPanel = useCallback(() => {
    if (showMediaPanel && mediaPanelTab === 'subtitles') {
      setShowMediaPanel(false);
      return;
    }

    setShowSidebar(false);
    setMediaPanelTab('subtitles');
    setShowMediaPanel(true);
  }, [showMediaPanel, mediaPanelTab]);

  useEffect(() => {
    if (playbackEngineRef.current) {
      void playbackEngineRef.current.setSpeed(playbackRate);
      return;
    }
    const video = videoRef.current;
    if (video) {
      video.playbackRate = playbackRate;
    }
  }, [nativePlaybackActive, playbackRate, streamUrl]);

  useEffect(() => {
    if (!nativePlaybackActive || !playbackEngineRef.current) return;
    const normalizeRatio = (value: string) => value.replace(/\s*\/\s*/, ':');
    void playbackEngineRef.current.setVideoAspect(aspectMode === 'default' ? null : normalizeRatio(aspectMode));
  }, [aspectMode, nativePlaybackActive]);

  useEffect(() => {
    if (!nativePlaybackActive || !playbackEngineRef.current) return;
    const crop = cropMode === 'none' || cropMode === 'custom' ? null : cropMode.replace(/\s*\/\s*/, ':');
    void playbackEngineRef.current.setVideoCrop(crop);
  }, [cropMode, nativePlaybackActive]);

  useEffect(() => {
    if (nativePlaybackActive) void playbackEngineRef.current?.setVideoRotation(rotation);
  }, [nativePlaybackActive, rotation]);

  useEffect(() => {
    if (!nativePlaybackActive || !playbackEngineRef.current) return;
    const style = subtitleStyleRef.current;
    void playbackEngineRef.current.setSubtitleDelay(style.delaySeconds);
    void playbackEngineRef.current.setAudioDelay(audioDelay);
    if (playbackEngineRef.current.kind !== 'libvlc') {
      void playbackEngineRef.current.setSubtitleStyle({
        fontSize: Math.round(style.fontSize * style.scale),
        color: style.fontColor,
        borderColor: style.borderColor,
        borderWidth: style.borderEnabled ? style.borderWidth : 0,
        backgroundColor: style.backgroundEnabled ? style.backgroundColor : '#00000000',
        position: style.position,
      });
    }
  }, [audioDelay, nativePlaybackActive]);

  useEffect(() => {
    applyNativeTextTrackVisibility();
  }, [applyNativeTextTrackVisibility, subtitleStyle]);

  const seekTo = useCallback((targetSeconds: number, options: { restartTranscoded?: boolean; updateSnapshot?: boolean } = {}) => {
    const nextPosition = clampSeconds(targetSeconds, duration || undefined);
    if (options.updateSnapshot !== false) {
      updatePlaybackSnapshot(nextPosition, duration || playbackDurationRef.current, { forceReact: true });
    }

    if (playbackEngineRef.current) {
      const seekGuard = {
        target: nextPosition,
        expiresAt: performance.now() + NATIVE_SEEK_GUARD_TIMEOUT_MS,
      };
      nativeSeekGuardRef.current = seekGuard;
      void playbackEngineRef.current.seek(nextPosition).catch(() => {
        if (nativeSeekGuardRef.current === seekGuard) nativeSeekGuardRef.current = null;
      });
      return;
    }

    nativeSeekGuardRef.current = null;

    const video = videoRef.current;
    if (!video) return;
    const shouldResumeAfterSeek = !video.paused && !userPausedRef.current;
    suppressPauseIntentUntilMsRef.current = performance.now() + 1500;
    const seekGeneration = ++transcodeSeekGenerationRef.current;
    const currentStreamPosition = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const directDuration = Number.isFinite(video.duration) ? video.duration : duration;
    const restartTranscodeAt = (target: number, forceRestart = false, generation = seekGeneration) => {
      transcodeSeekActiveRef.current = true;
      if (transcodeSeekSafetyRef.current) clearTimeout(transcodeSeekSafetyRef.current);
      transcodeSeekSafetyRef.current = setTimeout(() => {
        transcodeSeekSafetyRef.current = null;
        transcodeSeekActiveRef.current = false;
      }, TRANSCODE_SEEK_HOLD_TIMEOUT_MS);
      hlsTranscodeRestartAttemptsRef.current = 0;
      if (streamUsesBrowserPipelineRef.current) {
        void startBrowserStreamAt(target, {
          showSeekingStatus: true,
          seekGeneration: generation,
        });
        return;
      }
      void startTranscodedFallback(target, {
        ...transcodeSeekRestartOptions({ forceRestart }),
        seekGeneration: generation,
      });
    };

    const scheduleTranscodedSeekRestart = (target: number, forceRestart = false) => {
      // A new seek supersedes any restart still waiting in the debounce window.
      if (transcodeSeekTimerRef.current) {
        clearTimeout(transcodeSeekTimerRef.current);
        transcodeSeekTimerRef.current = null;
      }

      transcodeSeekActiveRef.current = true;
      pendingTranscodeSeekRef.current = target;

      // Deliberate restarts (track changes) bypass the debounce.
      if (forceRestart) {
        pendingTranscodeSeekRef.current = null;
        restartTranscodeAt(target, true, seekGeneration);
        return;
      }

      transcodeSeekTimerRef.current = setTimeout(() => {
        transcodeSeekTimerRef.current = null;
        const pendingTarget = pendingTranscodeSeekRef.current;
        pendingTranscodeSeekRef.current = null;
        if (pendingTarget !== null && seekGeneration === transcodeSeekGenerationRef.current) {
          restartTranscodeAt(pendingTarget, false, seekGeneration);
        }
      }, TRANSCODE_SEEK_DEBOUNCE_MS);
    };

    // Seekable transcoded streams expose a full-duration HLS VOD playlist. Let
    // hls.js request the target segment; the local server materializes it on
    // demand. Restarting the whole HLS session for each scrub makes late-episode
    // seeks fragile and can leave the UI pinned to the previous stream.
    if (streamIsTranscoded && streamIsSeekableRef.current) {
      if (options.restartTranscoded) {
        scheduleTranscodedSeekRestart(nextPosition, true);
        return;
      }

      const targetPosition = clampSeconds(nextPosition, directDuration || undefined);
      const canSeekInstantly = isTimeBuffered(video.buffered, targetPosition)
        || Math.abs(targetPosition - currentStreamPosition) < 0.5;
      pendingTranscodeSeekRef.current = null;
      transcodeSeekActiveRef.current = !canSeekInstantly;
      if (!canSeekInstantly) {
        if (transcodeSeekSafetyRef.current) clearTimeout(transcodeSeekSafetyRef.current);
        transcodeSeekSafetyRef.current = setTimeout(() => {
          transcodeSeekSafetyRef.current = null;
          transcodeSeekActiveRef.current = false;
        }, TRANSCODE_SEEK_HOLD_TIMEOUT_MS);
        hlsTranscodeRestartAttemptsRef.current = 0;
        setPlayerState('loading');
        setStatusMessage('Seeking local stream...');
        setErrorMessage(null);
      }
      video.currentTime = targetPosition;
      hlsRef.current?.startLoad(targetPosition);
      if (shouldResumeAfterSeek) {
        void video.play().catch(() => setPaused(true));
      }
      return;
    }

    // Only the linear fallback (unknown duration) needs an encoder restart.
    if (streamIsTranscoded && !streamIsSeekableRef.current) {
      const streamOffset = transcodeStartSecondsRef.current;
      const streamPosition = playerSecondsForAbsolute(nextPosition, {
        mode: 'offset',
        offsetSeconds: streamOffset,
      });
      const streamDuration = directDuration || undefined;
      // playerSecondsForAbsolute clamps positions before the current window to
      // zero. Treating that zero as seekable is what made a backward scrub snap
      // straight back to the original resume point instead of reloading there.
      const targetIsInsideCurrentWindow = nextPosition >= streamOffset;
      const canSeekInCurrentStream = targetIsInsideCurrentWindow
        && !options.restartTranscoded
        && isTimeBuffered(video.buffered, streamPosition);

      if (canSeekInCurrentStream) {
        // Target is already encoded and buffered — native seek, instant.
        pendingTranscodeSeekRef.current = null;
        transcodeSeekActiveRef.current = false;
        video.currentTime = clampSeconds(streamPosition, streamDuration);
        if (shouldResumeAfterSeek) {
          void video.play().catch(() => setPaused(true));
        }
        return;
      }

      // Target is outside the encoded region, so a re-encode from this point is
      // unavoidable. Hold the scrubber at the requested spot and coalesce a
      // burst of seeks so FFmpeg restarts once for the final target.
      scheduleTranscodedSeekRestart(nextPosition, Boolean(options.restartTranscoded));
      return;
    }

    if (shouldRestartUnseekableDirectStream({
      streamIsTranscoded,
      seekable: video.seekable,
      targetSeconds: nextPosition,
    })) {
      transcodeSeekActiveRef.current = true;
      hlsTranscodeRestartAttemptsRef.current = 0;
      void startTranscodedFallback(nextPosition, {
        force: true,
        allowNearEnd: true,
        showSeekingStatus: true,
      });
      return;
    }

    video.currentTime = clampSeconds(nextPosition, directDuration || undefined);
    if (shouldResumeAfterSeek) {
      void video.play().catch(() => setPaused(true));
    }
  }, [duration, startBrowserStreamAt, startTranscodedFallback, streamIsTranscoded, updatePlaybackSnapshot]);

  const flushNativeScrubPreview = useCallback(() => {
    nativeScrubSeekTimerRef.current = null;
    const target = pendingNativeScrubSeekRef.current;
    const engine = playbackEngineRef.current;
    if (!isScrubbingRef.current || target === null || !engine) {
      pendingNativeScrubSeekRef.current = null;
      return;
    }
    pendingNativeScrubSeekRef.current = null;
    lastNativeScrubSeekAtRef.current = performance.now();
    // Preview seeks are intentionally coalesced. LibVLC renders the frame at
    // each sampled target while Loom remains the source of truth for the bar
    // and subtitle clock; the exact release target is sent separately below.
    void engine.seek(target);
  }, []);

  const requestNativeScrubPreview = useCallback((target: number) => {
    if (!playbackEngineRef.current) return;
    pendingNativeScrubSeekRef.current = target;
    if (nativeScrubSeekTimerRef.current) return;
    const elapsed = performance.now() - lastNativeScrubSeekAtRef.current;
    const delay = Math.max(0, NATIVE_SCRUB_PREVIEW_INTERVAL_MS - elapsed);
    if (delay === 0) {
      flushNativeScrubPreview();
      return;
    }
    nativeScrubSeekTimerRef.current = setTimeout(flushNativeScrubPreview, delay);
  }, [flushNativeScrubPreview]);

  const cancelNativeScrubPreview = useCallback(() => {
    if (nativeScrubSeekTimerRef.current) {
      clearTimeout(nativeScrubSeekTimerRef.current);
      nativeScrubSeekTimerRef.current = null;
    }
    pendingNativeScrubSeekRef.current = null;
  }, []);

  const handleProgressPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    if (event.button !== 0) return;
    event.preventDefault();
    const bar = event.currentTarget;
    const pointerId = event.pointerId;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    bar.setPointerCapture(event.pointerId);
    setDismissedNextPromptKey(null);
    clearNextEpisodeCountdown();
    let pendingPosition = playbackPositionRef.current;
    isScrubbingRef.current = true;
    bar.dataset.scrubbing = 'true';
    if (scrubHudHideTimerRef.current) {
      clearTimeout(scrubHudHideTimerRef.current);
      scrubHudHideTimerRef.current = null;
    }
    if (scrubTimeHudRef.current) scrubTimeHudRef.current.style.opacity = '1';
    const previewFromClientX = (clientX: number) => {
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      pendingPosition = ratio * duration;
      requestNativeScrubPreview(pendingPosition);
      if (scrubPreviewRafRef.current !== null) return;
      scrubPreviewRafRef.current = requestAnimationFrame(() => {
        scrubPreviewRafRef.current = null;
        updatePlaybackSnapshot(pendingPosition, duration, { forceReact: false });
      });
    };
    previewFromClientX(event.clientX);
    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === pointerId) previewFromClientX(moveEvent.clientX);
    };
    let removeScrubListeners = () => undefined;
    const finishScrub = (finishEvent: PointerEvent, updateFromPointer: boolean) => {
      if (finishEvent.pointerId !== pointerId) return;
      if (updateFromPointer) previewFromClientX(finishEvent.clientX);
      cancelNativeScrubPreview();
      if (scrubPreviewRafRef.current !== null) {
        cancelAnimationFrame(scrubPreviewRafRef.current);
        scrubPreviewRafRef.current = null;
      }
      updatePlaybackSnapshot(pendingPosition, duration, { forceReact: true });
      seekTo(pendingPosition);
      isScrubbingRef.current = false;
      delete bar.dataset.scrubbing;
      scrubHudHideTimerRef.current = setTimeout(() => {
        scrubHudHideTimerRef.current = null;
        if (scrubTimeHudRef.current) scrubTimeHudRef.current.style.opacity = '0';
      }, 180);
      if (bar.hasPointerCapture(pointerId)) bar.releasePointerCapture(pointerId);
      removeScrubListeners();
    };
    const handleUp = (upEvent: PointerEvent) => finishScrub(upEvent, true);
    // pointercancel coordinates are frequently 0/0. Commit the last valid
    // preview target instead of turning a cancelled drag into a jump to zero.
    const handleCancel = (cancelEvent: PointerEvent) => finishScrub(cancelEvent, false);
    removeScrubListeners = () => {
      bar.removeEventListener('pointermove', handleMove);
      bar.removeEventListener('pointerup', handleUp);
      bar.removeEventListener('pointercancel', handleCancel);
      if (scrubListenerCleanupRef.current === removeScrubListeners) scrubListenerCleanupRef.current = null;
    };
    scrubListenerCleanupRef.current?.();
    scrubListenerCleanupRef.current = removeScrubListeners;
    bar.addEventListener('pointermove', handleMove);
    bar.addEventListener('pointerup', handleUp);
    bar.addEventListener('pointercancel', handleCancel);
  }, [cancelNativeScrubPreview, clearNextEpisodeCountdown, duration, requestNativeScrubPreview, seekTo, updatePlaybackSnapshot]);

  const handleProgressKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    const big = event.shiftKey ? 60 : 10;
    const small = 5;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      seekTo(playbackPositionRef.current - (event.shiftKey ? big : small));
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      seekTo(playbackPositionRef.current + (event.shiftKey ? big : small));
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      seekTo(playbackPositionRef.current - duration * 0.1);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      seekTo(playbackPositionRef.current + duration * 0.1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      seekTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      seekTo(duration);
    }
  }, [duration, seekTo]);

  const handleVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    setMuted(v === 0);
    if (playbackEngineRef.current) {
      void playbackEngineRef.current.setVolume(v);
      void playbackEngineRef.current.setMuted(v === 0);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.volume = v;
    video.muted = v === 0;
  }, []);

  const toggleMute = useCallback(() => {
    if (playbackEngineRef.current) {
      void playbackEngineRef.current.setMuted(!muted);
      return;
    }
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }, [muted]);

  const restartForTrackChange = useCallback(() => {
    if (playbackEngineRef.current) return;
    if (!streamUrl) return;
    applyNativeTextTrackVisibility();
    didTryTranscodeRef.current = false;
    hlsTranscodeRestartAttemptsRef.current = 0;
    const generation = ++trackChangeGenerationRef.current;
    void startBrowserStreamAt(playbackPositionRef.current, {
      trackChangeGeneration: generation,
    });
  }, [applyNativeTextTrackVisibility, startBrowserStreamAt, streamUrl]);

  const restartLibVlcForSubtitleFallback = useCallback(() => {
    if (playbackEngineRef.current?.kind !== 'libvlc') return;
    setReloadToken((value) => value + 1);
  }, []);

  const selectedSubtitleIsBurnedIn = useCallback(() => {
    const selected = selectedEmbeddedSubtitle(probeTracksRef.current, selectedSubtitleTrackIndexRef.current);
    return streamIsTranscoded && Boolean(selected && isBitmapSubtitleCodec(selected.track.codec));
  }, [streamIsTranscoded]);

  const applySubtitleStyleToStream = useCallback(() => {
    if (subtitleStyleApplyTimerRef.current) {
      clearTimeout(subtitleStyleApplyTimerRef.current);
      subtitleStyleApplyTimerRef.current = null;
    }
    if (playbackEngineRef.current) {
      const style = subtitleStyleRef.current;
      void playbackEngineRef.current.setSubtitleDelay(style.delaySeconds);
      if (playbackEngineRef.current.kind !== 'libvlc') {
        void playbackEngineRef.current.setSubtitleStyle({
          fontSize: Math.round(style.fontSize * style.scale),
          color: style.fontColor,
          borderColor: style.borderColor,
          borderWidth: style.borderEnabled ? style.borderWidth : 0,
          backgroundColor: style.backgroundEnabled ? style.backgroundColor : '#00000000',
          position: style.position,
        });
      }
      return;
    }
    applyNativeTextTrackVisibility();
    if (shouldRestartTranscodedSubtitleStyle({
      subtitleIsBurnedIn: selectedSubtitleIsBurnedIn(),
    })) {
      hlsTranscodeRestartAttemptsRef.current = 0;
      void startTranscodedFallback(playbackPositionRef.current, {
        force: true,
        allowNearEnd: true,
        keepReadyDuringRestart: true,
        deferStopCurrent: true,
      });
    }
  }, [applyNativeTextTrackVisibility, selectedSubtitleIsBurnedIn, startTranscodedFallback]);

  const scheduleSubtitleStyleToStream = useCallback(() => {
    if (playbackEngineRef.current) {
      applySubtitleStyleToStream();
      return;
    }
    applyNativeTextTrackVisibility();
    if (!shouldRestartTranscodedSubtitleStyle({
      subtitleIsBurnedIn: selectedSubtitleIsBurnedIn(),
    })) {
      return;
    }
    if (subtitleStyleApplyTimerRef.current) clearTimeout(subtitleStyleApplyTimerRef.current);
    subtitleStyleApplyTimerRef.current = setTimeout(() => {
      subtitleStyleApplyTimerRef.current = null;
      applySubtitleStyleToStream();
    }, 180);
  }, [applyNativeTextTrackVisibility, applySubtitleStyleToStream, selectedSubtitleIsBurnedIn]);

  const setLiveSubtitleStyle = useCallback((updater: (current: SubtitleStyleSettings) => SubtitleStyleSettings) => {
    const next = updater(subtitleStyleRef.current);
    subtitleStyleRef.current = next;
    setSubtitleStyle(next);
    scheduleSubtitleStyleToStream();
  }, [scheduleSubtitleStyleToStream]);

  const updateSubtitleStyle = useCallback((key: keyof SubtitleStyleSettings, value: number | string) => {
    setLiveSubtitleStyle((current) => ({
      ...current,
      [key]: value,
    }));
  }, [setLiveSubtitleStyle]);

  const adjustSubtitleDelay = useCallback((deltaSeconds: number) => {
    setLiveSubtitleStyle((current) => ({
      ...current,
      delaySeconds: clampSubtitleDelay(current.delaySeconds + deltaSeconds),
    }));
  }, [setLiveSubtitleStyle]);

  const resetSubtitleDelay = useCallback(() => {
    setLiveSubtitleStyle((current) => ({
      ...current,
      delaySeconds: 0,
    }));
  }, [setLiveSubtitleStyle]);

  const updateAudioDelay = useCallback((seconds: number) => {
    const nextDelay = Math.max(-60, Math.min(60, seconds));
    audioDelayRef.current = nextDelay;
    setAudioDelay(nextDelay);
    void playbackEngineRef.current?.setAudioDelay(nextDelay);
  }, []);

  const selectVideoTrack = useCallback((trackIndex: number) => {
    if (selectedVideoTrackIndexRef.current === trackIndex) return;
    selectedVideoTrackIndexRef.current = trackIndex;
    setSelectedVideoTrackIndex(trackIndex);
    if (playbackEngineRef.current) {
      void playbackEngineRef.current.selectVideo(trackIndex >= 0 ? trackIndex : null);
      return;
    }
    restartForTrackChange();
  }, [restartForTrackChange]);

  const selectAudioTrack = useCallback((trackIndex: number) => {
    if (selectedAudioTrackIndexRef.current === trackIndex) return;
    const selectedTrack = probeTracksRef.current.find((track) => track.index === trackIndex && track.type === 'audio');
    const preference = saveTrackPreference(trackPreferenceScopeKey, 'audio', selectedTrack, trackIndex >= 0);
    const nextPreferences = { ...sharedTrackPreferencesRef.current, audio: preference };
    sharedTrackPreferencesRef.current = nextPreferences;
    selectedAudioTrackIndexRef.current = trackIndex;
    setSelectedAudioTrackIndex(trackIndex);
    if (playbackEngineRef.current) {
      void playbackEngineRef.current.selectAudio(trackIndex >= 0 ? trackIndex : null);
      return;
    }
    restartForTrackChange();
  }, [restartForTrackChange, trackPreferenceScopeKey]);

  const selectSubtitleTrack = useCallback((trackIndex: number) => {
    if (selectedSubtitleTrackIndexRef.current === trackIndex) return;
    subtitleSelectionExplicitRef.current = true;
    const enabled = trackIndex >= 0 || trackIndex <= -1000;
    const selectedTrack = probeTracksRef.current.find((track) => track.index === trackIndex && track.type === 'subtitle');
    const playbackAction = subtitleTrackPlaybackAction({
      selectedTrackIndex: trackIndex,
      selectedSubtitleIsBitmap: Boolean(selectedTrack && isBitmapSubtitleCodec(selectedTrack.codec)),
      activeSubtitleIsBurnedIn: selectedSubtitleIsBurnedIn(),
    });
    const preference = saveTrackPreference(trackPreferenceScopeKey, 'subtitle', selectedTrack, enabled);
    const nextPreferences = { ...sharedTrackPreferencesRef.current, subtitle: preference };
    sharedTrackPreferencesRef.current = nextPreferences;
    subtitlesDefaultEnabledRef.current = enabled;
    libVlcSubtitleFallbackRef.current = false;
    setSubtitlesDefaultEnabled(enabled);
    saveSubtitlesDefaultEnabled(enabled);
    selectedSubtitleTrackIndexRef.current = trackIndex;
    setSelectedSubtitleTrackIndex(trackIndex);
    if (playbackEngineRef.current?.kind === 'libvlc') {
      // Do not pass Loom/probe IDs to LibVLC's independent SPU namespace.
      // Reopen only for a bitmap track, where native rendering is the explicit
      // fallback; parseable text remains on the Loom overlay path.
      if (selectedTrack && isBitmapSubtitleCodec(selectedTrack.codec)) {
        libVlcSubtitleFallbackRef.current = true;
        restartLibVlcForSubtitleFallback();
      } else {
        void playbackEngineRef.current.selectSubtitle(null);
      }
      return;
    }
    if (playbackEngineRef.current) {
      void playbackEngineRef.current.selectSubtitle(enabled ? trackIndex : null);
      return;
    }
    if (playbackAction === 'burn-in') {
      restartForTrackChange();
      return;
    }
    if (playbackAction === 'reload-source') {
      restartForTrackChange();
      return;
    }
    if (trackIndex <= -1000 || trackIndex < 0 || selectedTrack) {
      applyNativeTextTrackVisibility();
      return;
    }
    applyNativeTextTrackVisibility();
  }, [
    applyNativeTextTrackVisibility,
    restartForTrackChange,
    restartLibVlcForSubtitleFallback,
    selectedSubtitleIsBurnedIn,
    trackPreferenceScopeKey,
  ]);

  const selectSecondarySubtitleTrack = useCallback((trackIndex: number) => {
    if (!playbackEngineRef.current) return;
    setSelectedSecondarySubtitleTrackIndex(trackIndex);
    void playbackEngineRef.current.selectSecondarySubtitle(trackIndex >= 0 ? trackIndex : null);
  }, []);

  const changeVolume = useCallback((delta: number) => {
    const currentVolume = playbackEngineRef.current ? volume : videoRef.current?.volume ?? volume;
    const nextVolume = Math.min(1, Math.max(0, currentVolume + delta));
    setVolume(nextVolume);
    setMuted(nextVolume === 0);

    if (playbackEngineRef.current) {
      void playbackEngineRef.current.setVolume(nextVolume);
      void playbackEngineRef.current.setMuted(nextVolume === 0);
      return;
    }

    const video = videoRef.current;
    if (!video) return;
    video.volume = nextVolume;
    video.muted = nextVolume === 0;
  }, [volume]);

  const changePlaybackRate = useCallback((delta: number) => {
    setPlaybackRate((value) => Math.min(3, Math.max(0.25, value + delta)));
  }, []);

  const resetPlaybackRate = useCallback(() => {
    setPlaybackRate(1);
  }, []);

  const handleSurfaceClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isPlayerControlTarget(event.target)) {
      cancelPendingSurfaceClick();
      return;
    }
    if (playerState === 'error') {
      cancelPendingSurfaceClick();
      return;
    }
    if (showMediaPanel || showSidebar) {
      cancelPendingSurfaceClick();
      setShowMediaPanel(false);
      setShowSidebar(false);
      return;
    }
    // Some macOS/Electron input paths report the second press through the
    // click count but do not deliver a reliable `dblclick` event over the
    // transparent native-video composition. Keep the first click pending for
    // the full gesture window, then handle that signal while suppressing the
    // following dblclick so fullscreen toggles exactly once.
    if (event.detail > 1) {
      restorePlaybackStateAfterSurfaceDoubleClick();
      cancelPendingSurfaceClick();
      if (event.detail === 2) {
        toggleFullscreen();
        surfaceDoubleClickGuardUntilMsRef.current = Date.now() + SURFACE_DOUBLE_CLICK_WINDOW_MS;
      }
      return;
    }

    cancelPendingSurfaceClick();
    clickTimerRef.current = setTimeout(() => {
      if (playerState !== 'loading') {
        surfaceSingleClickActionRef.current = { wasPaused: paused, executedAt: Date.now() };
      }
      togglePlay();
      clickTimerRef.current = null;
    }, SURFACE_DOUBLE_CLICK_WINDOW_MS);
  }, [cancelPendingSurfaceClick, paused, playerState, restorePlaybackStateAfterSurfaceDoubleClick, showMediaPanel, showSidebar, toggleFullscreen, togglePlay]);

  const handleSurfaceDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isPlayerControlTarget(event.target)) {
      cancelPendingSurfaceClick();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (surfaceDoubleClickGuardUntilMsRef.current > Date.now()) {
      surfaceDoubleClickGuardUntilMsRef.current = 0;
      return;
    }
    restorePlaybackStateAfterSurfaceDoubleClick();
    cancelPendingSurfaceClick();
    if (playerState !== 'error') toggleFullscreen();
  }, [cancelPendingSurfaceClick, playerState, restorePlaybackStateAfterSurfaceDoubleClick, toggleFullscreen]);

  const handleSurfaceDoubleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isPlayerControlTarget(event.target)) {
      cancelPendingSurfaceClick();
      return;
    }
    handleSurfaceDoubleClick(event);
  }, [cancelPendingSurfaceClick, handleSurfaceDoubleClick]);

  // Dismissing an open side panel must work from anywhere outside it, not only
  // from the video surface. The surface's own click handler never sees a press
  // on the macOS title drag strip, the letterboxed margins, or the control bar,
  // so anything opened from the control bar could not be closed by clicking
  // "next to" it. Watch the whole player root in the capture phase instead, and
  // ignore presses that land inside a panel or on the control that toggles one.
  const handleRootPointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const isControl = isPlayerControlTarget(event.target);
    const isPanel = Boolean(target?.closest?.('.player-side-panel, [data-player-panel-toggle="true"]'));
    if (isControl || isPanel) {
      cancelPendingSurfaceClick();
    }
    if (!showMediaPanel && !showSidebar) return;
    if (isPanel) return;
    setShowMediaPanel(false);
    setShowSidebar(false);
  }, [cancelPendingSurfaceClick, showMediaPanel, showSidebar]);

  // ─── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableShortcutTarget(e.target)) return;
      if (playerStateRef.current === 'error') {
        if (e.key === 'Escape') {
          e.preventDefault();
          handleClose();
        }
        return;
      }
      if (
        isPlayerControlTarget(e.target)
        && [' ', 'Spacebar', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)
      ) {
        return;
      }
      const hasCommandModifier = e.metaKey || e.ctrlKey || e.altKey;

      switch (e.key) {
        case 'Escape':
          cancelPendingSurfaceClick();
          e.preventDefault();
          if (fullscreen) toggleFullscreen();
          else handleBack();
          break;
        case ' ':
        case 'Spacebar':
          if (hasCommandModifier) break;
          cancelPendingSurfaceClick();
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          cancelPendingSurfaceClick();
          e.preventDefault();
          seekTo(playbackPositionRef.current - (e.shiftKey ? 60 : skipBackSeconds));
          break;
        case 'ArrowRight':
          cancelPendingSurfaceClick();
          e.preventDefault();
          seekTo(playbackPositionRef.current + (e.shiftKey ? 60 : skipForwardSeconds));
          break;
        case 'ArrowUp':
          cancelPendingSurfaceClick();
          e.preventDefault();
          changeVolume(0.05);
          break;
        case 'ArrowDown':
          cancelPendingSurfaceClick();
          e.preventDefault();
          changeVolume(-0.05);
          break;
        case 'm':
        case 'M':
          if (hasCommandModifier) break;
          cancelPendingSurfaceClick();
          e.preventDefault();
          toggleMute();
          break;
        case 'Backspace':
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          cancelPendingSurfaceClick();
          e.preventDefault();
          handleBack();
          break;
        case 'f':
        case 'F':
          if (hasCommandModifier) break;
          cancelPendingSurfaceClick();
          e.preventDefault();
          toggleFullscreen();
          break;
        case '[':
          cancelPendingSurfaceClick();
          e.preventDefault();
          changePlaybackRate(-0.25);
          break;
        case ']':
          cancelPendingSurfaceClick();
          e.preventDefault();
          changePlaybackRate(0.25);
          break;
        case 'r':
        case 'R':
          cancelPendingSurfaceClick();
          e.preventDefault();
          resetPlaybackRate();
          break;
        case 'Home':
          cancelPendingSurfaceClick();
          e.preventDefault();
          seekTo(0);
          break;
        case 'End':
          cancelPendingSurfaceClick();
          e.preventDefault();
          seekTo(duration);
          break;
        case 'z':
        case 'Z':
          cancelPendingSurfaceClick();
          e.preventDefault();
          adjustSubtitleDelay(-(e.shiftKey ? SUBTITLE_DELAY_FINE_STEP_SECONDS : SUBTITLE_DELAY_STEP_SECONDS));
          break;
        case 'x':
        case 'X':
          cancelPendingSurfaceClick();
          e.preventDefault();
          adjustSubtitleDelay(e.shiftKey ? SUBTITLE_DELAY_FINE_STEP_SECONDS : SUBTITLE_DELAY_STEP_SECONDS);
          break;
        case 'c':
        case 'C':
          cancelPendingSurfaceClick();
          e.preventDefault();
          resetSubtitleDelay();
          break;
        default:
          if (/^[0-9]$/.test(e.key) && duration > 0) {
            cancelPendingSurfaceClick();
            e.preventDefault();
            seekTo((Number(e.key) / 10) * duration);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    cancelPendingSurfaceClick,
    changePlaybackRate,
    changeVolume,
    duration,
    fullscreen,
    handleBack,
    handleClose,
    resetPlaybackRate,
    adjustSubtitleDelay,
    resetSubtitleDelay,
    skipBackSeconds,
    skipForwardSeconds,
    seekTo,
    toggleMute,
    toggleFullscreen,
    togglePlay,
  ]);

  // ─── Derived ───────────────────────────────────────────────────────────────

  const activePlaybackEngine = nativePlaybackActive ? nativeEngineKind : 'browser';
  const playbackInformation = {
    engine: activePlaybackEngine === 'libvlc'
      ? 'LibVLC'
      : activePlaybackEngine === 'mpv'
        ? 'mpv'
        : 'Chromium',
    mode: nativePlaybackActive
      ? 'Native local playback'
      : streamIsTranscoded
        ? 'HLS transcode'
        : streamUrl
          ? 'Direct stream'
          : 'Preparing',
    hardwareDecode: nativePlaybackActive ? 'Native engine managed' : 'Chromium managed',
    encodeBackend: streamIsTranscoded ? 'Host transcoder' : 'Not used',
    note: streamIsTranscoded ? 'HLS backend details are reported by the host transcoder.' : undefined,
  };
  const progressPct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  const selectedSubtitleForOverlay = selectedSubtitleTrackIndex >= 0
    ? selectedEmbeddedSubtitle(mediaTracks, selectedSubtitleTrackIndex)
    : null;
  const selectedSubtitleTrackForSettings = mediaTracks.find((track) =>
    track.type === 'subtitle' && track.index === selectedSubtitleTrackIndex,
  );
  const subtitleStyleCompatibilityMessage = nativeEngineKind === 'libvlc'
    && selectedSubtitleTrackForSettings
    && isBitmapSubtitleCodec(selectedSubtitleTrackForSettings.codec)
    ? 'This image-based subtitle is rendered by LibVLC and cannot be restyled live. Choose an SRT, ASS, or WebVTT track to use Loom\'s position, size, outline, and color controls.'
    : undefined;
  const subtitleIsBurnedIn = streamIsTranscoded
    && Boolean(selectedSubtitleForOverlay && isBitmapSubtitleCodec(selectedSubtitleForOverlay.track.codec));
  const showSubtitleOverlay = shouldShowSubtitleOverlay({
    subtitlesEnabled: subtitlesDefaultEnabled,
    selectedSubtitleTrackIndex,
    cueCount: subtitleCues.length,
    subtitleIsBurnedIn,
  });

  // LibVLC remains a subtitle fallback while Loom's renderer is the primary
  // surface. Once usable cues are available, disable the native SPU so the
  // same subtitle is never painted twice. If cue loading fails, leaving the
  // native track enabled preserves subtitle visibility for bitmap/unsupported
  // formats.
  useEffect(() => {
    const engine = playbackEngineRef.current;
    if (!nativePlaybackActive || nativeEngineKind !== 'libvlc' || engine?.kind !== 'libvlc') return;
    const selectedTrack = probeTracksRef.current.find((track) =>
      track.type === 'subtitle' && track.index === selectedSubtitleTrackIndex,
    );
    const nativeFallbackAllowed = Boolean(selectedTrack && isBitmapSubtitleCodec(selectedTrack.codec));
    if (!subtitlesDefaultEnabled || selectedSubtitleTrackIndex === -1 || showSubtitleOverlay || !nativeFallbackAllowed) {
      void engine.selectSubtitle(null);
    }
  }, [nativeEngineKind, nativePlaybackActive, selectedSubtitleTrackIndex, showSubtitleOverlay, subtitlesDefaultEnabled]);

  useEffect(() => {
    if (!nativePlaybackActive || nativeEngineKind !== 'libvlc') return;
    if (!subtitlesDefaultEnabled || selectedSubtitleTrackIndex > -1000 || subtitleCues.length > 0) return;
    // A sidecar/OpenSubtitles track has an authorized, deterministic file
    // path. If Loom cannot obtain parseable cues, reopen LibVLC with only that
    // selected file as a native fallback. Embedded text tracks do not have a
    // safe SPU-ID mapping here, so they remain on Loom/MPV/browser fallback.
    if (!visibleSubtitles[-1000 - selectedSubtitleTrackIndex]) return;
    if (libVlcSubtitleFallbackRef.current) return;
    const timer = setTimeout(() => {
      if (libVlcSubtitleFallbackRef.current || playbackEngineRef.current?.kind !== 'libvlc') return;
      libVlcSubtitleFallbackRef.current = true;
      restartLibVlcForSubtitleFallback();
    }, 1_600);
    return () => clearTimeout(timer);
  }, [nativeEngineKind, nativePlaybackActive, restartLibVlcForSubtitleFallback, selectedSubtitleTrackIndex, subtitleCues.length, subtitlesDefaultEnabled, visibleSubtitles]);

  const useNativeSubtitleTracks = shouldUseNativeSubtitleTracks({
    subtitlesEnabled: subtitlesDefaultEnabled,
    selectedSubtitleTrackIndex,
    overlayVisible: showSubtitleOverlay,
    subtitleIsBurnedIn,
  });
  nativeSubtitleFallbackRef.current = useNativeSubtitleTracks;
  useEffect(() => {
    applyNativeTextTrackVisibility();
  }, [applyNativeTextTrackVisibility, useNativeSubtitleTracks, selectedSubtitleTrackIndex, subtitleCues.length]);

  const subtitleCueFontSize = Math.round(subtitleStyle.fontSize * subtitleStyle.scale);
  const subtitleCueShadow = subtitleStyle.borderWidth > 0
    ? `-${subtitleStyle.borderWidth}px -${subtitleStyle.borderWidth}px 0 ${subtitleStyle.borderColor}, ${subtitleStyle.borderWidth}px -${subtitleStyle.borderWidth}px 0 ${subtitleStyle.borderColor}, -${subtitleStyle.borderWidth}px ${subtitleStyle.borderWidth}px 0 ${subtitleStyle.borderColor}, ${subtitleStyle.borderWidth}px ${subtitleStyle.borderWidth}px 0 ${subtitleStyle.borderColor}`
    : 'none';
  const aspectRatio = aspectMode === 'default' ? undefined : aspectMode;
  const cropRatio = cropMode !== 'none' && cropMode !== 'custom' ? cropMode : undefined;
  const videoFrameRatio = cropRatio || aspectRatio;
  const videoFrameStyle: React.CSSProperties = videoFrameRatio
    ? { aspectRatio: videoFrameRatio, maxHeight: '100%', width: '100%' }
    : { height: '100%', width: '100%' };
  const videoStyle: React.CSSProperties = {
    objectFit: cropMode === 'none' ? 'contain' : 'cover',
    transform: rotation === 0 ? undefined : `rotate(${rotation}deg)`,
  };

  useEffect(() => {
    if (!libVlcSurfaceActive) return;
    let raf: number | null = null;
    let disposed = false;
    const syncViewport = () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        if (disposed) return;
        void syncNativeViewport();
      });
    };
    syncViewport();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncViewport) : null;
    if (observer && videoViewportRef.current) observer.observe(videoViewportRef.current);
    window.addEventListener('resize', syncViewport);
    return () => {
      disposed = true;
      if (raf !== null) cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener('resize', syncViewport);
    };
  }, [aspectMode, cropMode, fullscreen, libVlcSurfaceActive, rotation, syncNativeViewport, videoFrameRatio]);

  const currentEpLabel = useMemo(() => {
    if (!hasEpisodes) return null;
    const ep = episodes.find((item) => item.season === currentSeason && item.number === currentEpisode);
    const file = episodeFiles.find((item) => item.season === currentSeason && item.episode === currentEpisode);
    const label = displayEpisodeTitle(currentSeason, currentEpisode, ep?.title, file?.filePath);
    return label !== `Episode ${currentEpisode}`
      ? `${epCode(currentSeason, currentEpisode)} – ${label}`
      : epCode(currentSeason, currentEpisode);
  }, [currentEpisode, currentSeason, displayEpisodeTitle, episodeFiles, episodes, hasEpisodes]);

  const currentEpisodeMeta = useMemo(() =>
    episodes.find((item) => item.season === currentSeason && item.number === currentEpisode),
  [currentEpisode, currentSeason, episodes]);

  const pauseEpisodeTitle = useMemo(() => {
    if (!hasEpisodes) return '';
    const file = episodeFiles.find((item) => item.season === currentSeason && item.episode === currentEpisode);
    const label = displayEpisodeTitle(currentSeason, currentEpisode, currentEpisodeMeta?.title, file?.filePath);
    return label !== `Episode ${currentEpisode}` ? label : '';
  }, [currentEpisode, currentSeason, currentEpisodeMeta?.title, displayEpisodeTitle, episodeFiles, hasEpisodes]);
  const pauseRating = useMemo(() => {
    const value = hasEpisodes ? currentEpisodeMeta?.rating : artwork?.rating;
    return Number.isFinite(value) && (value || 0) > 0 ? Number(value) : 0;
  }, [artwork?.rating, currentEpisodeMeta?.rating, hasEpisodes]);

  const nextEpLabel = useMemo(() => {
    if (!nextEpisodeFile) return null;
    const ep = episodes.find((item) =>
      item.season === nextEpisodeFile.season && item.number === nextEpisodeFile.episode,
    );
    const label = displayEpisodeTitle(nextEpisodeFile.season, nextEpisodeFile.episode, ep?.title, nextEpisodeFile.filePath);
    return label !== `Episode ${nextEpisodeFile.episode}`
      ? `${epCode(nextEpisodeFile.season, nextEpisodeFile.episode)} - ${label}`
      : epCode(nextEpisodeFile.season, nextEpisodeFile.episode);
  }, [displayEpisodeTitle, episodes, nextEpisodeFile]);
  const showNextEpisodePrompt = Boolean(
    nextEpisodeFile
    && duration > 0
    && nextCountdown === null
    && !showControls
    && dismissedNextPromptKey !== `${currentSeason}-${currentEpisode}`
    && duration - position <= NEXT_EPISODE_PROMPT_REMAINING_SECONDS
    && position / duration >= WATCHED_THRESHOLD
    && !isScrubbingRef.current,
  );
  const activeMediaSegment = useMemo(
    () => activeSkipSegmentAt(mediaSegments.filter((segment) => skipPromptTypes[segment.type] !== false), position),
    [mediaSegments, position, skipPromptTypes],
  );
  const selectMarkerType = (type: MediaSegmentType) => {
    setMarkerType(type);
    const existing = mediaSegments.find((segment) => segment.type === type);
    setMarkerStart(String(((existing?.startMs ?? Math.round(playbackPositionRef.current * 1000)) / 1000).toFixed(1)));
    setMarkerEnd(existing?.endMs === null ? '' : String((((existing?.endMs) ?? Math.round((playbackPositionRef.current + 90) * 1000)) / 1000).toFixed(1)));
    setMarkerError(null);
  };
  const openMarkerEditor = () => {
    selectMarkerType(activeMediaSegment?.type || 'intro');
    setShowMarkerEditor(true);
    if (mediaId) {
      void desktopApi.getManagedMediaSegments({ mediaId, season: currentSeason, episode: currentEpisode })
        .then((candidates) => setRejectedSegments(candidates.filter((candidate) => candidate.status === 'rejected')));
    }
  };
  const saveMarker = async () => {
    if (!mediaId) return;
    const startSeconds = Number(markerStart);
    const endSeconds = markerEnd.trim() ? Number(markerEnd) : null;
    if (!Number.isFinite(startSeconds) || (endSeconds !== null && !Number.isFinite(endSeconds))) {
      setMarkerError('Enter valid start and end times in seconds.');
      return;
    }
    setMarkerSaving(true);
    setMarkerError(null);
    try {
      const response = await desktopApi.saveManualMediaSegment({
        mediaId,
        season: currentSeason,
        episode: currentEpisode,
        type: markerType,
        startMs: Math.round(startSeconds * 1000),
        endMs: endSeconds === null ? null : Math.round(endSeconds * 1000),
      });
      setMediaSegments(response.segments);
      setShowMarkerEditor(false);
    } catch (error) {
      setMarkerError(error instanceof Error ? error.message : 'Could not save that marker.');
    } finally {
      setMarkerSaving(false);
    }
  };
  const resetMarker = async () => {
    if (!mediaId) return;
    setMarkerSaving(true);
    setMarkerError(null);
    try {
      const response = await desktopApi.deleteManualMediaSegment({
        mediaId,
        season: currentSeason,
        episode: currentEpisode,
        type: markerType,
      });
      setMediaSegments(response.segments);
      selectMarkerType(markerType);
    } catch (error) {
      setMarkerError(error instanceof Error ? error.message : 'Could not reset that marker.');
    } finally {
      setMarkerSaving(false);
    }
  };
  const undoMarker = async () => {
    if (!mediaId) return;
    setMarkerSaving(true);
    setMarkerError(null);
    try {
      const response = await desktopApi.undoManualMediaSegment({
        mediaId,
        season: currentSeason,
        episode: currentEpisode,
        type: markerType,
      });
      setMediaSegments(response.segments);
      const restored = response.segments.find((segment) => segment.type === markerType);
      if (restored) {
        setMarkerStart((restored.startMs / 1000).toFixed(1));
        setMarkerEnd(restored.endMs === null ? '' : (restored.endMs / 1000).toFixed(1));
      }
    } catch (error) {
      setMarkerError(error instanceof Error ? error.message : 'Could not undo that change.');
    } finally {
      setMarkerSaving(false);
    }
  };
  const editorSegment = mediaSegments.find((segment) => segment.type === markerType);
  const rejectMarker = async () => {
    if (!mediaId || !editorSegment || editorSegment.source === 'manual') return;
    setMarkerSaving(true);
    setMarkerError(null);
    try {
      await desktopApi.updateManagedMediaSegment(editorSegment.id, { status: 'rejected' });
      const candidates = await desktopApi.getManagedMediaSegments({ mediaId, season: currentSeason, episode: currentEpisode });
      setRejectedSegments(candidates.filter((candidate) => candidate.status === 'rejected'));
      const response = await desktopApi.getMediaSegments({ mediaId, season: currentSeason, episode: currentEpisode });
      setMediaSegments(response.segments);
    } catch (error) {
      setMarkerError(error instanceof Error ? error.message : 'Could not reject that marker.');
    } finally {
      setMarkerSaving(false);
    }
  };
  const restorableSegment = rejectedSegments.find((segment) => segment.type === markerType);
  const restoreMarker = async () => {
    if (!mediaId || !restorableSegment) return;
    setMarkerSaving(true);
    try {
      await desktopApi.updateManagedMediaSegment(restorableSegment.id, { status: 'active' });
      const response = await desktopApi.getMediaSegments({ mediaId, season: currentSeason, episode: currentEpisode });
      setMediaSegments(response.segments);
      setRejectedSegments((current) => current.filter((segment) => segment.id !== restorableSegment.id));
    } finally {
      setMarkerSaving(false);
    }
  };
  return (
    <div
      className={`loom-player-root fixed inset-0 z-[70] flex ${nativePlaybackActive ? 'loom-player-native bg-transparent' : 'bg-black'} ${fullscreen ? 'loom-player-is-fullscreen' : ''} ${isModern ? 'loom-player-modern' : ''}`}
      onPointerDownCapture={handleRootPointerDownCapture}
      // Reveal the chrome from anywhere in the player, not just the video
      // surface. The surface excludes the letterboxed margins and sits under
      // the macOS drag band, so a pointer crossing those areas produced no
      // pointermove and the controls stayed hidden with no way to bring
      // them back.
      onPointerMove={handlePointerMove}
      ref={containerRef}
    >
      <style>
        {`video::cue {
          color: ${subtitleStyle.fontColor};
          font-size: ${subtitleCueFontSize}px;
          background-color: ${subtitleStyle.backgroundColor};
          text-shadow: ${subtitleCueShadow};
        }`}
      </style>
      <div
        className={`relative z-0 flex min-w-0 flex-1 items-center justify-center overflow-hidden ${nativePlaybackActive ? 'bg-transparent' : 'bg-black'} ${!showControls && !showTopControls ? 'cursor-none' : ''}`}
        onPointerMove={handlePointerMove}
        onClick={handleSurfaceClick}
        onDoubleClickCapture={handleSurfaceDoubleClickCapture}
      >
        <div className="loom-player-drag-region" aria-hidden="true" />

        <TopPlayerControls
          visible={showTopControls && playerState !== 'error'}
          label={currentEpLabel ?? title}
          onBack={handleBack}
          onClose={handleClose}
        />

        <div
          ref={videoViewportRef}
          className={`loom-player-viewport relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-transparent ${videoFrameRatio ? 'max-h-full max-w-full' : 'h-full w-full'}`}
          style={videoFrameStyle}
        >
          {!nativePlaybackActive && (
            <video
              ref={videoRef}
              className="h-full w-full"
              style={videoStyle}
              preload="auto"
            >
              {visibleSubtitles.map((subtitle, index) => {
                const trackIndex = -1000 - index;
                return (
                  <track
                    key={`${subtitle.url}-${index}`}
                    kind="subtitles"
                    src={subtitleSource(subtitle.url, serverBase)}
                    srcLang={subtitle.lang || 'en'}
                    label={subtitle.label || subtitle.lang || `Subtitle ${index + 1}`}
                    default={subtitlesDefaultEnabled && selectedSubtitleTrackIndex === trackIndex}
                  />
                );
              })}
            </video>
          )}

          <SubtitleOverlay
            cues={subtitleCues}
            videoRef={videoRef}
            transcodeStartSecondsRef={transcodeStartSecondsRef}
            streamIsSeekableRef={streamIsSeekableRef}
            streamIsTranscoded={streamIsTranscoded}
            currentTimeRef={nativeEngineKind === 'libvlc' ? playbackPositionRef : undefined}
            style={subtitleStyle}
            visible={showSubtitleOverlay}
          />
        </div>

        <PauseOverlay
          visible={paused && playerState === 'ready'}
          title={title}
          logoSources={pauseLogoSources}
          hasEpisodes={hasEpisodes}
          currentSeason={currentSeason}
          currentEpisode={currentEpisode}
          episodeTitle={pauseEpisodeTitle}
          rating={pauseRating}
        />

        {playerState === 'loading' && (
          <div
            role="status"
            aria-atomic="true"
            aria-busy="true"
            aria-live="polite"
            className="absolute inset-0 z-20 bg-black/55 flex flex-col items-center justify-center gap-2 text-center"
          >
            <LoomLoader
              style={theme.loaderStyle}
              className="grid h-16 w-16 place-items-center rounded-full bg-white/10 text-white shadow-2xl ring-1 ring-white/15 backdrop-blur-md"
              markClassName={theme.loaderStyle === 'horizontal-logo' ? 'h-6 w-auto' : 'h-9 w-9'}
              color="currentColor"
            />
            <p className="text-sm text-white/80">{statusMessage || 'Loading...'}</p>
          </div>
        )}

        {playerState === 'error' && (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="loom-player-error-title"
            aria-describedby="loom-player-error-description"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                handleClose();
                return;
              }
              if (event.key !== 'Tab') return;
              const firstButton = errorRetryButtonRef.current;
              const lastButton = errorCloseButtonRef.current;
              if (event.shiftKey && document.activeElement === firstButton) {
                event.preventDefault();
                lastButton?.focus();
              } else if (!event.shiftKey && document.activeElement === lastButton) {
                event.preventDefault();
                firstButton?.focus();
              }
            }}
            className="absolute inset-0 z-20 bg-black/70 flex flex-col items-center justify-center gap-3 px-6 text-center"
          >
            <p id="loom-player-error-title" className="text-sm text-white/90">Playback failed</p>
            <p id="loom-player-error-description" className="text-xs text-white/70 max-w-xl">{errorMessage || 'Unable to play this file.'}</p>
            <div className="flex gap-3">
              <button
                ref={errorRetryButtonRef}
                type="button"
                onClick={handleRetry}
                className="px-3 py-1.5 rounded bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)] text-sm hover:bg-[var(--loom-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Retry
              </button>
              <button
                ref={errorCloseButtonRef}
                type="button"
                onClick={handleClose}
                className="px-3 py-1.5 rounded border border-white/30 text-white text-sm hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {(nextCountdown !== null || showNextEpisodePrompt) && nextEpisodeFile && (
          <NextEpisodePrompt
            nextCountdown={nextCountdown}
            nextEpisodeFile={nextEpisodeFile}
            nextEpLabel={nextEpLabel}
            autoplayNextEnabled={autoplayNextEnabled}
            playNextEpisodeNow={playNextEpisodeNow}
            clearNextEpisodeCountdown={clearNextEpisodeCountdown}
            onDismiss={() => setDismissedNextPromptKey(`${currentSeason}-${currentEpisode}`)}
          />
        )}

        {nextCountdown === null && shouldShowSkipPrompt(activeMediaSegment, showMarkerEditor) && activeMediaSegment && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              const markerDuration = activeMediaSegment.mediaDurationMs / 1000;
              const mediaDuration = Math.max(markerDuration, duration, playbackDurationRef.current);
              const markerEnd = activeMediaSegment.endMs === null
                ? mediaDuration
                : activeMediaSegment.endMs / 1000;
              const terminalSegment = activeMediaSegment.endMs === null
                || (mediaDuration > 0 && mediaDuration - markerEnd <= END_COMPLETION_TOLERANCE_SECONDS);

              if (terminalSegment && mediaDuration > 0) {
                // An end marker means "finish this episode". Move only
                // forward, mark it complete, and show Loom's existing Up Next
                // view for three seconds instead of abruptly changing files.
                pendingCreditsCompletionRef.current = false;
                seekTo(mediaDuration);
                markCurrentEpisodeComplete();
                if (nextEpisodeFile) scheduleNextEpisode();
                return;
              }

              // Never let a stale or overlapping marker turn a Skip action
              // into an accidental rewind.
              const targetSeconds = Math.max(playbackPositionRef.current, markerEnd);
              seekTo(targetSeconds);
            }}
            className="loom-player-skip-prompt absolute bottom-32 right-8 z-40 rounded-md border border-white/25 bg-black/75 px-5 py-2.5 text-sm font-semibold text-white shadow-xl backdrop-blur-md transition hover:bg-white hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
          >
            Skip {skipPromptLabel(activeMediaSegment.type, hasEpisodes)}
          </button>
        )}

        {showMarkerEditor && (
          <PlayerMarkerEditor
            editorSegment={editorSegment}
            error={markerError}
            markerEnd={markerEnd}
            markerStart={markerStart}
            markerType={markerType}
            saving={markerSaving}
            onClose={() => setShowMarkerEditor(false)}
            onMarkerEndChange={setMarkerEnd}
            onMarkerStartChange={setMarkerStart}
            onMarkerTypeChange={selectMarkerType}
            onPreview={() => seekTo(Number(markerEnd))}
            onReject={() => void rejectMarker()}
            onRestore={() => void restoreMarker()}
            canRestore={Boolean(restorableSegment)}
            onReset={() => void resetMarker()}
            onSave={() => void saveMarker()}
            onUndo={() => void undoMarker()}
            onUseCurrentAsEnd={() => setMarkerEnd(playbackPositionRef.current.toFixed(1))}
            onUseCurrentAsStart={() => setMarkerStart(playbackPositionRef.current.toFixed(1))}
          />
        )}

        {/* Controls overlay */}
        <PlayerControlBar
          showControls={showControls && playerState !== 'error'}
          seekSliderRef={seekSliderRef}
          progressFillRef={progressFillRef}
          progressThumbRef={progressThumbRef}
          scrubTimeHudRef={scrubTimeHudRef}
          currentTimeTextRef={currentTimeTextRef}
          durationTimeTextRef={durationTimeTextRef}
          playbackPositionRef={playbackPositionRef}
          duration={duration}
          position={position}
          showRemainingTime={showRemainingTime}
          progressPct={progressPct}
          paused={paused}
          muted={muted}
          volume={volume}
          skipBackSeconds={skipBackSeconds}
          skipForwardSeconds={skipForwardSeconds}
          hasEpisodes={hasEpisodes}
          showSidebar={showSidebar}
          showMediaPanel={showMediaPanel}
          mediaPanelTab={mediaPanelTab}
          fullscreen={fullscreen}
          handleProgressPointerDown={handleProgressPointerDown}
          handleProgressKeyDown={handleProgressKeyDown}
          togglePlay={togglePlay}
          toggleTimeDisplay={toggleTimeDisplay}
          seekTo={seekTo}
          toggleMute={toggleMute}
          handleVolume={handleVolume}
          handlePrevEpisode={handlePrevEpisode}
          handleNextEpisode={handleNextEpisode}
          openEpisodePanel={openEpisodePanel}
          openSubtitlesPanel={openSubtitlesPanel}
          openMediaPanel={openMediaPanel}
          toggleFullscreen={toggleFullscreen}
        />
      </div>

      {showMediaPanel && (
        <PlayerSettingsPanel
          mediaPanelWidth={mediaPanelWidth}
          setMediaPanelWidth={setMediaPanelWidth}
          startSidePanelResize={startSidePanelResize}
          onClose={() => setShowMediaPanel(false)}
          mediaPanelTab={mediaPanelTab}
          setMediaPanelTab={setMediaPanelTab}
          videoTracks={videoTracks}
          selectedVideoTrackIndex={selectedVideoTrackIndex}
          selectVideoTrack={selectVideoTrack}
          aspectMode={aspectMode}
          setAspectMode={setAspectMode}
          cropMode={cropMode}
          setCropMode={setCropMode}
          rotation={rotation}
          setRotation={setRotation}
          playbackRate={playbackRate}
          setPlaybackRate={setPlaybackRate}
          playbackInformation={playbackInformation}
          audioTracks={audioTracks}
          selectedAudioTrackIndex={selectedAudioTrackIndex}
          selectAudioTrack={selectAudioTrack}
          audioDelay={audioDelay}
          updateAudioDelay={updateAudioDelay}
          audioDelayAvailable={nativePlaybackActive}
          subtitlesDefaultEnabled={subtitlesDefaultEnabled}
          subtitleTracks={subtitleTracks}
          selectedSubtitleTrackIndex={selectedSubtitleTrackIndex}
          selectSubtitleTrack={selectSubtitleTrack}
          secondarySubtitlesAvailable={nativePlaybackActive && nativeEngineKind === 'mpv'}
          selectedSecondarySubtitleTrackIndex={selectedSecondarySubtitleTrackIndex}
          selectSecondarySubtitleTrack={selectSecondarySubtitleTrack}
          subtitleStyle={subtitleStyle}
          subtitleCueFontSize={subtitleCueFontSize}
          subtitleStyleCompatibilityMessage={subtitleStyleCompatibilityMessage}
          updateSubtitleStyle={updateSubtitleStyle}
          applySubtitleStyleToStream={applySubtitleStyleToStream}
          onCorrectSkipTiming={() => {
            setShowMediaPanel(false);
            openMarkerEditor();
          }}
        />
      )}

      {hasEpisodes && showSidebar && (
        <PlayerEpisodePanel
          episodePanelWidth={episodePanelWidth}
          setEpisodePanelWidth={setEpisodePanelWidth}
          startSidePanelResize={startSidePanelResize}
          title={title}
          onClose={() => setShowSidebar(false)}
          tick={tick}
          sortedSeasons={sortedSeasons}
          groupedEpisodes={groupedEpisodes}
          episodeFiles={episodeFiles}
          currentSeason={currentSeason}
          currentEpisode={currentEpisode}
          duration={duration}
          position={position}
          displayEpisodeTitle={displayEpisodeTitle}
          goToEpisode={goToEpisode}
        />
      )}
    </div>
  );
}
