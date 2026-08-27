import {
  isMediaSessionDiscontinuity,
  normalizeMediaSessionSnapshot,
  resolveSeekPosition,
  supportsMediaSessionCommand,
  type MediaSessionAdapterKind,
  type MediaSessionCommand,
  type MediaSessionDiagnostics,
  type MediaSessionEngine,
  type MediaSessionSnapshot,
} from '../../shared/mediaControlProtocol.ts';

/**
 * The main process's single system media session.
 *
 * One player session owns the operating system's media session at a time. The
 * controller accepts snapshots from that player, picks one owner, forwards
 * commands only to it, and keeps a paused session available for resume. It does
 * not release on focus loss, which is the entire point of the feature.
 *
 * LibVLC and mpv run in this process, so their transport commands are executed
 * here rather than taking a renderer round trip. Chromium throttles renderer
 * timers whenever the window is backgrounded, which is exactly the case system
 * media controls exist for.
 *
 * The module knows nothing about Electron or any platform API, so the whole
 * lifecycle is exercised by the test runner with a fake adapter.
 */

/** The live player session that receives whatever the main process cannot run itself. */
export type MediaSessionOwner = {
  /** Stable identity, in practice a WebContents id. */
  id: number;
  /** False once the renderer is gone; a dead owner is released, never used. */
  isAlive: () => boolean;
  /**
   * Notify the player. `handledInMain` is true when the engine command already
   * ran here, in which case the renderer only syncs its own intent state and
   * must not run the transport again.
   */
  notify: (command: MediaSessionCommand, handledInMain: boolean) => void;
};

/** One platform media session. `start` throws when the platform session cannot be established. */
export type MediaSessionAdapter = {
  kind: MediaSessionAdapterKind;
  start: (handlers: { onCommand: (command: MediaSessionCommand) => void }) => void;
  publish: (snapshot: MediaSessionSnapshot) => void;
  clear: () => void;
};

export type MediaSessionAdapterCandidate = {
  kind: MediaSessionAdapterKind;
  create: () => MediaSessionAdapter;
};

/**
 * Transport operations the main process can run against a native engine.
 *
 * Each returns false when it could not act, which sends the command on to the
 * renderer instead of dropping it.
 */
export type MediaSessionEngineDispatcher = {
  setPaused: (engine: MediaSessionEngine, sessionId: string, paused: boolean) => boolean;
  seek: (engine: MediaSessionEngine, sessionId: string, positionSeconds: number) => boolean;
  setRate: (engine: MediaSessionEngine, sessionId: string, rate: number) => boolean;
};

export type MediaSessionControllerOptions = {
  platform: string;
  /** Ordered candidates; the first that starts becomes the session. */
  candidates: () => readonly MediaSessionAdapterCandidate[];
  engine?: MediaSessionEngineDispatcher;
  /** Resolve snapshot artwork to a local file. Adapters never see a URL. */
  resolveArtworkPath?: (snapshot: MediaSessionSnapshot) => string | null;
  /** Device preference. A disabled session releases immediately and never claims. */
  isEnabled?: () => boolean;
  logWarning?: (message: string, error?: unknown) => void;
};

export type MediaSessionController = {
  publish: (owner: MediaSessionOwner, snapshot: unknown) => MediaSessionDiagnostics;
  release: (ownerId: number) => boolean;
  releaseAll: () => void;
  diagnostics: () => MediaSessionDiagnostics;
  ownerId: () => number | null;
  /** Latest published snapshot, for tests and for artwork re-publication. */
  snapshot: () => MediaSessionSnapshot | null;
  /** Re-publish the current snapshot, used when artwork finishes resolving. */
  refresh: () => void;
};

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? '').trim();
  return text || 'unknown error';
}

