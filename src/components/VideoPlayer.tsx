/**
 * VideoPlayer — in-app HTML5 player with stream fallback.
 *
 * Uses the local media server stream for native playback and attempts a
 * one-time H.264/AAC transcode fallback when direct playback fails.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Events, Hls, isSupported } from 'hls.js';
import {
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import { desktopApi } from '@/lib/desktopApi';

// ─── Constants ────────────────────────────────────────────────────────────────

const PROGRESS_KEY = 'videoProgress';
const SUBTITLES_DEFAULT_KEY = 'subtitlesDefaultEnabled';
const WATCHED_THRESHOLD = 0.9;
const CONTROLS_HIDE_MS = 3000;
const HLS_FIRST_EXTENSIONS = new Set(['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', '3gp', 'ts']);
const DEFAULT_EPISODE_PANEL_WIDTH = 288;
const DEFAULT_MEDIA_PANEL_WIDTH = 360;
const MIN_SIDE_PANEL_WIDTH = 260;
const MAX_SIDE_PANEL_RATIO = 0.4;
type PlayerState = 'loading' | 'ready' | 'error';
type ControlTab = 'video' | 'audio' | 'subtitles';
type AspectMode = 'default' | 'contain' | 'fill' | '4 / 3' | '16 / 9' | '21 / 9';

interface MediaTrack {
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
}

type ProbeData = { durationSeconds?: number; tracks?: MediaTrack[] };

// ─── Types ────────────────────────────────────────────────────────────────────

interface EpisodeMeta {
  season: number;
  number: number;
  title: string;
  summary: string;
  still: string;
  rating: number;
  airDate: string;
}

interface EpisodeFile {
  season: number;
  episode: number;
  filePath: string;
  localMetadata?: {
    durationSeconds?: number;
  };
}

export interface VideoPlayerProps {
  filePath: string;
  title: string;
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
  currentSeason?: number;
  currentEpisode?: number;
  onClose: () => void;
  onEpisodeChange?: (filePath: string, season: number, episode: number) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanEpisodeTitle(raw: string, season: number, episode: number): string {
  if (!raw) return `Episode ${episode}`;
  let s = raw;
  s = s.replace(new RegExp(`^.*?[Ss]0*${season}\\s*[Ee]0*${episode}\\s*[-–_.\\s]*`, ''), '');
  s = s.replace(
    /[\s._-]*(?:\[|\()?(?:2160p|1080p|720p|480p|4K|BluRay|BDRip|WEB-DL|WEBRip|HDTV|AMZN|NF|DSNP|x264|x265|H\.264|H\.265|HEVC|AAC|AC3|DTS|SAMPA)\b.*$/i,
    '',
  );
  s = s.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || `Episode ${episode}`;
}

function epCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function shouldStartWithTranscode(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return HLS_FIRST_EXTENSIONS.has(ext);
}

function probeDurationSeconds(value: unknown): number {
  const duration = (value as ProbeData | undefined)?.durationSeconds;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function probeTracks(value: unknown): MediaTrack[] {
  const tracks = (value as ProbeData | undefined)?.tracks;
  return Array.isArray(tracks) ? tracks : [];
}

function clampSeconds(value: number, max?: number): number {
  const safeValue = Number.isFinite(value) ? value : 0;
  const safeMax = typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : undefined;
  return Math.max(0, safeMax ? Math.min(safeValue, safeMax) : safeValue);
}

function maxSidePanelWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_MEDIA_PANEL_WIDTH;
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.floor(window.innerWidth * MAX_SIDE_PANEL_RATIO));
}

function clampSidePanelWidth(value: number): number {
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.min(value, maxSidePanelWidth()));
}

function trackLabel(track: MediaTrack, ordinal: number): string {
  const language = track.language ? `[${track.language}] ` : '';
  const title = track.title ? `${track.title} ` : '';
  const details = track.type === 'video'
    ? [track.codec, track.width && track.height ? `${track.width}x${track.height}` : undefined, track.pixelFormat].filter(Boolean).join(', ')
    : track.type === 'audio'
      ? [track.codec, track.channels ? `${track.channels}ch` : undefined].filter(Boolean).join(', ')
      : track.codec || 'subtitle';
  return `#${ordinal + 1} ${language}${title}${details}`.trim();
}

function subtitleOrdinal(tracks: MediaTrack[], streamIndex: number): number {
  return tracks.filter((track) => track.type === 'subtitle').findIndex((track) => track.index === streamIndex);
}

function firstTrackIndex(tracks: MediaTrack[], type: MediaTrack['type']): number {
  return tracks.find((track) => track.type === type)?.index ?? -1;
}

// ─── Progress storage ─────────────────────────────────────────────────────────

type StoredProgress = number | { position: number; duration?: number };

function loadProgress(): Record<string, StoredProgress> {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); } catch { return {}; }
}

function saveProgress(filePath: string, position: number, duration: number): void {
  try {
    const all = loadProgress();
    if (position > 10) all[filePath] = { position, duration };
    if (duration > 0 && position / duration >= WATCHED_THRESHOLD) all[filePath] = { position: duration, duration };
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch (_e) { /* ignore */ }
}

