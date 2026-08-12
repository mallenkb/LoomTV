import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BrowserWindow, type WebContents } from 'electron';

type DynamicFunction = (...args: any[]) => any;
type KoffiLibrary = { func: (name: string, returnType: string, argumentTypes: string[]) => DynamicFunction };
type KoffiRuntime = { load: (libraryPath: string) => KoffiLibrary };

export type LibVlcAvailability = {
  available: boolean;
  libraryPath?: string;
  version?: string;
  runtimeSource?: 'environment' | 'system';
  warning?: string;
  reason?: string;
};

export type LibVlcStartOptions = {
  startSeconds?: number;
  volume?: number;
  muted?: boolean;
  speed?: number;
  subtitleDelay?: number;
  subtitleFiles?: Array<{ path: string; source: 'sidecar' | 'opensubtitles' }>;
};

export type LibVlcPlaybackState = {
  sessionId: string;
  status: 'starting' | 'loading' | 'ready' | 'ended' | 'error' | 'closed';
  position?: number;
  duration?: number;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
  speed?: number;
  error?: string;
};

export type LibVlcCommand =
  | { type: 'set-paused'; paused: boolean }
  | { type: 'seek'; position: number }
  | { type: 'set-volume'; volume: number }
  | { type: 'set-muted'; muted: boolean }
  | { type: 'set-speed'; speed: number };

type LibVlcApi = {
  newInstance: DynamicFunction;
  releaseInstance: DynamicFunction;
  getVersion: DynamicFunction;
  mediaNewPath: DynamicFunction;
  mediaAddOption: DynamicFunction;
  mediaRelease: DynamicFunction;
  playerNewFromMedia: DynamicFunction;
  playerRelease: DynamicFunction;
  playerPlay: DynamicFunction;
  playerStop: DynamicFunction;
  playerSetPause: DynamicFunction;
  playerGetState: DynamicFunction;
  playerGetTime: DynamicFunction;
  playerGetLength: DynamicFunction;
  playerSetTime: DynamicFunction;
  audioSetVolume: DynamicFunction;
  audioSetMute: DynamicFunction;
  playerSetRate: DynamicFunction;
  setDrawable: DynamicFunction;
};

type LibVlcRuntime = {
  api: LibVlcApi;
  libraryPath: string;
  version?: string;
  source: 'environment' | 'system';
};

type RuntimeCache = {
  key: string;
  runtime: LibVlcRuntime | null;
  warning?: string;
  resolvedAt: number;
};

type NativeDrawable = number | bigint;

const require = createRequire(__filename);
const MISSING_RUNTIME_CACHE_MS = 5_000;
let runtimeCache: RuntimeCache | null = null;
let currentSession: LibVlcPlaybackSession | null = null;

function truthyEnvironmentValue(value: unknown): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function libVlcEnabled(): boolean {
  return truthyEnvironmentValue(process.env.LOOMTV_ENABLE_LIBVLC)
    && !truthyEnvironmentValue(process.env.LOOMTV_DISABLE_LIBVLC);
}

function libVlcDisabledReason(): string {
  if (truthyEnvironmentValue(process.env.LOOMTV_DISABLE_LIBVLC)) {
    return 'Native LibVLC playback is disabled by LOOMTV_DISABLE_LIBVLC. LoomTV is using compatible fallback playback.';
  }
  return 'Native LibVLC playback is experimental and disabled by default. Set LOOMTV_ENABLE_LIBVLC=1 to opt in; LoomTV will use compatible fallback playback otherwise.';
}

function runtimeCacheKey(): string {
  return `${process.platform}\0${process.arch}\0${process.env.LOOMTV_ENABLE_LIBVLC || ''}\0${process.env.LOOMTV_DISABLE_LIBVLC || ''}\0${process.env.LOOMTV_LIBVLC_PATH || ''}`;
}

function libraryFileName(): string {
  if (process.platform === 'win32') return 'libvlc.dll';
  if (process.platform === 'darwin') return 'libvlc.dylib';
  return 'libvlc.so';
}

