import {
  desktopApi,
  type LibVlcCommand,
  type LibVlcPlaybackState,
} from '@/lib/desktopApi';
import type { PlaybackTrack } from '@/shared/playbackProtocol';
import type { MediaTrack } from '../types';
import { probeTracks } from '../helpers';
import type {
  PlaybackEngine,
  PlaybackEngineStateListener,
  PlaybackStartOptions,
} from './PlaybackEngine';
import PlaybackVolumeController from './PlaybackVolumeController';
import { NativeSessionLease } from './NativeSessionLease';

const SEEK_COALESCE_MS = 16;
const METADATA_PROBE_FALLBACK_MS = 2500;
const METADATA_PROBE_AFTER_READY_MS = 250;

export default class LibVlcPlaybackEngine implements PlaybackEngine {
  readonly kind = 'libvlc' as const;
  readonly surface = 'composited-window' as const;
  private readonly lease: NativeSessionLease<PlaybackStartOptions, LibVlcPlaybackState>;
  private readonly volumeController = new PlaybackVolumeController(async (volume, muted) => {
    await this.command({ type: 'set-volume', volume });
    await this.command({ type: 'set-muted', muted });
  });
  private lastState: LibVlcPlaybackState | null = null;
  private nativeTracks: PlaybackTrack[] = [];
  private probedTracks: MediaTrack[] = [];
  private externalSubtitleTracks: MediaTrack[] = [];
  private mergedTracks: PlaybackTrack[] | null = null;
  private pendingMetadataFilePath: string | null = null;
  private metadataProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataProbeFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataProbeGeneration = 0;
  private metadataProbeStarted = false;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSeekPosition: number | null = null;
  private lastSeekSentAt = 0;
  private lastPauseCommand: boolean | null = null;
  private destroyed = false;

  constructor(private readonly listener: PlaybackEngineStateListener) {
    this.lease = new NativeSessionLease<PlaybackStartOptions, LibVlcPlaybackState>(
      {
        start: async (source, options) => {
          const result = await desktopApi.libvlc.start(source, options);
          if (result.ok && result.surface !== 'composited-window') {
            // Preserve a partial session ID so the lease can reclaim it.
            return { ...result, ok: false, error: 'LibVLC playback is unavailable because its native surface is not composited.' };
          }
          return result;
        },
        stop: (sessionId) => desktopApi.libvlc.stop(sessionId),
        onState: (callback) => desktopApi.libvlc.onState(callback),
      },
      (state) => this.emitState(state),
      (error) => console.error('[playback] LibVLC session lifecycle failed.', error),
    );
  }

  private get sessionId(): string | null { return this.lease.sessionId; }

  static async available(): Promise<boolean> {
    const availability = await desktopApi.libvlc.availability();
    return availability.available
      && availability.enabled !== false
      && availability.surface === 'composited-window';
  }

  async load(filePath: string, options?: PlaybackStartOptions): Promise<boolean> {
    if (this.destroyed) throw new Error('The native playback engine has been disposed.');
    this.cancelMetadataProbe();
    this.cancelSeek();
    this.lastState = null;
    this.nativeTracks = [];
    this.probedTracks = [];
    this.lastPauseCommand = null;
    this.volumeController.reset(options?.volume, options?.muted);
    this.externalSubtitleTracks = (options?.subtitleFiles || []).map((subtitle, index) => ({
      index: -1000 - index,
      type: 'subtitle',
      title: subtitle.path.split(/[\\/]/).pop() || `Subtitle ${index + 1}`,
      source: subtitle.source,
    }));
    this.mergedTracks = null;
    if (!await this.lease.load(filePath, options)) return false;
    if (this.destroyed) return false;
    this.pendingMetadataFilePath = filePath;
    this.metadataProbeStarted = false;
    this.metadataProbeFallbackTimer = setTimeout(() => {
      this.metadataProbeFallbackTimer = null;
      this.beginMetadataProbe();
    }, METADATA_PROBE_FALLBACK_MS);
    // The lease may already have delivered an early ready event. Start the
    // delayed metadata probe only after the correct source has been adopted.
    this.beginMetadataProbeIfReady();
    return true;
  }

  private beginMetadataProbeIfReady(): void {
    if (this.lastState?.status === 'ready') this.beginMetadataProbe();
  }

