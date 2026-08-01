export type TranscodeCodec = 'h264' | 'hevc' | 'av1';
export type ProfileType = 'owner' | 'standard' | 'kid' | 'guest';

export const MEDIA_CORE_CONTRACT_VERSION: 1;
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
export function normalizeProfileType(value: unknown, fallback?: ProfileType): ProfileType;

export interface PortableProfile {
  id: string;
  name: string;
  type: ProfileType;
  hasPin: boolean;
  isGuest: boolean;
}

export function profileView(profile: unknown): PortableProfile | null;
