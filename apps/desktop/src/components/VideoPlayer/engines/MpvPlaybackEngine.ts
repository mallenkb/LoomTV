import { desktopApi, type MpvCommand, type MpvStartOptions } from '@/lib/desktopApi';
import type {
  PlaybackCommand,
  PlaybackEngine,
  PlaybackEngineState,
  PlaybackEngineStateListener,
  PlaybackEngineSurface,
  PlaybackStartOptions,
} from './PlaybackEngine';
import PlaybackVolumeController from './PlaybackVolumeController';
import { NativeSessionLease } from './NativeSessionLease';

const SEEK_COALESCE_MS = 16;

export default class MpvPlaybackEngine implements PlaybackEngine {
  readonly kind = 'mpv' as const;
  // Do not claim in-window composition until the native host confirms it.
  surface: PlaybackEngineSurface = 'external-window';
  private readonly lease: NativeSessionLease<MpvStartOptions, PlaybackEngineState>;
  private readonly volumeController = new PlaybackVolumeController(async (volume, muted) => {
    await this.command({ type: 'set-volume', volume });
    await this.command({ type: 'set-muted', muted });
  });
  private lastState: PlaybackEngineState | null = null;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSeekPosition: number | null = null;
  private lastSeekSentAt = 0;
  private lastPauseCommand: boolean | null = null;
  private destroyed = false;

  constructor(private readonly listener: PlaybackEngineStateListener) {
    this.lease = new NativeSessionLease<MpvStartOptions, PlaybackEngineState>(
      {
        start: (source, options) => desktopApi.mpv.start(source, options),
        stop: (sessionId) => desktopApi.mpv.stop(sessionId),
        onState: (callback) => desktopApi.mpv.onState(callback),
      },
      (state) => {
        this.surface = this.lease.surface === 'composited-window' ? 'composited-window' : 'external-window';
        this.emitState(state);
      },
      (error) => console.error('[playback] Native session lifecycle failed.', error),
    );
  }

  private get sessionId(): string | null { return this.lease.sessionId; }

  static async available(): Promise<boolean> {
    return (await desktopApi.mpv.availability()).available;
  }

  async load(filePath: string, options?: PlaybackStartOptions): Promise<boolean> {
    if (this.destroyed) throw new Error('The native playback engine has been disposed.');
    this.cancelSeek();
    this.lastState = null;
    this.lastPauseCommand = null;
    this.volumeController.reset(options?.volume, options?.muted);
    const loaded = await this.lease.load(filePath, options as MpvStartOptions | undefined);
    if (!loaded) return false;
    this.surface = this.lease.surface === 'composited-window' ? 'composited-window' : 'external-window';
    return true;
  }

  private emitState(state: PlaybackEngineState): void {
    if (this.destroyed || !this.sessionId) return;
    this.lastState = state;
    this.listener(state);
  }

  private async command(command: PlaybackCommand): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || this.destroyed) return;
    if (!await desktopApi.mpv.command(sessionId, command as MpvCommand)) {
      throw new Error(`The native player rejected ${command.type}.`);
    }
  }

  private setPaused(paused: boolean): Promise<void> {
    if (this.lastPauseCommand === paused && this.lastState?.paused === paused) return Promise.resolve();
    this.lastPauseCommand = paused;
    return this.command({ type: 'set-paused', paused }).catch((error) => {
      this.lastPauseCommand = null;
      throw error;
    });
  }

  private reflectSeek(position: number): void {
    if (!this.lastState) return;
    this.emitState({ ...this.lastState, position });
  }

  private sendSeek(position: number): Promise<void> {
    this.lastSeekSentAt = performance.now();
    return this.command({ type: 'seek', position });
  }

  private cancelSeek(): void {
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = null;
    this.pendingSeekPosition = null;
    this.lastSeekSentAt = 0;
  }

  play(): Promise<void> { return this.setPaused(false); }
  pause(): Promise<void> { return this.setPaused(true); }
  seek(position: number): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const target = Math.max(0, Number.isFinite(position) ? position : 0);
    this.reflectSeek(target);
    const elapsed = performance.now() - this.lastSeekSentAt;
    if (!this.seekTimer && elapsed >= SEEK_COALESCE_MS) return this.sendSeek(target);
    this.pendingSeekPosition = target;
    if (!this.seekTimer) {
      this.seekTimer = setTimeout(() => {
        this.seekTimer = null;
        const pending = this.pendingSeekPosition;
        this.pendingSeekPosition = null;
        if (pending !== null && !this.destroyed) {
          void this.sendSeek(pending).catch((error) => {
            console.error('[playback] Deferred native seek failed.', error);
          });
        }
      }, Math.max(0, SEEK_COALESCE_MS - elapsed));
    }
    return Promise.resolve();
  }
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
    this.destroyed = true;
    this.cancelSeek();
    this.lastPauseCommand = null;
    this.lastState = null;
    await this.lease.dispose();
  }
}
