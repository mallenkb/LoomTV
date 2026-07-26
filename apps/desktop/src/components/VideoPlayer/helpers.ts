import { cleanEpisodeTitleForDisplay, episodeCode } from '../../lib/episodeTitles.ts';
import { getProgressState } from '../../lib/progress.ts';
import { desktopApi } from '../../lib/desktopApi.ts';
import {
  AUTOPLAY_NEXT_EPISODE_KEY,
  DEFAULT_MEDIA_PANEL_WIDTH,
  MAX_SIDE_PANEL_RATIO,
  MIN_SIDE_PANEL_WIDTH,
  SUBTITLES_DEFAULT_KEY,
} from './constants';
import type {
  MediaTrack,
  PlaybackTrackPreferences,
  ProbeData,
  TrackPreference,
  TrackPreferenceType,
} from './types';

export function cleanEpisodeTitle(raw: string, season: number, episode: number): string {
  if (!raw) return `Episode ${episode}`;
  const officialTitle = cleanEpisodeTitleForDisplay(raw, undefined, season, episode);
  if (officialTitle !== `Episode ${episode}`) return officialTitle;
  let s = raw;
  s = s.replace(new RegExp(`^.*?[Ss]0*${season}\\s*[Ee]0*${episode}\\s*[-–_.\\s]*`, ''), '');
  s = s.replace(
    /[\s._-]*(?:\[|\()?(?:2160p|1080p|720p|480p|4K|BluRay|BDRip|WEB-DL|WEBRip|HDTV|AMZN|NF|DSNP|x264|x265|H\.264|H\.265|HEVC|AAC|AC3|DTS|SAMPA)\b.*$/i,
    '',
  );
  s = s.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || `Episode ${episode}`;
}

export function epCode(season: number, episode: number): string {
  return episodeCode(season, episode);
}

export function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function probeDurationSeconds(value: unknown): number {
  const duration = (value as ProbeData | undefined)?.durationSeconds;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function probeTracks(value: unknown): MediaTrack[] {
  const tracks = (value as ProbeData | undefined)?.tracks;
  return Array.isArray(tracks) ? tracks : [];
}

export function clampSeconds(value: number, max?: number): number {
  const safeValue = Number.isFinite(value) ? value : 0;
  const safeMax = typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : undefined;
  return Math.max(0, safeMax ? Math.min(safeValue, safeMax) : safeValue);
}

function maxSidePanelWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_MEDIA_PANEL_WIDTH;
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.floor(window.innerWidth * MAX_SIDE_PANEL_RATIO));
}

export function clampSidePanelWidth(value: number): number {
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.min(value, maxSidePanelWidth()));
}

