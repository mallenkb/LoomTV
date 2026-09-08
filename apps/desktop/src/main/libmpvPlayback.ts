import { BrowserWindow, type WebContents } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  MpvAvailability,
  MpvCommand,
  MpvPlaybackDiagnostics,
  MpvPlaybackState,
  MpvStartOptions,
} from '../shared/desktopProtocol.ts';
import type { PlaybackViewport } from '../shared/playbackProtocol.ts';
import { finiteNumber, normalizeMpvTracks } from './mpvPlaybackHelpers.ts';
import {
  createNativeViewHost,
  loadKoffi,
  type KoffiLibrary,
  type NativeViewHost,
} from './libvlcPlayback.ts';
import {
  releaseNativePlaybackDisplaySleep,
  syncNativePlaybackDisplaySleep,
} from './nativePlaybackPower.ts';

type NativePointer = bigint | number | null;
type NativeFunction = (...args: Array<string | number | bigint | Buffer | null>) => unknown;
type BridgeApi = {
  library: KoffiLibrary;
  create: NativeFunction;
  attach: NativeFunction;
  command: NativeFunction;
  pollInto: NativeFunction;
  destroy: NativeFunction;
};
type Runtime = {
  bridgePath: string;
  libraryPath: string;
  api: BridgeApi;
};
type MpvMessage = {
  event?: string;
  name?: string;
  data?: unknown;
  error?: string;
  reason?: string;
  request_id?: number;
};

let cachedRuntime: Runtime | null | undefined;
let cachedWarning = '';

function runtimeRoots(): string[] {
  const roots = typeof process.resourcesPath === 'string' && process.resourcesPath
    ? [path.join(process.resourcesPath, 'mpv', 'lib')]
    : [];
  if ((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp) {
    roots.push(
      path.resolve(__dirname, '../../resources/mpv/lib'),
      path.resolve(__dirname, '../../../desktop-tauri/src-tauri/resources/mpv/lib'),
    );
  }
  return [...new Set(roots)];
}

function configuredPaths(): { bridgePath: string; libraryPath: string } | null {
  const configuredLibrary = process.env.LOOMTV_LIBMPV_PATH?.trim();
  const configuredBridge = process.env.LOOMTV_LIBMPV_BRIDGE_PATH?.trim();
  const libraryName = process.platform === 'darwin'
    ? 'libmpv.dylib'
    : process.platform === 'win32' ? 'mpv-2.dll' : 'libmpv.so';
  const bridgeName = process.platform === 'darwin'
    ? 'libloomtv_mpv_bridge.dylib'
    : process.platform === 'win32' ? 'loomtv_mpv_bridge.dll' : 'libloomtv_mpv_bridge.so';
  const candidates = [
    ...(configuredLibrary && configuredBridge
      ? [{ bridgePath: path.resolve(configuredBridge), libraryPath: path.resolve(configuredLibrary) }]
      : []),
    ...runtimeRoots().map((root) => ({
      bridgePath: path.join(root, bridgeName),
      libraryPath: path.join(root, libraryName),
    })),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate.bridgePath) && fs.existsSync(candidate.libraryPath)) || null;
}

function bind(library: KoffiLibrary, name: string, result: string, args: string[]): NativeFunction {
  return library.func(name, result, args) as NativeFunction;
}

function loadRuntime(force = false): Runtime | null {
  if (force) cachedRuntime = undefined;
  if (cachedRuntime !== undefined) return cachedRuntime;
  const paths = configuredPaths();
  if (!paths) {
    cachedWarning = 'The bundled libmpv library or native bridge is missing.';
    cachedRuntime = null;
    return null;
  }
  try {
    const koffi = loadKoffi();
    const library = koffi.load(paths.bridgePath);
    const version = bind(library, 'loom_mpv_bridge_version', 'uint32', []);
    if (Number(version()) !== 1) throw new Error('The bundled libmpv bridge version is unsupported.');
    cachedWarning = '';
    cachedRuntime = {
      ...paths,
      api: {
        library,
        create: bind(library, 'loom_mpv_create', 'void *', ['str', 'void *', 'size_t']),
        attach: bind(library, 'loom_mpv_attach', 'int', ['void *', 'void *', 'void *', 'size_t']),
        command: bind(library, 'loom_mpv_command', 'int', ['void *', 'uint64', 'str', 'void *', 'size_t']),
        pollInto: bind(library, 'loom_mpv_poll_into', 'int', ['void *', 'void *', 'size_t']),
        destroy: bind(library, 'loom_mpv_destroy', 'void', ['void *']),
      },
    };
    return cachedRuntime;
  } catch (error) {
    cachedWarning = error instanceof Error ? error.message : 'The libmpv bridge could not load.';
    cachedRuntime = null;
    return null;
  }
}

