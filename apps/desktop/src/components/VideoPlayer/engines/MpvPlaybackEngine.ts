import { desktopApi, type MpvCommand, type MpvStartOptions } from '@/lib/desktopApi';
import type {
  PlaybackCommand,
  PlaybackEngine,
  PlaybackEngineState,
  PlaybackEngineStateListener,
  PlaybackStartOptions,
} from './PlaybackEngine';
import PlaybackVolumeController from './PlaybackVolumeController';

const SEEK_COALESCE_MS = 16;

export default class MpvPlaybackEngine implements PlaybackEngine {
  readonly kind = 'mpv' as const;
  readonly surface = 'external-window' as const;
  private sessionId: string | null = null;
  private readonly pendingStates: PlaybackEngineState[] = [];
  private readonly unsubscribe: () => void;
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
    this.unsubscribe = desktopApi.mpv.onState((state) => {
      if (!this.sessionId) {
        this.pendingStates.push(state);
        return;
      }
      if (state.sessionId === this.sessionId) this.emitState(state);
    });
  }

  static async available(): Promise<boolean> {
    return (await desktopApi.mpv.availability()).available;
  }

  async load(filePath: string, options?: PlaybackStartOptions): Promise<boolean> {
    this.destroyed = false;
    this.lastPauseCommand = false;
    this.volumeController.reset(options?.volume, options?.muted);
    const result = await desktopApi.mpv.start(filePath, options as MpvStartOptions | undefined);
    if (!result.ok || !result.sessionId) {
      this.lastPauseCommand = null;
      throw new Error(result.error || 'Native mpv playback could not be started.');
    }
    this.sessionId = result.sessionId;
    this.pendingStates.splice(0).forEach((state) => {
      if (state.sessionId === this.sessionId) this.emitState(state);
    });
    return true;
  }

  private emitState(state: PlaybackEngineState): void {
    if (this.destroyed || !this.sessionId) return;
    this.lastState = state;
    this.listener(state);
  }

  private async command(command: PlaybackCommand): Promise<void> {
    if (this.sessionId) await desktopApi.mpv.command(this.sessionId, command as MpvCommand);
  }

  private setPaused(paused: boolean): Promise<void> {
    if (this.lastPauseCommand === paused) return Promise.resolve();
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

  play(): Promise<void> { return this.setPaused(false); }
  pause(): Promise<void> { return this.setPaused(true); }
  seek(position: number): Promise<void> {
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
        if (pending !== null && !this.destroyed) void this.sendSeek(pending);
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
    this.unsubscribe();
    this.pendingStates.length = 0;
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = null;
    this.pendingSeekPosition = null;
    this.lastPauseCommand = null;
    this.lastState = null;
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (sessionId) await desktopApi.mpv.stop(sessionId);
  }
}