function candidateLibraryPaths(): Array<{ value: string; source: 'environment' | 'system' }> {
  const configured = process.env.LOOMTV_LIBVLC_PATH?.trim();
  const configuredPath = configured && fs.existsSync(configured) && fs.statSync(configured).isDirectory()
    ? path.join(configured, libraryFileName())
    : configured;
  const candidates: Array<{ value: string; source: 'environment' | 'system' }> = [];
  if (configuredPath) candidates.push({ value: configuredPath, source: 'environment' });

  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      { value: path.join(programFiles, 'VideoLAN', 'VLC', 'libvlc.dll'), source: 'system' },
      { value: path.join(localAppData, 'Programs', 'VideoLAN', 'VLC', 'libvlc.dll'), source: 'system' },
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      { value: '/Applications/VLC.app/Contents/MacOS/lib/libvlc.dylib', source: 'system' },
      { value: '/opt/homebrew/lib/libvlc.dylib', source: 'system' },
      { value: '/usr/local/lib/libvlc.dylib', source: 'system' },
      { value: 'libvlc.dylib', source: 'system' },
    );
  } else {
    candidates.push(
      { value: '/usr/lib/x86_64-linux-gnu/libvlc.so.5', source: 'system' },
      { value: '/usr/lib/aarch64-linux-gnu/libvlc.so.5', source: 'system' },
      { value: '/usr/lib/libvlc.so.5', source: 'system' },
      { value: '/usr/local/lib/libvlc.so', source: 'system' },
      { value: 'libvlc.so.5', source: 'system' },
      { value: 'libvlc.so', source: 'system' },
    );
  }
  return [...new Map(candidates.map((candidate) => [candidate.value, candidate])).values()];
}

function loadKoffi(): KoffiRuntime {
  try {
    return require('koffi') as KoffiRuntime;
  } catch (error) {
    throw new Error(
      'The optional koffi native binding is unavailable. Install it alongside the desktop app to enable LibVLC.',
      { cause: error },
    );
  }
}

function bind(library: KoffiLibrary, name: string, returnType: string, argumentTypes: string[]): DynamicFunction {
  return library.func(name, returnType, argumentTypes);
}

function loadRuntime(): { runtime: LibVlcRuntime | null; warning?: string } {
  if (!libVlcEnabled()) return { runtime: null };

  let koffi: KoffiRuntime;
  try {
    koffi = loadKoffi();
  } catch (error) {
    return { warning: error instanceof Error ? error.message : 'The optional koffi native binding is unavailable.' };
  }

  const rejected: string[] = [];
  for (const candidate of candidateLibraryPaths()) {
    try {
      const library = koffi.load(candidate.value);
      const api: LibVlcApi = {
        newInstance: bind(library, 'libvlc_new', 'void *', ['int', 'void *']),
        releaseInstance: bind(library, 'libvlc_release', 'void', ['void *']),
        getVersion: bind(library, 'libvlc_get_version', 'str', []),
        mediaNewPath: bind(library, 'libvlc_media_new_path', 'void *', ['void *', 'str']),
        mediaAddOption: bind(library, 'libvlc_media_add_option', 'void', ['void *', 'str']),
        mediaRelease: bind(library, 'libvlc_media_release', 'void', ['void *']),
        playerNewFromMedia: bind(library, 'libvlc_media_player_new_from_media', 'void *', ['void *']),
        playerRelease: bind(library, 'libvlc_media_player_release', 'void', ['void *']),
        playerPlay: bind(library, 'libvlc_media_player_play', 'int', ['void *']),
        playerStop: bind(library, 'libvlc_media_player_stop', 'void', ['void *']),
        playerSetPause: bind(library, 'libvlc_media_player_set_pause', 'void', ['void *', 'int']),
        playerGetState: bind(library, 'libvlc_media_player_get_state', 'int', ['void *']),
        playerGetTime: bind(library, 'libvlc_media_player_get_time', 'int64', ['void *']),
        playerGetLength: bind(library, 'libvlc_media_player_get_length', 'int64', ['void *']),
        playerSetTime: bind(library, 'libvlc_media_player_set_time', 'void', ['void *', 'int64']),
        audioSetVolume: bind(library, 'libvlc_audio_set_volume', 'int', ['void *', 'int']),
        audioSetMute: bind(library, 'libvlc_audio_set_mute', 'void', ['void *', 'int']),
        playerSetRate: bind(library, 'libvlc_media_player_set_rate', 'int', ['void *', 'float']),
        setDrawable: bind(
          library,
          process.platform === 'win32'
            ? 'libvlc_media_player_set_hwnd'
            : process.platform === 'darwin'
              ? 'libvlc_media_player_set_nsobject'
              : 'libvlc_media_player_set_xwindow',
          'void',
          process.platform === 'linux' ? ['void *', 'uint32'] : ['void *', 'void *'],
        ),
      };
      const version = String(api.getVersion() || '').trim() || undefined;
      return { runtime: { api, libraryPath: candidate.value, version, source: candidate.source } };
    } catch (error) {
      rejected.push(`${candidate.value}: ${error instanceof Error ? error.message : 'could not load'}`);
    }
  }
  return {
    runtime: null,
    warning: rejected.length > 0
      ? `LibVLC candidates could not be loaded: ${rejected.slice(0, 3).join('; ')}`
      : 'No LibVLC library candidate was found.',
  };
}

