import {
  desktopApi,
  type LibVlcCommand,
  type LibVlcPlaybackState,
} from '@/lib/desktopApi';
import type {
  PlaybackEngine,
  PlaybackEngineStateListener,
  PlaybackStartOptions,
} from './PlaybackEngine';
import PlaybackVolumeController from './PlaybackVolumeController';

export default class LibVlcPlaybackEngine implements PlaybackEngine {
  readonly kind = 'libvlc' as const;
  readonly surface = 'composited-window' as const;
  private sessionId: string | null = null;
  private readonly pendingStates: LibVlcPlaybackState[] = [];
  private readonly unsubscribe: () => void;
  private readonly volumeController = new PlaybackVolumeController(async (volume, muted) => {
    await this.command({ type: 'set-volume', volume });
    await this.command({ type: 'set-muted', muted });
  });

  constructor(private readonly listener: PlaybackEngineStateListener) {
    this.unsubscribe = desktopApi.libvlc.onState((state) => {
      if (!this.sessionId) {
        this.pendingStates.push(state);
        return;
      }
      const sessionId = this.sessionId;
      if (state.sessionId && state.sessionId !== sessionId) return;
      this.listener({ ...state, sessionId });
    });
  }

  static async available(): Promise<boolean> {
    const availability = await desktopApi.libvlc.availability();
    return availability.available
      && availability.enabled !== false
      && availability.surface === 'composited-window';
  }

  async load(filePath: string, options?: PlaybackStartOptions): Promise<boolean> {
    this.volumeController.reset(options?.volume, options?.muted);
    const failures: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await desktopApi.libvlc.start(filePath, options);
      if (result.ok && result.sessionId && result.surface === 'composited-window') {
        this.sessionId = result.sessionId;
        const sessionId = this.sessionId;
        this.pendingStates.splice(0).forEach((state) => {
          if (state.sessionId && state.sessionId !== sessionId) return;
          this.listener({ ...state, sessionId });
        });
        return true;
      }

      failures.push(result.error || (
        result.surface !== 'composited-window'
          ? 'LibVLC playback is unavailable because its native surface is not composited.'
          : 'Native LibVLC playback could not be started.'
      ));
      console.warn(`[player] LibVLC startup attempt ${attempt} of 3 failed:`, failures.at(-1));
      if (attempt < 3) {
        await desktopApi.libvlc.refreshAvailability().catch(() => undefined);
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
    }
    throw new Error(`LibVLC could not start after three attempts: ${failures.join(' | ')}`);
  }

  private async command(command: LibVlcCommand): Promise<void> {
    if (this.sessionId) await desktopApi.libvlc.command(this.sessionId, command);
  }

  play(): Promise<void> { return this.command({ type: 'set-paused', paused: false }); }
  pause(): Promise<void> { return this.command({ type: 'set-paused', paused: true }); }
  seek(position: number): Promise<void> { return this.command({ type: 'seek', position }); }
  setVolume(volume: number): Promise<void> { return this.volumeController.setVolume(volume); }
  setMuted(muted: boolean): Promise<void> { return this.volumeController.setMuted(muted); }
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
    if (sessionId) await desktopApi.libvlc.stop(sessionId);
  }
}
