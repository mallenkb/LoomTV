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
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  /** Frames per second, resolved from ffprobe's rational frame rate. */
  frameRate?: number;
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
  preset?: 'auto' | 'software' | 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'rkmpp';
  targetVideoCodec?: 'h264' | 'hevc' | 'av1';
  softwareVideoEncoder?: 'libx264' | 'libx265' | 'libsvtav1' | 'libaom-av1';
  maxWidth?: number;
  maxHeight?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  toneMap?: boolean;
  startSeconds?: number;
  videoTrackIndex?: number;
  audioTrackIndex?: number;
  subtitleTrackIndex?: number;
  subtitleStreamOrdinal?: number;
  subtitleCodec?: string;
  subtitleFilePath?: string;
  secondarySubtitleTrackIndex?: number;
  secondarySubtitleStreamOrdinal?: number;
  secondarySubtitleCodec?: string;
  secondarySubtitleFilePath?: string;
  subtitleStyle?: SubtitleStyleOptions;
  forceTranscode?: boolean;
}

export interface TranscodeSession {
  sessionId: string;
  filePath: string;
  playlistUrl: string;
  outputDir: string;
  /**
   * True when the playlist is a full-duration VOD on the absolute timeline, so
   * the player can seek natively anywhere. False for the linear fallback used
   * when the media duration is unknown (player must offset by `startSeconds`).
   */
  seekable: boolean;
  /** Absolute timeline offset of the first segment (0 for seekable streams). */
  startSeconds: number;
  /** Encoder actually selected after capability checks and fallback. */
  preset?: 'software' | 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'rkmpp';
  /** Output codec selected for this session. */
  codec?: 'h264' | 'hevc' | 'av1';
}
