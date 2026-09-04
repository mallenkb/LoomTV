import type { AudioTrack, SubtitleTrack, VideoSource } from 'expo-video';
import type { LocalMediaTrack, PlayTarget, StreamOptions, SubtitleRecord, TrackPreference } from './mobileDomain';
import { secureLanUrl } from './mobileSecureTransport';
import { filePathFromUrl } from './mobileLibrary';

export type PlayerAudioOption = {
  key: string;
  label: string;
  localTrack?: LocalMediaTrack;
  nativeTrack?: AudioTrack;
};

export type PlayerSubtitleOption = {
  key: string;
  label: string;
  localTrack?: LocalMediaTrack;
  nativeTrack?: SubtitleTrack;
  sidecar?: SubtitleRecord;
  streamOrdinal?: number;
};

export function isHlsPlaybackUrl(playbackUrl: string): boolean {
  return playbackUrl.includes('.m3u8') || playbackUrl.includes('/hls/');
}

export function videoSourceFor(playbackUrl: string, target?: PlayTarget | null, deviceToken?: string): VideoSource {
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

export function playbackUrlWithAnchor(url: string, startSeconds?: number): string {
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

export function playerDisplayLabels(target: PlayTarget): { topTitle: string; bottomTitle: string } {
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

export function hasStreamOptions(options: StreamOptions): boolean {
  return Boolean(options.forceTranscode)
    || typeof options.audioTrackIndex === 'number'
    || typeof options.subtitleTrackIndex === 'number'
    || Boolean(options.subtitleFilePath);
}

export function normalizeTrackField(value?: string): string {
  return (value || '').trim().toLowerCase();
}

export function playbackPreferenceScope(target: Pick<PlayTarget, 'mediaId' | 'streamPath'>): string {
  return target.mediaId ? `media:${target.mediaId}` : `file:${filePathFromUrl(target.streamPath)}`;
}

export function trackLanguageName(language?: string): string {
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

export function localTrackLabel(track: LocalMediaTrack, ordinal: number): string {
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

export function nativeTrackKey(track: { id?: string; language?: string; label?: string }, prefix: string, index: number): string {
  return `${prefix}-${track.id || `${track.language || ''}-${track.label || ''}` || index}`;
}

export function nativeTrackLabel(track: { language?: string; label?: string }, index: number): string {
  const languageCode = track.language?.trim();
  const languageName = trackLanguageName(languageCode);
  const language = languageCode
    ? languageName
      ? `${languageName} [${languageCode}]`
      : `[${languageCode}]`
    : '';
  return `#${index + 1} ${[language, track.label?.trim()].filter(Boolean).join(' ') || `Track ${index + 1}`}`;
}

export function sidecarSubtitleLabel(subtitle: SubtitleRecord, index: number): string {
  const languageCode = subtitle.lang?.trim();
  const languageName = trackLanguageName(languageCode);
  const language = languageCode
    ? languageName
      ? `${languageName} [${languageCode}]`
      : `[${languageCode}]`
    : '';
  return `#${index + 1} ${[language, subtitle.label?.trim()].filter(Boolean).join(' ') || `Subtitle ${index + 1}`}`;
}

export function audioPreference(option: PlayerAudioOption | undefined, enabled: boolean): TrackPreference {
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

export function subtitlePreference(option: PlayerSubtitleOption | null, enabled: boolean): TrackPreference {
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

export function optionMatchesPreference(
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

export function preferredAudioKey(options: PlayerAudioOption[], preference?: TrackPreference): string {
  if (!preference?.enabled) return options[0]?.key || '';
  return options.find((option) => optionMatchesPreference(option, preference, 'audio'))?.key || options[0]?.key || '';
}

export function preferredSubtitleKey(options: PlayerSubtitleOption[], preference?: TrackPreference): string {
  if (!preference) return 'off';
  if (!preference.enabled) return 'off';
  return options.find((option) => optionMatchesPreference(option, preference, 'subtitle'))?.key || 'off';
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function mobileSeekAccessibilityText(position: number, duration: number): string {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safePosition = Math.max(0, Math.min(position, safeDuration || Math.max(0, position)));
  return `Elapsed ${formatClock(safePosition)}; remaining -${formatClock(Math.max(0, safeDuration - safePosition))}; total ${formatClock(safeDuration)}`;
}
