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
import { recordPlaybackDiagnostic } from './playbackDiagnostics.ts';
import { isScreenLocked } from './screenLock.ts';
import { finiteNumber, meetsMinimumMacOS, mpvColor, mpvFlag, normalizeMpvTracks } from './mpvPlaybackHelpers.ts';
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

// bundle-libmpv.cjs records the oldest macOS its libraries support. Check it
// before loading so older systems fall back to HLS with a clear reason.
function bundledMinimumMacOS(libraryPath: string): string | null {
  try {
    const inventory: unknown = JSON.parse(fs.readFileSync(path.join(path.dirname(libraryPath), 'libmpv-inventory.json'), 'utf8'));
    const minimum = (inventory as { minimumMacOS?: unknown } | null)?.minimumMacOS;
    return typeof minimum === 'string' ? minimum : null;
  } catch {
    return null;
  }
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
  const minimumMacOS = bundledMinimumMacOS(paths.libraryPath);
  // getSystemVersion exists only in Electron; plain Node runs skip the check.
  const systemVersion = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : null;
  if (process.platform === 'darwin' && systemVersion && !meetsMinimumMacOS(systemVersion, minimumMacOS)) {
    cachedWarning = `The bundled libmpv requires macOS ${minimumMacOS} or later.`;
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

const PRESENTATION_COMMANDS: ReadonlySet<MpvCommand['type']> = new Set([
  'set-video-aspect', 'set-video-crop', 'set-video-rotation', 'set-subtitle-style',
]);

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
    // mpv clears the crop with an empty value; "no" is rejected.
    case 'set-video-crop': return [['set_property', 'video-crop', command.crop ?? '']];
    case 'set-video-rotation': return [['set_property', 'video-rotate', command.degrees]];
    case 'set-subtitle-style': {
      // Saved styles can hold CSS colors such as "transparent" or rgba().
      // Convert them, and leave out any mpv cannot represent rather than let
      // one rejected color end the whole playback session.
      const colors = [
        ['sub-color', mpvColor(command.color)],
        ['sub-border-color', mpvColor(command.borderColor)],
        ['sub-back-color', mpvColor(command.backgroundColor)],
      ] as const;
      return [
        ['set_property', 'sub-font-size', command.fontSize],
        ...colors.flatMap(([name, value]) => (value ? [['set_property', name, value]] : [])),
        ['set_property', 'sub-border-size', command.borderWidth],
        ['set_property', 'sub-pos', command.position],
      ];
    }
  }
}

class LibMpvSession {
  readonly id = crypto.randomUUID();
  private engine: NativePointer = null;
  private host: NativeViewHost | null = null;
  private timer: NodeJS.Timeout | null = null;
  private eventBuffer: Buffer | null = Buffer.allocUnsafe(2 * 1024 * 1024 + 1);
  private readonly onOwnerDestroyed = () => this.stop();
  private request = 0;
  private stopped = false;
  private local4kCacheLimited = false;
  private state: MpvPlaybackState = { sessionId: this.id, status: 'starting' };
  private diagnostics: MpvPlaybackDiagnostics = {};
  private readonly subtitleSources: Map<string, 'sidecar' | 'opensubtitles'>;
  private afterLoad: unknown[][];
  // Mute acts on the audio output, after mpv's ~200 ms buffer, so M is instant
  // both ways. The soft \`mute\` property is applied before that buffer, which
  // let a fifth of a second of sound play after M; it is used only until an
  // output exists. Both output controls are LoomTV's own, never system volume:
  // avfoundation implements ao-mute, and coreaudio only ao-volume on its
  // private audio unit.
  private desiredMuted = false;
  private softMuted = false;
  private lastOcclusionCheckAt = 0;
  private occludedSince = 0;
  private selectedVideoTrackId: number | null = null;
  private suspendedVideoTrackId: number | null = null;

