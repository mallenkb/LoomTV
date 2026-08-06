import type { PlaybackCommand, PlaybackStartOptions, PlaybackState } from '@/shared/playbackProtocol';

export type PlaybackEngineKind = 'browser' | 'mpv' | 'libvlc';
export type PlaybackEngineState = PlaybackState;
export type PlaybackEngineSurface = 'composited-window' | 'external-window';
export type { PlaybackCommand, PlaybackStartOptions };

export interface PlaybackEngine {
  readonly kind: PlaybackEngineKind;
  readonly surface: PlaybackEngineSurface;
  load(filePath: string, options?: PlaybackStartOptions): Promise<boolean>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  selectVideo(trackId: number | null): Promise<void>;
  selectAudio(trackId: number | null): Promise<void>;
  selectSubtitle(trackId: number | null): Promise<void>;
  selectSecondarySubtitle(trackId: number | null): Promise<void>;
  setSubtitleDelay(seconds: number): Promise<void>;
  setAudioDelay(seconds: number): Promise<void>;
  setSubtitleStyle(style: { fontSize: number; color: string; borderColor: string; borderWidth: number; backgroundColor: string; position: number }): Promise<void>;
  setVideoAspect(aspect: string | null): Promise<void>;
  setVideoCrop(crop: string | null): Promise<void>;
  setVideoRotation(degrees: number): Promise<void>;
  destroy(): Promise<void>;
}

export type PlaybackEngineStateListener = (state: PlaybackEngineState) => void;
