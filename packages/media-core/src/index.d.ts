export type TranscodeCodec = 'h264' | 'hevc' | 'av1';
export type ProfileType = 'owner' | 'standard' | 'kid' | 'guest';

export const MEDIA_CORE_CONTRACT_VERSION: 2;
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
  containers?: unknown;
  videoCodecs?: unknown;
  audioCodecs?: unknown;
  supportsHls?: unknown;
  supportsHdr?: unknown;
  supportsTextSubtitles?: unknown;
  maxWidth?: unknown;
  maxHeight?: unknown;
  maxVideoBitrateKbps?: unknown;
}

export interface NormalizedClientPlaybackCapabilities {
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  supportsHls: boolean;
  supportsHdr: boolean;
  supportsTextSubtitles: boolean;
  maxWidth: number;
  maxHeight: number;
  maxVideoBitrateKbps: number;
}

export type PlaybackPlanMode = 'direct' | 'remux' | 'direct-stream' | 'transcode';

export interface PlaybackPlan {
  mode: PlaybackPlanMode;
  reason: string;
  sourceAction: 'direct' | 'transcode';
  codec?: string;
  backend?: string;
  facts?: {
    container: string;
    videoCodec: string;
    audioCodec: string;
    width: number;
    height: number;
    bitrate: number;
    hdr: boolean;
  };
}

export function normalizeClientPlaybackCapabilities(input?: ClientPlaybackCapabilitiesInput): NormalizedClientPlaybackCapabilities;
export function playbackPlanForMedia(media?: Record<string, unknown>, input?: ClientPlaybackCapabilitiesInput): PlaybackPlan;
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
