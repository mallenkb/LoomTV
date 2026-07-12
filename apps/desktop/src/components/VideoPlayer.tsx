/**
 * VideoPlayer — in-app HTML5 player with stream fallback.
 *
 * Uses the local media server stream for native playback and attempts a
 * one-time H.264/AAC transcode fallback when direct playback fails.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls, { ErrorTypes, Events, type ErrorData } from 'hls.js';
import LoomLoader from '@/components/LoomLoader';
import { useTheme } from '@/components/ThemeProvider';
import { desktopApi } from '@/lib/desktopApi';
import { cleanEpisodeTitleForDisplay } from '@/lib/episodeTitles';
import {
  getPlayableStartPosition,
  hydrateProgressFromDatabase,
  saveProgress as savePlaybackProgress,
} from '@/lib/progress';
import {
  CONTROLS_HIDE_MS,
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
  PlayerState,
  RotationMode,
  SubtitleStyleSettings,
  VideoPlayerProps,
} from './VideoPlayer/types';
export type { VideoPlayerProps } from './VideoPlayer/types';
import {
  cleanEpisodeTitle,
  clampSeconds,
  clampSidePanelWidth,
  epCode,
  externalSubtitleOrdinal,
  firstSubtitleTrackIndex,
  firstTrackIndex,
  formatTime,
  getStoredDuration,
  hlsErrorSummary,
  isBitmapSubtitleCodec,
  loadAutoplayNextEpisode,
  loadSharedTrackPreferences,
  loadSubtitlesDefaultEnabled,
  loadTrackPreferences,
  mediaErrorMessage,
  parseVttCues,
  preferredTrackIndex,
  probeDurationSeconds,
  probeTracks,
  saveAutoplayNextEpisode,
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
import PlayerSettingsPanel from './VideoPlayer/PlayerSettingsPanel';
import SubtitleOverlay from './VideoPlayer/SubtitleOverlay';
import TopPlayerControls from './VideoPlayer/TopPlayerControls';
import { loadSubtitleStyle, saveSubtitleStyle } from './VideoPlayer/subtitleStyleStorage';
import {
  clampSubtitleDelay,
  isEditableShortcutTarget,
  isTimeBuffered,
  isPlayerControlTarget,
  shouldRestartTranscodedSubtitleStyle,
  shouldShowSubtitleOverlay,
  shouldUseNativeSubtitleTracks,
  subtitleTrackPlaybackAction,
  transcodeSeekRestartOptions,
} from './VideoPlayer/playerControls';

const EMPTY_EPISODES: EpisodeMeta[] = [];
const EMPTY_EPISODE_FILES: EpisodeFile[] = [];
const EMPTY_SUBTITLES: NonNullable<VideoPlayerProps['subtitles']> = [];
const POSITION_UI_UPDATE_INTERVAL_MS = 1000;
const PROGRESS_SAVE_INTERVAL_MS = 2000;

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
  onClose,
  onEpisodeChange,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const seekSliderRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const progressThumbRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const durationTimeTextRef = useRef<HTMLSpanElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const transcodeSessionIdRef = useRef<string | null>(null);
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
  const subtitlesDefaultEnabledRef = useRef(loadSubtitlesDefaultEnabled());
  const subtitleStyleRef = useRef<SubtitleStyleSettings>(loadSubtitleStyle());
  const applyNativeTextTrackVisibilityRef = useRef<() => void>(() => undefined);
  const nextEpisodeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPositionUiUpdateRef = useRef(0);
  const lastProgressSaveRef = useRef(0);
  const playbackPositionRef = useRef(0);
  const playbackDurationRef = useRef(0);
  const isScrubbingRef = useRef(false);
  const scrubPreviewRafRef = useRef<number | null>(null);
  const transcodeSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTranscodeSeekRef = useRef<number | null>(null);
  const transcodeSeekActiveRef = useRef(false);
  const transcodeSeekGenerationRef = useRef(0);
  const transcodeSeekSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True when the active transcoded stream is a full-duration seekable VOD,
  // so seeking is a native currentTime change instead of an encoder restart.
  const streamIsSeekableRef = useRef(false);
  const subtitleStyleApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nativeSubtitleFallbackRef = useRef(false);
  const nativeSubtitleStyleRefreshRafRef = useRef<number | null>(null);

  const [streamUrl, setStreamUrl] = useState<string>('');
  const [streamIsTranscoded, setStreamIsTranscoded] = useState(false);
  const [playerState, setPlayerState] = useState<PlayerState>('loading');
  const [statusMessage, setStatusMessage] = useState('Preparing player...');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showTopControls, setShowTopControls] = useState(true);
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
  const [subtitlesDefaultEnabled, setSubtitlesDefaultEnabled] = useState(subtitlesDefaultEnabledRef.current);
  const [autoplayNextEnabled, setAutoplayNextEnabled] = useState(loadAutoplayNextEpisode);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyleSettings>(() => subtitleStyleRef.current);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [aspectMode, setAspectMode] = useState<AspectMode>('default');
  const [cropMode, setCropMode] = useState<CropMode>('none');
  const [rotation, setRotation] = useState<RotationMode>(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [skipBackSeconds, setSkipBackSeconds] = useState(DEFAULT_SKIP_BACK_SECONDS);
  const [skipForwardSeconds, setSkipForwardSeconds] = useState(DEFAULT_SKIP_FORWARD_SECONDS);
  const [dismissedNextPromptKey, setDismissedNextPromptKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // force episode list re-render
  const [playbackLogoCandidates, setPlaybackLogoCandidates] = useState<string[]>([]);

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
    if (currentTimeTextRef.current) {
      currentTimeTextRef.current.textContent = formatTime(safePosition);
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
  const [sharedTrackPreferences, setSharedTrackPreferences] = useState(() => loadTrackPreferences(trackPreferenceScopeKey));
  useEffect(() => {
    let cancelled = false;
    setSharedTrackPreferences(loadTrackPreferences(trackPreferenceScopeKey));
    void loadSharedTrackPreferences(trackPreferenceScopeKey).then((preferences) => {
      if (!cancelled) setSharedTrackPreferences(preferences);
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
  }, [filePath]);

  useEffect(() => {
    let cancelled = false;
    void desktopApi.getSettings()
      .then((settings) => {
        if (cancelled) return;
        setSkipBackSeconds(
          Number.isFinite(settings.playbackSkipBackSeconds) && (settings.playbackSkipBackSeconds || 0) > 0
            ? Number(settings.playbackSkipBackSeconds)
            : DEFAULT_SKIP_BACK_SECONDS,
        );
        setSkipForwardSeconds(
          Number.isFinite(settings.playbackSkipForwardSeconds) && (settings.playbackSkipForwardSeconds || 0) > 0
            ? Number(settings.playbackSkipForwardSeconds)
            : DEFAULT_SKIP_FORWARD_SECONDS,
        );
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
  const externalSubtitleTracks = useMemo<MediaTrack[]>(
    () => subtitles.map((subtitle, index) => ({
      index: -1000 - index,
      type: 'subtitle',
      codec: 'external',
      language: subtitle.lang,
      title: subtitle.label,
      default: false,
      forced: false,
    })),
    [subtitles],
  );
  const subtitleTracks = useMemo(() => mediaTracks.filter((track) => track.type === 'subtitle'), [mediaTracks]);

  const groupedEpisodes = useMemo(() =>
    episodes.reduce((acc, ep) => {
      if (!acc[ep.season]) acc[ep.season] = [];
      acc[ep.season].push(ep);
      return acc;
    }, {} as Record<number, EpisodeMeta[]>),
  [episodes]);

  const displayEpisodeTitle = useCallback((season: number, episode: number, rawTitle?: string, filePath?: string): string => {
    const metadataTitle = cleanEpisodeTitleForDisplay(rawTitle, title, season, episode);
    if (metadataTitle !== `Episode ${episode}`) return metadataTitle;
    if (!filePath) return metadataTitle;

    const fileTitle = cleanEpisodeTitle(filePath, season, episode);
    return fileTitle !== `Episode ${episode}` ? fileTitle : metadataTitle;
  }, [title]);

  const sortedSeasons = useMemo(
    () => Object.keys(groupedEpisodes).map(Number).sort((a, b) => a - b),
    [groupedEpisodes],
  );

  const playableEpisodeFiles = useMemo(
    () => episodeFiles
      .filter((item) => Boolean(item.filePath))
      .slice()
      .sort((a, b) => a.season - b.season || a.episode - b.episode),
    [episodeFiles],
  );

  const nextEpisodeFile = useMemo(() => {
    if (!hasEpisodes) return null;
    const currentIndex = playableEpisodeFiles.findIndex((item) =>
      item.season === currentSeason && item.episode === currentEpisode,
    );
    return currentIndex >= 0 ? playableEpisodeFiles[currentIndex + 1] || null : null;
  }, [currentEpisode, currentSeason, hasEpisodes, playableEpisodeFiles]);

  const stopTranscodeSession = useCallback(async () => {
    const sessionId = transcodeSessionIdRef.current;
    if (!sessionId) return;
    transcodeSessionIdRef.current = null;
    try {
      await desktopApi.media.stopTranscode(sessionId);
    } catch (_error) {
      // Non-fatal cleanup failure.
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
    const index = selectedSubtitleTrackIndex;
    const resolveSubtitleUrl = async (): Promise<string> => {
      if (index <= -1000) {
        const external = subtitles[-1000 - index];
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
        const response = await fetch(url);
        const text = response.ok ? await response.text() : '';
        if (!cancelled) setSubtitleCues(parseVttCues(text));
      } catch {
        if (!cancelled) setSubtitleCues([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath, mediaTracks, selectedSubtitleTrackIndex, serverBase, subtitles]);

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

  const applyProbeData = useCallback((data: unknown) => {
    const nextDuration = probeDurationSeconds(data);
    const nextTracks = [...probeTracks(data), ...externalSubtitleTracks];
    const preferences = sharedTrackPreferences;
    const hasSubtitlePreference = preferences.subtitle !== undefined;
    const firstVideo = firstTrackIndex(nextTracks, 'video');
    const preferredAudio = preferredTrackIndex(nextTracks, 'audio', preferences.audio);
    const preferredSubtitle = preferredTrackIndex(nextTracks, 'subtitle', preferences.subtitle);
    const firstAudio = preferredAudio ?? firstTrackIndex(nextTracks, 'audio');
    const firstSubtitle = preferredSubtitle ?? (subtitlesDefaultEnabledRef.current ? firstSubtitleTrackIndex(nextTracks) : -1);
    const subtitlesEnabled = hasSubtitlePreference ? firstSubtitle >= 0 : subtitlesDefaultEnabledRef.current;

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
  }, [externalSubtitleTracks, sharedTrackPreferences, updatePlaybackSnapshot]);

  // ─── Episode navigation ────────────────────────────────────────────────────

  const clearNextEpisodeCountdown = useCallback(() => {
    if (nextEpisodeTimerRef.current) {
      clearInterval(nextEpisodeTimerRef.current);
      nextEpisodeTimerRef.current = null;
    }
    setNextCountdown(null);
  }, []);

  const goToEpisode = useCallback((season: number, episode: number) => {
    const next = episodeFiles.find((item) => item.season === season && item.episode === episode);
    if (next && onEpisodeChange) {
      clearNextEpisodeCountdown();
      onEpisodeChange(next.filePath, season, episode);
    }
  }, [clearNextEpisodeCountdown, episodeFiles, onEpisodeChange]);

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
    if (duration <= 0) return;
    updatePlaybackSnapshot(duration, duration, { forceReact: true });
    void savePlaybackProgress(filePath, duration, duration);
    setTick((n) => n + 1);
  }, [duration, filePath, updatePlaybackSnapshot]);

  const playNextEpisodeNow = useCallback(() => {
    if (!nextEpisodeFile) return;
    if (duration > 0 && position / duration >= WATCHED_THRESHOLD) {
      markCurrentEpisodeComplete();
    }
    goToEpisode(nextEpisodeFile.season, nextEpisodeFile.episode);
  }, [duration, goToEpisode, markCurrentEpisodeComplete, nextEpisodeFile, position]);

  const scheduleNextEpisode = useCallback(() => {
    if (!nextEpisodeFile || !onEpisodeChange) return;
    clearNextEpisodeCountdown();
    let remainingSeconds = NEXT_EPISODE_COUNTDOWN_SECONDS;
    setNextCountdown(remainingSeconds);
    nextEpisodeTimerRef.current = setInterval(() => {
      remainingSeconds -= 1;
      if (remainingSeconds <= 0) {
        clearNextEpisodeCountdown();
        onEpisodeChange(nextEpisodeFile.filePath, nextEpisodeFile.season, nextEpisodeFile.episode);
        return;
      }
      setNextCountdown(remainingSeconds);
    }, 1000);
  }, [clearNextEpisodeCountdown, nextEpisodeFile, onEpisodeChange]);

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
    } = {},
  ) => {
    if (!playerActiveRef.current) return;
    if (didTryTranscodeRef.current && !options.force) return;
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
    transcodeStartSecondsRef.current = safeStartSeconds;
    updatePlaybackSnapshot(safeStartSeconds, durationHint || playbackDurationRef.current, { forceReact: true });
    const keepReady = Boolean(options.keepReadyDuringRestart && hasPlayableDataRef.current);
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

      transcodeSessionIdRef.current = transcodeResult.data.sessionId;
      // Seekable streams expose the whole timeline on an absolute VOD playlist,
      // so there is no per-window offset and seeking is native. The linear
      // fallback (unknown duration) keeps the window-relative offset.
      streamIsSeekableRef.current = Boolean(transcodeResult.data.seekable);
      transcodeStartSecondsRef.current = transcodeResult.data.seekable
        ? 0
        : (transcodeResult.data.startSeconds ?? safeStartSeconds);
      setStreamIsTranscoded(true);
      setStreamUrl(transcodeResult.data.playlistUrl);
      if (options.deferStopCurrent && previousSessionId && previousSessionId !== transcodeResult.data.sessionId) {
        void desktopApi.media.stopTranscode(previousSessionId);
      }
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

  const handleRetry = useCallback(() => {
    didTryTranscodeRef.current = false;
    hlsRecoveryAttemptsRef.current = 0;
    hlsTranscodeRestartAttemptsRef.current = 0;
    setStreamIsTranscoded(false);
    setPlayerState('loading');
    setStatusMessage('Retrying playback...');
    setErrorMessage(null);
    void stopTranscodeSession();
    setReloadToken((value) => value + 1);
  }, [stopTranscodeSession]);

  useEffect(() => {
    let cancelled = false;
    probedDurationRef.current = 0;
    probeTracksRef.current = externalSubtitleTracks;
    setMediaTracks(externalSubtitleTracks);
    const preferences = sharedTrackPreferences;
    const preferredExternalSubtitle = preferredTrackIndex(externalSubtitleTracks, 'subtitle', preferences.subtitle);
    const firstExternalSubtitle = preferredExternalSubtitle ?? (subtitlesDefaultEnabledRef.current ? firstSubtitleTrackIndex(externalSubtitleTracks) : -1);
    const externalSubtitlesEnabled = preferences.subtitle !== undefined ? firstExternalSubtitle >= 0 : subtitlesDefaultEnabledRef.current;
    subtitlesDefaultEnabledRef.current = externalSubtitlesEnabled;
    selectedSubtitleTrackIndexRef.current = firstExternalSubtitle;
    setSelectedSubtitleTrackIndex(firstExternalSubtitle);
    setSubtitlesDefaultEnabled(externalSubtitlesEnabled);
    updatePlaybackSnapshot(playbackPositionRef.current, 0, { forceReact: true });

    void desktopApi.media.probe(filePath).then((result) => {
      if (cancelled || !result.ok) return;
      applyProbeData(result.data);
    }).catch(() => {
      if (!cancelled) {
        probedDurationRef.current = 0;
        applyNativeTextTrackVisibilityRef.current();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [applyProbeData, externalSubtitleTracks, filePath, sharedTrackPreferences, updatePlaybackSnapshot]);

  // ─── Load media stream URL ────────────────────────────────────────────────
  useEffect(() => {
    const loadToken = ++loadTokenRef.current;
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
    streamIsSeekableRef.current = false;
    setStreamIsTranscoded(false);
    updatePlaybackSnapshot(0, 0, { forceReact: true });
    setPlayerState('loading');
    setStatusMessage('Preparing stream...');
    setErrorMessage(null);
    setStreamUrl('');

    void stopTranscodeSession();

    (async () => {
      try {
        const stream = await desktopApi.getStreamUrl(filePath);
        if (!playerActiveRef.current || loadToken !== loadTokenRef.current) return;
        if (stream.playbackMode === 'transcode') {
          await startTranscodedFallback(getPlayableStartPosition(filePath, probedDurationRef.current), {
            force: true,
            allowNearEnd: true,
          });
          return;
        }
        setStreamIsTranscoded(Boolean(stream.isTranscoded));
        setStreamUrl(stream.url);
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
      void stopTranscodeSession();
    };
  }, [filePath, reloadToken, startTranscodedFallback, stopTranscodeSession, updatePlaybackSnapshot]);

  // ─── Player binding, events, and fallback ────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    const sourceToken = ++sourceLoadTokenRef.current;
    const isHlsSource = /\.m3u8(\?|$)/i.test(streamUrl);
    let isManagedHls = false;
    const resumeSeconds = getPlayableStartPosition(filePath, probedDurationRef.current);
    // For a seekable VOD transcode, begin loading at the intended absolute
    // position (resume or the spot a track-change restart was issued from).
    const hlsStartPosition = streamIsSeekableRef.current ? Math.max(0, playbackPositionRef.current) : 0;

    clearHls();
    hlsRecoveryAttemptsRef.current = 0;
    hasPlayableDataRef.current = false;
    setPlayerState('loading');
    setStatusMessage(streamIsTranscoded ? 'Loading local stream...' : 'Loading stream...');
    setErrorMessage(null);
    setPaused(true);

    const playIfAllowed = () => {
      if (!playerActiveRef.current || userPausedRef.current) {
        setPaused(true);
        return;
      }
      void video.play().catch(() => setPaused(true));
    };

    if (isHlsSource) {
      if (Hls.isSupported()) {
        const hls = new Hls({
          autoStartLoad: false,
          startPosition: hlsStartPosition,
          maxBufferLength: 45,
          maxMaxBufferLength: 90,
          backBufferLength: 30,
          manifestLoadingMaxRetry: 20,
          manifestLoadingRetryDelay: 500,
          fragLoadingMaxRetry: 20,
          fragLoadingRetryDelay: 500,
        });
        isManagedHls = true;
        hlsRef.current = hls;
        const markHlsPlayable = () => {
          if (sourceToken !== sourceLoadTokenRef.current) return;
          hlsRecoveryAttemptsRef.current = 0;
          hasPlayableDataRef.current = true;
          transcodeSeekActiveRef.current = false;
          setPlayerState('ready');
          setStatusMessage('');
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
        hls.on(Events.ERROR, (_event: Events.ERROR, data: ErrorData) => {
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
      } else if (video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')) {
        video.src = streamUrl;
      } else {
        setPlayerState('error');
        setErrorMessage('HLS streams are not supported in this build.');
        return;
      }
    } else {
      video.src = streamUrl;
    }

    const onLoadStart = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      if (hasPlayableDataRef.current || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
      setPlayerState('loading');
      setStatusMessage(streamIsTranscoded ? 'Loading local stream...' : 'Buffering...');
      setErrorMessage(null);
    };

    const onWaiting = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
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
    };

    const onTime = () => {
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const totalDuration = probedDurationRef.current || (Number.isFinite(video.duration) ? video.duration : 0);
      const absolutePosition = streamIsTranscoded
        ? transcodeStartSecondsRef.current + currentTime
        : currentTime;
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
      if (!streamIsTranscoded && resumeSeconds > 10 && mediaDuration) {
        video.currentTime = Math.min(resumeSeconds, Math.max(0, video.duration - 0.1));
      }
    };

    const onPlayable = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      hlsRecoveryAttemptsRef.current = 0;
      hasPlayableDataRef.current = true;
      transcodeSeekActiveRef.current = false;
      setPlayerState('ready');
      setStatusMessage('');
      playIfAllowed();
    };

    const onPlaying = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      hlsRecoveryAttemptsRef.current = 0;
      hasPlayableDataRef.current = true;
      transcodeSeekActiveRef.current = false;
      setPlayerState('ready');
      setStatusMessage('');
      userPausedRef.current = false;
      setPaused(false);
    };

    const onEnded = () => {
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const totalDuration = probedDurationRef.current || (Number.isFinite(video.duration) ? video.duration : 0);
      const endedPosition = clampSeconds(
        streamIsTranscoded ? transcodeStartSecondsRef.current + currentTime : currentTime,
        totalDuration || undefined,
      );
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
    video.autoplay = !userPausedRef.current;
    if (!isManagedHls) {
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

  // ─── Auto-hide controls ────────────────────────────────────────────────────

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    setShowTopControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!videoRef.current?.paused) {
        setShowControls(false);
        setShowTopControls(false);
      }
    }, CONTROLS_HIDE_MS);
  }, []);

  const handlePointerMove = useCallback(() => {
    resetHideTimer();
  }, [resetHideTimer]);

  useEffect(() => {
    if (paused) {
      setShowControls(true);
      setShowTopControls(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      return;
    }
    resetHideTimer();
  }, [paused, resetHideTimer]);

  useEffect(() => () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }, []);

  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const onFullscreenChange = () => setFullscreen(Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, []);

  useEffect(() => () => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
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
    if (transcodeSeekTimerRef.current) {
      clearTimeout(transcodeSeekTimerRef.current);
      transcodeSeekTimerRef.current = null;
    }
    if (transcodeSeekSafetyRef.current) {
      clearTimeout(transcodeSeekSafetyRef.current);
      transcodeSeekSafetyRef.current = null;
    }
  }, []);

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
  }, [playerState]);

  const shutdownPlayback = useCallback(() => {
    playerActiveRef.current = false;
    userPausedRef.current = true;
    loadTokenRef.current += 1;
    sourceLoadTokenRef.current += 1;
    clearNextEpisodeCountdown();
    clearHls();
    const video = videoRef.current;
    if (video) {
      video.autoplay = false;
      video.pause();
    }
    void stopTranscodeSession();
  }, [clearHls, clearNextEpisodeCountdown, stopTranscodeSession]);

  const handleClose = useCallback((event?: React.SyntheticEvent) => {
    event?.preventDefault();
    shutdownPlayback();
    onClose();
  }, [onClose, shutdownPlayback]);

  const handleBack = useCallback((event?: React.SyntheticEvent) => {
    event?.preventDefault();
    shutdownPlayback();
    onClose();
  }, [onClose, shutdownPlayback]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void })
      | null;
    if (!el) return;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const fullscreenElement = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (!fullscreenElement) {
      const requestFullscreen = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
      if (requestFullscreen) void requestFullscreen();
    } else {
      const exitFullscreen = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
      if (exitFullscreen) void exitFullscreen();
    }
  }, []);

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

  const startSidePanelResize = useCallback((
    event: React.MouseEvent<HTMLDivElement>,
    currentWidth: number,
    setWidth: React.Dispatch<React.SetStateAction<number>>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = currentWidth;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      setWidth(clampSidePanelWidth(startWidth + startX - moveEvent.clientX));
    };

    const onMouseUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.playbackRate = playbackRate;
    }
  }, [playbackRate, streamUrl]);

  useEffect(() => {
    applyNativeTextTrackVisibility();
  }, [applyNativeTextTrackVisibility, subtitleStyle]);

  const seekTo = useCallback((targetSeconds: number, options: { restartTranscoded?: boolean; updateSnapshot?: boolean } = {}) => {
    const nextPosition = clampSeconds(targetSeconds, duration || undefined);
    if (options.updateSnapshot !== false) {
      updatePlaybackSnapshot(nextPosition, duration || playbackDurationRef.current, { forceReact: true });
    }

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
      const streamPosition = nextPosition - transcodeStartSecondsRef.current;
      const streamDuration = directDuration || undefined;
      const canSeekInCurrentStream = streamPosition >= 0
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

    video.currentTime = clampSeconds(nextPosition, directDuration || undefined);
    if (shouldResumeAfterSeek) {
      void video.play().catch(() => setPaused(true));
    }
  }, [duration, startTranscodedFallback, streamIsTranscoded, updatePlaybackSnapshot]);

  const handleProgressPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    if (event.button !== 0) return;
    event.preventDefault();
    const bar = event.currentTarget;
    bar.setPointerCapture(event.pointerId);
    setDismissedNextPromptKey(null);
    clearNextEpisodeCountdown();
    const rect = bar.getBoundingClientRect();
    let pendingPosition = playbackPositionRef.current;
    isScrubbingRef.current = true;
    const previewFromClientX = (clientX: number) => {
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      pendingPosition = ratio * duration;
      if (scrubPreviewRafRef.current !== null) return;
      scrubPreviewRafRef.current = requestAnimationFrame(() => {
        scrubPreviewRafRef.current = null;
        updatePlaybackSnapshot(pendingPosition, duration, { forceReact: false });
      });
    };
    previewFromClientX(event.clientX);
    const handleMove = (moveEvent: PointerEvent) => previewFromClientX(moveEvent.clientX);
    const handleUp = (upEvent: PointerEvent) => {
      previewFromClientX(upEvent.clientX);
      if (scrubPreviewRafRef.current !== null) {
        cancelAnimationFrame(scrubPreviewRafRef.current);
        scrubPreviewRafRef.current = null;
      }
      updatePlaybackSnapshot(pendingPosition, duration, { forceReact: true });
      seekTo(pendingPosition);
      isScrubbingRef.current = false;
      bar.releasePointerCapture(upEvent.pointerId);
      bar.removeEventListener('pointermove', handleMove);
      bar.removeEventListener('pointerup', handleUp);
      bar.removeEventListener('pointercancel', handleUp);
    };
    bar.addEventListener('pointermove', handleMove);
    bar.addEventListener('pointerup', handleUp);
    bar.addEventListener('pointercancel', handleUp);
  }, [duration, seekTo, updatePlaybackSnapshot]);

  const handleProgressKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    const big = event.shiftKey ? 60 : 10;
    const small = 5;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekTo(playbackPositionRef.current - (event.shiftKey ? big : small));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekTo(playbackPositionRef.current + (event.shiftKey ? big : small));
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
    const video = videoRef.current;
    if (!video) return;
    video.volume = v;
    video.muted = v === 0;
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }, []);

  const restartForTrackChange = useCallback(() => {
    if (!streamUrl) return;
    applyNativeTextTrackVisibility();
    didTryTranscodeRef.current = false;
    hlsTranscodeRestartAttemptsRef.current = 0;
    void startTranscodedFallback(position, { force: true, allowNearEnd: true });
  }, [applyNativeTextTrackVisibility, position, startTranscodedFallback, streamUrl]);

  const reloadSourceForDirectPlayback = useCallback(() => {
    if (!streamUrl) return;
    applyNativeTextTrackVisibility();
    didTryTranscodeRef.current = false;
    hlsTranscodeRestartAttemptsRef.current = 0;
    const currentPosition = playbackPositionRef.current || position;
    const currentDuration = probedDurationRef.current || playbackDurationRef.current || duration;
    if (currentPosition > 0 && currentDuration > 0) {
      void savePlaybackProgress(filePath, currentPosition, currentDuration);
    }
    setStreamIsTranscoded(false);
    setPlayerState('loading');
    setStatusMessage('Loading stream...');
    setErrorMessage(null);
    setReloadToken((value) => value + 1);
  }, [applyNativeTextTrackVisibility, duration, filePath, position, streamUrl]);

  const selectedSubtitleIsBurnedIn = useCallback(() => {
    const selected = selectedEmbeddedSubtitle(probeTracksRef.current, selectedSubtitleTrackIndexRef.current);
    return streamIsTranscoded && Boolean(selected && isBitmapSubtitleCodec(selected.track.codec));
  }, [streamIsTranscoded]);

  const applySubtitleStyleToStream = useCallback(() => {
    if (subtitleStyleApplyTimerRef.current) {
      clearTimeout(subtitleStyleApplyTimerRef.current);
      subtitleStyleApplyTimerRef.current = null;
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

  const toggleAutoplayNext = useCallback(() => {
    setAutoplayNextEnabled((current) => {
      const next = !current;
      saveAutoplayNextEpisode(next);
      if (!next) clearNextEpisodeCountdown();
      return next;
    });
  }, [clearNextEpisodeCountdown]);

  const selectVideoTrack = useCallback((trackIndex: number) => {
    selectedVideoTrackIndexRef.current = trackIndex;
    setSelectedVideoTrackIndex(trackIndex);
    restartForTrackChange();
  }, [restartForTrackChange]);

  const selectAudioTrack = useCallback((trackIndex: number) => {
    const selectedTrack = probeTracksRef.current.find((track) => track.index === trackIndex && track.type === 'audio');
    saveTrackPreference(trackPreferenceScopeKey, 'audio', selectedTrack, trackIndex >= 0);
    setSharedTrackPreferences(loadTrackPreferences(trackPreferenceScopeKey));
    selectedAudioTrackIndexRef.current = trackIndex;
    setSelectedAudioTrackIndex(trackIndex);
    restartForTrackChange();
  }, [restartForTrackChange, trackPreferenceScopeKey]);

  const selectSubtitleTrack = useCallback((trackIndex: number) => {
    const enabled = trackIndex >= 0 || trackIndex <= -1000;
    const selectedTrack = probeTracksRef.current.find((track) => track.index === trackIndex && track.type === 'subtitle');
    const playbackAction = subtitleTrackPlaybackAction({
      selectedTrackIndex: trackIndex,
      selectedSubtitleIsBitmap: Boolean(selectedTrack && isBitmapSubtitleCodec(selectedTrack.codec)),
      activeSubtitleIsBurnedIn: selectedSubtitleIsBurnedIn(),
    });
    saveTrackPreference(trackPreferenceScopeKey, 'subtitle', selectedTrack, enabled);
    setSharedTrackPreferences(loadTrackPreferences(trackPreferenceScopeKey));
    subtitlesDefaultEnabledRef.current = enabled;
    setSubtitlesDefaultEnabled(enabled);
    saveSubtitlesDefaultEnabled(enabled);
    selectedSubtitleTrackIndexRef.current = trackIndex;
    setSelectedSubtitleTrackIndex(trackIndex);
    if (playbackAction === 'burn-in') {
      restartForTrackChange();
      return;
    }
    if (playbackAction === 'reload-source') {
      reloadSourceForDirectPlayback();
      return;
    }
    if (trackIndex <= -1000 || trackIndex < 0 || selectedTrack) {
      applyNativeTextTrackVisibility();
      return;
    }
    applyNativeTextTrackVisibility();
  }, [
    applyNativeTextTrackVisibility,
    reloadSourceForDirectPlayback,
    restartForTrackChange,
    selectedSubtitleIsBurnedIn,
    trackPreferenceScopeKey,
  ]);

  const changeVolume = useCallback((delta: number) => {
    const currentVolume = videoRef.current?.volume ?? volume;
    const nextVolume = Math.min(1, Math.max(0, currentVolume + delta));
    setVolume(nextVolume);
    setMuted(nextVolume === 0);

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

  const handleSurfaceClick = useCallback(() => {
    if (playerState === 'error') return;
    if (showMediaPanel || showSidebar) {
      setShowMediaPanel(false);
      setShowSidebar(false);
      return;
    }
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      togglePlay();
      clickTimerRef.current = null;
    }, 220);
  }, [playerState, showMediaPanel, showSidebar, togglePlay]);

  const handleSurfaceDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (playerState !== 'error') toggleFullscreen();
  }, [playerState, toggleFullscreen]);

  const handleSurfaceDoubleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isPlayerControlTarget(event.target)) return;
    handleSurfaceDoubleClick(event);
  }, [handleSurfaceDoubleClick]);

  // ─── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableShortcutTarget(e.target)) return;
      const hasCommandModifier = e.metaKey || e.ctrlKey || e.altKey;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          handleBack();
          break;
        case ' ':
        case 'Spacebar':
          if (hasCommandModifier) break;
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekTo(playbackPositionRef.current - (e.shiftKey ? 60 : skipBackSeconds));
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekTo(playbackPositionRef.current + (e.shiftKey ? 60 : skipForwardSeconds));
          break;
        case 'ArrowUp':
          e.preventDefault();
          changeVolume(0.05);
          break;
        case 'ArrowDown':
          e.preventDefault();
          changeVolume(-0.05);
          break;
        case 'm':
        case 'M':
          if (hasCommandModifier) break;
          e.preventDefault();
          toggleMute();
          break;
        case 'Backspace':
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          e.preventDefault();
          handleBack();
          break;
        case 'f':
        case 'F':
          if (hasCommandModifier) break;
          e.preventDefault();
          toggleFullscreen();
          break;
        case '[':
          e.preventDefault();
          changePlaybackRate(-0.25);
          break;
        case ']':
          e.preventDefault();
          changePlaybackRate(0.25);
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          resetPlaybackRate();
          break;
        case 'Home':
          e.preventDefault();
          seekTo(0);
          break;
        case 'End':
          e.preventDefault();
          seekTo(duration);
          break;
        case 'z':
        case 'Z':
          e.preventDefault();
          adjustSubtitleDelay(-(e.shiftKey ? SUBTITLE_DELAY_FINE_STEP_SECONDS : SUBTITLE_DELAY_STEP_SECONDS));
          break;
        case 'x':
        case 'X':
          e.preventDefault();
          adjustSubtitleDelay(e.shiftKey ? SUBTITLE_DELAY_FINE_STEP_SECONDS : SUBTITLE_DELAY_STEP_SECONDS);
          break;
        case 'c':
        case 'C':
          e.preventDefault();
          resetSubtitleDelay();
          break;
        default:
          if (/^[0-9]$/.test(e.key) && duration > 0) {
            e.preventDefault();
            seekTo((Number(e.key) / 10) * duration);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    changePlaybackRate,
    changeVolume,
    duration,
    handleBack,
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

  const progressPct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  const selectedSubtitleForOverlay = selectedSubtitleTrackIndex >= 0
    ? selectedEmbeddedSubtitle(mediaTracks, selectedSubtitleTrackIndex)
    : null;
  const subtitleIsBurnedIn = streamIsTranscoded
    && Boolean(selectedSubtitleForOverlay && isBitmapSubtitleCodec(selectedSubtitleForOverlay.track.codec));
  const showSubtitleOverlay = shouldShowSubtitleOverlay({
    subtitlesEnabled: subtitlesDefaultEnabled,
    selectedSubtitleTrackIndex,
    cueCount: subtitleCues.length,
    subtitleIsBurnedIn,
  });
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
    ...(fullscreen ? { objectPosition: 'center 24px' } : {}),
  };

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

  return (
    <div className="loom-player-root fixed inset-0 z-50 flex bg-black" ref={containerRef}>
      <style>
        {`video::cue {
          color: ${subtitleStyle.fontColor};
          font-size: ${subtitleCueFontSize}px;
          background-color: ${subtitleStyle.backgroundColor};
          text-shadow: ${subtitleCueShadow};
        }`}
      </style>
      <div
        className={`relative z-0 flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black ${!showControls && !showTopControls ? 'cursor-none' : ''}`}
        onMouseMove={handlePointerMove}
        onClick={handleSurfaceClick}
        onDoubleClickCapture={handleSurfaceDoubleClickCapture}
      >
        <div className="loom-player-drag-region" aria-hidden="true" />

        <TopPlayerControls
          visible={showTopControls}
          label={currentEpLabel ?? title}
          onBack={handleBack}
          onClose={handleClose}
        />

        <div
          className={`relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden ${videoFrameRatio ? 'max-h-full max-w-full' : 'h-full w-full'}`}
          style={videoFrameStyle}
        >
          <video
            ref={videoRef}
            className="h-full w-full"
            style={videoStyle}
            preload="auto"
          >
            {subtitles.map((subtitle, index) => {
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

          <SubtitleOverlay
            cues={subtitleCues}
            videoRef={videoRef}
            transcodeStartSecondsRef={transcodeStartSecondsRef}
            streamIsTranscoded={streamIsTranscoded}
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
          <div className="absolute inset-0 z-20 bg-black/55 flex flex-col items-center justify-center gap-2 text-center">
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
          <div className="absolute inset-0 z-20 bg-black/70 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-white/90">Playback failed</p>
            <p className="text-xs text-white/70 max-w-xl">{errorMessage || 'Unable to play this file.'}</p>
            <div className="flex gap-3">
              <button
                onClick={handleRetry}
                className="px-3 py-1.5 rounded bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)] text-sm hover:bg-[var(--loom-accent-hover)]"
              >
                Retry
              </button>
              <button
                onClick={handleClose}
                className="px-3 py-1.5 rounded border border-white/30 text-white text-sm hover:bg-white/10"
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

        {/* Controls overlay */}
        <PlayerControlBar
          showControls={showControls}
          seekSliderRef={seekSliderRef}
          progressFillRef={progressFillRef}
          progressThumbRef={progressThumbRef}
          currentTimeTextRef={currentTimeTextRef}
          durationTimeTextRef={durationTimeTextRef}
          playbackPositionRef={playbackPositionRef}
          duration={duration}
          position={position}
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
          hasEpisodes={hasEpisodes}
          autoplayNextEnabled={autoplayNextEnabled}
          toggleAutoplayNext={toggleAutoplayNext}
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
          audioTracks={audioTracks}
          selectedAudioTrackIndex={selectedAudioTrackIndex}
          selectAudioTrack={selectAudioTrack}
          subtitlesDefaultEnabled={subtitlesDefaultEnabled}
          subtitleTracks={subtitleTracks}
          selectedSubtitleTrackIndex={selectedSubtitleTrackIndex}
          selectSubtitleTrack={selectSubtitleTrack}
          subtitleStyle={subtitleStyle}
          subtitleCueFontSize={subtitleCueFontSize}
          updateSubtitleStyle={updateSubtitleStyle}
          applySubtitleStyleToStream={applySubtitleStyleToStream}
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