function getStoredPosition(filePath: string): number {
  const stored = loadProgress()[filePath];
  if (typeof stored === 'number') return stored;
  return stored?.position ?? 0;
}

function getStoredDuration(filePath: string): number {
  const stored = loadProgress()[filePath];
  return typeof stored === 'object' && stored?.duration ? stored.duration : 0;
}

function progressFraction(filePath: string, duration?: number): number {
  const position = getStoredPosition(filePath);
  const total = duration && duration > 0 ? duration : getStoredDuration(filePath);
  if (!position || !total || total <= 0) return 0;
  return Math.min(1, Math.max(0, position / total));
}

function loadSubtitlesDefaultEnabled(): boolean {
  try {
    return localStorage.getItem(SUBTITLES_DEFAULT_KEY) !== 'false';
  } catch {
    return true;
  }
}

function saveSubtitlesDefaultEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SUBTITLES_DEFAULT_KEY, enabled ? 'true' : 'false');
  } catch (_error) {
    // Ignore storage failures; subtitles still work for this session.
  }
}

function isWatched(filePath: string, duration?: number): boolean {
  const pos = getStoredPosition(filePath);
  const total = duration && duration > 0 ? duration : getStoredDuration(filePath);
  if (!pos || !total || total <= 0) return false;
  return pos / total >= WATCHED_THRESHOLD;
}

function isInProgress(filePath: string, duration?: number): boolean {
  const pos = getStoredPosition(filePath);
  if (!pos || pos <= 10) return false;
  const total = duration && duration > 0 ? duration : getStoredDuration(filePath);
  if (total && total > 0 && pos / total >= WATCHED_THRESHOLD) return false;
  return true;
}

function mediaErrorMessage(error: MediaError | null): string {
  if (!error) return 'Playback error';
  if (error.message) return error.message;
  return `Playback error (${error.code})`;
}

function transcodeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error) as { error?: unknown };
      if (typeof parsed.error === 'string') return parsed.error;
    } catch {
      return error;
    }
    return error;
  }
  if (error && typeof error === 'object' && 'error' in error) {
    const nestedError = (error as { error?: unknown }).error;
    if (typeof nestedError === 'string') return nestedError;
  }
  return 'Unable to start transcoding fallback';
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function VideoPlayer({
  filePath,
  title,
  episodes = [],
  episodeFiles = [],
  currentSeason = 1,
  currentEpisode = 1,
  onClose,
  onEpisodeChange,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const transcodeSessionIdRef = useRef<string | null>(null);
  const loadTokenRef = useRef(0);
  const sourceLoadTokenRef = useRef(0);
  const didTryTranscodeRef = useRef(false);
  const transcodeStartSecondsRef = useRef(0);
  const probedDurationRef = useRef(0);
  const probeTracksRef = useRef<MediaTrack[]>([]);
  const selectedVideoTrackIndexRef = useRef<number | undefined>(undefined);
  const selectedAudioTrackIndexRef = useRef<number | undefined>(undefined);
  const selectedSubtitleTrackIndexRef = useRef<number>(-1);
  const subtitlesDefaultEnabledRef = useRef(loadSubtitlesDefaultEnabled());

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
  const [showSidebar, setShowSidebar] = useState(true);
  const [showMediaPanel, setShowMediaPanel] = useState(false);
  const [episodePanelWidth, setEpisodePanelWidth] = useState(DEFAULT_EPISODE_PANEL_WIDTH);
  const [mediaPanelWidth, setMediaPanelWidth] = useState(DEFAULT_MEDIA_PANEL_WIDTH);
  const [mediaPanelTab, setMediaPanelTab] = useState<ControlTab>('video');
  const [mediaTracks, setMediaTracks] = useState<MediaTrack[]>([]);
  const [selectedVideoTrackIndex, setSelectedVideoTrackIndex] = useState(-1);
  const [selectedAudioTrackIndex, setSelectedAudioTrackIndex] = useState(-1);
  const [selectedSubtitleTrackIndex, setSelectedSubtitleTrackIndex] = useState(-1);
  const [subtitlesDefaultEnabled, setSubtitlesDefaultEnabled] = useState(subtitlesDefaultEnabledRef.current);
  const [aspectMode, setAspectMode] = useState<AspectMode>('default');
  const [playbackRate, setPlaybackRate] = useState(1);
  const [tick, setTick] = useState(0); // force episode list re-render

  const hasEpisodes = episodes.length > 0 && episodeFiles.length > 0;
  const videoTracks = useMemo(() => mediaTracks.filter((track) => track.type === 'video'), [mediaTracks]);
  const audioTracks = useMemo(() => mediaTracks.filter((track) => track.type === 'audio'), [mediaTracks]);
  const subtitleTracks = useMemo(() => mediaTracks.filter((track) => track.type === 'subtitle'), [mediaTracks]);

  const groupedEpisodes = useMemo(() =>
    episodes.reduce((acc, ep) => {
      if (!acc[ep.season]) acc[ep.season] = [];
      acc[ep.season].push(ep);
      return acc;
    }, {} as Record<number, EpisodeMeta[]>),
  [episodes]);

  const sortedSeasons = useMemo(
    () => Object.keys(groupedEpisodes).map(Number).sort((a, b) => a - b),
    [groupedEpisodes],
  );

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
    const selectedSubtitleOrdinal = subtitleOrdinal(probeTracksRef.current, selectedSubtitleTrackIndexRef.current);

    tracks.forEach((track, index) => {
      const shouldShow = subtitlesDefaultEnabledRef.current
        && (selectedSubtitleOrdinal >= 0 ? index === selectedSubtitleOrdinal : index === 0);
      track.mode = shouldShow ? 'showing' : 'disabled';
    });
  }, []);

  const applyProbeData = useCallback((data: unknown) => {
    const nextDuration = probeDurationSeconds(data);
    const nextTracks = probeTracks(data);
    const firstVideo = firstTrackIndex(nextTracks, 'video');
    const firstAudio = firstTrackIndex(nextTracks, 'audio');
    const firstSubtitle = subtitlesDefaultEnabledRef.current ? firstTrackIndex(nextTracks, 'subtitle') : -1;

    probedDurationRef.current = nextDuration;
    probeTracksRef.current = nextTracks;
    selectedVideoTrackIndexRef.current = firstVideo >= 0 ? firstVideo : undefined;
    selectedAudioTrackIndexRef.current = firstAudio >= 0 ? firstAudio : undefined;
    selectedSubtitleTrackIndexRef.current = firstSubtitle;

    if (nextDuration > 0) setDuration(nextDuration);
    setMediaTracks(nextTracks);
    setSelectedVideoTrackIndex(firstVideo);
    setSelectedAudioTrackIndex(firstAudio);
    setSelectedSubtitleTrackIndex(firstSubtitle);
  }, []);

  // ─── Episode navigation ────────────────────────────────────────────────────

  const goToEpisode = useCallback((season: number, episode: number) => {
    const next = episodeFiles.find((item) => item.season === season && item.episode === episode);
    if (next && onEpisodeChange) onEpisodeChange(next.filePath, season, episode);
  }, [episodeFiles, onEpisodeChange]);

  const handlePrevEpisode = useCallback(() => {
    let season = currentSeason;
    let episode = currentEpisode - 1;
    if (episode < 1) {
      const idx = sortedSeasons.indexOf(currentSeason);
      if (idx <= 0) return;
      season = sortedSeasons[idx - 1];
      episode = groupedEpisodes[season]?.length || 1;
    }
    goToEpisode(season, episode);
  }, [currentEpisode, currentSeason, goToEpisode, groupedEpisodes, sortedSeasons]);

  const handleNextEpisode = useCallback(() => {
    let season = currentSeason;
    let episode = currentEpisode + 1;
    const eps = groupedEpisodes[currentSeason] || [];
    if (episode > eps.length) {
      const idx = sortedSeasons.indexOf(currentSeason);
      if (idx >= sortedSeasons.length - 1) return;
      season = sortedSeasons[idx + 1];
      episode = 1;
    }
    goToEpisode(season, episode);
  }, [currentEpisode, currentSeason, goToEpisode, groupedEpisodes, sortedSeasons]);

  const startTranscodedFallback = useCallback(async (
    startSeconds = 0,
    options: { force?: boolean } = {},
  ) => {
    if (didTryTranscodeRef.current && !options.force) return;
    didTryTranscodeRef.current = true;
    const token = loadTokenRef.current;
    const safeStartSeconds = Math.floor(clampSeconds(startSeconds, probedDurationRef.current));
    transcodeStartSecondsRef.current = safeStartSeconds;
    setPosition(safeStartSeconds);
    setPlayerState('loading');
    setStatusMessage(safeStartSeconds > 0 ? 'Seeking local stream...' : 'Starting local compatible stream...');
    setErrorMessage(null);
    await stopTranscodeSession();

    try {
      if (probeTracksRef.current.length === 0 && probedDurationRef.current === 0) {
        const probeResult = await desktopApi.media.probe(filePath);
        if (token !== loadTokenRef.current) return;
        if (probeResult.ok) applyProbeData(probeResult.data);
      }

      const subtitleIndex = selectedSubtitleTrackIndexRef.current;
      const selectedSubtitle = probeTracksRef.current.find((track) => track.index === subtitleIndex);
      const result = await desktopApi.media.startTranscode(filePath, {
        preset: 'auto',
        startSeconds: safeStartSeconds,
        ...(typeof selectedVideoTrackIndexRef.current === 'number' ? { videoTrackIndex: selectedVideoTrackIndexRef.current } : {}),
        ...(typeof selectedAudioTrackIndexRef.current === 'number' ? { audioTrackIndex: selectedAudioTrackIndexRef.current } : {}),
        subtitleTrackIndex: subtitleIndex,
        subtitleStreamOrdinal: subtitleIndex >= 0 ? subtitleOrdinal(probeTracksRef.current, subtitleIndex) : undefined,
        subtitleCodec: selectedSubtitle?.codec,
      });
      if (token !== loadTokenRef.current) return;

      if (!result.ok || !result.data?.playlistUrl) {
        throw new Error(result.error || 'Failed to start transcode session');
      }

      transcodeSessionIdRef.current = result.data.sessionId;
      setStreamIsTranscoded(true);
      setStreamUrl(result.data.playlistUrl);
      setPlayerState('loading');
      setStatusMessage('Loading local stream...');
    } catch (error) {
      if (token !== loadTokenRef.current) return;
      setPlayerState('error');
      setStatusMessage('Unable to play media');
      setErrorMessage(transcodeErrorMessage(error));
      setStreamIsTranscoded(false);
    }
  }, [applyProbeData, filePath, stopTranscodeSession]);

  const handleRetry = useCallback(() => {
    didTryTranscodeRef.current = false;
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
    probeTracksRef.current = [];
    setMediaTracks([]);
    setDuration(0);

    void desktopApi.media.probe(filePath).then((result) => {
      if (cancelled || !result.ok) return;
      applyProbeData(result.data);
    }).catch(() => {
      if (!cancelled) probedDurationRef.current = 0;
    });

    return () => {
      cancelled = true;
    };
  }, [applyProbeData, filePath]);

  // ─── Load media stream URL ────────────────────────────────────────────────
  useEffect(() => {
    const loadToken = ++loadTokenRef.current;
    didTryTranscodeRef.current = false;
    transcodeStartSecondsRef.current = 0;
    setStreamIsTranscoded(false);
    setPosition(0);
    setPlayerState('loading');
    setStatusMessage('Preparing stream...');
    setErrorMessage(null);
    setStreamUrl('');

    void stopTranscodeSession();

    (async () => {
      try {
        if (shouldStartWithTranscode(filePath)) {
          await startTranscodedFallback(getStoredPosition(filePath), { force: true });
          return;
        }

        const { url } = await desktopApi.getStreamUrl(filePath);
        if (loadToken !== loadTokenRef.current) return;
        setStreamUrl(url);
      } catch (error) {
        if (loadToken !== loadTokenRef.current) return;
        setPlayerState('error');
        setStatusMessage('Failed to resolve stream');
        setErrorMessage(error instanceof Error ? error.message : 'Failed to resolve stream URL');
      }
    })();

    return () => {
      void stopTranscodeSession();
    };
  }, [filePath, reloadToken, startTranscodedFallback, stopTranscodeSession]);

  // ─── Player binding, events, and fallback ────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    const sourceToken = ++sourceLoadTokenRef.current;
    const isHlsSource = /\.m3u8(\?|$)/i.test(streamUrl);
    const resumeSeconds = getStoredPosition(filePath);

    clearHls();
    setPlayerState('loading');
    setStatusMessage(streamIsTranscoded ? 'Loading local stream...' : 'Loading stream...');
    setErrorMessage(null);
    setPaused(true);

    if (isHlsSource) {
      if (isSupported()) {
        const hls = new Hls({
          manifestLoadingMaxRetry: 20,
          manifestLoadingRetryDelay: 500,
          fragLoadingMaxRetry: 20,
          fragLoadingRetryDelay: 500,
        });
        hlsRef.current = hls;
        hls.attachMedia(video);
        hls.loadSource(streamUrl);
        hls.on(Events.ERROR, (_event, data) => {
          if (sourceToken !== sourceLoadTokenRef.current) return;
          if (!data.fatal) return;
          if (!didTryTranscodeRef.current && !streamIsTranscoded) {
            setStatusMessage('Trying local compatible stream...');
            void startTranscodedFallback(getStoredPosition(filePath), { force: true });
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

    video.preload = 'auto';
    video.load();

    const onLoadStart = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      setPlayerState('loading');
      setStatusMessage(streamIsTranscoded ? 'Loading local stream...' : 'Buffering...');
      setErrorMessage(null);
    };

    const onWaiting = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
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
        saveProgress(filePath, nextPosition, totalDuration);
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
      applyNativeTextTrackVisibility();
      if (!streamIsTranscoded && resumeSeconds > 10 && mediaDuration) {
        video.currentTime = Math.min(resumeSeconds, Math.max(0, video.duration - 0.1));
      }
    };

    const onCanPlay = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      setPlayerState('ready');
      setStatusMessage('');
      void video.play().catch(() => setPaused(true));
    };

    const onEnded = () => {
      setPaused(true);
      if (hasEpisodes) handleNextEpisode();
    };

    const onError = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      setPaused(true);
      if (!isHlsSource && !didTryTranscodeRef.current) {
        setStatusMessage('Trying local compatible stream...');
        const fallbackStart = video.currentTime > 0 ? video.currentTime : getStoredPosition(filePath);
        void startTranscodedFallback(fallbackStart, { force: true });
        return;
      }
      setPlayerState('error');
      setErrorMessage(mediaErrorMessage(video.error));
    };

    video.addEventListener('loadstart', onLoadStart);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    return () => {
      video.removeEventListener('loadstart', onLoadStart);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
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
    hasEpisodes,
    clearHls,
    clearVideoElement,
    applyNativeTextTrackVisibility,
    startTranscodedFallback,
    handleNextEpisode,
  ]);

  // ─── Auto-hide controls ────────────────────────────────────────────────────

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!videoRef.current?.paused) setShowControls(false);
    }, CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }, []);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => () => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
  }, []);

  // Stop transcode session when component closes.
  useEffect(() => () => {
    void stopTranscodeSession();
  }, [stopTranscodeSession]);

  // ─── Controls ──────────────────────────────────────────────────────────────

  const togglePlay = useCallback(() => {
    if (playerState === 'loading') return;
    const video = videoRef.current;
    if (!video) return;
    video.paused ? void video.play() : video.pause();
  }, [playerState]);

  const handleClose = useCallback((event?: React.SyntheticEvent) => {
    event?.preventDefault();
    onClose();
  }, [onClose]);

  const handleBack = useCallback((event?: React.SyntheticEvent) => {
    event?.preventDefault();
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    onClose();
  }, [onClose]);

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
    if (showMediaPanel) {
      setShowMediaPanel(false);
      return;
    }

    setShowSidebar(false);
    setShowMediaPanel(true);
  }, [showMediaPanel]);

  const openEpisodePanel = useCallback(() => {
    if (showSidebar) {
      setShowSidebar(false);
      return;
    }

    setShowMediaPanel(false);
    setShowSidebar(true);
  }, [showSidebar]);

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
    if (video) video.playbackRate = playbackRate;
  }, [playbackRate, streamUrl]);

  const seekTo = useCallback((targetSeconds: number) => {
    const nextPosition = clampSeconds(targetSeconds, duration || undefined);
    setPosition(nextPosition);

    if (streamIsTranscoded) {
      void startTranscodedFallback(nextPosition, { force: true });
      return;
    }

    const video = videoRef.current;
    if (!video) return;
    const directDuration = Number.isFinite(video.duration) ? video.duration : duration;
    video.currentTime = clampSeconds(nextPosition, directDuration || undefined);
  }, [duration, startTranscodedFallback, streamIsTranscoded]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * duration);
  }, [duration, seekTo]);

  const handleVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const v = parseFloat(e.target.value);
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
    void startTranscodedFallback(position, { force: true });
  }, [applyNativeTextTrackVisibility, position, startTranscodedFallback, streamUrl]);

  const selectVideoTrack = useCallback((trackIndex: number) => {
    selectedVideoTrackIndexRef.current = trackIndex;
    setSelectedVideoTrackIndex(trackIndex);
    restartForTrackChange();
  }, [restartForTrackChange]);

  const selectAudioTrack = useCallback((trackIndex: number) => {
    selectedAudioTrackIndexRef.current = trackIndex;
    setSelectedAudioTrackIndex(trackIndex);
    restartForTrackChange();
  }, [restartForTrackChange]);

  const selectSubtitleTrack = useCallback((trackIndex: number) => {
    const enabled = trackIndex >= 0;
    subtitlesDefaultEnabledRef.current = enabled;
    setSubtitlesDefaultEnabled(enabled);
    saveSubtitlesDefaultEnabled(enabled);
    selectedSubtitleTrackIndexRef.current = trackIndex;
    setSelectedSubtitleTrackIndex(trackIndex);
    restartForTrackChange();
  }, [restartForTrackChange]);

  const changeVolume = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    const nextVolume = Math.min(1, Math.max(0, video.volume + delta));
    video.volume = nextVolume;
    video.muted = nextVolume === 0 ? true : false;
  }, []);

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
      const video = videoRef.current;
      if (!video) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          handleBack();
          break;
        case ' ':
          e.preventDefault();
          video.paused ? void video.play() : video.pause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekTo(position - (e.shiftKey ? 60 : 10));
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekTo(position + (e.shiftKey ? 60 : 30));
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
          video.muted = !video.muted;
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
          seekTo(0);
          break;
        case 'End':
          e.preventDefault();
          seekTo(duration);
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
    position,
    resetPlaybackRate,
    seekTo,
    toggleFullscreen,
  ]);

  // ─── Derived ───────────────────────────────────────────────────────────────

  const progressPct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  const currentEpLabel = useMemo(() => {
    if (!hasEpisodes) return null;
    const ep = episodes.find((item) => item.season === currentSeason && item.number === currentEpisode);
    return ep?.title
      ? `${epCode(currentSeason, currentEpisode)} – ${cleanEpisodeTitle(ep.title, currentSeason, currentEpisode)}`
      : epCode(currentSeason, currentEpisode);
  }, [currentEpisode, currentSeason, episodes, hasEpisodes]);

  return (
    <div className="fixed inset-0 z-50 flex bg-black" ref={containerRef}>
      <div
        className="relative flex-1 flex items-center justify-center bg-black overflow-hidden"
        onMouseMove={resetHideTimer}
        onClick={handleSurfaceClick}
        onDoubleClick={handleSurfaceDoubleClick}
      >
        <button
          onClick={(event) => {
            event.stopPropagation();
            handleBack(event);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          className="absolute top-3 left-3 z-40 rounded border border-white/25 bg-black/40 px-3 py-1.5 text-xs text-white/90 hover:bg-black/70 hover:text-white transition-colors flex items-center gap-1.5"
          aria-label="Back"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>

        <div className="pointer-events-none absolute top-3 left-1/2 z-40 max-w-[60%] -translate-x-1/2 rounded-full border border-white/10 bg-black/35 px-4 py-1.5 text-center text-xs font-medium text-white/80 shadow-lg backdrop-blur-md">
          <span className="block truncate">{currentEpLabel ?? title}</span>
        </div>

        <video
          ref={videoRef}
          className={`w-full h-full ${aspectMode === 'fill' ? 'object-cover' : 'object-contain'}`}
          style={aspectMode.includes('/') ? { aspectRatio: aspectMode } : undefined}
          preload="auto"
        />

        {playerState === 'loading' && (
          <div className="absolute inset-0 z-20 bg-black/55 flex flex-col items-center justify-center gap-2 text-center">
            <div className="h-10 w-10 rounded-full border-4 border-white/35 border-t-[#eba865] animate-spin" />
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
                className="px-3 py-1.5 rounded bg-[#eba865] text-black text-sm hover:bg-[#d4964f]"
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

        {/* Controls overlay */}
        <div
          className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-4 pb-4 pt-10 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {/* Progress bar */}
          <div
            className="relative h-1.5 rounded-full bg-white/20 cursor-pointer mb-3 group"
            onClick={handleSeek}
          >
            <div className="h-full rounded-full bg-[#eba865] pointer-events-none" style={{ width: `${progressPct}%` }} />
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3.5 w-3.5 rounded-full bg-white shadow opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
              style={{ left: `${progressPct}%` }}
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="rounded-full p-1.5 text-white hover:text-[#eba865] transition-colors"
            >
              {paused ? <Play className="w-5 h-5 fill-current" /> : <Pause className="w-5 h-5 fill-current" />}
            </button>

            <button
              onClick={() => seekTo(position - 10)}
              className="text-white/70 hover:text-white transition-colors"
              title="Back 10s"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            <button
              onClick={() => seekTo(position + 30)}
              className="text-white/70 hover:text-white transition-colors"
              title="Forward 30s"
            >
              <RotateCw className="w-4 h-4" />
            </button>

            <span className="text-white/70 text-xs tabular-nums select-none">
              {formatTime(position)} / {formatTime(duration)}
            </span>

            <div className="flex-1" />

            {hasEpisodes && (
              <>
                <button onClick={handlePrevEpisode} className="text-white/70 hover:text-white transition-colors" title="Previous episode">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button onClick={handleNextEpisode} className="text-white/70 hover:text-white transition-colors" title="Next episode">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </>
            )}

            <button onClick={toggleMute} className="text-white/70 hover:text-white transition-colors">
              {muted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={handleVolume}
              className="w-20 accent-[#eba865] cursor-pointer"
            />

            <button
              onClick={openMediaPanel}
              className={`text-white/70 hover:text-white transition-colors ${showMediaPanel ? 'text-[#eba865]' : ''}`}
              title="Video, audio, and subtitle controls"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>

            {hasEpisodes && (
              <button
                onClick={openEpisodePanel}
                className={`text-white/70 hover:text-white transition-colors ${showSidebar ? 'text-[#eba865]' : ''}`}
                title="Episode list"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                </svg>
              </button>
            )}

            <button onClick={toggleFullscreen} className="text-white/70 hover:text-white transition-colors">
              {fullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>

            <button onClick={handleClose} className="text-white/70 hover:text-white transition-colors" title="Close player">
              <X className="w-4 h-4" />
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
            <span className="h-12 w-1 rounded-full bg-white/10 transition-colors group-hover:bg-[#eba865]/70" />
          </div>

          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate">Playback Settings</p>
              <p className="text-[10px] uppercase tracking-widest text-[#eba865]/75">Video, Audio, Subtitles</p>
            </div>
            <button
              onClick={() => setShowMediaPanel(false)}
              className="text-[#a8a8a8] hover:text-white ml-2 shrink-0"
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
                  <div>
                    <p className="mb-2 text-xs font-semibold text-white">Video track</p>
                    <div className="overflow-hidden rounded-lg bg-white/10">
                      {videoTracks.length === 0 && <p className="px-3 py-2 text-white/50">No video tracks found</p>}
                      {videoTracks.map((track, index) => (
                        <button
                          key={track.index}
                          onClick={() => selectVideoTrack(track.index)}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedVideoTrackIndex === track.index ? 'bg-[#eba865]/25 text-white' : 'hover:bg-white/10'}`}
                        >
                          <span className={`h-2.5 w-2.5 rounded-full ${selectedVideoTrackIndex === track.index ? 'bg-[#eba865]' : 'bg-white/60'}`} />
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
                          className={`rounded-md px-3 py-1.5 text-xs transition-colors ${aspectMode === mode ? 'bg-[#eba865] text-black' : 'bg-white/10 text-white/75 hover:bg-white/15'}`}
                        >
                          {mode === 'fill' ? 'Crop' : mode}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between text-xs font-semibold text-white">
                      <span>Speed</span>
                      <span className="text-[#eba865]">{playbackRate.toFixed(2)}x</span>
                    </div>
                    <input
                      type="range"
                      min={0.25}
                      max={4}
                      step={0.05}
                      value={playbackRate}
                      onChange={(event) => setPlaybackRate(Number(event.target.value))}
                      className="w-full accent-[#eba865]"
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
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedAudioTrackIndex === -1 ? 'bg-[#eba865]/25 text-white' : 'hover:bg-white/10'}`}
                      >
                        <span className={`h-2.5 w-2.5 rounded-full ${selectedAudioTrackIndex === -1 ? 'bg-[#eba865]' : 'bg-white/60'}`} />
                        <span>&lt;None&gt;</span>
                      </button>
                      {audioTracks.map((track, index) => (
                        <button
                          key={track.index}
                          onClick={() => selectAudioTrack(track.index)}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedAudioTrackIndex === track.index ? 'bg-[#eba865]/25 text-white' : 'hover:bg-white/10'}`}
                        >
                          <span className={`h-2.5 w-2.5 rounded-full ${selectedAudioTrackIndex === track.index ? 'bg-[#eba865]' : 'bg-white/60'}`} />
                          <span className="truncate">{trackLabel(track, index)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-semibold text-white">Audio delay</p>
                    <p className="rounded-lg bg-white/10 px-3 py-2 text-xs text-white/55">
                      Delay controls need the native mpv engine path; track switching is available here.
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
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedSubtitleTrackIndex === -1 ? 'bg-[#eba865]/25 text-white' : 'hover:bg-white/10'}`}
                      >
                        <span className={`h-2.5 w-2.5 rounded-full ${selectedSubtitleTrackIndex === -1 ? 'bg-[#eba865]' : 'bg-white/60'}`} />
                        <span>Off</span>
                      </button>
                      {subtitleTracks.length === 0 && <p className="px-3 py-2 text-xs text-white/50">No subtitle tracks found</p>}
                      {subtitleTracks.map((track, index) => (
                        <button
                          key={track.index}
                          onClick={() => selectSubtitleTrack(track.index)}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${selectedSubtitleTrackIndex === track.index ? 'bg-[#eba865]/25 text-white' : 'hover:bg-white/10'}`}
                        >
                          <span className={`h-2.5 w-2.5 rounded-full ${selectedSubtitleTrackIndex === track.index ? 'bg-[#eba865]' : 'bg-white/60'}`} />
                          <span className="truncate">{trackLabel(track, index)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <p className="rounded-lg bg-white/10 px-3 py-2 text-xs text-white/55">
                    Subtitles now load automatically when available. Choose Off once to keep them off by default until you pick a subtitle again.
                  </p>
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
            <span className="h-12 w-1 rounded-full bg-white/10 transition-colors group-hover:bg-[#eba865]/70" />
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <p className="text-sm font-semibold text-white truncate">{title}</p>
            <button
              onClick={() => setShowSidebar(false)}
              className="text-[#a8a8a8] hover:text-white ml-2 shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <ScrollArea className="flex-1">
            {tick >= 0 && sortedSeasons.map((season) => (
              <div key={season}>
                <p className="sticky top-0 z-10 bg-[#111] px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[#eba865]">
                  Season {season}
                </p>
                {(groupedEpisodes[season] || []).map((ep) => {
                  const file = episodeFiles.find((item) => item.season === ep.season && item.episode === ep.number);
                  const isCurrent = ep.season === currentSeason && ep.number === currentEpisode;
                  const epPath = file?.filePath;
                  const epDur = isCurrent ? duration : file?.localMetadata?.durationSeconds;
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
                        ${isCurrent ? 'bg-[#eba865]/15' : 'hover:bg-white/5'}
                        ${!file ? 'cursor-not-allowed opacity-30' : ''}
                        ${watched && !isCurrent ? 'opacity-50' : ''}`}
                    >
                      {(inProgress || isCurrent) && progFrac > 0 && (
                        <span
                          className={`pointer-events-none absolute bottom-0 left-0 h-0.5 ${isCurrent ? 'bg-[#eba865]' : 'bg-amber-400'}`}
                          style={{ width: `${Math.min(100, progFrac * 100)}%` }}
                        />
                      )}
                      <span className={`w-12 shrink-0 font-mono text-[10px] ${isCurrent ? 'text-[#eba865]' : 'text-[#555]'}`}>
                        {epCode(ep.season, ep.number)}
                      </span>
                      <span className={`min-w-0 flex-1 truncate text-xs leading-snug ${isCurrent ? 'font-medium text-[#eba865]' : watched ? 'text-[#555]' : 'text-white'}`}>
                        {ep.title ? cleanEpisodeTitle(ep.title, ep.season, ep.number) : `Episode ${ep.number}`}
                      </span>
                      {watched && !isCurrent && <CheckCircle className="h-3 w-3 shrink-0 text-green-500 opacity-70" />}
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