export function trackLabel(track: MediaTrack, ordinal: number): string {
  const languageName = trackLanguageName(track.language);
  const language = track.language
    ? languageName
      ? `${languageName} [${track.language}] `
      : `[${track.language}] `
    : '';
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

function subtitleOrdinal(tracks: MediaTrack[], streamIndex: number): number {
  return tracks.filter((track) => track.type === 'subtitle').findIndex((track) => track.index === streamIndex);
}

export function selectedEmbeddedSubtitle(tracks: MediaTrack[], streamIndex: number): { track: MediaTrack; ordinal: number } | null {
  if (streamIndex < 0) return null;
  const track = tracks.find((candidate) => candidate.type === 'subtitle' && candidate.index === streamIndex);
  if (!track) return null;
  const ordinal = subtitleOrdinal(tracks, streamIndex);
  return ordinal >= 0 ? { track, ordinal } : null;
}

export function externalSubtitleOrdinal(tracks: MediaTrack[], streamIndex: number): number {
  return tracks.findIndex((track) => track.index === streamIndex);
}

export function firstTrackIndex(tracks: MediaTrack[], type: MediaTrack['type']): number {
  return tracks.find((track) => track.type === type)?.index ?? -1;
}

function normalizeTrackField(value?: string): string {
  return (value || '').trim().toLowerCase();
}

const SIGNS_ONLY_SUBTITLE_PATTERNS = [
  /\bsigns?\b/,
  /\bsongs?\b/,
  /\bs&s\b/,
  /\bkaraoke\b/,
  /\btypesett?ing\b/,
];

export function isSignsOnlySubtitleTrack(track: MediaTrack): boolean {
  const title = normalizeTrackField(track.title);
  if (!title) return false;
  if (/\bfull\b|\bdialogu?e\b|\bcomplete\b/.test(title)) return false;
  return SIGNS_ONLY_SUBTITLE_PATTERNS.some((pattern) => pattern.test(title));
}

export function firstSubtitleTrackIndex(tracks: MediaTrack[]): number {
  const candidates = tracks.filter((track) => track.type === 'subtitle');
  if (candidates.length === 0) return -1;

  const dialogue = candidates.filter((track) => !track.forced && !isSignsOnlySubtitleTrack(track));
  const fullSubtitle = dialogue.find((track) => track.default)
    || dialogue.find((track) => normalizeTrackField(track.language).startsWith('en'))
    || dialogue[0]
    || candidates.find((track) => track.default && !track.forced)
    || candidates.find((track) => normalizeTrackField(track.language).startsWith('en') && !track.forced)
    || candidates.find((track) => !track.forced);

  return (fullSubtitle || candidates[0]).index;
}

export function trackPreferenceScope(mediaId: string | undefined, filePath: string): string {
  return mediaId ? `media:${mediaId}` : `file:${filePath}`;
}

const PROFILE_TRACK_PREFERENCE_SCOPE = 'player:defaults';

async function loadStoredTrackPreferences(scope: string): Promise<PlaybackTrackPreferences> {
  try {
    const preferences = await desktopApi.getPlaybackTrackPreferences(scope);
    return preferences && !('audio' in preferences || 'subtitle' in preferences) ? {} : preferences as PlaybackTrackPreferences;
  } catch {
    return {};
  }
}

export async function loadSharedTrackPreferences(scope: string): Promise<PlaybackTrackPreferences> {
  if (scope === PROFILE_TRACK_PREFERENCE_SCOPE) {
    return loadStoredTrackPreferences(scope);
  }

  const [profileDefaults, scopedPreferences] = await Promise.all([
    loadStoredTrackPreferences(PROFILE_TRACK_PREFERENCE_SCOPE),
    loadStoredTrackPreferences(scope),
  ]);
  return {
    ...profileDefaults,
    ...scopedPreferences,
  };
}

const trackPreferenceSaveQueues = new Map<string, Promise<void>>();
const TRACK_PREFERENCE_SAVE_QUEUE = 'player:preferences';

export function saveTrackPreference(
  scope: string,
  type: TrackPreferenceType,
  track: MediaTrack | undefined,
  enabled: boolean,
): TrackPreference {
  const preference: TrackPreference = {
    enabled,
    index: track?.index,
    language: normalizeTrackField(track?.language),
    title: normalizeTrackField(track?.title),
    codec: normalizeTrackField(track?.codec),
    forced: track?.forced,
  };
  const previousSave = trackPreferenceSaveQueues.get(TRACK_PREFERENCE_SAVE_QUEUE) ?? Promise.resolve();
  const queuedSave = previousSave.then(async () => {
    try {
      const active = await desktopApi.getActiveProfileState();
      const storageScopes = Array.from(new Set([PROFILE_TRACK_PREFERENCE_SCOPE, scope]));
      for (const storageScope of storageScopes) {
        const existing = await loadStoredTrackPreferences(storageScope);
        const nextPreferences = {
          ...existing,
          [type]: preference,
        };
        await desktopApi.savePlaybackTrackPreferences(storageScope, nextPreferences, active.profileId || undefined);
      }
    } catch {
      // Track selection still applies for the current session.
    }
  });
  trackPreferenceSaveQueues.set(TRACK_PREFERENCE_SAVE_QUEUE, queuedSave);
  void queuedSave.finally(() => {
    if (trackPreferenceSaveQueues.get(TRACK_PREFERENCE_SAVE_QUEUE) === queuedSave) {
      trackPreferenceSaveQueues.delete(TRACK_PREFERENCE_SAVE_QUEUE);
    }
  });
  return preference;
}

export function preferredTrackIndex(tracks: MediaTrack[], type: TrackPreferenceType, preference?: TrackPreference): number | null {
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

  // Stream indexes are file-local and may refer to a different language in
  // the next episode, so use the saved index only when semantic metadata did
  // not identify a matching track.
  return scopedCandidates.find((track) => track.index === preference.index)?.index ?? null;
}

export function subtitleSource(url: string, serverBase: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  if (!serverBase) return url;
  return `${serverBase}${url.startsWith('/') ? url : `/${url}`}`;
}

function hlsResponseCode(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const response = (data as { response?: { code?: unknown } }).response;
  return typeof response?.code === 'number' ? response.code : undefined;
}

export function hlsErrorSummary(data: unknown): string {
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

export function shouldRestartMissingLocalHls(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const detail = String((data as { details?: unknown }).details || '');
  const statusCode = hlsResponseCode(data);
  return statusCode === 404 && /manifest|level/i.test(detail);
}

export function getStoredDuration(filePath: string): number {
  return getProgressState(filePath).duration;
}

export function loadSubtitlesDefaultEnabled(): boolean {
  try {
    return localStorage.getItem(SUBTITLES_DEFAULT_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function saveSubtitlesDefaultEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SUBTITLES_DEFAULT_KEY, enabled ? 'true' : 'false');
  } catch (_error) {
    // Ignore storage failures; subtitles still work for this session.
  }
}

export function loadAutoplayNextEpisode(): boolean {
  try {
    return localStorage.getItem(AUTOPLAY_NEXT_EPISODE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function saveAutoplayNextEpisode(enabled: boolean): void {
  try {
    localStorage.setItem(AUTOPLAY_NEXT_EPISODE_KEY, enabled ? 'true' : 'false');
  } catch (_error) {
    // Autoplay still applies for the current session.
  }
}

export function isInProgress(filePath: string, duration?: number): boolean {
  return getProgressState(filePath, duration).inProgress;
}

export function mediaErrorMessage(error: MediaError | null): string {
  if (!error) return 'Playback error';
  if (error.message) return error.message;
  return `Playback error (${error.code})`;
}

export function transcodeErrorMessage(error: unknown): string {
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

export type SubtitleCue = { start: number; end: number; text: string };

const BITMAP_SUBTITLE_CODECS = [
  'hdmv_pgs_subtitle',
  'pgssub',
  'pgs',
  'dvd_subtitle',
  'dvdsub',
  'dvb_subtitle',
  'dvbsub',
  'xsub',
];

export function isBitmapSubtitleCodec(codec?: string): boolean {
  const normalized = (codec || '').toLowerCase();
  return BITMAP_SUBTITLE_CODECS.some((entry) => normalized.includes(entry));
}

function parseVttTimestamp(value: string): number {
  const parts = value.trim().split(':');
  if (parts.length < 2) return NaN;
  const seconds = parseFloat((parts.pop() || '').replace(',', '.'));
  const minutes = parseInt(parts.pop() || '0', 10);
  const hours = parts.length ? parseInt(parts.pop() || '0', 10) : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

export function parseVttCues(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    const arrowIndex = lines.findIndex((line) => line.includes('-->'));
    if (arrowIndex === -1) continue;
    const [startRaw, restRaw] = lines[arrowIndex].split('-->');
    const endRaw = (restRaw || '').trim().split(/\s+/)[0] || '';
    const start = parseVttTimestamp(startRaw);
    const end = parseVttTimestamp(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = lines
      .slice(arrowIndex + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}
