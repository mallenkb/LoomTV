export type MediaBackend = 'html5' | 'hls';

export interface MediaTrack {
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

export interface ProbeResult {
  filePath: string;
  container?: string;
  durationSeconds?: number;
  bitrateKbps?: number;
  videoCodec?: string;
  audioCodec?: string;
  resolution?: { width?: number; height?: number };
  subtitleStreams: MediaTrack[];
  tracks: MediaTrack[];
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SubtitleStyleOptions {
  delaySeconds?: number;
  position?: number;
  scale?: number;
  fontSize?: number;
  fontColor?: string;
  borderColor?: string;
  borderWidth?: number;
  backgroundColor?: string;
}

export interface TranscodeOptions {
  preset?: 'auto' | 'software' | 'videotoolbox' | 'nvenc' | 'qsv';
  startSeconds?: number;
  videoTrackIndex?: number;
  audioTrackIndex?: number;
  subtitleTrackIndex?: number;
  subtitleStreamOrdinal?: number;
  subtitleCodec?: string;
  secondarySubtitleTrackIndex?: number;
  secondarySubtitleStreamOrdinal?: number;
  secondarySubtitleCodec?: string;
  subtitleStyle?: SubtitleStyleOptions;
  forceTranscode?: boolean;
}

export interface TranscodeSession {
  sessionId: string;
  filePath: string;
  playlistUrl: string;
  outputDir: string;
}
