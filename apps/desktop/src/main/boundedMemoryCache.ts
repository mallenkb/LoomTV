/** A disposable read cache. Values are never a substitute for committed storage. */
export class IdleValueCache<T> {
  private stored: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleMs: number;

  constructor(idleMs: number) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) throw new RangeError('idleMs must be positive.');
    this.idleMs = idleMs;
  }

  get value(): T | null {
    if (this.stored !== null) this.arm();
    return this.stored;
  }

  set value(value: T | null) {
    this.clear();
    this.stored = value;
    if (value !== null) this.arm();
  }

  /** Inspection must not extend the lifetime of a cache. */
  peek(): T | null { return this.stored; }

  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.stored = null;
  }

  private arm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.clear(), this.idleMs);
    this.timer.unref?.();
  }
}

type CacheLimits = { maxEntries: number; maxBytes: number; idleMs: number };
type Entry<T> = { value: T; bytes: number; expiresAt: number };

/**
 * Bounded recent reads with one expiry timer, not one timer per media item.
 * `bytes` is the caller's encoded-payload estimate, not a V8 heap measurement.
 */
export class MemoryLruCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly limits: CacheLimits;
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(limits: CacheLimits) {
    if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries <= 0
      || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0
      || !Number.isFinite(limits.idleMs) || limits.idleMs <= 0) {
      throw new RangeError('Cache limits must be positive finite values.');
    }
    this.limits = { ...limits };
  }

  get size(): number { this.prune(); return this.entries.size; }
  get estimatedBytes(): number { this.prune(); return this.bytes; }

  get(key: K): V | undefined {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    entry.expiresAt = Date.now() + this.limits.idleMs;
    this.entries.set(key, entry);
    this.arm();
    return entry.value;
  }

  set(key: K, value: V, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Cache size must be a nonnegative integer.');
    this.prune();
    this.remove(key);
    if (bytes > this.limits.maxBytes) {
      this.arm();
      return false;
    }
    this.entries.set(key, { value, bytes, expiresAt: Date.now() + this.limits.idleMs });
    this.bytes += bytes;
    while (this.entries.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
    this.arm();
    return true;
  }

  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.entries.clear();
    this.bytes = 0;
  }

  private remove(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
  }

  private arm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.entries.size === 0) return;
    let next = Infinity;
    for (const entry of this.entries.values()) next = Math.min(next, entry.expiresAt);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.prune();
      this.arm();
    }, Math.max(1, next - Date.now()));
    this.timer.unref?.();
  }
}