export function createMediaSessionController(
  options: MediaSessionControllerOptions,
): MediaSessionController {
  const { platform, candidates, engine, resolveArtworkPath, isEnabled, logWarning } = options;

  let owner: MediaSessionOwner | null = null;
  let adapter: MediaSessionAdapter | null = null;
  let adapterKind: MediaSessionAdapterKind = 'unsupported';
  let published: MediaSessionSnapshot | null = null;
  let startFailureReason: string | undefined;
  /**
   * True once a session has been released. While set, a paused snapshot does
   * not take the operating system's media slot back: another app may hold it,
   * and LoomTV must not fight for a session it is not actually playing.
   */
  let awaitingPlayToReclaim = false;

  const warn = (message: string, error?: unknown) => logWarning?.(message, error);

  const diagnostics = (): MediaSessionDiagnostics => ({
    platform,
    adapter: adapterKind,
    active: adapter !== null,
    ...(startFailureReason ? { reason: startFailureReason } : {}),
  });

  const routeCommand = (command: MediaSessionCommand) => {
    const target = owner;
    const snapshot = published;
    if (!target || !snapshot) return;
    if (!target.isAlive()) {
      // The renderer disappeared without releasing. Tear down rather than leave
      // the operating system pointed at a session that no longer exists.
      releaseAll();
      return;
    }
    if (!supportsMediaSessionCommand(snapshot, command.type)) return;

    let handledInMain = false;
    const nativeEngine = snapshot.engine !== 'chromium' && snapshot.engineSessionId
      ? snapshot.engine
      : null;

    if (nativeEngine && engine) {
      const sessionId = snapshot.engineSessionId as string;
      try {
        if (command.type === 'play') {
          handledInMain = engine.setPaused(nativeEngine, sessionId, false);
        } else if (command.type === 'pause') {
          handledInMain = engine.setPaused(nativeEngine, sessionId, true);
        } else if (command.type === 'toggle') {
          handledInMain = engine.setPaused(nativeEngine, sessionId, snapshot.state === 'playing');
        } else if (command.type === 'setRate') {
          handledInMain = engine.setRate(nativeEngine, sessionId, command.rate);
        } else if (command.type === 'seekAbsolute' || command.type === 'seekRelative') {
          const position = resolveSeekPosition(snapshot, command);
          handledInMain = position !== null && engine.seek(nativeEngine, sessionId, position);
        }
      } catch (error) {
        // Falling through to the renderer is better than losing the command.
        handledInMain = false;
        warn(`[media-session] Dispatching ${command.type} to ${nativeEngine} failed.`, error);
      }
    }

    try {
      target.notify(command, handledInMain);
    } catch (error) {
      warn(`[media-session] Notifying the player of ${command.type} failed.`, error);
    }
  };

  const startAdapter = (): void => {
    if (adapter) return;
    const failures: string[] = [];

    for (const candidate of candidates()) {
      let created: MediaSessionAdapter;
      try {
        created = candidate.create();
        created.start({ onCommand: routeCommand });
      } catch (error) {
        failures.push(`${candidate.kind}: ${describeError(error)}`);
        continue;
      }
      adapter = created;
      adapterKind = created.kind;
      startFailureReason = undefined;
      return;
    }

    adapter = null;
    adapterKind = 'unsupported';
    startFailureReason = failures[0] || `No system media session is available on ${platform}.`;
    // A missing adapter disables system controls and nothing else.
    warn(`[media-session] No adapter started. ${failures.join(' | ') || startFailureReason}`);
  };

  const stopAdapter = (): void => {
    const current = adapter;
    adapter = null;
    adapterKind = 'unsupported';
    published = null;
    if (!current) return;
    try {
      current.clear();
    } catch (error) {
      warn('[media-session] Clearing the platform media session failed.', error);
    }
  };

  const publishSnapshot = (snapshot: MediaSessionSnapshot): void => {
    if (!adapter) return;
    const artworkPath = resolveArtworkPath?.(snapshot) ?? null;
    const withArtwork: MediaSessionSnapshot = artworkPath
      ? { ...snapshot, artworkPath }
      : snapshot;
    try {
      adapter.publish(withArtwork);
    } catch (error) {
      warn('[media-session] Publishing the media session snapshot failed.', error);
    }
  };

  function releaseAll(): void {
    owner = null;
    awaitingPlayToReclaim = true;
    stopAdapter();
  }

  return {
    publish(nextOwner, rawSnapshot) {
      if (isEnabled && !isEnabled()) {
        if (adapter || owner) releaseAll();
        startFailureReason = 'System media controls are turned off in Playback settings.';
        return diagnostics();
      }

      const snapshot = normalizeMediaSessionSnapshot(rawSnapshot);

      if (snapshot.state === 'stopped') {
        // Playback ended: release the session but leave the player window alone.
        if (!owner || owner.id === nextOwner.id) releaseAll();
        return diagnostics();
      }

      if (!nextOwner.isAlive()) {
        if (owner?.id === nextOwner.id) releaseAll();
        return diagnostics();
      }

      if (awaitingPlayToReclaim && snapshot.state !== 'playing') {
        // Contention: another app may now hold the media slot. LoomTV only takes
        // it back when it is actually playing again.
        return diagnostics();
      }

      // A newer player replaces the older owner. The adapter keeps running, so
      // the operating system sees one continuous session rather than a gap.
      const ownerChanged = owner?.id !== nextOwner.id;
      owner = nextOwner;
      awaitingPlayToReclaim = false;

      startAdapter();
      if (!adapter) return diagnostics();

      if (ownerChanged || isMediaSessionDiscontinuity(published, snapshot)) {
        published = snapshot;
        publishSnapshot(snapshot);
      } else {
        // Keep the position current for the next seek without touching the OS.
        published = snapshot;
      }

      return diagnostics();
    },

    release(ownerId) {
      if (!owner || owner.id !== ownerId) return false;
      releaseAll();
      return true;
    },

    releaseAll,

    diagnostics,

    ownerId: () => owner?.id ?? null,

    snapshot: () => published,

    refresh() {
      if (published) publishSnapshot(published);
    },
  };
}