  private emitState(state: LibVlcPlaybackState): void {
    if (this.destroyed || !this.sessionId) return;
    this.lastState = { ...state, tracks: undefined };
    if (state.tracks && state.tracks !== this.nativeTracks) {
      this.nativeTracks = state.tracks;
      this.mergedTracks = null;
    }
    if (state.status === 'ready') this.beginMetadataProbe();
    const tracks = this.effectiveTracks();
    this.listener({
      ...state,
      sessionId: this.sessionId,
      ...(tracks.length > 0 ? { tracks } : {}),
    });
  }

  private effectiveTracks(): PlaybackTrack[] {
    return this.mergedTracks ??= this.buildEffectiveTracks();
  }

  private buildEffectiveTracks(): PlaybackTrack[] {
    if (this.nativeTracks.length > 0) return this.mergeTrackMetadata(this.nativeTracks);
    const metadataTracks = [...this.probedTracks, ...this.externalSubtitleTracks];
    if (metadataTracks.length === 0) return [];
    const firstSelected = {
      video: metadataTracks.find((track) => track.type === 'video' && track.default)
        || metadataTracks.find((track) => track.type === 'video'),
      audio: metadataTracks.find((track) => track.type === 'audio' && track.default)
        || metadataTracks.find((track) => track.type === 'audio'),
      subtitle: metadataTracks.find((track) => track.type === 'subtitle' && track.default),
    };
    return metadataTracks.flatMap((track): PlaybackTrack[] => {
      if (track.type !== 'video' && track.type !== 'audio' && track.type !== 'subtitle') return [];
      return [{
        id: track.index,
        streamIndex: track.index,
        type: track.type,
        codec: track.codec,
        language: track.language,
        title: track.title,
        channels: track.channels,
        default: track.default,
        forced: track.forced,
        selected: firstSelected[track.type]?.index === track.index,
        external: track.source ? track.source !== 'embedded' : false,
        source: track.source || 'embedded',
      }];
    });
  }

  private mergeTrackMetadata(nativeTracks: PlaybackTrack[]): PlaybackTrack[] {
    const metadataTracks = [...this.probedTracks, ...this.externalSubtitleTracks];
    if (nativeTracks.length === 0 || metadataTracks.length === 0) return nativeTracks;
    const ordinals: Record<PlaybackTrack['type'], number> = { video: 0, audio: 0, subtitle: 0 };
    const byType = {
      video: metadataTracks.filter((track) => track.type === 'video'),
      audio: metadataTracks.filter((track) => track.type === 'audio'),
      subtitle: metadataTracks.filter((track) => track.type === 'subtitle'),
    };
    return nativeTracks.map((track) => {
      const ordinal = ordinals[track.type]++;
      const probe = byType[track.type][ordinal];
      if (!probe) return track;
      return {
        ...track,
        streamIndex: probe.index,
        codec: probe.codec || track.codec,
        language: probe.language || track.language,
        title: probe.title || track.title,
        channels: probe.channels || track.channels,
        default: probe.default ?? track.default,
        forced: probe.forced ?? track.forced,
        external: probe.source ? probe.source !== 'embedded' : track.external,
        source: probe.source || track.source,
      };
    });
  }

  private cancelMetadataProbe(): void {
    this.metadataProbeGeneration += 1;
    this.pendingMetadataFilePath = null;
    this.metadataProbeStarted = false;
    if (this.metadataProbeTimer) clearTimeout(this.metadataProbeTimer);
    this.metadataProbeTimer = null;
    if (this.metadataProbeFallbackTimer) clearTimeout(this.metadataProbeFallbackTimer);
    this.metadataProbeFallbackTimer = null;
  }

  private beginMetadataProbe(): void {
    if (this.destroyed || this.metadataProbeStarted || !this.pendingMetadataFilePath) return;
    this.metadataProbeStarted = true;
    if (this.metadataProbeFallbackTimer) clearTimeout(this.metadataProbeFallbackTimer);
    this.metadataProbeFallbackTimer = null;
    const filePath = this.pendingMetadataFilePath;
    const generation = ++this.metadataProbeGeneration;
    this.metadataProbeTimer = setTimeout(() => {
      this.metadataProbeTimer = null;
      void desktopApi.media.probe(filePath)
        .then((result) => {
          if (this.destroyed || generation !== this.metadataProbeGeneration || !this.sessionId || !result.ok) return;
          this.probedTracks = probeTracks(result.data);
          this.mergedTracks = null;
          if (this.lastState) this.emitState(this.lastState);
        })
        .catch(() => undefined);
    }, METADATA_PROBE_AFTER_READY_MS);
  }