  constructor(
    private readonly runtime: Runtime,
    private readonly owner: WebContents,
    private readonly ownerWindow: BrowserWindow,
    private readonly source: string,
    options: MpvStartOptions,
    private readonly onStopped: (session: LibMpvSession) => void,
  ) {
    this.subtitleSources = new Map((options.subtitleFiles || []).map((file) => [path.resolve(file.path), file.source]));
    this.desiredMuted = options.muted === true;
    this.softMuted = this.desiredMuted;
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
    try {
      const error = Buffer.alloc(1024);
      this.engine = runtime.api.create(runtime.libraryPath, error, error.length) as NativePointer;
      if (!this.engine) throw new Error(errorText(error, 'libmpv could not create a playback core.'));
      this.host = createNativeViewHost(loadKoffi(), ownerWindow);
      const attached = Number(runtime.api.attach(this.engine, this.host.drawable, error, error.length));
      if (attached < 0) throw new Error(errorText(error, 'The libmpv render surface could not attach.'));
      owner.once('destroyed', this.onOwnerDestroyed);
      this.timer = setInterval(() => this.poll(), 16);
      this.timer.unref?.();
      this.send(['loadfile', source, 'replace']);
      this.emit({ status: 'loading' });
    } catch (cause) {
      this.dispose();
      throw cause;
    }
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
    if (this.stopped || !this.engine || !this.eventBuffer) return;
    const output = this.eventBuffer;
    try {
      if (this.state.status === 'ready') this.syncOffscreenVideo(Date.now());
      const length = Number(this.runtime.api.pollInto(this.engine, output, output.length));
      if (length === 0) return;
      if (length < 0 || length > output.length - 1) throw new Error('libmpv returned an oversized event batch.');
      const messages = JSON.parse(output.subarray(0, length).toString('utf8')) as MpvMessage[];
      for (const message of messages) {
        if (this.stopped) break;
        this.handle(message);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'libmpv returned an invalid event.');
    }
  }

