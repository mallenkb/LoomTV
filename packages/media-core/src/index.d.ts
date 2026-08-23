export type TranscodeCodec = 'h264' | 'hevc' | 'av1';
export type ProfileType = 'owner' | 'standard' | 'kid' | 'guest';

export const MEDIA_CORE_CONTRACT_VERSION: 3;
export const VIDEO_EXTENSIONS: readonly string[];
export const TRANSCODE_CODECS: readonly TranscodeCodec[];
export const PROFILE_TYPES: readonly ProfileType[];

export function isVideoFilePath(filePath: string): boolean;
export function createMediaItemId(filePath: string): string;
export function normalizeTranscodeCodec(value: unknown, fallback?: TranscodeCodec): TranscodeCodec;

export interface PlaybackProfileInput {
  codec?: unknown;
  targetVideoCodec?: unknown;
  maxWidth?: unknown;
  maxHeight?: unknown;
  videoBitrateKbps?: unknown;
  audioBitrateKbps?: unknown;
  toneMap?: unknown;
}

export interface NormalizedPlaybackProfile {
  codec: TranscodeCodec;
  maxWidth: number;
  maxHeight: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  toneMap: boolean;
}

export function normalizePlaybackProfile(input?: PlaybackProfileInput): NormalizedPlaybackProfile;

export interface ClientPlaybackCapabilitiesInput {
  contractVersion?: unknown;
  containers?: unknown;
  videoCodecs?: unknown;
  audioCodecs?: unknown;
  streamingProtocols?: unknown;
  subtitleModes?: unknown;
  hdrFormats?: unknown;
  supportsHls?: unknown;
  supportsHdr?: unknown;
  supportsTextSubtitles?: unknown;
  maxWidth?: unknown;
  maxHeight?: unknown;
  maxVideoBitrateKbps?: unknown;
}

export interface NormalizedClientPlaybackCapabilities {
  contractVersion: 1;
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  streamingProtocols: Array<'http' | 'hls'>;
  subtitleModes: Array<'text' | 'bitmap' | 'burn-in' | 'external'>;
  hdrFormats: Array<'hdr10' | 'hdr10-plus' | 'hlg' | 'dolby-vision'>;
  supportsHls: boolean;
  supportsHdr: boolean;
  supportsTextSubtitles: boolean;
  maxWidth: number;
  maxHeight: number;
  maxVideoBitrateKbps: number;
}

export type PlaybackPlanMode = 'direct' | 'remux' | 'transcode';

export interface MediaTrackProbe {
  id: string;
  index: number;
  kind: 'video' | 'audio' | 'subtitle' | 'data' | 'unknown';
  codec: string;
  language?: string;
  title?: string;
  channels?: number;
  width?: number;
  height?: number;
  profile?: string;
  pixelFormat?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  frameRate?: number;
  default: boolean;
  forced: boolean;
  external?: boolean;
}

export interface MediaProbe {
  sourceId: string;
  container: string;
  durationSeconds?: number;
  bitrateKbps?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  hdr: boolean;
  hdrFormat?: 'hdr10' | 'hdr10-plus' | 'hlg' | 'dolby-vision';
  tracks: MediaTrackProbe[];
  chapters: Array<{ startMs: number; endMs: number; title: string }>;
  probedAt: number;
  adapterGaps: Array<'external_sidecar_subtitles'>;
}

export interface PlaybackSelectionRequest {
  videoTrackId?: string;
  audioTrackId?: string | null;
  subtitleTrackId?: string | null;
  startSeconds?: number;
}

export interface PlaybackPlan {
  contractVersion: 1;
  mode: PlaybackPlanMode;
  transport: 'http' | 'hls';
  reasonCode: string;
  reason: string;
  sourceId: string;
  sourceAction: 'direct' | 'transcode';
  selectedVideoTrackId: string;
  selectedAudioTrackId?: string;
  selectedSubtitleTrackId?: string;
  outputContainer: string;
  outputVideoCodec: string;
  outputAudioCodec?: string;
  burnSubtitles: boolean;
  toneMap: boolean;
  maxWidth?: number;
  maxHeight?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps: number;
  codec: string;
  backend: string;
  copyVideo: boolean;
  copyAudio: boolean;
  requiresFfmpeg: boolean;
  selectedVideoTrackIndex: number;
  selectedAudioTrackIndex?: number;
  selectedSubtitleTrackIndex?: number;
  selectedSubtitleTrackOrdinal?: number;
  facts: {
    sourceId: string;
    sourceState: string;
    container: string;
    videoCodec: string;
    audioCodec: string;
    width: number;
    height: number;
    bitrate: number;
    hdr: boolean;
    hdrFormat: string | null;
    tracks: MediaTrackProbe[];
  };
}

export function normalizeClientPlaybackCapabilities(input?: ClientPlaybackCapabilitiesInput): NormalizedClientPlaybackCapabilities;
export function playbackPlanForMedia(
  media?: Record<string, unknown>,
  input?: ClientPlaybackCapabilitiesInput | { capabilities?: ClientPlaybackCapabilitiesInput },
  request?: PlaybackSelectionRequest,
): PlaybackPlan;
export function ffprobeMediaArguments(filePath: string): string[];
export function parseFfprobeMediaProbe(
  raw: string | Buffer | Record<string, unknown>,
  options?: { sourceId?: string; probedAt?: number },
): MediaProbe;
export function normalizeProfileType(value: unknown, fallback?: ProfileType): ProfileType;

export interface PortableProfile {
  id: string;
  name: string;
  type: ProfileType;
  hasPin: boolean;
  isGuest: boolean;
}

export function profileView(profile: unknown): PortableProfile | null;

export interface CleanedMediaTitle {
  title: string;
  year: number;
}

export interface EpisodeNumbers {
  season: number;
  episode: number;
}

export interface VideoClassification {
  kind: 'movie' | 'episode';
  title: string;
  year?: number;
  animeLikely: boolean;
  series?: {
    title: string;
    season: number;
    episode: number | null;
  };
}

export function cleanMediaTitle(name: string): CleanedMediaTitle;
export function isLikelyEpisodeFileName(name: string): boolean;
export function parseEpisodeFileName(
  fileName: string,
  fallbackSeason: number,
  options?: { aggressive?: boolean },
): EpisodeNumbers | null;
export function seriesTitleFromEpisodeName(fileName: string): string | null;
export function isLikelyAnimePath(filePath: string, title?: string): boolean;
export function classifyVideoFile(relativePath: string): VideoClassification;
