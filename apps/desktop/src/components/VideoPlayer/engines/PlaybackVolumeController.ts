const clampVolume = (volume: number): number => Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));

/**
 * Coalesces the separate volume and mute calls made by the player UI into one
 * ordered engine update. Range inputs can produce many events per second; only
 * the newest state should reach a native player while an earlier update is in
 * flight.
 */
export default class PlaybackVolumeController {
  private volume = 1;
  private muted = false;
  private lastAudibleVolume = 1;
  private dirty = false;
  private flushPromise: Promise<void> | null = null;

  constructor(private readonly apply: (volume: number, muted: boolean) => Promise<void>) {}

  reset(volume = 1, muted = false): void {
    this.volume = clampVolume(volume);
    this.muted = muted || this.volume === 0;
    if (this.volume > 0) this.lastAudibleVolume = this.volume;
    this.dirty = false;
  }

  setVolume(volume: number): Promise<void> {
    this.volume = clampVolume(volume);
    this.muted = this.volume === 0;
    if (this.volume > 0) this.lastAudibleVolume = this.volume;
    return this.scheduleFlush();
  }

  setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    if (!muted && this.volume === 0) this.volume = this.lastAudibleVolume;
    return this.scheduleFlush();
  }

  private scheduleFlush(): Promise<void> {
    this.dirty = true;
    if (!this.flushPromise) {
      this.flushPromise = new Promise<void>((resolve, reject) => {
        queueMicrotask(() => {
          void this.flush(resolve, reject);
        });
      });
    }
    return this.flushPromise;
  }

  private async flush(resolve: () => void, reject: (error: unknown) => void): Promise<void> {
    try {
      do {
        this.dirty = false;
        const volume = this.volume;
        const muted = this.muted;
        await this.apply(volume, muted);
      } while (this.dirty);
      resolve();
    } catch (error) {
      reject(error);
    } finally {
      this.flushPromise = null;
      if (this.dirty) void this.scheduleFlush();
    }
  }
}