function cachedRuntime(): RuntimeCache {
  const key = runtimeCacheKey();
  if (
    runtimeCache
    && runtimeCache.key === key
    && (runtimeCache.runtime || Date.now() - runtimeCache.resolvedAt < MISSING_RUNTIME_CACHE_MS)
  ) return runtimeCache;
  const resolved = loadRuntime();
  runtimeCache = { key, runtime: resolved.runtime, warning: resolved.warning, resolvedAt: Date.now() };
  return runtimeCache;
}

export function invalidateLibVlcRuntimeCache(): void {
  runtimeCache = null;
}

export function libVlcAvailability(): LibVlcAvailability {
  if (!libVlcEnabled()) return { available: false, reason: libVlcDisabledReason() };
  const { runtime, warning } = cachedRuntime();
  return runtime
    ? {
      available: true,
      libraryPath: runtime.libraryPath,
      version: runtime.version,
      runtimeSource: runtime.source,
      warning,
    }
    : {
      available: false,
      warning,
      reason: 'LibVLC is not available. Install VLC/libvlc and the optional koffi native binding, or leave the experimental bridge disabled to use fallback playback.',
    };
}

export function refreshLibVlcAvailability(): LibVlcAvailability {
  invalidateLibVlcRuntimeCache();
  return libVlcAvailability();
}

export function libVlcRuntimeSummary(): string {
  const availability = libVlcAvailability();
  return availability.available
    ? `[playback] experimental LibVLC ready — ${availability.version || 'unknown version'} (${availability.runtimeSource}: ${availability.libraryPath})`
    : `[playback] experimental LibVLC unavailable — ${availability.reason}`;
}

function drawableForWindow(window: BrowserWindow): NativeDrawable {
  const handle = window.getNativeWindowHandle();
  if (!handle.length) throw new Error('The native LoomTV window handle is unavailable.');
  if (process.platform === 'linux') return handle.readUInt32LE(0);
  if (handle.length >= 8) return handle.readBigUInt64LE(0);
  return handle.readUInt32LE(0);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function assertNonRemoteSource(value: string, label: string): void {
  const source = String(value || '').trim();
  if (!source) throw new Error(`A local ${label} path is required.`);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) throw new Error(`Remote ${label} URLs are not allowed.`);
  if (process.platform === 'win32' && source.startsWith('\\\\')) {
    throw new Error(`Remote ${label} paths are not allowed.`);
  }
  if (process.platform !== 'win32' && source.startsWith('//')) {
    throw new Error(`Remote ${label} paths are not allowed.`);
  }
}

