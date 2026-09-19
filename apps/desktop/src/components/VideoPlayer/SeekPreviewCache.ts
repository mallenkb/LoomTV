import { desktopApi } from '@/lib/desktopApi';

const INTERVAL = 2;
const MAX_ENTRIES = 12;
const MAX_DECODED_BYTES = 8 * 1024 * 1024;

type Preview = { frame: number; url: string; image: HTMLImageElement; bytes: number };

// One extraction at a time, with only the latest target and its neighbours
// queued. Let the active frame finish so fast dragging cannot starve previews.
export default class SeekPreviewCache {
  private entries = new Map<number, Preview>();
  private failed = new Set<number>();
  private attempted = new Set<number>();
  private target = 0;
  private loading = false;
  private disposed = false;
  private cancel: (() => void) | null = null;

  constructor(
    private filePath: string,
    private duration: number,
    private changed: () => void,
  ) {}

  request(seconds: number): void {
    const target = Math.floor(Math.max(0, Math.min(this.duration - 0.1, seconds)) / INTERVAL) * INTERVAL;
    if (target !== this.target) this.attempted.clear();
    this.target = target;
    const cached = this.entries.get(this.target);
    if (cached) {
      this.entries.delete(this.target);
      this.entries.set(this.target, cached);
    }
    this.pump();
  }

  nearest(seconds: number): Preview | null {
    let nearest: Preview | null = null;
    for (const entry of this.entries.values()) {
      if (!nearest || Math.abs(entry.frame - seconds) < Math.abs(nearest.frame - seconds)) nearest = entry;
    }
    return nearest;
  }

  private pump(): void {
    if (this.disposed || this.loading) return;
    const frame = [this.target, this.target + INTERVAL, this.target - INTERVAL].find(
      (time) => time >= 0 && time < this.duration && !this.entries.has(time) && !this.failed.has(time) && !this.attempted.has(time),
    );
    if (frame === undefined) return;
    this.attempted.add(frame);
    this.loading = true;
    void this.load(frame).finally(() => {
      this.loading = false;
      this.pump();
    });
  }

  private async load(frame: number): Promise<void> {
    try {
      const { url } = await desktopApi.getThumbnail(this.filePath, String(frame), true);
      if (this.disposed) return;
      // An image request supports the authenticated artwork URLs in every
      // desktop mode, including origins that cannot fetch and read the bytes.
      const image = new Image();
      image.decoding = 'async';
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          image.onload = null;
          image.onerror = null;
          this.cancel = null;
          if (error) { image.removeAttribute('src'); reject(error); }
          else resolve();
        };
        const timeout = setTimeout(() => finish(new Error('Preview timed out.')), 10_000);
        this.cancel = () => finish(new Error('Preview closed.'));
        image.onload = () => finish();
        image.onerror = () => finish(new Error('Preview unavailable.'));
        image.src = url;
      });
      if (this.disposed) return;
      await image.decode().catch(() => undefined);
      if (this.disposed) return;
      const bytes = image.naturalWidth * image.naturalHeight * 4;
      if (!bytes || bytes > MAX_DECODED_BYTES) throw new Error('Invalid preview dimensions.');
      this.entries.set(frame, { frame, url, image, bytes });
      let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      while (this.entries.size > MAX_ENTRIES || total > MAX_DECODED_BYTES) {
        const oldest = this.entries.entries().next().value;
        if (!oldest) break;
        total -= oldest[1].bytes;
        oldest[1].image.removeAttribute('src');
        this.entries.delete(oldest[0]);
      }
      this.changed();
    } catch {
      if (!this.disposed) {
        if (this.failed.size === 0) console.warn('[player] Seek thumbnail unavailable; retaining the timestamp preview.');
        this.failed.add(frame);
        const oldest = this.failed.values().next().value;
        if (this.failed.size > MAX_ENTRIES && oldest !== undefined) this.failed.delete(oldest);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel?.();
    for (const entry of this.entries.values()) entry.image.removeAttribute('src');
    this.entries.clear();
    this.failed.clear();
    this.attempted.clear();
  }
}
