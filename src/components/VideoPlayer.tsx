/**
 * VideoPlayer — in-app HTML5 player with stream fallback.
 *
 * Uses the local media server stream for native playback and attempts a
 * one-time H.264/AAC transcode fallback when direct playback fails.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorTypes, Events, Hls, isSupported } from 'hls.js';
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
import LoomLoader from '@/components/LoomLoader';
import { useTheme } from '@/components/ThemeProvider';
import { desktopApi } from '@/lib/desktopApi';
import {
  getPlayableStartPosition,
  getProgressState,
  hydrateProgressFromDatabase,
  isWatched,
  progressFraction,
  saveProgress as savePlaybackProgress,
} from '@/lib/progress';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUBTITLES_DEFAULT_KEY = 'subtitlesDefaultEnabled';
const AUTOPLAY_NEXT_EPISODE_KEY = 'loomtvAutoplayNextEpisode';
const TRACK_PREFERENCES_KEY = 'loomtvPlaybackTrackPreferences';
const WATCHED_THRESHOLD = 0.9;
const CONTROLS_HIDE_MS = 3000;
const NEXT_EPISODE_COUNTDOWN_SECONDS = 3;
const REPLAY_FROM_START_REMAINING_SECONDS = 8;
const HLS_RECOVERY_ATTEMPTS = 3;
const HLS_TRANSCODE_RESTART_ATTEMPTS = 2;
const HLS_FIRST_EXTENSIONS = new Set(['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', '3gp', 'ts']);
const DEFAULT_EPISODE_PANEL_WIDTH = 288;
const DEFAULT_MEDIA_PANEL_WIDTH = 360;
const MIN_SIDE_PANEL_WIDTH = 260;
const MAX_SIDE_PANEL_RATIO = 0.4;
type PlayerState = 'loading' | 'ready' | 'error';
type ControlTab = 'video' | 'audio' | 'subtitles';
type AspectMode = 'default' | 'contain' | 'fill' | '4 / 3' | '16 / 9' | '21 / 9';
type PlaybackEngine = 'mpv' | 'html5';
type TrackPreferenceType = 'audio' | 'subtitle';

type SubtitleStyleSettings = {
  delaySeconds: number;
  position: number;
  scale: number;
  fontSize: number;
  fontColor: string;
  borderColor: string;
  borderWidth: number;
  backgroundColor: string;
};

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
  default?: boolean;
  forced?: boolean;
}

type ProbeData = { durationSeconds?: number; tracks?: MediaTrack[] };
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
  mediaId?: string;
  filePath: string;
  title: string;
  subtitles?: { lang: string; label: string; url: string }[];
  episodes?: EpisodeMeta[];
  episodeFiles?: EpisodeFile[];
  currentSeason?: number;
  currentEpisode?: number;
  onClose: () => void;
  onEpisodeChange?: (filePath: string, season: number, episode: number) => void;
}

const EMPTY_EPISODES: EpisodeMeta[] = [];
const EMPTY_EPISODE_FILES: EpisodeFile[] = [];
const EMPTY_SUBTITLES: NonNullable<VideoPlayerProps['subtitles']> = [];
const subtitleCueTiming = new WeakMap<TextTrackCue, { startTime: number; endTime: number }>();
const DEFAULT_SUBTITLE_STYLE: SubtitleStyleSettings = {
  delaySeconds: 0,
  position: 96,
  scale: 1,
  fontSize: 32,
  fontColor: '#ffffff',
  borderColor: '#000000',
  borderWidth: 3,
  backgroundColor: '#000000',
};

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
  const flags = [
    track.default ? 'default' : undefined,
    track.forced ? 'forced' : undefined,
  ].filter(Boolean).join(', ');
  const details = track.type === 'video'
    ? [track.codec, track.width && track.height ? `${track.width}x${track.height}` : undefined, track.pixelFormat].filter(Boolean).join(', ')
    : track.type === 'audio'
      ? [track.codec, track.channels ? `${track.channels}ch` : undefined].filter(Boolean).join(', ')
      : [track.codec || 'subtitle', flags].filter(Boolean).join(', ');
  return `#${ordinal + 1} ${language}${title}${details}`.trim();
}

function subtitleOrdinal(tracks: MediaTrack[], streamIndex: number): number {
  return tracks.filter((track) => track.type === 'subtitle').findIndex((track) => track.index === streamIndex);
}

function selectedEmbeddedSubtitle(tracks: MediaTrack[], streamIndex: number): { track: MediaTrack; ordinal: number } | null {
  if (streamIndex < 0) return null;
  const track = tracks.find((candidate) => candidate.type === 'subtitle' && candidate.index === streamIndex);
  if (!track) return null;
  const ordinal = subtitleOrdinal(tracks, streamIndex);
  return ordinal >= 0 ? { track, ordinal } : null;
}

function externalSubtitleOrdinal(tracks: MediaTrack[], streamIndex: number): number {
  return tracks.findIndex((track) => track.index === streamIndex);
}

function firstTrackIndex(tracks: MediaTrack[], type: MediaTrack['type']): number {
  return tracks.find((track) => track.type === type)?.index ?? -1;
}

function firstSubtitleTrackIndex(tracks: MediaTrack[]): number {
  const candidates = tracks.filter((track) => track.type === 'subtitle');
  if (candidates.length === 0) return -1;

  const fullSubtitle = candidates.find((track) => track.default && !track.forced)
    || candidates.find((track) => normalizeTrackField(track.language).startsWith('en') && !track.forced)
    || candidates.find((track) => !track.forced);

  return (fullSubtitle || candidates[0]).index;
}

function normalizeTrackField(value?: string): string {
  return (value || '').trim().toLowerCase();
}

function trackPreferenceScope(mediaId: string | undefined, filePath: string): string {
  return mediaId ? `media:${mediaId}` : `file:${filePath}`;
}

function loadTrackPreferences(scope: string): PlaybackTrackPreferences {
  try {
    const all = JSON.parse(localStorage.getItem(TRACK_PREFERENCES_KEY) || '{}') as Record<string, PlaybackTrackPreferences>;
    return all[scope] || {};
  } catch {
    return {};
  }
}

function saveTrackPreference(scope: string, type: TrackPreferenceType, track: MediaTrack | undefined, enabled: boolean): void {
  try {
    const all = JSON.parse(localStorage.getItem(TRACK_PREFERENCES_KEY) || '{}') as Record<string, PlaybackTrackPreferences>;
    all[scope] = {
      ...(all[scope] || {}),
      [type]: {
        enabled,
        index: track?.index,
        language: normalizeTrackField(track?.language),
        title: normalizeTrackField(track?.title),
        codec: normalizeTrackField(track?.codec),
        forced: track?.forced,
      },
    };
    localStorage.setItem(TRACK_PREFERENCES_KEY, JSON.stringify(all));
  } catch (_error) {
    // Track selection still applies for the current session.
  }
}

function preferredTrackIndex(tracks: MediaTrack[], type: TrackPreferenceType, preference?: TrackPreference): number | null {
  if (!preference) return null;
  if (!preference.enabled) return -1;

  const candidates = tracks.filter((track) => track.type === type);
  if (candidates.length === 0) return null;
  const scopedCandidates = type === 'subtitle'
    && candidates.some((track) => !track.forced)
    ? candidates.filter((track) => !track.forced)
    : candidates;

  const language = normalizeTrackField(preference.language);
  const title = normalizeTrackField(preference.title);
  const codec = normalizeTrackField(preference.codec);

  const sameIndex = scopedCandidates.find((track) => track.index === preference.index);
  if (sameIndex) return sameIndex.index;

  const exact = scopedCandidates.find((track) =>
    language && normalizeTrackField(track.language) === language
    && normalizeTrackField(track.title) === title
    && normalizeTrackField(track.codec) === codec,
  );
  if (exact) return exact.index;

  const languageAndTitle = scopedCandidates.find((track) =>
    language && normalizeTrackField(track.language) === language
    && title && normalizeTrackField(track.title) === title,
  );
  if (languageAndTitle) return languageAndTitle.index;

  const languageMatch = scopedCandidates.find((track) =>
    language && normalizeTrackField(track.language) === language,
  );
  if (languageMatch) return languageMatch.index;

  const titleMatch = scopedCandidates.find((track) =>
    title && normalizeTrackField(track.title) === title,
  );
  if (titleMatch) return titleMatch.index;

  return scopedCandidates.find((track) => track.index === preference.index)?.index ?? null;
}

function subtitleSource(url: string, serverBase: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!serverBase) return url;
  return `${serverBase}${url.startsWith('/') ? url : `/${url}`}`;
}

function hlsResponseCode(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const response = (data as { response?: { code?: unknown } }).response;
  return typeof response?.code === 'number' ? response.code : undefined;
}

function hlsErrorSummary(data: unknown): string {
  if (!data || typeof data !== 'object') return String(data);
  const value = data as {
    type?: unknown;
    details?: unknown;
    fatal?: unknown;
    reason?: unknown;
    error?: { message?: unknown };
    response?: { code?: unknown; text?: unknown; url?: unknown };
  };
  return JSON.stringify({
    type: value.type,
    details: value.details,
    fatal: value.fatal,
    reason: value.reason,
    message: value.error?.message,
    response: value.response,
  });
}

function shouldRestartMissingLocalHls(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const detail = String((data as { details?: unknown }).details || '');
  const statusCode = hlsResponseCode(data);
  return statusCode === 404 && /manifest|level/i.test(detail);
}

function mpvTrackType(type: 'video' | 'audio' | 'subtitle'): 'video' | 'audio' | 'sub' {
  return type === 'subtitle' ? 'sub' : type;
}

function getStoredDuration(filePath: string): number {
  return getProgressState(filePath).duration;
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

function loadAutoplayNextEpisode(): boolean {
  try {
    return localStorage.getItem(AUTOPLAY_NEXT_EPISODE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function saveAutoplayNextEpisode(enabled: boolean): void {
  try {
    localStorage.setItem(AUTOPLAY_NEXT_EPISODE_KEY, enabled ? 'true' : 'false');
  } catch (_error) {
    // Autoplay still applies for the current session.
  }
}

function isInProgress(filePath: string, duration?: number): boolean {
  return getProgressState(filePath, duration).inProgress;
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
  mediaId,
  filePath,
  title,
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
  const nextEpisodeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [streamUrl, setStreamUrl] = useState<string>('');
  const [streamIsTranscoded, setStreamIsTranscoded] = useState(false);
  const [playbackEngine, setPlaybackEngine] = useState<PlaybackEngine>('html5');
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
  const [tick, setTick] = useState(0); // force episode list re-render
  const trackPreferenceScopeKey = useMemo(() => trackPreferenceScope(mediaId, filePath), [filePath, mediaId]);

  useEffect(() => {
    void hydrateProgressFromDatabase().then(() => setTick((value) => value + 1));
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

  const startTranscodedFallback = useCallback(async (
    startSeconds = 0,
    options: { force?: boolean } = {},
  ) => {
    if (didTryTranscodeRef.current && !options.force) return;
    didTryTranscodeRef.current = true;
    const token = loadTokenRef.current;
    const durationHint = probedDurationRef.current || getStoredDuration(filePath);
    const clampedStartSeconds = clampSeconds(startSeconds, durationHint || undefined);
    const safeStartSeconds = durationHint > 0
      && (clampedStartSeconds / durationHint >= WATCHED_THRESHOLD
        || durationHint - clampedStartSeconds <= REPLAY_FROM_START_REMAINING_SECONDS)
      ? 0
      : Math.floor(clampedStartSeconds);
    hlsRecoveryAttemptsRef.current = 0;
    transcodeStartSecondsRef.current = safeStartSeconds;
    setPosition(safeStartSeconds);
    setPlayerState('loading');
    setStatusMessage(safeStartSeconds > 0 ? 'Seeking local stream...' : 'Starting local compatible stream...');
    setErrorMessage(null);
    clearHls();
    await stopTranscodeSession();

    try {
      if (probeTracksRef.current.length === 0 && probedDurationRef.current === 0) {
        const probeResult = await desktopApi.media.probe(filePath);
        if (token !== loadTokenRef.current) return;
        if (probeResult.ok) applyProbeData(probeResult.data);
      }

      const subtitleIndex = selectedSubtitleTrackIndexRef.current;
      const embeddedSubtitle = selectedEmbeddedSubtitle(probeTracksRef.current, subtitleIndex);
      const { url } = await desktopApi.getStreamUrl(filePath, {
        forceTranscode: true,
        startSeconds: safeStartSeconds,
        ...(typeof selectedVideoTrackIndexRef.current === 'number' ? { videoTrackIndex: selectedVideoTrackIndexRef.current } : {}),
        ...(typeof selectedAudioTrackIndexRef.current === 'number' ? { audioTrackIndex: selectedAudioTrackIndexRef.current } : {}),
        ...(embeddedSubtitle ? {
          subtitleTrackIndex: subtitleIndex,
          subtitleStreamOrdinal: embeddedSubtitle.ordinal,
          subtitleCodec: embeddedSubtitle.track.codec,
        } : {}),
        subtitleStyle,
      });
      if (token !== loadTokenRef.current) return;

      transcodeSessionIdRef.current = null;
      setStreamIsTranscoded(true);
      setStreamUrl(url);
      setPlayerState('loading');
      setStatusMessage('Loading local stream...');
    } catch (error) {
      if (token !== loadTokenRef.current) return;
      setPlayerState('error');
      setStatusMessage('Unable to play media');
      setErrorMessage(transcodeErrorMessage(error));
      setStreamIsTranscoded(false);
    }
  }, [applyProbeData, clearHls, filePath, stopTranscodeSession, subtitleStyle]);

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
        applyNativeTextTrackVisibility();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [applyNativeTextTrackVisibility, applyProbeData, externalSubtitleTracks, filePath, trackPreferenceScopeKey]);

  // ─── Load media stream URL ────────────────────────────────────────────────
  useEffect(() => {
    const loadToken = ++loadTokenRef.current;
    didTryTranscodeRef.current = false;
    transcodeStartSecondsRef.current = 0;
    hlsRecoveryAttemptsRef.current = 0;
    hlsTranscodeRestartAttemptsRef.current = 0;
    setStreamIsTranscoded(false);
    setPlaybackEngine('html5');
    setPosition(0);
    setPlayerState('loading');
    setStatusMessage('Preparing stream...');
    setErrorMessage(null);
    setStreamUrl('');

    void stopTranscodeSession();

    (async () => {
      try {
        const startSeconds = getPlayableStartPosition(filePath, probedDurationRef.current);

        if (shouldStartWithTranscode(filePath)) {
          await startTranscodedFallback(startSeconds, { force: true });
          return;
        }

        const { url, isTranscoded } = await desktopApi.getStreamUrl(filePath);
        if (loadToken !== loadTokenRef.current) return;
        setStreamIsTranscoded(Boolean(isTranscoded));
        setStreamUrl(url);
      } catch (error) {
        if (loadToken !== loadTokenRef.current) return;
        setPlayerState('error');
        setStatusMessage('Failed to resolve stream');
        setErrorMessage(error instanceof Error ? error.message : 'Failed to resolve stream URL');
      }
    })();

    return () => {
      void desktopApi.closeMPV();
      void stopTranscodeSession();
    };
  }, [filePath, reloadToken, startTranscodedFallback, stopTranscodeSession]);

  useEffect(() => {
    if (playbackEngine !== 'mpv') return;
    let cancelled = false;

    const poll = async () => {
      try {
        const state = await desktopApi.queryMPV();
        if (cancelled || !state) return;

        const nextPosition = Number.isFinite(state.position) ? state.position : 0;
        const nextDuration = Number.isFinite(state.duration) ? state.duration : duration;
        setPosition(nextPosition);
        if (nextDuration > 0) setDuration(nextDuration);
        setPaused(Boolean(state.paused));
        setMuted(Boolean(state.muted));
        setVolume(Math.max(0, Math.min(1, (state.volume ?? 100) / 100)));
        if (state.speed && Number.isFinite(state.speed)) setPlaybackRate(state.speed);

        if (nextPosition > 10 && nextDuration > 0) {
          void savePlaybackProgress(filePath, nextPosition, nextDuration);
          setTick((n) => n + 1);
        }
      } catch {
        // mpv may be closing; the exit event closes the player.
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [duration, filePath, playbackEngine]);

  useEffect(() => {
    if (playbackEngine !== 'mpv') return () => undefined;
    return desktopApi.onMPVEvent((event) => {
      if (event === 'closed') onClose();
    });
  }, [onClose, playbackEngine]);

  // ─── Player binding, events, and fallback ────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (playbackEngine !== 'html5' || !video || !streamUrl) return;

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

    if (isHlsSource) {
      if (isSupported()) {
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
          void video.play().catch(() => setPaused(true));
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
        hls.on(Events.ERROR, (_event, data) => {
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
            void startTranscodedFallback(restartAt, { force: true });
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
      applyNativeTextTrackVisibility();
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
      void video.play().catch(() => setPaused(true));
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
      setPaused(true);
      if (autoplayNextEnabled && nextEpisodeFile) scheduleNextEpisode();
    };

    const onError = () => {
      if (sourceToken !== sourceLoadTokenRef.current) return;
      setPaused(true);
      if (!isHlsSource && !didTryTranscodeRef.current) {
        setStatusMessage('Trying local compatible stream...');
        const fallbackStart = video.currentTime > 0
          ? video.currentTime
          : getPlayableStartPosition(filePath, probedDurationRef.current);
        void startTranscodedFallback(fallbackStart, { force: true });
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
    video.autoplay = true;
    if (!isManagedHls) {
      video.load();
      void video.play().catch(() => setPaused(true));
    }

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      onPlayable();
    }

    return () => {
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
    playbackEngine,
    hasEpisodes,
    autoplayNextEnabled,
    nextEpisodeFile,
    clearHls,
    clearVideoElement,
    applyNativeTextTrackVisibility,
    startTranscodedFallback,
    scheduleNextEpisode,
  ]);

  // ─── Auto-hide controls ────────────────────────────────────────────────────

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    setShowTopControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (playbackEngine === 'mpv' ? !paused : !videoRef.current?.paused) {
        setShowControls(false);
        setShowTopControls(false);
      }
    }, CONTROLS_HIDE_MS);
  }, [paused, playbackEngine]);

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
    void stopTranscodeSession();
    void desktopApi.closeMPV();
  }, [stopTranscodeSession]);

  // ─── Controls ──────────────────────────────────────────────────────────────

  const togglePlay = useCallback(() => {
    if (playerState === 'loading') return;
    if (playbackEngine === 'mpv') {
      void desktopApi.toggleMPVPause();
      setPaused((value) => !value);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.paused ? void video.play() : video.pause();
  }, [playbackEngine, playerState]);

  const handleClose = useCallback((event?: React.SyntheticEvent) => {
    event?.preventDefault();
    void desktopApi.closeMPV();
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
    if (playbackEngine === 'mpv') {
      const nextFullscreen = !fullscreen;
      setFullscreen(nextFullscreen);
      void desktopApi.setMPVFullscreen(nextFullscreen);
      return;
    }

    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      void el.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  }, [fullscreen, playbackEngine]);

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
    if (playbackEngine === 'mpv') {
      void desktopApi.setMPVSpeed(playbackRate);
    } else if (video) {
      video.playbackRate = playbackRate;
    }
  }, [playbackEngine, playbackRate, streamUrl]);

  useEffect(() => {
    if (playbackEngine !== 'mpv') return;
    void desktopApi.setMPVAspectMode(aspectMode);
  }, [aspectMode, playbackEngine]);

  useEffect(() => {
    applyNativeTextTrackVisibility();
    if (playbackEngine === 'mpv') {
      void desktopApi.setMPVSubtitleStyle(subtitleStyle);
    }
  }, [applyNativeTextTrackVisibility, playbackEngine, subtitleStyle]);

  const seekTo = useCallback((targetSeconds: number) => {
    const nextPosition = clampSeconds(targetSeconds, duration || undefined);
    setPosition(nextPosition);

    if (playbackEngine === 'mpv') {
      void desktopApi.seekMPV(nextPosition, 'absolute');
      return;
    }

    if (streamIsTranscoded) {
      hlsTranscodeRestartAttemptsRef.current = 0;
      void startTranscodedFallback(nextPosition, { force: true });
      return;
    }

    const video = videoRef.current;
    if (!video) return;
    const directDuration = Number.isFinite(video.duration) ? video.duration : duration;
    video.currentTime = clampSeconds(nextPosition, directDuration || undefined);
  }, [duration, playbackEngine, startTranscodedFallback, streamIsTranscoded]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * duration);
  }, [duration, seekTo]);

  const handleVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    setMuted(v === 0);
    if (playbackEngine === 'mpv') {
      void desktopApi.setMPVVolume(v * 100);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.volume = v;
    video.muted = v === 0;
  }, [playbackEngine]);

  const toggleMute = useCallback(() => {
    if (playbackEngine === 'mpv') {
      void desktopApi.toggleMPVMute();
      setMuted((value) => !value);
      return;
    }
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }, [playbackEngine]);

  const restartForTrackChange = useCallback(() => {
    if (!streamUrl) return;
    applyNativeTextTrackVisibility();
    didTryTranscodeRef.current = false;
    hlsTranscodeRestartAttemptsRef.current = 0;
    void startTranscodedFallback(position, { force: true });
  }, [applyNativeTextTrackVisibility, position, startTranscodedFallback, streamUrl]);

  const applySubtitleStyleToStream = useCallback(() => {
    applyNativeTextTrackVisibility();
    if (playbackEngine === 'mpv') {
      void desktopApi.setMPVSubtitleStyle(subtitleStyle);
      return;
    }
    if (streamIsTranscoded && selectedSubtitleTrackIndexRef.current >= 0) {
      hlsTranscodeRestartAttemptsRef.current = 0;
      void startTranscodedFallback(position, { force: true });
    }
  }, [applyNativeTextTrackVisibility, playbackEngine, position, startTranscodedFallback, streamIsTranscoded, subtitleStyle]);

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
    if (playbackEngine === 'mpv') {
      void desktopApi.selectMPVTrack(mpvTrackType('video'), trackIndex);
      return;
    }
    restartForTrackChange();
  }, [playbackEngine, restartForTrackChange]);

  const selectAudioTrack = useCallback((trackIndex: number) => {
    const selectedTrack = probeTracksRef.current.find((track) => track.index === trackIndex && track.type === 'audio');
    saveTrackPreference(trackPreferenceScopeKey, 'audio', selectedTrack, trackIndex >= 0);
    selectedAudioTrackIndexRef.current = trackIndex;
    setSelectedAudioTrackIndex(trackIndex);
    if (playbackEngine === 'mpv') {
      void desktopApi.selectMPVTrack(mpvTrackType('audio'), trackIndex);
      return;
    }
    restartForTrackChange();
  }, [playbackEngine, restartForTrackChange, trackPreferenceScopeKey]);

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
    if (playbackEngine === 'mpv') {
      void desktopApi.selectMPVTrack(mpvTrackType('subtitle'), trackIndex);
      return;
    }
    restartForTrackChange();
  }, [applyNativeTextTrackVisibility, playbackEngine, restartForTrackChange, trackPreferenceScopeKey]);

  const changeVolume = useCallback((delta: number) => {
    const currentVolume = playbackEngine === 'mpv'
      ? volume
      : videoRef.current?.volume ?? volume;
    const nextVolume = Math.min(1, Math.max(0, currentVolume + delta));
    setVolume(nextVolume);
    setMuted(nextVolume === 0);

    if (playbackEngine === 'mpv') {
      void desktopApi.setMPVVolume(nextVolume * 100);
      return;
    }

    const video = videoRef.current;
    if (!video) return;
    video.volume = nextVolume;
    video.muted = nextVolume === 0;
  }, [playbackEngine, volume]);

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
    return ep?.title
      ? `${epCode(currentSeason, currentEpisode)} – ${cleanEpisodeTitle(ep.title, currentSeason, currentEpisode)}`
      : epCode(currentSeason, currentEpisode);
  }, [currentEpisode, currentSeason, episodes, hasEpisodes]);

  const nextEpLabel = useMemo(() => {
    if (!nextEpisodeFile) return null;
    const ep = episodes.find((item) =>
      item.season === nextEpisodeFile.season && item.number === nextEpisodeFile.episode,
    );
    return ep?.title
      ? `${epCode(nextEpisodeFile.season, nextEpisodeFile.episode)} - ${cleanEpisodeTitle(ep.title, nextEpisodeFile.season, nextEpisodeFile.episode)}`
      : epCode(nextEpisodeFile.season, nextEpisodeFile.episode);
  }, [episodes, nextEpisodeFile]);

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
          className={`absolute top-3 left-3 z-40 flex h-10 items-center gap-2 rounded-lg border border-white/20 bg-black/55 px-3 text-sm text-white shadow-lg backdrop-blur-md transition-opacity duration-200 hover:bg-white/10 hover:text-[var(--loom-accent)] ${showTopControls ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          aria-label="Back"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>

        <div className={`pointer-events-none absolute top-3 left-1/2 z-40 max-w-[60%] -translate-x-1/2 rounded-full border border-white/10 bg-black/35 px-4 py-1.5 text-center text-xs font-medium text-white/80 shadow-lg backdrop-blur-md transition-opacity duration-200 ${showTopControls ? 'opacity-100' : 'opacity-0'}`}>
          <span className="block truncate">{currentEpLabel ?? title}</span>
        </div>

        <button
          onClick={(event) => {
            event.stopPropagation();
            handleClose();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          className={`absolute right-3 top-3 z-40 grid h-10 w-10 place-items-center rounded-lg border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-md transition-opacity duration-200 hover:bg-white/10 hover:text-[var(--loom-accent)] ${showTopControls ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
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

        {nextCountdown !== null && nextEpisodeFile && (
          <div
            className="absolute inset-0 z-30 flex items-end justify-end bg-gradient-to-t from-black/85 via-black/20 to-transparent p-6"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <div className="w-full max-w-sm rounded-lg border border-white/15 bg-black/70 p-4 text-white shadow-2xl backdrop-blur-md">
              <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--loom-accent)]">Up next</p>
              <p className="mt-1 truncate text-sm font-semibold">{nextEpLabel || epCode(nextEpisodeFile.season, nextEpisodeFile.episode)}</p>
              <p className="mt-2 text-xs text-white/65">Playing in {nextCountdown}</p>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => goToEpisode(nextEpisodeFile.season, nextEpisodeFile.episode)}
                  className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-white/85"
                >
                  Play now
                </button>
                <button
                  onClick={clearNextEpisodeCountdown}
                  className="rounded-md border border-white/20 px-3 py-1.5 text-xs font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Cancel
                </button>
              </div>
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
            <div className="h-full rounded-full bg-[var(--loom-accent)] pointer-events-none" style={{ width: `${progressPct}%` }} />
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3.5 w-3.5 rounded-full bg-white shadow opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
              style={{ left: `${progressPct}%` }}
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={togglePlay}
              className="grid h-12 w-12 shrink-0 place-items-center rounded-full text-white transition-colors hover:bg-white/10 hover:text-[var(--loom-accent)]"
              title={paused ? 'Play' : 'Pause'}
            >
              {paused ? <Play className="h-6 w-6 fill-current" /> : <Pause className="h-6 w-6 fill-current" />}
            </button>

            <button
              onClick={() => seekTo(position - 10)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              title="Back 10s"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            <button
              onClick={() => seekTo(position + 30)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
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
                <button
                  onClick={handlePrevEpisode}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  title="Previous episode"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={handleNextEpisode}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  title="Next episode"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </>
            )}

            <button
              onClick={toggleMute}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              title={muted || volume === 0 ? 'Unmute' : 'Mute'}
            >
              {muted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={handleVolume}
              className="w-20 accent-[var(--loom-accent)] cursor-pointer"
            />

            <button
              onClick={openMediaPanel}
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white ${showMediaPanel ? 'text-[var(--loom-accent)]' : ''}`}
              title="Video, audio, and subtitle controls"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>

            {hasEpisodes && (
              <button
                onClick={openEpisodePanel}
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white ${showSidebar ? 'text-[var(--loom-accent)]' : ''}`}
                title="Episode list"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2}>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                </svg>
              </button>
            )}

            <button
              onClick={toggleFullscreen}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {fullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
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
                        onMouseUp={applySubtitleStyleToStream}
                        onTouchEnd={applySubtitleStyleToStream}
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
                        onMouseUp={applySubtitleStyleToStream}
                        onTouchEnd={applySubtitleStyleToStream}
                        className="w-full accent-[var(--loom-accent)]"
                      />
                    </div>
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
                        ${!file ? 'cursor-not-allowed opacity-30' : ''}
                        ${watched && !isCurrent ? 'opacity-50' : ''}`}
                    >
                      {(inProgress || isCurrent) && progFrac > 0 && (
                        <span
                          className={`pointer-events-none absolute bottom-0 left-0 h-0.5 ${isCurrent ? 'bg-[var(--loom-accent)]' : 'bg-amber-400'}`}
                          style={{ width: `${Math.min(100, progFrac * 100)}%` }}
                        />
                      )}
                      <span className={`w-12 shrink-0 font-mono text-[10px] ${isCurrent ? 'text-[var(--loom-accent)]' : 'text-[#555]'}`}>
                        {epCode(ep.season, ep.number)}
                      </span>
                      <span className={`min-w-0 flex-1 truncate text-xs leading-snug ${isCurrent ? 'font-medium text-[var(--loom-accent)]' : watched ? 'text-[#555]' : 'text-white'}`}>
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
