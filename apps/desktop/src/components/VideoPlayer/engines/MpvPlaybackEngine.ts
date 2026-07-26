import { desktopApi, type MpvCommand, type MpvStartOptions } from '@/lib/desktopApi';
import type { PlaybackEngine, PlaybackEngineStateListener } from './PlaybackEngine';

export default class MpvPlaybackEngine implements PlaybackEngine {
  readonly kind = 'mpv' as const;
  private sessionId: string | null = null;
  private readonly pendingStates: Parameters<PlaybackEngineStateListener>[0][] = [];
  private readonly unsubscribe: () => void;

  constructor(private readonly listener: PlaybackEngineStateListener) {
    this.unsubscribe = desktopApi.mpv.onState((state) => {
      if (!this.sessionId) {
        this.pendingStates.push(state);
        return;
      }
      if (state.sessionId === this.sessionId) this.listener(state);
    });
  }

  static async available(): Promise<boolean> {
    return (await desktopApi.mpv.availability()).available;
  }

  async load(filePath: string, options?: MpvStartOptions): Promise<boolean> {
    const result = await desktopApi.mpv.start(filePath, options);
    if (!result.ok || !result.sessionId) {
      throw new Error(result.error || 'Native mpv playback could not be started.');
    }
    this.sessionId = result.sessionId;
    this.pendingStates.splice(0).forEach((state) => {
      if (state.sessionId === this.sessionId) this.listener(state);
    });
    return true;
  }

  private async command(command: MpvCommand): Promise<void> {
    if (this.sessionId) await desktopApi.mpv.command(this.sessionId, command);
  }

  play(): Promise<void> { return this.command({ type: 'set-paused', paused: false }); }
  pause(): Promise<void> { return this.command({ type: 'set-paused', paused: true }); }
  seek(position: number): Promise<void> { return this.command({ type: 'seek', position }); }
  setVolume(volume: number): Promise<void> { return this.command({ type: 'set-volume', volume }); }
  setMuted(muted: boolean): Promise<void> { return this.command({ type: 'set-muted', muted }); }
  setSpeed(speed: number): Promise<void> { return this.command({ type: 'set-speed', speed }); }
  selectVideo(trackId: number | null): Promise<void> { return this.command({ type: 'set-video-track', trackId }); }
  selectAudio(trackId: number | null): Promise<void> { return this.command({ type: 'set-audio-track', trackId }); }
  selectSubtitle(trackId: number | null): Promise<void> { return this.command({ type: 'set-subtitle-track', trackId }); }
  selectSecondarySubtitle(trackId: number | null): Promise<void> {
    return this.command({ type: 'set-secondary-subtitle-track', trackId });
  }
  setSubtitleDelay(seconds: number): Promise<void> { return this.command({ type: 'set-subtitle-delay', seconds }); }
  setAudioDelay(seconds: number): Promise<void> { return this.command({ type: 'set-audio-delay', seconds }); }
  setSubtitleStyle(style: { fontSize: number; color: string; borderColor: string; borderWidth: number; backgroundColor: string; position: number }): Promise<void> {
    return this.command({ type: 'set-subtitle-style', ...style });
  }
  setVideoAspect(aspect: string | null): Promise<void> { return this.command({ type: 'set-video-aspect', aspect }); }
  setVideoCrop(crop: string | null): Promise<void> { return this.command({ type: 'set-video-crop', crop }); }
  setVideoRotation(degrees: number): Promise<void> { return this.command({ type: 'set-video-rotation', degrees }); }

  async destroy(): Promise<void> {
    this.unsubscribe();
    this.pendingStates.length = 0;
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (sessionId) await desktopApi.mpv.stop(sessionId);
  }
}