function statusForLibVlcState(state: number): LibVlcPlaybackState['status'] {
  if (state === 3 || state === 4) return 'ready';
  if (state === 6) return 'ended';
  if (state === 7) return 'error';
  if (state === 5) return 'closed';
  return 'loading';
}

class LibVlcPlaybackSession {
  readonly id = crypto.randomUUID();
  private readonly instance: any;
  private readonly player: any;
  private readonly timer: NodeJS.Timeout;
  private stopped = false;
  private ended = false;
  private state: LibVlcPlaybackState;

  constructor(
    private readonly runtime: LibVlcRuntime,
    private readonly owner: WebContents,
    ownerWindow: BrowserWindow,
    filePath: string,
    options: LibVlcStartOptions,
    private readonly onTerminated: (session: LibVlcPlaybackSession) => void,
  ) {
    const api = runtime.api;
    this.state = {
      sessionId: this.id,
      status: 'starting',
      volume: clamp(finite(options.volume, 1), 0, 1),
      muted: options.muted === true,
      speed: clamp(finite(options.speed, 1), 0.25, 3),
    };
    this.instance = api.newInstance(0, null);
    if (!this.instance) throw new Error('LibVLC could not create a media instance.');

    let media: any;
    try {
      media = api.mediaNewPath(this.instance, filePath);
      if (!media) throw new Error('LibVLC could not open the authorized local media path.');
      for (const subtitle of options.subtitleFiles || []) api.mediaAddOption(media, `:sub-file=${subtitle.path}`);
      if (finite(options.subtitleDelay, 0) !== 0) api.mediaAddOption(media, `:sub-delay=${Math.round(finite(options.subtitleDelay, 0) * 1_000_000)}`);
      this.player = api.playerNewFromMedia(media);
    } catch (error) {
      if (media) {
        try { api.mediaRelease(media); } catch { /* best effort */ }
      }
      try { api.releaseInstance(this.instance); } catch { /* best effort */ }
      throw error;
    }
    api.mediaRelease(media);
    if (!this.player) {
      api.releaseInstance(this.instance);
      throw new Error('LibVLC could not create a media player.');
    }

    try {
      api.setDrawable(this.player, drawableForWindow(ownerWindow));
      api.audioSetVolume(this.player, Math.round(clamp(finite(options.volume, 1), 0, 1) * 100));
      api.audioSetMute(this.player, options.muted === true ? 1 : 0);
      api.playerSetRate(this.player, clamp(finite(options.speed, 1), 0.25, 3));
      const startSeconds = Math.max(0, finite(options.startSeconds, 0));
      if (api.playerPlay(this.player) < 0) throw new Error('LibVLC rejected the authorized local media source.');
      if (startSeconds > 0) api.playerSetTime(this.player, Math.round(startSeconds * 1_000));
    } catch (error) {
      this.release();
      throw error instanceof Error ? error : new Error('LibVLC could not start local playback.');
    }

    owner.once('destroyed', () => this.stop());
    this.emit({ status: 'loading' });
    this.timer = setInterval(() => this.poll(), 250);
    this.timer.unref();
  }

  private emit(patch: Partial<LibVlcPlaybackState>): void {
    this.state = { ...this.state, ...patch };
    if (!this.owner.isDestroyed()) this.owner.send('libvlc:state', this.state);
  }