function errorText(buffer: Buffer, fallback: string): string {
  const end = buffer.indexOf(0);
  const value = buffer.subarray(0, end < 0 ? buffer.length : end).toString('utf8').trim();
  return value || fallback;
}

function disabled(): boolean {
  const value = process.env.LOOMTV_DISABLE_LIBMPV?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function libMpvAvailability(force = false): MpvAvailability {
  if (disabled()) return { available: false, surface: 'unavailable', reason: 'Native libmpv playback is disabled for this run.' };
  const runtime = loadRuntime(force);
  return runtime ? {
    available: true,
    surface: 'composited-window',
    libraryPath: runtime.libraryPath,
    runtimeSource: 'bundled',
    version: 'libmpv client API 2',
  } : {
    available: false,
    surface: 'unavailable',
    reason: cachedWarning || 'libmpv is unavailable.',
  };
}

export function libMpvRuntimeSummary(): string {
  const availability = libMpvAvailability();
  return availability.available
    ? `[playback] native libmpv ready — ${availability.libraryPath}`
    : `[playback] native libmpv unavailable — ${availability.reason}`;
}

function commandList(command: MpvCommand): unknown[][] {
  switch (command.type) {
    case 'set-paused': return [['set_property', 'pause', command.paused]];
    case 'seek': return [['seek', Math.max(0, command.position), 'absolute+exact']];
    case 'set-volume': return [['set_property', 'volume', Math.max(0, Math.min(1, command.volume)) * 100]];
    case 'set-muted': return [['set_property', 'mute', command.muted]];
    case 'set-speed': return [['set_property', 'speed', Math.max(0.25, Math.min(3, command.speed))]];
    case 'set-video-track': return [['set_property', 'vid', command.trackId ?? 'no']];
    case 'set-audio-track': return [['set_property', 'aid', command.trackId ?? 'no']];
    case 'set-subtitle-track': return [['set_property', 'sid', command.trackId ?? 'no']];
    case 'set-secondary-subtitle-track': return [['set_property', 'secondary-sid', command.trackId ?? 'no']];
    case 'set-subtitle-delay': return [['set_property', 'sub-delay', command.seconds]];
    case 'set-audio-delay': return [['set_property', 'audio-delay', command.seconds]];
    case 'set-video-aspect': return [['set_property', 'video-aspect-override', command.aspect ?? '-1']];
    case 'set-video-crop': return [['set_property', 'video-crop', command.crop ?? 'no']];
    case 'set-video-rotation': return [['set_property', 'video-rotate', command.degrees]];
    case 'set-subtitle-style': return [
      ['set_property', 'sub-font-size', command.fontSize],
      ['set_property', 'sub-color', command.color],
      ['set_property', 'sub-border-color', command.borderColor],
      ['set_property', 'sub-border-size', command.borderWidth],
      ['set_property', 'sub-back-color', command.backgroundColor],
      ['set_property', 'sub-pos', command.position],
    ];
  }
}

class LibMpvSession {
  readonly id = crypto.randomUUID();
  private readonly engine: NativePointer;
  private readonly host: NativeViewHost;
  private timer: NodeJS.Timeout | null = null;
  private readonly eventBuffer = Buffer.allocUnsafe(2 * 1024 * 1024 + 1);
  private request = 0;
  private stopped = false;
  private state: MpvPlaybackState = { sessionId: this.id, status: 'starting' };
  private diagnostics: MpvPlaybackDiagnostics = {};
  private readonly subtitleSources: Map<string, 'sidecar' | 'opensubtitles'>;
  private afterLoad: unknown[][];

  constructor(
    private readonly runtime: Runtime,
    private readonly owner: WebContents,
    private readonly ownerWindow: BrowserWindow,
    source: string,
    options: MpvStartOptions,
    private readonly onStopped: (session: LibMpvSession) => void,
  ) {
    const error = Buffer.alloc(1024);
    this.engine = runtime.api.create(runtime.libraryPath, error, error.length) as NativePointer;
    if (!this.engine) throw new Error(errorText(error, 'libmpv could not create a playback core.'));
    try {
      this.host = createNativeViewHost(loadKoffi(), ownerWindow);
      const attached = Number(runtime.api.attach(this.engine, this.host.drawable, error, error.length));
      if (attached < 0) throw new Error(errorText(error, 'The libmpv render surface could not attach.'));
    } catch (cause) {
      runtime.api.destroy(this.engine);
      throw cause;
    }
    this.subtitleSources = new Map((options.subtitleFiles || []).map((file) => [path.resolve(file.path), file.source]));
    this.afterLoad = [
      ['set_property', 'volume', Math.max(0, Math.min(1, options.volume ?? 1)) * 100],
      ['set_property', 'mute', options.muted === true],
      ['set_property', 'speed', Math.max(0.25, Math.min(3, options.speed ?? 1))],
      ['set_property', 'pause', false],
      ...(options.audioLanguage ? [['set_property', 'alang', options.audioLanguage]] : []),
      ...(Number.isFinite(options.audioTrackId) ? [['set_property', 'aid', options.audioTrackId]] : []),
      ...(options.audioDelay !== undefined ? [['set_property', 'audio-delay', options.audioDelay]] : []),
      ...(options.subtitleDelay !== undefined ? [['set_property', 'sub-delay', options.subtitleDelay]] : []),
      ...(options.startSeconds && options.startSeconds > 0 ? [['seek', options.startSeconds, 'absolute+exact']] : []),
      ...(options.subtitleFiles || []).map((file) => ['sub-add', file.path, 'auto']),
    ];
    if (options.subtitleStyle) this.afterLoad.push(...commandList({ type: 'set-subtitle-style', ...options.subtitleStyle }));
    this.timer = setInterval(() => this.poll(), 16);
    this.timer.unref?.();
    this.send(['loadfile', source, 'replace']);
    this.emit({ status: 'loading' });
    owner.once('destroyed', () => this.stop());
  }

  private send(command: unknown[]): boolean {
    if (this.stopped || !this.engine) return false;
    const error = Buffer.alloc(1024);
    const result = Number(this.runtime.api.command(
      this.engine,
      ++this.request,
      JSON.stringify(command),
      error,
      error.length,
    ));
    if (result < 0) throw new Error(`libmpv ${String(command[0])} failed: ${errorText(error, 'command rejected')}`);
    return true;
  }

  private poll(): void {
    if (this.stopped || !this.engine) return;
    const output = this.eventBuffer;
    try {
      const length = Number(this.runtime.api.pollInto(this.engine, output, output.length));
      if (length === 0) return;
      if (length < 0 || length > output.length - 1) throw new Error('libmpv returned an oversized event batch.');
      const messages = JSON.parse(output.subarray(0, length).toString('utf8')) as MpvMessage[];
      for (const message of messages) this.handle(message);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'libmpv returned an invalid event.');
    }
  }

  private handle(message: MpvMessage): void {
    if (message.event === 'bridge-error') return this.fail(message.error || 'The libmpv renderer failed.');
    if (message.event === 'file-loaded') {
      const commands = this.afterLoad.splice(0);
      for (const command of commands) this.send(command);
      this.emit({ status: 'ready', paused: false });
      return;
    }
    if (message.event === 'start-file') return this.emit({ status: 'loading' });
    if (message.event === 'end-file') {
      if (message.reason === 'eof') this.emit({ status: 'ended', paused: true });
      else if (!['stop', 'quit', 'redirect'].includes(message.reason || '')) this.fail(message.error || 'libmpv could not play this source.');
      return;
    }
    if (message.event !== 'property-change' || !message.name) return;
    if (message.name === 'time-pos') this.emit({ position: finiteNumber(message.data) });
    else if (message.name === 'duration') this.emit({ duration: finiteNumber(message.data) });
    else if (message.name === 'pause') this.emit({ paused: message.data === true });
    else if (message.name === 'volume') this.emit({ volume: finiteNumber(message.data) === undefined ? undefined : Number(message.data) / 100 });
    else if (message.name === 'mute') this.emit({ muted: message.data === true });
    else if (message.name === 'speed') this.emit({ speed: finiteNumber(message.data) });
    else if (message.name === 'track-list') this.emit({ tracks: normalizeMpvTracks(message.data, this.subtitleSources) });
    else if (message.name === 'video-params' && message.data && typeof message.data === 'object') {
      const params = message.data as Record<string, unknown>;
      this.emit({ videoWidth: finiteNumber(params.w), videoHeight: finiteNumber(params.h) });
    } else if (message.name === 'hwdec-current') this.updateDiagnostics({
      hardwareDecoder: typeof message.data === 'string' ? message.data : undefined,
      hardwareDecode: typeof message.data === 'string' && message.data !== 'no',
    });
    else if (message.name === 'frame-drop-count') this.updateDiagnostics({ frameDrops: finiteNumber(message.data) });
    else if (message.name === 'decoder-frame-drop-count') this.updateDiagnostics({ decoderFrameDrops: finiteNumber(message.data) });
    else if (message.name === 'demuxer-cache-duration') this.updateDiagnostics({ bufferSeconds: finiteNumber(message.data) });
    else if (message.name === 'paused-for-cache') this.updateDiagnostics({ buffering: message.data === true });
    else if (message.name === 'video-codec') this.updateDiagnostics({ videoCodec: typeof message.data === 'string' ? message.data : undefined });
    else if (message.name === 'estimated-vf-fps') this.updateDiagnostics({ estimatedFps: finiteNumber(message.data) });
  }

  private updateDiagnostics(patch: MpvPlaybackDiagnostics): void {
    this.diagnostics = { ...this.diagnostics, ...patch };
    this.emit({ diagnostics: this.diagnostics });
  }

  private emit(patch: Partial<MpvPlaybackState>): void {
    this.state = { ...this.state, ...patch, sessionId: this.id };
    syncNativePlaybackDisplaySleep(this.id, this.state);
    if (!this.owner.isDestroyed()) this.owner.send('mpv:state', { ...patch, sessionId: this.id, status: this.state.status });
  }

  private fail(message: string): void {
    console.warn(`[playback] libmpv session failed — ${message}`);
    this.emit({ status: 'error', paused: true, error: message });
  }

  command(command: MpvCommand): boolean {
    try { return commandList(command).every((entry) => this.send(entry)); }
    catch (error) { this.fail(error instanceof Error ? error.message : 'libmpv rejected a playback command.'); return false; }
  }

  setViewport(owner: WebContents, viewport: PlaybackViewport): boolean {
    if (owner !== this.owner || this.stopped) return false;
    this.host.syncBounds(viewport);
    return true;
  }

  syncSurface(owner: WebContents): boolean {
    if (owner !== this.owner || this.stopped) return false;
    this.host.syncHierarchy(true);
    this.host.setVisible(!this.ownerWindow.isMinimized() && this.ownerWindow.isVisible());
    return true;
  }

  setFullscreenTransition(owner: WebContents, transitioning: boolean): boolean {
    if (owner !== this.owner || this.stopped) return false;
    this.host.setAutoresize(transitioning);
    if (!transitioning) this.host.syncHierarchy(true);
    return true;
  }

  stop(): boolean {
    if (this.stopped) return false;
    try { this.send(['stop']); } catch { /* teardown continues */ }
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    releaseNativePlaybackDisplaySleep(this.id);
    this.host.destroy();
    this.runtime.api.destroy(this.engine);
    this.emit({ status: 'closed' });
    this.onStopped(this);
    return true;
  }
}

