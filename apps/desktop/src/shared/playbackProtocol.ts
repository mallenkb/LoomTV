/**
 * Playback-engine-neutral data shared by native desktop adapters.
 *
 * MPV and LibVLC each translate these values to their own native API. Keeping
 * this contract separate prevents a new engine from having to pretend it is
 * an MPV implementation merely to participate in the player lifecycle.
 */
export type PlaybackTrack = {
  id: number;
  type: 'video' | 'audio' | 'subtitle';
  codec?: string;
  language?: string;
  title?: string;
  channels?: number;
  default?: boolean;
  forced?: boolean;
  selected?: boolean;
  external?: boolean;
  source: 'embedded' | 'sidecar' | 'opensubtitles';
};

export type PlaybackDiagnostics = {
  hardwareDecoder?: string;
  hardwareDecode?: boolean;
  frameDrops?: number;
  decoderFrameDrops?: number;
  bufferSeconds?: number;
  buffering?: boolean;
  videoCodec?: string;
  estimatedFps?: number;
};

export type PlaybackState = {
  sessionId: string;
  status: 'starting' | 'loading' | 'ready' | 'ended' | 'error' | 'closed';
  position?: number;
  duration?: number;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
  speed?: number;
  tracks?: PlaybackTrack[];
  videoWidth?: number;
  videoHeight?: number;
  diagnostics?: PlaybackDiagnostics;
  error?: string;
};

/**
 * The renderer's video viewport in WebContents/CSS pixels, measured from the
 * top-left of the Electron content view. The macOS native host converts this
 * to AppKit's bottom-left coordinate system before framing its NSView.
 */
export type PlaybackViewport = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PlaybackStartOptions = {
  startSeconds?: number;
  volume?: number;
  muted?: boolean;
  speed?: number;
  /** Preferred embedded audio track resolved from the saved per-profile preference. */
  audioTrackId?: number;
  /** Semantic fallback used when a native engine's runtime IDs differ from probe stream indexes. */
  audioLanguage?: string;
  audioDelay?: number;
  subtitleDelay?: number;
  subtitleStyle?: {
    fontSize: number;
    color: string;
    borderColor: string;
    borderWidth: number;
    backgroundColor: string;
    position: number;
  };
  subtitleFiles?: Array<{ path: string; source: 'sidecar' | 'opensubtitles' }>;
  /** Keep native subtitles available as a fallback when the Loom overlay has no usable cues. */
  nativeSubtitles?: boolean;
};

export type PlaybackCommand =
  | { type: 'set-paused'; paused: boolean }
  | { type: 'seek'; position: number }
  | { type: 'set-volume'; volume: number }
  | { type: 'set-muted'; muted: boolean }
  | { type: 'set-speed'; speed: number }
  | { type: 'set-video-track'; trackId: number | null }
  | { type: 'set-audio-track'; trackId: number | null }
  | { type: 'set-subtitle-track'; trackId: number | null }
  | { type: 'set-secondary-subtitle-track'; trackId: number | null }
  | { type: 'set-subtitle-delay'; seconds: number }
  | { type: 'set-audio-delay'; seconds: number }
  | { type: 'set-subtitle-style'; fontSize: number; color: string; borderColor: string; borderWidth: number; backgroundColor: string; position: number }
  | { type: 'set-video-aspect'; aspect: string | null }
  | { type: 'set-video-crop'; crop: string | null }
  | { type: 'set-video-rotation'; degrees: number };