  private handle(message: MpvMessage): void {
    if (message.event === 'bridge-error') return this.fail(message.error || 'The libmpv renderer failed.');
    if (message.event === 'file-loaded') {
      const commands = this.afterLoad.splice(0);
      // These are preferences layered on a file that already opened. One that
      // mpv rejects is logged and skipped, never a reason to abandon native
      // playback for the transcoded fallback.
      for (const command of commands) {
        try {
          this.send(command);
        } catch (error) {
          console.warn(`[playback] libmpv skipped ${String(command[1] ?? command[0])}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
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
    else if (message.name === 'pause') this.emit({ paused: mpvFlag(message.data) });
    else if (message.name === 'volume') this.emit({ volume: finiteNumber(message.data) === undefined ? undefined : Number(message.data) / 100 });
    // The soft mute no longer carries the viewer's choice; report that choice.
    else if (message.name === 'mute') this.emit({ muted: this.desiredMuted });
    else if (message.name === 'current-ao') {
      // A new audio output starts at full volume: after an audio track change
      // or a device switch, carry the mute over to it.
      if (typeof message.data === 'string' && message.data && this.desiredMuted
        && this.muteOutput(true) && this.softMuted
        && this.trySend(['set_property', 'mute', false])) {
        this.softMuted = false;
      }
    }
    else if (message.name === 'speed') this.emit({ speed: finiteNumber(message.data) });
    else if (message.name === 'track-list') {
      const tracks = normalizeMpvTracks(message.data, this.subtitleSources);
      const selectedVideo = tracks.find((track) => track.type === 'video' && track.selected);
      if (selectedVideo) this.selectedVideoTrackId = selectedVideo.id;
      // Turning video off offscreen is not the viewer's choice; keep the
      // track shown as selected.
      this.emit({
        tracks: this.suspendedVideoTrackId === null ? tracks : tracks.map((track) => (
          track.type === 'video' ? { ...track, selected: track.id === this.suspendedVideoTrackId } : track
        )),
      });
    }
    else if (message.name === 'video-params' && message.data && typeof message.data === 'object') {
      const params = message.data as Record<string, unknown>;
      const width = finiteNumber(params.w);
      const height = finiteNumber(params.h);
      this.emit({ videoWidth: width, videoHeight: height });
      if (!this.local4kCacheLimited && path.isAbsolute(this.source)
        && ((width ?? 0) > 2560 || (height ?? 0) > 1440)) {
        this.local4kCacheLimited = true;
        // Bound compressed packet retention for local 4K files. Decoder frame
        // pools, rendering quality, and exact seek behavior remain engine-owned.
        this.send(['set_property', 'demuxer-max-bytes', 64 * 1024 * 1024]);
        this.send(['set_property', 'demuxer-max-back-bytes', 16 * 1024 * 1024]);
        recordPlaybackDiagnostic('mpv.local4k.packetBudgetBytes', 80 * 1024 * 1024);
      }
    } else if (message.name === 'hwdec-current') {
      const decoder = typeof message.data === 'string' && message.data ? message.data : undefined;
      if (decoder !== this.diagnostics.hardwareDecoder) {
        recordPlaybackDiagnostic('mpv.decoder', decoder || 'unknown');
      }
      this.updateDiagnostics({
        hardwareDecoder: decoder,
        hardwareDecode: decoder === undefined ? undefined : decoder !== 'no',
      });
    }
    else if (message.name === 'frame-drop-count') this.updateDiagnostics({ frameDrops: finiteNumber(message.data) });
    else if (message.name === 'decoder-frame-drop-count') this.updateDiagnostics({ decoderFrameDrops: finiteNumber(message.data) });
    else if (message.name === 'demuxer-cache-duration') this.updateDiagnostics({ bufferSeconds: finiteNumber(message.data) });
    else if (message.name === 'paused-for-cache') this.updateDiagnostics({ buffering: mpvFlag(message.data) });
    else if (message.name === 'video-codec') this.updateDiagnostics({ videoCodec: typeof message.data === 'string' ? message.data : undefined });
    else if (message.name === 'estimated-vf-fps') this.updateDiagnostics({ estimatedFps: finiteNumber(message.data) });
  }

  private updateDiagnostics(patch: MpvPlaybackDiagnostics): void {
    this.diagnostics = { ...this.diagnostics, ...patch };
    this.emit({ diagnostics: this.diagnostics });
  }

  private emit(patch: Partial<MpvPlaybackState>): void {
    this.state = { ...this.state, ...patch, sessionId: this.id };
    syncNativePlaybackDisplaySleep(this.id, this.state, () => {
      if (!this.owner.isDestroyed()) {
        this.owner.send('media-control:command', { type: 'pause' }, true);
      }
      this.command({ type: 'set-paused', paused: true });
    });
    if (!this.owner.isDestroyed()) this.owner.send('mpv:state', { ...patch, sessionId: this.id, status: this.state.status });
  }

  private fail(message: string): void {
    console.warn(`[playback] libmpv session failed — ${message}`);
    try {
      this.emit({ status: 'error', paused: true, error: message });
    } finally {
      this.dispose();
    }
  }

  private trySend(command: unknown[]): boolean {
    try { return this.send(command); } catch { return false; }
  }

  /** Mute or unmute at the audio output. False when no output control exists yet. */
  private muteOutput(muted: boolean): boolean {
    if (this.trySend(['set_property', 'ao-mute', muted])) {
      // Undo an earlier ao-volume mute in case the output changed type.
      if (!muted) this.trySend(['set_property', 'ao-volume', 100]);
      return true;
    }
    return this.trySend(['set_property', 'ao-volume', muted ? 0 : 100]);
  }

  private applyMute(muted: boolean): boolean {
    this.desiredMuted = muted;
    this.emit({ muted });
    const appliedAtOutput = this.muteOutput(muted);
    try {
      // Without an audio output yet, or to clear a mute set at startup, fall
      // back to the soft property. Either failing still fails closed.
      if (!appliedAtOutput || (!muted && this.softMuted)) {
        this.send(['set_property', 'mute', muted]);
        this.softMuted = muted;
      }
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'libmpv rejected the mute command.');
      return false;
    }
  }

  /**
   * Turn video off while the window is fully hidden. mpv keeps about 200 MB
   * of OpenGL render targets in the main process for as long as a video
   * output exists, which is wasted while nothing is on screen; audio keeps
   * playing. See LibVlcPlaybackSession.syncOffscreenVideo for the LibVLC case.
   */
  private syncOffscreenVideo(now: number): void {
    if (now - this.lastOcclusionCheckAt < 500) return;
    this.lastOcclusionCheckAt = now;
    if (!this.host?.isOccluded?.() && !isScreenLocked()) {
      this.occludedSince = 0;
      this.resumeOffscreenVideo();
      return;
    }
    if (this.occludedSince === 0) this.occludedSince = now;
    if (this.suspendedVideoTrackId !== null || this.selectedVideoTrackId === null) return;
    if (now - this.occludedSince < 3_000) return;
    if (!this.trySend(['set_property', 'vid', 'no'])) return;
    this.suspendedVideoTrackId = this.selectedVideoTrackId;
    recordPlaybackDiagnostic('mpv.offscreen', 'video-suspended');
  }

  private resumeOffscreenVideo(): void {
    const trackId = this.suspendedVideoTrackId;
    if (trackId === null) return;
    this.suspendedVideoTrackId = null;
    // The relative zero seek decodes the current frame, which a paused
    // player would otherwise not show until playback resumes.
    if (this.trySend(['set_property', 'vid', trackId])) this.trySend(['seek', 0, 'relative+exact']);
    recordPlaybackDiagnostic('mpv.offscreen', 'video-restored');
  }

  command(command: MpvCommand): boolean {
    if (command.type === 'set-muted') return this.applyMute(command.muted);
    if (command.type === 'set-video-track') this.suspendedVideoTrackId = null;
    try { return commandList(command).every((entry) => this.send(entry)); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'libmpv rejected a playback command.';
      // A rejected display preference leaves the video playing as it was.
      // Transport and track commands still fail closed.
      if (PRESENTATION_COMMANDS.has(command.type)) {
        console.warn(`[playback] libmpv skipped ${command.type}: ${message}`);
        return false;
      }
      this.fail(message);
      return false;
    }
  }

  setViewport(owner: WebContents, viewport: PlaybackViewport): boolean {
    if (owner !== this.owner || this.stopped || !this.host) return false;
    this.host.syncBounds(viewport);
    return true;
  }

  syncSurface(owner: WebContents): boolean {
    if (owner !== this.owner || this.stopped || !this.host) return false;
    this.host.syncHierarchy(true);
    this.host.setVisible(!this.ownerWindow.isMinimized() && this.ownerWindow.isVisible());
    return true;
  }

  setFullscreenTransition(owner: WebContents, transitioning: boolean): boolean {
    if (owner !== this.owner || this.stopped || !this.host) return false;
    this.host.setAutoresize(transitioning);
    if (!transitioning) this.host.syncHierarchy(true);
    return true;
  }

  private dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.owner.removeListener('destroyed', this.onOwnerDestroyed);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.eventBuffer = null;
    const engine = this.engine;
    const host = this.host;
    this.engine = null;
    this.host = null;
    for (const cleanup of [
      () => releaseNativePlaybackDisplaySleep(this.id),
      () => { if (engine) this.runtime.api.destroy(engine); },
      () => host?.destroy(),
      () => this.onStopped(this),
    ]) {
      try { cleanup(); } catch (error) { console.warn('[playback] libmpv cleanup failed', error); }
    }
  }

  stop(): boolean {
    if (this.stopped) return false;
    try { this.send(['stop']); } catch {}
    try {
      this.emit({ status: 'closed' });
    } finally {
      this.dispose();
    }
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