let currentSession: LibMpvSession | null = null;

export function startLibMpvPlayback(owner: WebContents, source: string, options: MpvStartOptions = {}) {
  if (disabled()) return { ok: false, error: libMpvAvailability().reason };
  const runtime = loadRuntime();
  const ownerWindow = BrowserWindow.fromWebContents(owner);
  if (!runtime) return { ok: false, error: cachedWarning || 'libmpv is unavailable.' };
  if (!ownerWindow || ownerWindow.isDestroyed()) return { ok: false, error: 'The LoomTV window is unavailable.' };
  currentSession?.stop();
  try {
    const session = new LibMpvSession(runtime, owner, ownerWindow, source, options, (stopped) => {
      if (currentSession === stopped) currentSession = null;
    });
    currentSession = session;
    return { ok: true, sessionId: session.id, surface: 'composited-window' as const };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'libmpv could not start.' };
  }
}

export function commandLibMpvPlayback(sessionId: string, command: MpvCommand): boolean {
  return currentSession?.id === sessionId ? currentSession.command(command) : false;
}
export function stopLibMpvPlayback(sessionId?: string): boolean {
  if (!currentSession || (sessionId && currentSession.id !== sessionId)) return false;
  const result = currentSession.stop();
  currentSession = null;
  return result;
}
export function syncLibMpvPlaybackSurface(owner: WebContents): boolean {
  return currentSession?.syncSurface(owner) ?? false;
}
export function setLibMpvPlaybackViewport(owner: WebContents, viewport: PlaybackViewport): boolean {
  return currentSession?.setViewport(owner, viewport) ?? false;
}
export function setLibMpvPlaybackFullscreenTransition(owner: WebContents, transitioning: boolean): boolean {
  return currentSession?.setFullscreenTransition(owner, transitioning) ?? false;
}
export function stopAllLibMpvPlayback(): void {
  stopLibMpvPlayback();
  cachedRuntime = undefined;
}