  private poll(): void {
    if (this.stopped) return;
    try {
      const api = this.runtime.api;
      const nativeState = Number(api.playerGetState(this.player));
      const status = statusForLibVlcState(nativeState);
      const durationMs = Number(api.playerGetLength(this.player));
      const positionMs = Number(api.playerGetTime(this.player));
      const duration = durationMs > 0 ? durationMs / 1_000 : undefined;
      const position = positionMs >= 0 ? positionMs / 1_000 : undefined;
      const next: Partial<LibVlcPlaybackState> = {
        status,
        duration,
        position,
        paused: nativeState === 4,
      };
      this.emit(next);
      if (status === 'ended') {
        this.ended = true;
        this.finish();
      } else if (status === 'error') {
        this.emit({ status: 'error', error: 'LibVLC reported a playback error.' });
        this.finish();
      }
    } catch (error) {
      this.emit({ status: 'error', error: error instanceof Error ? error.message : 'LibVLC playback failed.' });
      this.finish();
    }
  }

  command(command: LibVlcCommand): boolean {
    if (this.stopped) return false;
    try {
      const api = this.runtime.api;
      switch (command.type) {
        case 'set-paused':
          api.playerSetPause(this.player, command.paused ? 1 : 0);
          this.emit({ paused: command.paused });
          return true;
        case 'seek':
          api.playerSetTime(this.player, Math.round(Math.max(0, finite(command.position, 0)) * 1_000));
          return true;
        case 'set-volume':
          {
            const volume = clamp(finite(command.volume, 1), 0, 1);
            const result = Number(api.audioSetVolume(this.player, Math.round(volume * 100)));
            if (result >= 0) this.emit({ volume });
            return result >= 0;
          }
        case 'set-muted':
          api.audioSetMute(this.player, command.muted ? 1 : 0);
          this.emit({ muted: command.muted });
          return true;
        case 'set-speed':
          {
            const speed = clamp(finite(command.speed, 1), 0.25, 3);
            const result = Number(api.playerSetRate(this.player, speed));
            if (result >= 0) this.emit({ speed });
            return result >= 0;
          }
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  stop(): boolean {
    if (this.stopped) return false;
    try { this.runtime.api.playerStop(this.player); } catch { /* release still runs */ }
    this.finish();
    return true;
  }

  private release(): void {
    try { this.runtime.api.playerRelease(this.player); } catch { /* best effort */ }
    try { this.runtime.api.releaseInstance(this.instance); } catch { /* best effort */ }
  }

  private finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.release();
    this.emit({ status: this.ended ? 'ended' : 'closed', paused: true });
    this.onTerminated(this);
  }
}

export function startLibVlcPlayback(
  owner: WebContents,
  filePath: string,
  options: LibVlcStartOptions = {},
): { ok: boolean; sessionId?: string; error?: string } {
  if (!libVlcEnabled()) return { ok: false, error: libVlcDisabledReason() };
  try {
    assertNonRemoteSource(filePath, 'media');
    for (const subtitle of options.subtitleFiles || []) assertNonRemoteSource(subtitle.path, 'subtitle');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Only local media sources are allowed.' };
  }
  const { runtime } = cachedRuntime();
  const ownerWindow = BrowserWindow.fromWebContents(owner);
  if (!runtime) return { ok: false, error: libVlcAvailability().reason };
  if (!ownerWindow || ownerWindow.isDestroyed()) return { ok: false, error: 'The LoomTV window is unavailable.' };
  try {
    currentSession?.stop();
    const session = new LibVlcPlaybackSession(runtime, owner, ownerWindow, filePath, options, (terminated) => {
      if (currentSession === terminated) currentSession = null;
    });
    currentSession = session;
    return { ok: true, sessionId: session.id };
  } catch (error) {
    invalidateLibVlcRuntimeCache();
    return { ok: false, error: error instanceof Error ? error.message : 'LibVLC could not start local playback.' };
  }
}

export function commandLibVlcPlayback(sessionId: string, command: LibVlcCommand): boolean {
  return currentSession?.id === sessionId ? currentSession.command(command) : false;
}

export function stopLibVlcPlayback(sessionId?: string): boolean {
  if (!currentSession || (sessionId && currentSession.id !== sessionId)) return false;
  const stopped = currentSession.stop();
  currentSession = null;
  return stopped;
}

export function stopAllLibVlcPlayback(): void {
  stopLibVlcPlayback();
}
