/**
 * VideoPlayer — in-app HTML5 player with stream fallback.
 *
 * Uses the local media server stream for native playback and attempts a
 * one-time H.264/AAC transcode fallback when direct playback fails.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls, { ErrorTypes, Events, type ErrorData } from 'hls.js';
import { AnimatePresence, motion } from 'motion/react';
import {
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  ListOrdered,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Star,
  Subtitles,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import LoomLoader from '@/components/LoomLoader';
import { useTheme } from '@/components/ThemeProvider';
import { desktopApi } from '@/lib/desktopApi';
import { cleanEpisodeTitleForDisplay } from '@/lib/episodeTitles';
import {
  getPlayableStartPosition,
  hydrateProgressFromDatabase,
  isWatched,
  progressFraction,
  saveProgress as savePlaybackProgress,
} from '@/lib/progress';
import {
  CONTROLS_HIDE_MS,
  DEFAULT_EPISODE_PANEL_WIDTH,
  DEFAULT_MEDIA_PANEL_WIDTH,
  DEFAULT_SKIP_BACK_SECONDS,
  DEFAULT_SKIP_FORWARD_SECONDS,
  DEFAULT_SUBTITLE_STYLE,
  END_COMPLETION_TOLERANCE_SECONDS,
  HLS_RECOVERY_ATTEMPTS,
  HLS_TRANSCODE_RESTART_ATTEMPTS,
  NEXT_EPISODE_COUNTDOWN_SECONDS,
  NEXT_EPISODE_PROMPT_REMAINING_SECONDS,
  REPLAY_FROM_START_REMAINING_SECONDS,
  WATCHED_THRESHOLD,
  subtitleCueTiming,
} from './VideoPlayer/constants';
import type {
  AspectMode,
  ControlTab,
  EpisodeFile,
  EpisodeMeta,
  MediaTrack,
  PlayerState,
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
  isInProgress,
  loadAutoplayNextEpisode,
  loadSubtitlesDefaultEnabled,
  loadTrackPreferences,
  mediaErrorMessage,
  preferredTrackIndex,
  probeDurationSeconds,
  probeTracks,
  saveAutoplayNextEpisode,
  saveSubtitlesDefaultEnabled,
  saveTrackPreference,
  selectedEmbeddedSubtitle,
  shouldRestartMissingLocalHls,
  shouldStartWithTranscode,
  subtitleOrdinal,
  subtitleSource,
  trackLabel,
  trackPreferenceScope,
  transcodeErrorMessage,
} from './VideoPlayer/helpers';

const EMPTY_EPISODES: EpisodeMeta[] = [];
const EMPTY_EPISODE_FILES: EpisodeFile[] = [];
const EMPTY_SUBTITLES: NonNullable<VideoPlayerProps['subtitles']> = [];

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
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const transcodeSessionIdRef = useRef<string | null>(null);
  const loadTokenRef = useRef(0);
  const sourceLoadTokenRef = useRef(0);
  const playerActiveRef = useRef(true);
  const userPausedRef = useRef(false);
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
  const subtitleStyleRef = useRef<SubtitleStyleSettings>(DEFAULT_SUBTITLE_STYLE);
  const applyNativeTextTrackVisibilityRef = useRef<() => void>(() => undefined);
  const nextEpisodeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
  const [mediaPanelTab, setMediaPanelTab] = useState<ControlTab>('video');
  const [mediaTracks, setMediaTracks] = useState<MediaTrack[]>([]);
  const [serverBase, setServerBase] = useState('');
  const [selectedVideoTrackIndex, setSelectedVideoTrackIndex] = useState(-1);
  const [selectedAudioTrackIndex, setSelectedAudioTrackIndex] = useState(-1);
  const [selectedSubtitleTrackIndex, setSelectedSubtitleTrackIndex] = useState(-1);
  const [subtitlesDefaultEnabled, setSubtitlesDefaultEnabled] = useState(subtitlesDefaultEnabledRef.current);
  const [autoplayNextEnabled, setAutoplayNextEnabled] = useState(loadAutoplayNextEpisode);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyleSettings>(DEFAULT_SUBTITLE_STYLE);
  const [aspectMode, setAspectMode] = useState<AspectMode>('default');
  const [playbackRate, setPlaybackRate] = useState(1);
  const [skipBackSeconds, setSkipBackSeconds] = useState(DEFAULT_SKIP_BACK_SECONDS);
  const [skipForwardSeconds, setSkipForwardSeconds] = useState(DEFAULT_SKIP_FORWARD_SECONDS);
  const [dismissedNextPromptKey, setDismissedNextPromptKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // force episode list re-render
  const [playbackLogoCandidates, setPlaybackLogoCandidates] = useState<string[]>([]);
  const trackPreferenceScopeKey = useMemo(() => trackPreferenceScope(mediaId, filePath), [filePath, mediaId]);
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
    const tracks = Array.from(video.textTracks);
    const selectedIndex = selectedSubtitleTrackIndexRef.current;
    const selectedSubtitleOrdinal = selectedIndex <= -1000
      ? externalSubtitleOrdinal(externalSubtitleTracks, selectedIndex)
      : subtitleOrdinal(probeTracksRef.current, selectedIndex);

    tracks.forEach((track, index) => {
      const shouldShow = subtitlesDefaultEnabledRef.current
        && (selectedSubtitleOrdinal >= 0 ? index === selectedSubtitleOrdinal : index === 0);
      try {
        track.mode = shouldShow ? 'showing' : 'disabled';
      } catch (_error) {
        return;
      }

      let cues: TextTrackCue[] = [];
      try {
        cues = Array.from(track.cues || []);
      } catch (_error) {
        return;
      }
      cues.forEach((cue) => {
        try {
          const originalTiming = subtitleCueTiming.get(cue) || {
            startTime: cue.startTime,
            endTime: cue.endTime,
          };
          subtitleCueTiming.set(cue, originalTiming);
          const delayedStart = Math.max(0, originalTiming.startTime + subtitleStyle.delaySeconds);
          cue.startTime = delayedStart;
          cue.endTime = Math.max(delayedStart + 0.1, originalTiming.endTime + subtitleStyle.delaySeconds);

          if ('line' in cue) {
            (cue as VTTCue).line = Math.round(100 - subtitleStyle.position);
          }
        } catch (_error) {
          // Browser cue implementations can reject runtime mutations.
        }
      });
    });
  }, [externalSubtitleTracks, subtitleStyle.delaySeconds, subtitleStyle.position]);

  useEffect(() => {
    applyNativeTextTrackVisibilityRef.current = applyNativeTextTrackVisibility;
  }, [applyNativeTextTrackVisibility]);

  const applyProbeData = useCallback((data: unknown) => {
    const nextDuration = probeDurationSeconds(data);
    const nextTracks = [...probeTracks(data), ...externalSubtitleTracks];
    const preferences = loadTrackPreferences(trackPreferenceScopeKey);
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

    if (nextDuration > 0) setDuration(nextDuration);
    setMediaTracks(nextTracks);
    setSelectedVideoTrackIndex(firstVideo);
    setSelectedAudioTrackIndex(firstAudio);
    setSelectedSubtitleTrackIndex(firstSubtitle);
    setSubtitlesDefaultEnabled(subtitlesEnabled);
  }, [externalSubtitleTracks, trackPreferenceScopeKey]);

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
    setPosition(duration);
    void savePlaybackProgress(filePath, duration, duration);
    setTick((n) => n + 1);
  }, [duration, filePath]);

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
    setPosition(safeStartSeconds);
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
        if (probeResult.ok) applyProbeData(probeResult.data);
      }

      const subtitleIndex = selectedSubtitleTrackIndexRef.current;
      const embeddedSubtitle = selectedEmbeddedSubtitle(probeTracksRef.current, subtitleIndex);
      const transcodeResult = await desktopApi.media.startTranscode(filePath, {
        forceTranscode: true,
        startSeconds: safeStartSeconds,
        ...(typeof selectedVideoTrackIndexRef.current === 'number' ? { videoTrackIndex: selectedVideoTrackIndexRef.current } : {}),
        ...(typeof selectedAudioTrackIndexRef.current === 'number' ? { audioTrackIndex: selectedAudioTrackIndexRef.current } : {}),
        ...(embeddedSubtitle ? {
          subtitleTrackIndex: subtitleIndex,
          subtitleStreamOrdinal: embeddedSubtitle.ordinal,
          subtitleCodec: embeddedSubtitle.track.codec,
        } : {}),
        subtitleStyle: subtitleStyleRef.current,
      });
      if (!playerActiveRef.current || token !== loadTokenRef.current) return;
      if (!transcodeResult.ok || !transcodeResult.data?.playlistUrl) {
        throw new Error(transcodeResult.error || 'Unable to start local stream.');
      }

      transcodeSessionIdRef.current = transcodeResult.data.sessionId;
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
  }, [applyProbeData, clearHls, filePath, stopTranscodeSession]);

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
    const preferences = loadTrackPreferences(trackPreferenceScopeKey);
    const preferredExternalSubtitle = preferredTrackIndex(externalSubtitleTracks, 'subtitle', preferences.subtitle);
    const firstExternalSubtitle = preferredExternalSubtitle ?? (subtitlesDefaultEnabledRef.current ? firstSubtitleTrackIndex(externalSubtitleTracks) : -1);
    const externalSubtitlesEnabled = preferences.subtitle !== undefined ? firstExternalSubtitle >= 0 : subtitlesDefaultEnabledRef.current;
    subtitlesDefaultEnabledRef.current = externalSubtitlesEnabled;
    selectedSubtitleTrackIndexRef.current = firstExternalSubtitle;
    setSelectedSubtitleTrackIndex(firstExternalSubtitle);
    setSubtitlesDefaultEnabled(externalSubtitlesEnabled);
    setDuration(0);

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
  }, [applyProbeData, externalSubtitleTracks, filePath, trackPreferenceScopeKey]);

  // ─── Load media stream URL ────────────────────────────────────────────────
  useEffect(() => {
    const loadToken = ++loadTokenRef.current;
    playerActiveRef.current = true;
    userPausedRef.current = false;
    didTryTranscodeRef.current = false;
    transcodeStartSecondsRef.current = 0;
    hlsRecoveryAttemptsRef.current = 0;
    hlsTranscodeRestartAttemptsRef.current = 0;
    setStreamIsTranscoded(false);
    setPosition(0);
    setPlayerState('loading');
    setStatusMessage('Preparing stream...');
    setErrorMessage(null);
    setStreamUrl('');

    void stopTranscodeSession();

    (async () => {
      try {
        const startSeconds = getPlayableStartPosition(filePath, probedDurationRef.current);
        const html5DirectPlay = await desktopApi.media.canDirectPlay(filePath, 'html5').catch(() => null);
        if (!playerActiveRef.current || loadToken !== loadTokenRef.current) return;

        if (html5DirectPlay?.ok && html5DirectPlay.data === false) {
          await startTranscodedFallback(startSeconds, { force: true });
          return;
        }

        if (shouldStartWithTranscode(filePath)) {
          await startTranscodedFallback(startSeconds, { force: true });
          return;
        }

        const { url, isTranscoded } = await desktopApi.getStreamUrl(filePath);
        if (!playerActiveRef.current || loadToken !== loadTokenRef.current) return;
        setStreamIsTranscoded(Boolean(isTranscoded));
        setStreamUrl(url);
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
  }, [filePath, reloadToken, startTranscodedFallback, stopTranscodeSession]);

  // ─── Player binding, events, and fallback ────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    const sourceToken = ++sourceLoadTokenRef.current;
    const isHlsSource = /\.m3u8(\?|$)/i.test(streamUrl);
    let isManagedHls = false;
    const resumeSeconds = getPlayableStartPosition(filePath, probedDurationRef.current);

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
          startPosition: 0,
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
          hls.startLoad(0);
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

    const onPlay = () => setPaused(false);

    const onPause = () => setPaused(true);

    const onDuration = () => {
      const mediaDuration = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(probedDurationRef.current || mediaDuration);
    };

    const onTime = () => {
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const totalDuration = probedDurationRef.current || (Number.isFinite(video.duration) ? video.duration : 0);
      const absolutePosition = streamIsTranscoded
        ? transcodeStartSecondsRef.current + currentTime
        : currentTime;
      const nextPosition = clampSeconds(absolutePosition, totalDuration || undefined);
      setPosition(nextPosition);
      if (nextPosition > 10 && totalDuration > 0) {
        void savePlaybackProgress(filePath, nextPosition, totalDuration);
        setTick((n) => n + 1);
      }
    };

    const onVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    const onLoadedMetadata = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      const mediaDuration = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(probedDurationRef.current || mediaDuration);
      applyNativeTextTrackVisibilityRef.current();
      if (!streamIsTranscoded && resumeSeconds > 10 && mediaDuration) {
        video.currentTime = Math.min(resumeSeconds, Math.max(0, video.duration - 0.1));
      }
    };

    const onPlayable = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      hlsRecoveryAttemptsRef.current = 0;
      hasPlayableDataRef.current = true;
      setPlayerState('ready');
      setStatusMessage('');
      playIfAllowed();
    };

    const onPlaying = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      hlsRecoveryAttemptsRef.current = 0;
      hasPlayableDataRef.current = true;
      setPlayerState('ready');
      setStatusMessage('');
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
    const onFullscreenChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => () => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
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
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    shutdownPlayback();
    onClose();
  }, [onClose, shutdownPlayback]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      void el.requestFullscreen();
    } else {
      void document.exitFullscreen();
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

  const seekTo = useCallback((targetSeconds: number, options: { restartTranscoded?: boolean } = {}) => {
    const nextPosition = clampSeconds(targetSeconds, duration || undefined);
    setPosition(nextPosition);

    const video = videoRef.current;
    if (!video) return;

    if (streamIsTranscoded) {
      const streamPosition = nextPosition - transcodeStartSecondsRef.current;
      if (streamPosition >= 0 && !options.restartTranscoded) {
        const streamDuration = Number.isFinite(video.duration) ? video.duration : undefined;
        video.currentTime = clampSeconds(streamPosition, streamDuration);
        return;
      }
      hlsTranscodeRestartAttemptsRef.current = 0;
      void startTranscodedFallback(nextPosition, {
        force: true,
        allowNearEnd: true,
        showSeekingStatus: true,
        keepReadyDuringRestart: !options.restartTranscoded,
      });
      return;
    }

    const directDuration = Number.isFinite(video.duration) ? video.duration : duration;
    video.currentTime = clampSeconds(nextPosition, directDuration || undefined);
  }, [duration, startTranscodedFallback, streamIsTranscoded]);

  const handleProgressPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    if (event.button !== 0) return;
    event.preventDefault();
    const bar = event.currentTarget;
    bar.setPointerCapture(event.pointerId);
    const rect = bar.getBoundingClientRect();
    const seekFromClientX = (clientX: number, restart: boolean) => {
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      seekTo(ratio * duration, { restartTranscoded: restart });
    };
    seekFromClientX(event.clientX, false);
    const handleMove = (moveEvent: PointerEvent) => seekFromClientX(moveEvent.clientX, false);
    const handleUp = (upEvent: PointerEvent) => {
      seekFromClientX(upEvent.clientX, true);
      bar.releasePointerCapture(event.pointerId);
      bar.removeEventListener('pointermove', handleMove);
      bar.removeEventListener('pointerup', handleUp);
      bar.removeEventListener('pointercancel', handleUp);
    };
    bar.addEventListener('pointermove', handleMove);
    bar.addEventListener('pointerup', handleUp);
    bar.addEventListener('pointercancel', handleUp);
  }, [duration, seekTo]);

  const handleProgressKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    const big = event.shiftKey ? 60 : 10;
    const small = 5;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekTo(position - (event.shiftKey ? big : small), { restartTranscoded: true });
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekTo(position + (event.shiftKey ? big : small), { restartTranscoded: true });
    } else if (event.key === 'Home') {
      event.preventDefault();
      seekTo(0, { restartTranscoded: true });
    } else if (event.key === 'End') {
      event.preventDefault();
      seekTo(duration, { restartTranscoded: true });
    }
  }, [duration, position, seekTo]);

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

  const applySubtitleStyleToStream = useCallback(() => {
    applyNativeTextTrackVisibility();
    if (streamIsTranscoded && selectedSubtitleTrackIndexRef.current >= 0) {
      hlsTranscodeRestartAttemptsRef.current = 0;
      void startTranscodedFallback(position, {
        force: true,
        allowNearEnd: true,
        keepReadyDuringRestart: true,
        deferStopCurrent: true,
      });
    }
  }, [applyNativeTextTrackVisibility, position, startTranscodedFallback, streamIsTranscoded]);

  const updateSubtitleStyle = useCallback((key: keyof SubtitleStyleSettings, value: number | string) => {
    setSubtitleStyle((current) => ({
      ...current,
      [key]: value,
    }));
  }, []);

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
    selectedAudioTrackIndexRef.current = trackIndex;
    setSelectedAudioTrackIndex(trackIndex);
    restartForTrackChange();
  }, [restartForTrackChange, trackPreferenceScopeKey]);

  const selectSubtitleTrack = useCallback((trackIndex: number) => {
    const enabled = trackIndex >= 0 || trackIndex <= -1000;
    const selectedTrack = probeTracksRef.current.find((track) => track.index === trackIndex && track.type === 'subtitle');
    saveTrackPreference(trackPreferenceScopeKey, 'subtitle', selectedTrack, enabled);
    subtitlesDefaultEnabledRef.current = enabled;
    setSubtitlesDefaultEnabled(enabled);
    saveSubtitlesDefaultEnabled(enabled);
    selectedSubtitleTrackIndexRef.current = trackIndex;
    setSelectedSubtitleTrackIndex(trackIndex);
    if (trackIndex <= -1000) {
      applyNativeTextTrackVisibility();
      return;
    }
    restartForTrackChange();
  }, [applyNativeTextTrackVisibility, restartForTrackChange, trackPreferenceScopeKey]);

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
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      togglePlay();
      clickTimerRef.current = null;
    }, 220);
  }, [playerState, togglePlay]);

  const handleSurfaceDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (playerState !== 'error') toggleFullscreen();
  }, [playerState, toggleFullscreen]);

  // ─── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          handleBack();
          break;
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekTo(position - (e.shiftKey ? 60 : skipBackSeconds));
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekTo(position + (e.shiftKey ? 60 : skipForwardSeconds));
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
          e.preventDefault();
          toggleMute();
          break;
        case 'Backspace':
          e.preventDefault();
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          handleBack();
          break;
        case 'f':
        case 'F':
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
          seekTo(0, { restartTranscoded: true });
          break;
        case 'End':
          e.preventDefault();
          seekTo(duration, { restartTranscoded: true });
          break;
        default:
          if (/^[0-9]$/.test(e.key) && duration > 0) {
            e.preventDefault();
            seekTo((Number(e.key) / 10) * duration, { restartTranscoded: true });
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
    position,
    resetPlaybackRate,
    skipBackSeconds,
    skipForwardSeconds,
    seekTo,
    toggleMute,
    toggleFullscreen,
    togglePlay,
  ]);

  // ─── Derived ───────────────────────────────────────────────────────────────

  const progressPct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  const subtitleCueFontSize = Math.round(subtitleStyle.fontSize * subtitleStyle.scale);
  const subtitleCueShadow = subtitleStyle.borderWidth > 0
    ? `-${subtitleStyle.borderWidth}px -${subtitleStyle.borderWidth}px 0 ${subtitleStyle.borderColor}, ${subtitleStyle.borderWidth}px -${subtitleStyle.borderWidth}px 0 ${subtitleStyle.borderColor}, -${subtitleStyle.borderWidth}px ${subtitleStyle.borderWidth}px 0 ${subtitleStyle.borderColor}, ${subtitleStyle.borderWidth}px ${subtitleStyle.borderWidth}px 0 ${subtitleStyle.borderColor}`
    : 'none';

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
    && dismissedNextPromptKey !== `${currentSeason}-${currentEpisode}`
    && duration - position <= NEXT_EPISODE_PROMPT_REMAINING_SECONDS
    && position / duration >= WATCHED_THRESHOLD,
  );

  return (
    <div className="fixed inset-0 z-50 flex bg-black" ref={containerRef}>
      <style>
        {`video::cue {
          color: ${subtitleStyle.fontColor};
          font-size: ${subtitleCueFontSize}px;
          background-color: ${subtitleStyle.backgroundColor};
          text-shadow: ${subtitleCueShadow};
        }`}
      </style>
      <div
        className={`relative flex-1 flex items-center justify-center bg-black overflow-hidden ${!showControls && !showTopControls ? 'cursor-none' : ''}`}
        onMouseMove={handlePointerMove}
        onClick={handleSurfaceClick}
        onDoubleClick={handleSurfaceDoubleClick}
      >
        <button
          onClick={(event) => {
            event.stopPropagation();
            handleBack(event);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          className={`loom-player-top-control absolute left-6 z-40 flex h-10 items-center gap-2 rounded-lg border border-white/20 bg-black/55 px-3 text-sm text-white shadow-lg backdrop-blur-md transition-opacity duration-200 hover:bg-white/10 hover:text-[var(--loom-accent)] ${showTopControls ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          aria-label="Back"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>

        <div className={`loom-player-top-control pointer-events-none absolute left-1/2 z-40 max-w-[60%] -translate-x-1/2 rounded-full border border-white/10 bg-black/35 px-4 py-1.5 text-center text-xs font-medium text-white/80 shadow-lg backdrop-blur-md transition-opacity duration-200 ${showTopControls ? 'opacity-100' : 'opacity-0'}`}>
          <span className="block truncate">{currentEpLabel ?? title}</span>
        </div>

        <button
          onClick={(event) => {
            event.stopPropagation();
            handleClose();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          className={`loom-player-top-control absolute right-6 z-40 grid h-10 w-10 place-items-center rounded-lg border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md transition-opacity duration-200 hover:bg-white/10 hover:text-[var(--loom-accent)] ${showTopControls ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          title="Close player"
          aria-label="Close player"
        >
          <X className="h-4 w-4" />
        </button>

        <video
          ref={videoRef}
          className={`w-full h-full ${aspectMode === 'fill' ? 'object-cover' : 'object-contain'}`}
          style={aspectMode.includes('/') ? { aspectRatio: aspectMode } : undefined}
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

        <AnimatePresence>
          {paused && playerState === 'ready' && (
            <motion.div
              key="pause-overlay"
              className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            >
              <motion.div
                className="absolute inset-0 bg-black/65"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              />
              <motion.div
                className="absolute bottom-32 left-6 right-6 flex max-w-2xl flex-col items-start text-white sm:bottom-36"
                initial={{ opacity: 0, y: 18, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 12, scale: 0.995 }}
                transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
              >
                {pauseLogoSources.length > 0 ? (
                  <img
                    src={pauseLogoSources[0]}
                    alt={title}
                    className="mb-4 h-40 max-h-[28vh] w-[min(48rem,84vw)] object-contain object-left-bottom drop-shadow-[0_3px_18px_rgba(0,0,0,0.75)]"
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                ) : (
                  <h2 className="mb-2 max-w-[min(34rem,78vw)] text-4xl font-black uppercase leading-none tracking-normal drop-shadow-[0_3px_18px_rgba(0,0,0,0.75)] sm:text-5xl">
                    {title}
                  </h2>
                )}
                {hasEpisodes && (
                  <p className="text-[24px] font-semibold leading-tight text-white/85">
                    {epCode(currentSeason, currentEpisode)}
                  </p>
                )}
                {pauseEpisodeTitle && (
                  <p className="mt-2 max-w-3xl text-[32px] font-bold leading-tight text-white">{pauseEpisodeTitle}</p>
                )}
                {pauseRating > 0 && (
                  <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#f5c451]/15 px-3 py-1 text-sm font-bold text-[#f5c451] shadow-[0_4px_16px_rgba(0,0,0,0.35)]">
                    <Star className="h-4 w-4 fill-current" />
                    {pauseRating.toFixed(1)}
                  </span>
                )}
                {currentEpisodeMeta?.summary && (
                  <p className="mt-1 line-clamp-2 max-w-xl text-xs leading-relaxed text-white/75">
                    {currentEpisodeMeta.summary}
                  </p>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

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
          <div
            className="pointer-events-auto absolute inset-0 z-50 flex items-end justify-end p-6 pb-28"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <div className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-white/15 bg-black/75 text-white shadow-2xl backdrop-blur-xl">
              <div className="p-5">
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--loom-accent)]">Up next</p>
                    <p className="mt-1.5 truncate text-lg font-semibold leading-tight">
                      {nextEpLabel || epCode(nextEpisodeFile.season, nextEpisodeFile.episode)}
                    </p>
                    <p className="mt-2 text-sm text-white/65">
                      {nextCountdown !== null
                        ? 'Playing next in'
                        : autoplayNextEnabled ? 'Autoplay starts when this episode finishes.' : 'Ready when you are.'}
                    </p>
                  </div>
                  {nextCountdown !== null && (
                    <div className="relative shrink-0">
                      <svg viewBox="0 0 44 44" className="h-20 w-20 -rotate-90">
                        <circle cx="22" cy="22" r="20" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="3" />
                        <circle
                          cx="22"
                          cy="22"
                          r="20"
                          fill="none"
                          stroke="var(--loom-accent)"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeDasharray={2 * Math.PI * 20}
                          strokeDashoffset={2 * Math.PI * 20 * (1 - Math.min(1, Math.max(0, nextCountdown / NEXT_EPISODE_COUNTDOWN_SECONDS)))}
                          style={{ transition: 'stroke-dashoffset 1s linear' }}
                        />
                      </svg>
                      <div className="pointer-events-none absolute inset-0 grid place-items-center">
                        <span className="font-semibold text-white tabular-nums leading-none text-[28px]">
                          {nextCountdown}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="mt-5 flex gap-2.5">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      playNextEpisodeNow();
                    }}
                    className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-white text-sm font-semibold text-black shadow-sm transition-colors hover:bg-white/90"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    Play now
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      if (nextCountdown !== null) {
                        clearNextEpisodeCountdown();
                      } else {
                        setDismissedNextPromptKey(`${currentSeason}-${currentEpisode}`);
                      }
                    }}
                    className="flex h-11 items-center justify-center rounded-lg border border-white/20 bg-black/40 px-5 text-sm font-semibold text-white/80 backdrop-blur-md transition-colors hover:border-white/30 hover:bg-white/10 hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              </div>
              {nextCountdown !== null && (
                <div className="h-1 w-full bg-white/10">
                  <div
                    className="h-full bg-[var(--loom-accent)] transition-[width] duration-1000 ease-linear"
                    style={{
                      width: `${Math.min(100, Math.max(0, ((NEXT_EPISODE_COUNTDOWN_SECONDS - nextCountdown) / NEXT_EPISODE_COUNTDOWN_SECONDS) * 100))}%`,
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Controls overlay */}
        <div
          className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/55 to-transparent px-6 pb-6 pt-14 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {/* Progress bar */}
          <div
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={duration || 0}
            aria-valuenow={Math.min(position, duration || position)}
            aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
            aria-keyshortcuts="ArrowLeft ArrowRight Home End"
            onPointerDown={handleProgressPointerDown}
            onKeyDown={handleProgressKeyDown}
            className="group relative mb-3 h-6 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
          >
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/25 shadow-[0_1px_2px_rgba(0,0,0,0.6)] ring-1 ring-black/30 transition-[height] duration-150 group-hover:h-2.5 group-focus-visible:h-2.5">
              <div
                className="h-full rounded-full bg-[var(--loom-accent)] shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div
              className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-[0_2px_6px_rgba(0,0,0,0.55)] ring-2 ring-[var(--loom-accent)] transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
              style={{ left: `${progressPct}%` }}
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={togglePlay}
              className="grid h-14 w-14 shrink-0 place-items-center rounded-full text-white outline-none transition-colors hover:bg-white/10 hover:text-[var(--loom-accent)] focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              title={paused ? 'Play (Space)' : 'Pause (Space)'}
              aria-label={paused ? 'Play' : 'Pause'}
              aria-keyshortcuts="Space"
            >
              {paused ? <Play className="h-8 w-8 fill-current" /> : <Pause className="h-8 w-8 fill-current" />}
            </button>

            <button
              type="button"
              onClick={() => seekTo(position - skipBackSeconds)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              title={`Back ${skipBackSeconds}s`}
              aria-label={`Back ${skipBackSeconds} seconds`}
            >
              <RotateCcw className="h-5 w-5" strokeWidth={2.25} />
            </button>

            <button
              type="button"
              onClick={() => seekTo(position + skipForwardSeconds)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              title={`Forward ${skipForwardSeconds}s`}
              aria-label={`Forward ${skipForwardSeconds} seconds`}
            >
              <RotateCw className="h-5 w-5" strokeWidth={2.25} />
            </button>

            <div
              className="ml-1 select-none text-base font-medium tabular-nums text-white/90"
              aria-live="off"
            >
              <span className="text-white">{formatTime(position)}</span>
              <span className="mx-1.5 text-white/45">/</span>
              <span className="text-white/60">{formatTime(duration)}</span>
            </div>

            <div className="flex-1" />

            {hasEpisodes && (
              <div className="mr-1 flex items-center gap-1">
                <button
                  type="button"
                  onClick={handlePrevEpisode}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
                  title="Previous episode"
                  aria-label="Previous episode"
                >
                  <ChevronLeft className="h-5 w-5" strokeWidth={2.5} />
                </button>
                <button
                  type="button"
                  onClick={handleNextEpisode}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
                  title="Next episode"
                  aria-label="Next episode"
                >
                  <ChevronRight className="h-5 w-5" strokeWidth={2.5} />
                </button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleMute}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
                title={muted || volume === 0 ? 'Unmute (M)' : 'Mute (M)'}
                aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
                aria-pressed={muted || volume === 0}
              >
                {muted || volume === 0 ? <VolumeX className="h-5 w-5" strokeWidth={2.25} /> : <Volume2 className="h-5 w-5" strokeWidth={2.25} />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={handleVolume}
                aria-label="Volume"
                aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
                className="h-1.5 w-24 cursor-pointer rounded-full accent-[var(--loom-accent)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              />
            </div>

            <div className="mx-1 h-7 w-px bg-white/20" aria-hidden="true" />

            {hasEpisodes && (
              <button
                type="button"
                onClick={openEpisodePanel}
                className={`flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${showSidebar ? 'border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
                title="Episode list"
                aria-label="Episode list"
                aria-pressed={showSidebar}
                aria-expanded={showSidebar}
              >
                <ListOrdered className="h-5 w-5" strokeWidth={2.25} />
                <span className="text-sm font-medium">Episodes</span>
              </button>
            )}

            <button
              type="button"
              onClick={openSubtitlesPanel}
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${showMediaPanel && mediaPanelTab === 'subtitles' ? 'border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
              title="Subtitles"
              aria-label="Subtitles"
              aria-pressed={showMediaPanel && mediaPanelTab === 'subtitles'}
              aria-expanded={showMediaPanel && mediaPanelTab === 'subtitles'}
            >
              <Subtitles className="h-5 w-5" strokeWidth={2.25} />
            </button>

            <button
              type="button"
              onClick={openMediaPanel}
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${showMediaPanel && mediaPanelTab === 'video' ? 'border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
              title="Playback settings"
              aria-label="Playback settings"
              aria-pressed={showMediaPanel && mediaPanelTab === 'video'}
              aria-expanded={showMediaPanel && mediaPanelTab === 'video'}
            >
              <SlidersHorizontal className="h-5 w-5" strokeWidth={2.25} />
            </button>

            <button
              type="button"
              onClick={toggleFullscreen}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-pressed={fullscreen}
              aria-keyshortcuts="F"
            >
              {fullscreen ? <Minimize className="h-5 w-5" strokeWidth={2.25} /> : <Maximize className="h-5 w-5" strokeWidth={2.25} />}
            </button>
          </div>
        </div>
      </div>

      {showMediaPanel && (
        <aside
          className="player-side-panel relative flex h-full shrink-0 flex-col border-l border-white/10 bg-[#111] shadow-2xl"
          style={{ width: clampSidePanelWidth(mediaPanelWidth), maxWidth: '40vw' }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <div
            className="absolute left-0 top-0 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize items-center justify-center group"
            onMouseDown={(event) => startSidePanelResize(event, mediaPanelWidth, setMediaPanelWidth)}
            title="Drag to resize"
          >
            <span className="h-12 w-1 rounded-full bg-white/10 transition-colors group-hover:bg-[var(--loom-accent)]/70" />
          </div>

          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate">Playback Settings</p>
              <p className="text-[10px] uppercase tracking-widest text-[var(--loom-accent)]/75">Video, Audio, Subtitles</p>
            </div>
            <button
              onClick={() => setShowMediaPanel(false)}
              className="text-[var(--loom-muted)] hover:text-white ml-2 shrink-0"
              aria-label="Close playback settings"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 border-b border-white/10 text-xs font-bold uppercase tracking-wide text-white/55">
            {(['video', 'audio', 'subtitles'] as ControlTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setMediaPanelTab(tab)}
                className={`px-3 py-4 transition-colors ${mediaPanelTab === tab ? 'bg-white/5 text-white' : 'hover:bg-white/5 hover:text-white/80'}`}
              >
                {tab}
              </button>
            ))}
          </div>

          <ScrollArea className="flex-1">
            <div className="p-5 text-sm text-white/85">
              {mediaPanelTab === 'video' && (
                <div className="space-y-5">
                  {hasEpisodes && (
                    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg bg-white/10 px-3 py-2.5 text-xs transition-colors hover:bg-white/15">
                      <span>
                        <span className="block font-semibold text-white">Autoplay next episode</span>
                        <span className="mt-0.5 block text-white/50">Follow season order after a 3 second countdown.</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={autoplayNextEnabled}
                        onChange={toggleAutoplayNext}
                        className="h-4 w-4 shrink-0 accent-[var(--loom-accent)]"
                      />
                    </label>
                  )}

                  <div>
                    <p className="mb-2 text-xs font-semibold text-white">Video track</p>
                    <div className="overflow-hidden rounded-lg bg-white/10">
                      {videoTracks.length === 0 && <p className="px-3 py-2 text-white/50">No video tracks found</p>}
                      {videoTracks.map((track, index) => (
                        <button
                          key={track.index}
                          onClick={() => selectVideoTrack(track.index)}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedVideoTrackIndex === track.index ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                        >
                          <span className={`h-2.5 w-2.5 rounded-full ${selectedVideoTrackIndex === track.index ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                          <span className="truncate">{trackLabel(track, index)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-semibold text-white">Aspect ratio</p>
                    <div className="flex flex-wrap gap-1">
                      {(['default', 'contain', 'fill', '4 / 3', '16 / 9', '21 / 9'] as AspectMode[]).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => setAspectMode(mode)}
                          className={`rounded-md px-3 py-1.5 text-xs transition-colors ${aspectMode === mode ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'bg-white/10 text-white/75 hover:bg-white/15'}`}
                        >
                          {mode === 'fill' ? 'Crop' : mode}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between text-xs font-semibold text-white">
                      <span>Speed</span>
                      <span className="text-[var(--loom-accent)]">{playbackRate.toFixed(2)}x</span>
                    </div>
                    <input
                      type="range"
                      min={0.25}
                      max={4}
                      step={0.05}
                      value={playbackRate}
                      onChange={(event) => setPlaybackRate(Number(event.target.value))}
                      className="w-full accent-[var(--loom-accent)]"
                    />
                    <div className="mt-1 flex justify-between text-[10px] text-white/45">
                      <span>0.25x</span>
                      <span>1x</span>
                      <span>4x</span>
                    </div>
                  </div>
                </div>
              )}

              {mediaPanelTab === 'audio' && (
                <div className="space-y-5">
                  <div>
                    <p className="mb-2 text-xs font-semibold text-white">Audio track</p>
                    <div className="overflow-hidden rounded-lg bg-white/10">
                      <button
                        onClick={() => selectAudioTrack(-1)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedAudioTrackIndex === -1 ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                      >
                        <span className={`h-2.5 w-2.5 rounded-full ${selectedAudioTrackIndex === -1 ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                        <span>&lt;None&gt;</span>
                      </button>
                      {audioTracks.map((track, index) => (
                        <button
                          key={track.index}
                          onClick={() => selectAudioTrack(track.index)}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedAudioTrackIndex === track.index ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                        >
                          <span className={`h-2.5 w-2.5 rounded-full ${selectedAudioTrackIndex === track.index ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                          <span className="truncate">{trackLabel(track, index)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-semibold text-white">Audio delay</p>
                    <p className="rounded-lg bg-white/10 px-3 py-2 text-xs text-white/55">
                      Delay controls are not available for in-app playback yet; track switching is available here.
                    </p>
                  </div>
                </div>
              )}

              {mediaPanelTab === 'subtitles' && (
                <div className="space-y-5">
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold text-white">Subtitle</p>
                      <p className="text-[10px] uppercase tracking-wide text-white/45">
                        Default {subtitlesDefaultEnabled ? 'on' : 'off'}
                      </p>
                    </div>
                    <div className="overflow-hidden rounded-lg bg-white/10">
                      <button
                        onClick={() => selectSubtitleTrack(-1)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedSubtitleTrackIndex === -1 ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                      >
                        <span className={`h-2.5 w-2.5 rounded-full ${selectedSubtitleTrackIndex === -1 ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                        <span>Off</span>
                      </button>
                      {subtitleTracks.length === 0 && <p className="px-3 py-2 text-xs text-white/50">No subtitle tracks found</p>}
                      {subtitleTracks.map((track, index) => (
                        <button
                          key={track.index}
                          onClick={() => selectSubtitleTrack(track.index)}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedSubtitleTrackIndex === track.index ? 'bg-[var(--loom-accent)]/25 text-white' : 'hover:bg-white/10'}`}
                        >
                          <span className={`h-2.5 w-2.5 rounded-full ${selectedSubtitleTrackIndex === track.index ? 'bg-[var(--loom-accent)]' : 'bg-white/60'}`} />
                          <span className="truncate">{trackLabel(track, index)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-5 rounded-xl bg-white/[0.06] p-4">
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold text-white">Position</p>
                        <span className="text-xs text-[var(--loom-accent)]">{Math.round(subtitleStyle.position)}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={subtitleStyle.position}
                        onChange={(event) => updateSubtitleStyle('position', Number(event.target.value))}
                        className="w-full accent-[var(--loom-accent)]"
                      />
                    </div>

                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold text-white">Size</p>
                        <span className="text-xs text-[var(--loom-accent)]">{subtitleCueFontSize}px</span>
                      </div>
                      <input
                        type="range"
                        min={24}
                        max={96}
                        step={1}
                        value={subtitleStyle.fontSize}
                        onChange={(event) => updateSubtitleStyle('fontSize', Number(event.target.value))}
                        className="w-full accent-[var(--loom-accent)]"
                      />
                    </div>

                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold text-white">Outline</p>
                        <span className="text-xs text-[var(--loom-accent)]">{subtitleStyle.borderWidth}px</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={10}
                        step={1}
                        value={subtitleStyle.borderWidth}
                        onChange={(event) => updateSubtitleStyle('borderWidth', Number(event.target.value))}
                        className="w-full accent-[var(--loom-accent)]"
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      {([
                        ['fontColor', 'Text'],
                        ['borderColor', 'Outline'],
                        ['backgroundColor', 'Background'],
                      ] as Array<[keyof SubtitleStyleSettings, string]>).map(([key, label]) => (
                        <label key={key} className="space-y-2">
                          <span className="block text-xs font-semibold text-white">{label}</span>
                          <input
                            type="color"
                            value={String(subtitleStyle[key])}
                            onChange={(event) => updateSubtitleStyle(key, event.target.value)}
                            className="h-9 w-full cursor-pointer rounded-md border border-white/10 bg-white/10 p-1"
                          />
                        </label>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={applySubtitleStyleToStream}
                      className="w-full rounded-md bg-white/10 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/15"
                    >
                      Apply subtitle style
                    </button>
                  </div>

                </div>
              )}
            </div>
          </ScrollArea>
        </aside>
      )}

      {hasEpisodes && showSidebar && (
        <aside
          className="player-side-panel relative flex h-full shrink-0 flex-col bg-[#111] border-l border-white/10 shadow-2xl"
          style={{ width: clampSidePanelWidth(episodePanelWidth), maxWidth: '40vw' }}
        >
          <div
            className="absolute left-0 top-0 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize items-center justify-center group"
            onMouseDown={(event) => startSidePanelResize(event, episodePanelWidth, setEpisodePanelWidth)}
            title="Drag to resize"
          >
            <span className="h-12 w-1 rounded-full bg-white/10 transition-colors group-hover:bg-[var(--loom-accent)]/70" />
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <p className="text-sm font-semibold text-white truncate">{title}</p>
            <button
              onClick={() => setShowSidebar(false)}
              className="text-[var(--loom-muted)] hover:text-white ml-2 shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <ScrollArea className="flex-1">
            {tick >= 0 && sortedSeasons.map((season) => (
              <div key={season}>
                <p className="sticky top-0 z-10 bg-[#111] px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[var(--loom-accent)]">
                  Season {season}
                </p>
                {(groupedEpisodes[season] || []).map((ep) => {
                  const file = episodeFiles.find((item) => item.season === ep.season && item.episode === ep.number);
                  const isCurrent = ep.season === currentSeason && ep.number === currentEpisode;
                  const epPath = file?.filePath;
                  const epDur = isCurrent ? duration : file?.localMetadata?.durationSeconds;
                  const episodeTitle = displayEpisodeTitle(ep.season, ep.number, ep.title, epPath);
                  const watched = epPath ? isWatched(epPath, epDur) : false;
                  const inProgress = epPath ? isInProgress(epPath, epDur) : false;
                  const progFrac = isCurrent && duration > 0
                    ? position / duration
                    : epPath
                      ? progressFraction(epPath, epDur)
                      : 0;

                  return (
                    <button
                      key={`${ep.season}-${ep.number}`}
                      disabled={!file}
                      onClick={() => file && goToEpisode(ep.season, ep.number)}
                      className={`relative w-full flex items-center gap-2 px-4 py-2.5 text-left transition-colors
                        ${isCurrent ? 'bg-[var(--loom-accent)]/15' : 'hover:bg-white/5'}
                        ${!file ? 'cursor-not-allowed opacity-30' : ''}`}
                    >
                      {(inProgress || isCurrent) && progFrac > 0 && (
                        <span
                          className={`pointer-events-none absolute bottom-0 left-0 h-0.5 ${isCurrent ? 'bg-[var(--loom-accent)]' : 'bg-amber-400'}`}
                          style={{ width: `${Math.min(100, progFrac * 100)}%` }}
                        />
                      )}
                      <span className={`w-12 shrink-0 font-mono text-[10px] ${isCurrent ? 'text-[var(--loom-accent)]' : 'text-[var(--loom-muted)]'}`}>
                        {epCode(ep.season, ep.number)}
                      </span>
                      <span className={`min-w-0 flex-1 truncate text-xs leading-snug ${isCurrent ? 'font-medium text-[var(--loom-accent)]' : 'text-white'}`}>
                        {episodeTitle}
                      </span>
                      {watched && !isCurrent && <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />}
                      {inProgress && !isCurrent && <span className="shrink-0 text-[9px] text-amber-400">resume</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </ScrollArea>
        </aside>
      )}
    </div>
  );
}
