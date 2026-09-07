/** Owns one native playback session across asynchronous start and stop calls. */
export type NativeStartResult = {
  ok: boolean;
  sessionId?: string;
  surface?: string;
  error?: string;
};
export type NativeState = { sessionId?: string };
export type NativeSessionPort<Options, State extends NativeState> = {
  start: (source: string, options?: Options) => Promise<NativeStartResult>;
  stop: (sessionId: string) => Promise<unknown>;
  onState: (listener: (state: State) => void) => () => void;
};

/**
 * Starts and stops are serialized. Superseded queued loads never reach the host;
 * an already dispatched start is allowed to settle and its late ID is stopped.
 * dispose() waits for that cleanup instead of inventing cancellation semantics.
 * Hosts must bound their own calls and keep stop(sessionId) strictly ID-scoped.
 */
export class NativeSessionLease<Options, State extends NativeState> {
  private generation = 0;
  private disposed = false;
  private active: string | null = null;
  private activeGeneration = 0;
  private readonly early = new Map<string, State>();
  private earlyAnonymous: State | null = null;
  private readonly failedStops = new Set<string>();
  private starting = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly port: NativeSessionPort<Options, State>;
  private readonly listener: (state: State) => void;
  private readonly onError: (error: unknown) => void;
  private readonly unsubscribe: () => void;
  private disposal: Promise<void> | null = null;
  surface: string | undefined;

  constructor(
    port: NativeSessionPort<Options, State>,
    listener: (state: State) => void,
    onError: (error: unknown) => void,
  ) {
    this.port = port;
    this.listener = listener;
    this.onError = onError;
    this.unsubscribe = port.onState(state => this.receive(state));
  }

  get sessionId(): string | null { return this.activeGeneration === this.generation ? this.active : null; }
  get isDisposed(): boolean { return this.disposed; }

  private report(error: unknown): void {
    try { this.onError(error); } catch { /* Reporting must not interrupt cleanup. */ }
  }

  private deliver(state: State): void {
    try { this.listener(state); } catch (error) { this.report(error); }
  }

  private receive(state: State): void {
    if (this.disposed) return;
    const sessionId = state.sessionId;
    if (
      this.active
      && this.activeGeneration === this.generation
      && (!sessionId || sessionId === this.active)
    ) {
      // LibVLC historically permits session-less state patches. A serialized
      // active lease gives those patches an unambiguous owner.
      this.deliver(state);
      return;
    }
    if (!this.starting) return;

    if (!sessionId) {
      // A start can emit state before its reply supplies the session ID. Apply
      // anonymous patches to every candidate already seen, and keep a base for
      // candidates that identify themselves later. This preserves event order.
      this.earlyAnonymous = this.earlyAnonymous
        ? { ...this.earlyAnonymous, ...state }
        : state;
      for (const [candidateId, existing] of this.early) {
        this.early.set(candidateId, { ...existing, ...state });
      }
      return;
    }

    const existing = this.early.get(sessionId);
    const merged = existing
      ? { ...existing, ...state }
      : this.earlyAnonymous
        ? { ...this.earlyAnonymous, ...state }
        : state;
    this.early.delete(sessionId);
    this.early.set(sessionId, merged);
    if (this.early.size > 8) {
      const oldest = this.early.keys().next();
      if (!oldest.done) this.early.delete(oldest.value);
    }
  }

  private async stop(id: string): Promise<void> {
    try {
      await this.port.stop(id);
      this.failedStops.delete(id);
    } catch (error) {
      this.failedStops.add(id);
      this.report(error);
      throw error;
    }
  }

  load(source: string, options?: Options): Promise<boolean> {
    if (this.disposed) return Promise.reject(new Error('The native playback engine has been disposed.'));
    const generation = ++this.generation;
    const operation = this.tail.then(async (): Promise<boolean> => {
      if (this.disposed || generation !== this.generation) return false;
      if (this.failedStops.size) throw new Error('Native playback cleanup failed. Dispose this engine before retrying.');
      const previous = this.active;
      this.active = null;
      this.surface = undefined;
      if (previous) await this.stop(previous);
      if (this.disposed || generation !== this.generation) return false;
      this.starting = true;
      this.early.clear();
      this.earlyAnonymous = null;
      try {
        const result = await this.port.start(source, options);
        if (this.disposed || generation !== this.generation) {
          if (result.sessionId) await this.stop(result.sessionId);
          return false;
        }
        if (!result.ok || !result.sessionId) {
          if (result.sessionId) await this.stop(result.sessionId);
          throw new Error(result.error || 'The native playback engine could not start.');
        }
        this.active = result.sessionId;
        this.activeGeneration = generation;
        this.surface = result.surface;
        const state = this.early.get(result.sessionId) ?? this.earlyAnonymous;
        if (state) this.deliver(state);
        return !this.disposed && generation === this.generation;
      } finally {
        this.starting = false;
        this.early.clear();
        this.earlyAnonymous = null;
      }
    });
    // Keep the queue alive after a failure while returning the actual rejection
    // to the caller. failedStops prevents a new load after failed native cleanup.
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    ++this.generation;
    try { this.unsubscribe(); } catch (error) { this.report(error); }
    this.early.clear();
    this.earlyAnonymous = null;
    this.disposal = this.tail.then(async () => {
      const active = this.active;
      this.active = null;
      this.surface = undefined;
      if (active) {
        try { await this.stop(active); } catch { /* Retry below. */ }
      }
      const errors: unknown[] = [];
      for (const id of [...this.failedStops]) {
        try { await this.stop(id); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Native playback cleanup failed.');
    });
    this.tail = this.disposal.then(() => undefined, () => undefined);
    return this.disposal;
  }
}
