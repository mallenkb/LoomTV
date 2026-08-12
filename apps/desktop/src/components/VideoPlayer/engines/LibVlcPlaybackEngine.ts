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

function hasExternalSurface(surface: unknown): boolean {
  return surface === 'external-window'
    || (typeof surface === 'object'
      && surface !== null
      && 'kind' in surface
      && surface.kind === 'external-window');
}

/**
 * Renderer adapter for an optional LibVLC bridge.
 *
 * LibVLC is only considered usable when the host explicitly reports an
 * external native window. Electron cannot safely hand a DOM element to a
 * LibVLC renderer through the current preload, so an embedded/unknown surface
 * is deliberately rejected and the caller continues to MPV/browser fallback.
 */
export default class LibVlcPlaybackEngine implements PlaybackEngine {
  readonly kind = 'libvlc' as const;
  readonly surface = 'external-window' as const;
  private sessionId: string | null = null;
  private readonly pendingStates: LibVlcPlaybackState[] = [];
  private readonly unsubscribe: () => void;

  constructor(private readonly listener: PlaybackEngineStateListener) {
    this.unsubscribe = desktopApi.libvlc.onState((state) => {
      if (!this.sessionId) {
        this.pendingStates.push(state);
        return;
      }
      if (state.sessionId && state.sessionId !== this.sessionId) return;
      const sessionId = this.sessionId;
      if (!sessionId) return;
      this.listener({ ...state, sessionId });
    });
  }

  static async available(): Promise<boolean> {
    const availability = await desktopApi.libvlc.availability();
    return availability.available
      && availability.enabled === true
      && availability.surface === 'external-window';
  }

  async load(filePath: string, options?: PlaybackStartOptions): Promise<boolean> {
    const availability = await desktopApi.libvlc.availability();
    if (!availability.available
      || availability.enabled !== true
      || availability.surface !== 'external-window') {
      throw new Error('LibVLC playback is unavailable because the host did not report an attached external native surface.');
    }
    const result = await desktopApi.libvlc.start(filePath, options);
    if (!result.ok || !result.sessionId) {
      throw new Error(result.error || 'Native LibVLC playback could not be started.');
    }
    if (result.surface !== undefined && !hasExternalSurface(result.surface)) {
      throw new Error('LibVLC playback is unavailable because its native surface is not attached to the desktop window.');
    }

    const sessionId = result.sessionId;
    this.sessionId = sessionId;
    this.pendingStates.splice(0).forEach((state) => {
      if (state.sessionId && state.sessionId !== sessionId) return;
      this.listener({ ...state, sessionId });
    });
    return true;
  }

  private async command(command: LibVlcCommand): Promise<void> {
    if (this.sessionId) await desktopApi.libvlc.command(this.sessionId, command);
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
    if (sessionId) await desktopApi.libvlc.stop(sessionId);
  }
}