  private updateSelectedTrack(type: PlaybackTrack['type'], trackId: number | null): void {
    if (this.nativeTracks.length > 0) {
      this.nativeTracks = this.nativeTracks.map((track) => (
        track.type === type ? { ...track, selected: trackId !== null && track.id === trackId } : track
      ));
    } else if (this.probedTracks.length > 0) {
      this.nativeTracks = this.effectiveTracks().map((track) => (
        track.type === type ? { ...track, selected: trackId !== null && track.id === trackId } : track
      ));
    }
    this.mergedTracks = null;
    if (this.lastState) this.emitState(this.lastState);
  }

  private async command(command: LibVlcCommand): Promise<void> {
    if (this.sessionId && !this.destroyed) await desktopApi.libvlc.command(this.sessionId, command);
  }

  private async requiredCommand(command: LibVlcCommand, failureMessage: string): Promise<void> {
    if (this.destroyed || !this.sessionId || !await desktopApi.libvlc.command(this.sessionId, command)) {
      throw new Error(failureMessage);
    }
  }

  private setPaused(paused: boolean): Promise<void> {
    if (this.lastPauseCommand === paused && this.lastState?.paused === paused) return Promise.resolve();
    this.lastPauseCommand = paused;
    return this.requiredCommand({ type: 'set-paused', paused }, 'Could not change playback state.').catch((error) => {
      this.lastPauseCommand = null;
      throw error;
    });
  }

  private reflectSeek(position: number): void {
    if (!this.lastState) return;
    this.emitState({ ...this.lastState, status: 'loading', position });
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
          void this.sendSeek(pending).catch((error) => console.error('[playback] Deferred LibVLC seek failed.', error));
        }
      }, Math.max(0, SEEK_COALESCE_MS - elapsed));
    }
    return Promise.resolve();
  }
  setVolume(volume: number): Promise<void> { return this.volumeController.setVolume(volume); }
  setMuted(muted: boolean): Promise<void> { return this.volumeController.setMuted(muted); }
  setSpeed(speed: number): Promise<void> { return this.command({ type: 'set-speed', speed }); }
  async selectVideo(trackId: number | null): Promise<void> {
    await this.requiredCommand({ type: 'set-video-track', trackId }, 'LibVLC could not change the video track. Playback was left unchanged.');
    this.updateSelectedTrack('video', trackId);
  }
  async selectAudio(trackId: number | null): Promise<void> {
    await this.requiredCommand({ type: 'set-audio-track', trackId }, 'LibVLC could not change the audio track. Playback was left unchanged.');
    this.updateSelectedTrack('audio', trackId);
  }
  async selectSubtitle(trackId: number | null): Promise<void> {
    await this.requiredCommand({ type: 'set-subtitle-track', trackId }, 'LibVLC could not change the subtitle track. Playback was left unchanged.');
    this.updateSelectedTrack('subtitle', trackId);
  }
  selectSecondarySubtitle(trackId: number | null): Promise<void> { return this.command({ type: 'set-secondary-subtitle-track', trackId }); }
  setSubtitleDelay(seconds: number): Promise<void> { return this.command({ type: 'set-subtitle-delay', seconds }); }
  setAudioDelay(seconds: number): Promise<void> { return this.command({ type: 'set-audio-delay', seconds }); }
  setSubtitleStyle(style: { fontSize: number; color: string; borderColor: string; borderWidth: number; backgroundColor: string; position: number }): Promise<void> {
    return this.command({ type: 'set-subtitle-style', ...style });
  }
  setVideoAspect(aspect: string | null): Promise<void> {
    return this.requiredCommand({ type: 'set-video-aspect', aspect }, 'This LibVLC runtime cannot change the aspect ratio live.');
  }
  setVideoCrop(crop: string | null): Promise<void> {
    return this.requiredCommand({ type: 'set-video-crop', crop }, 'This LibVLC runtime cannot crop video live.');
  }
  setVideoRotation(degrees: number): Promise<void> {
    return this.requiredCommand({ type: 'set-video-rotation', degrees }, 'LibVLC does not support live video rotation in Loom.');
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.cancelMetadataProbe();
    this.cancelSeek();
    this.lastPauseCommand = null;
    this.lastState = null;
    this.nativeTracks = [];
    this.probedTracks = [];
    this.externalSubtitleTracks = [];
    this.mergedTracks = null;
    await this.lease.dispose();
  }
}
