import { BrowserWindow, screen, type WebContents } from 'electron';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {
  MpvAvailability,
  MpvCommand,
  MpvPlaybackDiagnostics,
  MpvPlaybackState,
  MpvStartOptions,
} from '../shared/desktopProtocol.ts';
import {
  finiteNumber,
  isLikelyNaturalMpvEof,
  normalizeMpvTracks,
  unexpectedMpvExitMessage,
} from './mpvPlaybackHelpers.ts';
import {
  releaseNativePlaybackDisplaySleep,
  syncNativePlaybackDisplaySleep,
} from './nativePlaybackPower';
import { loadSettings } from './settings.ts';
import { parseRequiredJson } from './runtimeValidation.ts';
import { z } from 'zod';

type MpvJsonMessage = {
  event?: string;
  name?: string;
  data?: unknown;
  error?: string;
  reason?: string;
  request_id?: number;
};
const mpvJsonMessageSchema = z.object({
  event: z.string().optional(),
  name: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
  request_id: z.number().finite().optional(),
});

type MpvRuntime = {
  executablePath: string;
  source: 'environment' | 'user-selected' | 'bundled' | 'system';
};

const OBSERVED_PROPERTIES = [
  'time-pos',
  'duration',
  'pause',
  'volume',
  'mute',
  'speed',
  'track-list',
  'video-params',
  'hwdec-current',
  'frame-drop-count',
  'decoder-frame-drop-count',
  'demuxer-cache-duration',
  'cache-buffering-state',
  'video-codec',
  'estimated-vf-fps',
] as const;

function executableName(): string {
  return process.platform === 'win32' ? 'mpv.exe' : 'mpv';
}

function platformVariants(): string[] {
  if (process.platform === 'darwin') return ['mac', 'macos', 'darwin'];
  if (process.platform === 'win32') return ['win', 'windows'];
  return ['linux'];
}

function architectureVariants(): string[] {
  if (process.arch === 'arm64') return ['arm64', 'aarch64'];
  if (process.arch === 'x64') return ['x64', 'amd64'];
  if (process.arch === 'ia32') return ['ia32', 'x86'];
  if (process.arch === 'arm') return ['arm', 'armv7'];
  return [process.arch];
}

function packagedResourceRoots(): string[] {
  const roots: string[] = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.trim()) {
    roots.push(path.join(process.resourcesPath, 'mpv'));
  }
  // Electron's development resources directory does not contain extraResources;
  // only inspect the repository resource folder when running the unpackaged app.
  if ((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp) {
    roots.push(path.resolve(__dirname, '../../resources/mpv'));
  }
  return [...new Set(roots)];
}

function packagedCandidates(): string[] {
  const name = executableName();
  const layoutRoots: string[] = [];
  for (const root of packagedResourceRoots()) {
    for (const platform of platformVariants()) {
      for (const architecture of architectureVariants()) {
        layoutRoots.push(path.join(root, platform, architecture));
      }
      layoutRoots.push(path.join(root, platform));
    }
    for (const architecture of architectureVariants()) layoutRoots.push(path.join(root, architecture));
    layoutRoots.push(root);
  }

  const candidates: string[] = [];
  for (const root of layoutRoots) {
    candidates.push(
      path.join(root, name),
      path.join(root, 'bin', name),
      path.join(root, 'mpv.app', 'Contents', 'MacOS', name),
    );
  }
  return candidates;
}

function systemCandidates(): string[] {
  if (process.platform === 'win32') {
    return [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'mpv', 'mpv.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/Applications/mpv.app/Contents/MacOS/mpv'];
  }
  return ['/usr/bin/mpv', '/usr/local/bin/mpv', '/snap/bin/mpv'];
}

// Discovery may shell out to `which`, and `mpv --version` spawns a process —
// all synchronously. `mpvAvailability()` runs before every
// playback start, so without this cache each play blocks the main process (and
// therefore the media server serving any paired device). Keyed on
// LOOMTV_MPV_PATH so pointing at a different binary re-resolves, and cleared by
// invalidateMpvRuntimeCache() when a launch fails.
type MpvRuntimeCache = {
  key: string;
  runtime: MpvRuntime | null;
  version?: string;
  warning?: string;
  resolvedAt: number;
};
let runtimeCache: MpvRuntimeCache | null = null;
const MISSING_RUNTIME_CACHE_MS = 5000;

function runtimeCacheKey(): string {
  return `${process.env.LOOMTV_MPV_PATH?.trim() || ''}\0${loadSettings().mpvExecutablePath || ''}`;
}

export function invalidateMpvRuntimeCache(): void {
  runtimeCache = null;
}

function cachedMpvRuntime(): MpvRuntimeCache {
  const key = runtimeCacheKey();
  if (
    runtimeCache
    && runtimeCache.key === key
    && (runtimeCache.runtime || Date.now() - runtimeCache.resolvedAt < MISSING_RUNTIME_CACHE_MS)
  ) return runtimeCache;
  const runtime = resolveMpvRuntime();
  runtimeCache = {
    key,
    runtime: runtime.runtime,
    version: runtime.version,
    warning: runtime.warning,
    resolvedAt: Date.now(),
  };
  return runtimeCache;
}

function selectedMpvPath(): string {
  try {
    return loadSettings().mpvExecutablePath || '';
  } catch {
    return '';
  }
}

function normalizeMpvPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (process.platform === 'darwin' && resolved.toLowerCase().endsWith('.app')) {
    return path.join(resolved, 'Contents', 'MacOS', executableName());
  }
  return resolved;
}

export function validateMpvExecutable(candidate: string): { executablePath: string; version: string } {
  const executablePath = normalizeMpvPath(candidate);
  try {
    if (!fs.statSync(executablePath).isFile()) throw new Error('The selected path is not an executable file.');
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'The selected mpv path is unavailable.', { cause: error });
  }
  const version = mpvVersion(executablePath);
  if (!version) throw new Error('The selected file is not a working mpv executable.');
  return { executablePath, version };
}

function resolveMpvRuntime(): { runtime: MpvRuntime | null; version?: string; warning?: string } {
  const configured = process.env.LOOMTV_MPV_PATH?.trim();
  const selected = selectedMpvPath();
  const discovered = [...systemCandidates()];
  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const output = execFileSync(locator, [executableName()], { encoding: 'utf8', windowsHide: true });
    discovered.push(...output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  } catch {
    // Standard paths above are enough when the app was launched without PATH.
  }
  const directCandidates = [
    ...(configured ? [{ executablePath: configured, source: 'environment' as const }] : []),
    ...(selected ? [{ executablePath: selected, source: 'user-selected' as const }] : []),
    ...packagedCandidates().map((executablePath) => ({ executablePath, source: 'bundled' as const })),
    ...[...new Set(discovered)].map((executablePath) => ({ executablePath, source: 'system' as const })),
  ];
  const rejected: string[] = [];
  for (const candidate of directCandidates) {
    try {
      const validated = validateMpvExecutable(candidate.executablePath);
      return { runtime: { executablePath: validated.executablePath, source: candidate.source }, version: validated.version };
    } catch (error) {
      if (candidate.source !== 'system') rejected.push(`${candidate.source}: ${error instanceof Error ? error.message : 'unavailable'}`);
    }
  }
  return {
    runtime: null,
    warning: rejected.length > 0 ? `Configured mpv paths could not be used: ${rejected.join('; ')}` : undefined,
  };
}

function mpvVersion(executablePath: string): string | undefined {
  try {
    const output = execFileSync(executablePath, ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    return output.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

function ipcAddress(sessionId: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\loomtv-mpv-${sessionId}`;
  return path.join(os.tmpdir(), `loomtv-mpv-${sessionId}.sock`);
}

function mpvGeometry(window: BrowserWindow): string {
  const bounds = window.getContentBounds();
  let y = bounds.y;
  if (process.platform === 'darwin') {
    const display = screen.getDisplayMatching(bounds);
    y = display.bounds.y + display.bounds.height - bounds.y - bounds.height;
  }
  return `${Math.max(1, bounds.width)}x${Math.max(1, bounds.height)}+${bounds.x}+${y}`;
}

class MpvPlaybackSession {
  readonly id = crypto.randomUUID();
  private readonly address = ipcAddress(this.id);
  private readonly process: ChildProcess;
  private socket: net.Socket | null = null;
  private buffer = '';
  private stopped = false;
  private ended = false;
  private terminated = false;
  private launchError = false;
  private connectAttempts = 0;
  private requestId = 1;
  private lastPositionEventAt = 0;
  private lastStderr = '';
  private lastDiagnosticsEventAt = 0;
  private diagnosticsTimer: NodeJS.Timeout | null = null;
  private diagnostics: MpvPlaybackDiagnostics = {};
  private geometryTimer: NodeJS.Timeout | null = null;
  private exitGraceTimer: NodeJS.Timeout | null = null;
  private readonly pendingRequests = new Map<number, string>();
  private readonly subtitleSources: Map<string, 'sidecar' | 'opensubtitles'>;
  private state: MpvPlaybackState;
  private readonly windowListeners: Array<() => void> = [];

  constructor(
    executable: string,
    private readonly owner: WebContents,
    private readonly ownerWindow: BrowserWindow,
    filePath: string,
    options: MpvStartOptions,
    private readonly onTerminated: (session: MpvPlaybackSession) => void,
    private readonly onLaunchFailed: () => void,
  ) {
    this.state = { sessionId: this.id, status: 'starting' };
    this.subtitleSources = new Map(
      (options.subtitleFiles || []).map((subtitle) => [path.resolve(subtitle.path), subtitle.source]),
    );
    if (process.platform !== 'win32') fs.rmSync(this.address, { force: true });
    const args = [
      '--no-config',
      '--load-scripts=no',
      '--no-border',
      '--force-window=immediate',
      '--keep-open=no',
      '--idle=no',
      '--pause=no',
      '--osc=no',
      '--osd-level=0',
      '--input-default-bindings=no',
      '--input-cursor=no',
      '--cursor-autohide=no',
      '--focus-on-open=no',
      '--audio-display=no',
      '--sub-auto=no',
      '--hwdec=auto-safe',
      '--terminal=no',
      `--input-ipc-server=${this.address}`,
      `--geometry=${mpvGeometry(ownerWindow)}`,
      `--volume=${Math.round(Math.max(0, Math.min(1, options.volume ?? 1)) * 100)}`,
      `--mute=${options.muted ? 'yes' : 'no'}`,
      `--speed=${Math.max(0.25, Math.min(3, options.speed ?? 1))}`,
      `--audio-delay=${options.audioDelay || 0}`,
      `--sub-delay=${options.subtitleDelay || 0}`,
      ...(options.subtitleStyle ? [
        `--sub-font-size=${options.subtitleStyle.fontSize}`,
        `--sub-color=${options.subtitleStyle.color}`,
        `--sub-border-color=${options.subtitleStyle.borderColor}`,
        `--sub-border-size=${options.subtitleStyle.borderWidth}`,
        `--sub-back-color=${options.subtitleStyle.backgroundColor}`,
        `--sub-pos=${options.subtitleStyle.position}`,
      ] : []),
      ...(options.startSeconds && options.startSeconds > 0 ? [`--start=${options.startSeconds}`] : []),
      ...(options.subtitleFiles || []).flatMap((subtitleFile) => [`--sub-file=${subtitleFile.path}`]),
      '--',
      filePath,
    ];
    this.process = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    this.process.stderr?.setEncoding('utf8');
    this.process.stderr?.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) {
        this.lastStderr = message.slice(-1000);
        console.warn('[mpv]', message.slice(0, 1000));
      }
    });
    this.process.once('error', (error) => {
      this.launchError = true;
      this.onLaunchFailed();
      this.fail(`Could not start mpv: ${error.message}`);
    });
    this.process.once('close', (code, signal) => {
      // mpv may close before its final IPC end-file event is delivered. Keep
      // the socket alive briefly so normal EOF never becomes a false crash.
      this.exitGraceTimer = setTimeout(() => {
        if (!this.stopped && !this.ended && !this.launchError) {
          if (isLikelyNaturalMpvEof({
            code,
            position: this.state.position,
            duration: this.state.duration,
          })) {
            this.ended = true;
            this.emit({ status: 'ended', paused: true });
          } else {
            this.fail(unexpectedMpvExitMessage({ code, signal, stderr: this.lastStderr }));
          }
        }
        this.finishTermination();
      }, 150);
      this.exitGraceTimer.unref();
    });

    const syncGeometry = () => this.scheduleGeometrySync();
    const syncVisibility = () => this.syncWindowVisibility();
    this.ownerWindow.on('move', syncGeometry);
    this.ownerWindow.on('resize', syncGeometry);
    this.ownerWindow.on('maximize', syncGeometry);
    this.ownerWindow.on('unmaximize', syncGeometry);
    this.ownerWindow.on('enter-full-screen', syncGeometry);
    this.ownerWindow.on('leave-full-screen', syncGeometry);
    this.ownerWindow.on('minimize', syncVisibility);
    this.ownerWindow.on('restore', syncVisibility);
    this.ownerWindow.on('hide', syncVisibility);
    this.ownerWindow.on('show', syncVisibility);
    this.ownerWindow.on('focus', syncVisibility);
    screen.on('display-metrics-changed', syncGeometry);
    this.windowListeners.push(() => {
      this.ownerWindow.removeListener('move', syncGeometry);
      this.ownerWindow.removeListener('resize', syncGeometry);
      this.ownerWindow.removeListener('maximize', syncGeometry);
      this.ownerWindow.removeListener('unmaximize', syncGeometry);
      this.ownerWindow.removeListener('enter-full-screen', syncGeometry);
      this.ownerWindow.removeListener('leave-full-screen', syncGeometry);
      this.ownerWindow.removeListener('minimize', syncVisibility);
      this.ownerWindow.removeListener('restore', syncVisibility);
      this.ownerWindow.removeListener('hide', syncVisibility);
      this.ownerWindow.removeListener('show', syncVisibility);
      this.ownerWindow.removeListener('focus', syncVisibility);
      screen.removeListener('display-metrics-changed', syncGeometry);
    });
    const stopForDestroyedOwner = () => this.stop();
    this.owner.once('destroyed', stopForDestroyedOwner);
    this.windowListeners.push(() => this.owner.removeListener('destroyed', stopForDestroyedOwner));
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    this.connectAttempts += 1;
    const socket = net.createConnection(this.address);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      this.socket = socket;
      socket.removeAllListeners('error');
      socket.on('error', (error) => {
        if (!this.stopped) this.fail(`mpv IPC failed: ${error.message}`);
      });
      socket.on('data', (chunk: string) => this.read(chunk));
      socket.on('close', () => { this.socket = null; });
      OBSERVED_PROPERTIES.forEach((property, index) => {
        this.send(['observe_property', index + 1, property], `observe ${property}`);
      });
      this.syncWindowVisibility();
      this.scheduleGeometrySync();
      this.emit({ status: 'loading' });
    });
    socket.once('error', () => {
      socket.destroy();
      if (this.connectAttempts < 60 && !this.stopped) {
        setTimeout(() => this.connect(), 50);
      } else if (!this.stopped) {
        this.fail('Could not connect to mpv.');
        this.stop();
      }
    });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          this.handleMessage(parseRequiredJson(line, mpvJsonMessageSchema, 'mpv IPC message'));
        } catch {
          console.warn('[mpv] Ignored malformed IPC message.');
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleMessage(message: MpvJsonMessage): void {
    if (message.request_id !== undefined) {
      const context = this.pendingRequests.get(message.request_id);
      this.pendingRequests.delete(message.request_id);
      if (context && message.error && message.error !== 'success') {
        console.warn(`[mpv] ${context} failed: ${message.error}`);
      }
    }
    if (message.event === 'file-loaded') {
      // LoomTV opens playback as an autoplay action. Make this explicit rather
      // than relying on mpv's inherited/default pause state, which can report a
      // paused property during startup on some runtimes.
      this.send(['set_property', 'pause', false], 'autoplay');
      this.emit({ status: 'ready', paused: false });
      return;
    }
    if (message.event === 'start-file') {
      this.emit({ status: 'loading' });
      return;
    }
    if (message.event === 'end-file') {
      if (message.reason === 'eof') {
        this.ended = true;
        this.emit({ status: 'ended', paused: true });
      } else if (!this.stopped && message.reason !== 'stop' && message.reason !== 'quit') {
        this.fail(`mpv stopped playback (${message.reason || 'unknown reason'}).`);
      }
      return;
    }
    if (message.event !== 'property-change' || !message.name) return;

    if (message.name === 'time-pos') {
      const position = finiteNumber(message.data);
      this.state = { ...this.state, position };
      const now = Date.now();
      if (now - this.lastPositionEventAt >= 250) {
        this.lastPositionEventAt = now;
        this.emit({ position });
      }
    }
    else if (message.name === 'duration') this.emit({ duration: finiteNumber(message.data) });
    else if (message.name === 'pause') this.emit({ paused: message.data === true });
    else if (message.name === 'volume') this.emit({ volume: finiteNumber(message.data) === undefined ? undefined : Number(message.data) / 100 });
    else if (message.name === 'mute') this.emit({ muted: message.data === true });
    else if (message.name === 'speed') this.emit({ speed: finiteNumber(message.data) });
    else if (message.name === 'track-list') this.emit({ tracks: normalizeMpvTracks(message.data, this.subtitleSources) });
    else if (message.name === 'video-params' && message.data && typeof message.data === 'object') {
      const params = message.data as Record<string, unknown>;
      this.emit({ videoWidth: finiteNumber(params.w), videoHeight: finiteNumber(params.h) });
    }
    else if (message.name === 'hwdec-current') this.updateDiagnostics({
      hardwareDecoder: typeof message.data === 'string' ? message.data : undefined,
      hardwareDecode: typeof message.data === 'string' && message.data !== 'no',
    });
    else if (message.name === 'frame-drop-count') this.updateDiagnostics({ frameDrops: finiteNumber(message.data) });
    else if (message.name === 'decoder-frame-drop-count') this.updateDiagnostics({ decoderFrameDrops: finiteNumber(message.data) });
    else if (message.name === 'demuxer-cache-duration') this.updateDiagnostics({ bufferSeconds: finiteNumber(message.data) });
    else if (message.name === 'cache-buffering-state') this.updateDiagnostics({ buffering: message.data === true });
    else if (message.name === 'video-codec') this.updateDiagnostics({ videoCodec: typeof message.data === 'string' ? message.data : undefined });
    else if (message.name === 'estimated-vf-fps') this.updateDiagnostics({ estimatedFps: finiteNumber(message.data) });
  }

  private updateDiagnostics(patch: MpvPlaybackDiagnostics): void {
    this.diagnostics = { ...this.diagnostics, ...patch };
    const now = Date.now();
    const emitDiagnostics = () => {
      this.diagnosticsTimer = null;
      this.lastDiagnosticsEventAt = Date.now();
      this.emit({ diagnostics: this.diagnostics });
    };
    const delay = Math.max(0, 250 - (now - this.lastDiagnosticsEventAt));
    if (this.diagnosticsTimer) return;
    if (delay === 0) emitDiagnostics();
    else {
      this.diagnosticsTimer = setTimeout(emitDiagnostics, delay);
      this.diagnosticsTimer.unref?.();
    }
  }

  private emit(patch: Partial<MpvPlaybackState>): void {
    this.state = { ...this.state, ...patch, sessionId: this.id };
    syncNativePlaybackDisplaySleep(this.id, this.state);
    if (!this.owner.isDestroyed()) {
      this.owner.send('mpv:state', {
        ...patch,
        sessionId: this.id,
        status: this.state.status,
      } satisfies MpvPlaybackState);
    }
  }

  private fail(error: string): void {
    this.emit({ status: 'error', error, paused: true });
  }

  private send(command: unknown[], context?: string): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    const requestId = this.requestId++;
    if (context) this.pendingRequests.set(requestId, context);
    this.socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
    return true;
  }

  private scheduleGeometrySync(): void {
    if (this.stopped || this.ownerWindow.isDestroyed()) return;
    if (this.geometryTimer) clearTimeout(this.geometryTimer);
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = null;
      if (this.stopped || this.ownerWindow.isDestroyed()) return;
      this.send(['set_property', 'geometry', mpvGeometry(this.ownerWindow)], 'window geometry');
    }, 16);
  }

  private syncWindowVisibility(): void {
    if (this.stopped || this.ownerWindow.isDestroyed()) return;
    const minimized = this.ownerWindow.isMinimized() || !this.ownerWindow.isVisible();
    this.send(['set_property', 'window-minimized', minimized], 'window visibility');
    if (!minimized) this.scheduleGeometrySync();
  }

  command(command: MpvCommand): boolean {
    switch (command.type) {
      case 'set-paused': return this.send(['set_property', 'pause', command.paused]);
      case 'seek': return this.send(['seek', Math.max(0, command.position), 'absolute+exact']);
      case 'set-volume': return this.send(['set_property', 'volume', Math.max(0, Math.min(1, command.volume)) * 100]);
      case 'set-muted': return this.send(['set_property', 'mute', command.muted]);
      case 'set-speed': return this.send(['set_property', 'speed', Math.max(0.25, Math.min(3, command.speed))]);
      case 'set-video-track': return this.send(['set_property', 'vid', command.trackId ?? 'no']);
      case 'set-audio-track': return this.send(['set_property', 'aid', command.trackId ?? 'no']);
      case 'set-subtitle-track': return this.send(['set_property', 'sid', command.trackId ?? 'no']);
      case 'set-secondary-subtitle-track': return this.send(['set_property', 'secondary-sid', command.trackId ?? 'no']);
      case 'set-subtitle-delay': return this.send(['set_property', 'sub-delay', command.seconds]);
      case 'set-audio-delay': return this.send(['set_property', 'audio-delay', command.seconds]);
      case 'set-subtitle-style': {
        return [
          ['set_property', 'sub-font-size', command.fontSize],
          ['set_property', 'sub-color', command.color],
          ['set_property', 'sub-border-color', command.borderColor],
          ['set_property', 'sub-border-size', command.borderWidth],
          ['set_property', 'sub-back-color', command.backgroundColor],
          ['set_property', 'sub-pos', command.position],
        ].every((entry) => this.send(entry));
      }
      case 'set-video-aspect': return this.send(['set_property', 'video-aspect-override', command.aspect ?? '-1']);
      case 'set-video-crop': return this.send(['set_property', 'video-crop', command.crop ?? 'no']);
      case 'set-video-rotation': return this.send(['set_property', 'video-rotate', command.degrees]);
    }
  }

  stop(): boolean {
    if (this.stopped) return false;
    this.stopped = true;
    this.send(['quit']);
    const process = this.process;
    setTimeout(() => {
      if (process.exitCode === null && process.signalCode === null) process.kill();
    }, 1500).unref();
    this.cleanup();
    return true;
  }

  private cleanup(): void {
    releaseNativePlaybackDisplaySleep(this.id);
    if (this.geometryTimer) clearTimeout(this.geometryTimer);
    this.geometryTimer = null;
    if (this.diagnosticsTimer) clearTimeout(this.diagnosticsTimer);
    this.diagnosticsTimer = null;
    if (this.exitGraceTimer) clearTimeout(this.exitGraceTimer);
    this.exitGraceTimer = null;
    this.socket?.destroy();
    this.socket = null;
    this.pendingRequests.clear();
    this.windowListeners.splice(0).forEach((remove) => remove());
    if (process.platform !== 'win32') fs.rmSync(this.address, { force: true });
  }

  private finishTermination(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.cleanup();
    this.emit({ status: 'closed' });
    this.onTerminated(this);
  }
}

let currentSession: MpvPlaybackSession | null = null;

// Developer/rollout escape hatch. Native playback is not a user preference, so
// this is the supported way to force the Chromium/FFmpeg path for a run.
function mpvDisabledByEnvironment(): boolean {
  const value = process.env.LOOMTV_DISABLE_MPV?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function mpvAvailability(): MpvAvailability {
  if (mpvDisabledByEnvironment()) {
    return {
      available: false,
      reason: 'Native mpv playback is disabled by LOOMTV_DISABLE_MPV. LoomTV is using compatible fallback playback.',
    };
  }
  const { runtime, version, warning } = cachedMpvRuntime();
  return runtime
    ? {
      available: true,
      executablePath: runtime.executablePath,
      // The older IPC type omits the new bundled source; preserve its runtime
      // value without changing the shared protocol in this discovery-only edit.
      runtimeSource: runtime.source,
      version,
      warning,
    }
    : {
      available: false,
      reason: 'The bundled or selected mpv runtime is unavailable. LoomTV will use compatible Chromium/HLS fallback playback until a working MPV runtime is available.',
      warning,
    };
}

export function refreshMpvAvailability(): MpvAvailability {
  invalidateMpvRuntimeCache();
  return mpvAvailability();
}

/** One line describing the resolved playback runtime, for startup diagnostics. */
export function mpvRuntimeSummary(): string {
  const availability = mpvAvailability();
  return availability.available
    ? `[playback] native mpv ready — ${availability.version || 'unknown version'} (${availability.runtimeSource}: ${availability.executablePath})`
    : `[playback] native mpv unavailable — ${availability.reason}`;
}

export function startMpvPlayback(
  owner: WebContents,
  filePath: string,
  options: MpvStartOptions = {},
): { ok: boolean; sessionId?: string; error?: string } {
  if (mpvDisabledByEnvironment()) return { ok: false, error: mpvAvailability().reason };
  const { runtime } = cachedMpvRuntime();
  const ownerWindow = BrowserWindow.fromWebContents(owner);
  if (!runtime) {
    // A cached path can go stale if mpv is uninstalled mid-session.
    invalidateMpvRuntimeCache();
    return { ok: false, error: mpvAvailability().reason };
  }
  if (!ownerWindow || ownerWindow.isDestroyed()) return { ok: false, error: 'The LoomTV window is unavailable.' };
  currentSession?.stop();
  const session = new MpvPlaybackSession(
    runtime.executablePath,
    owner,
    ownerWindow,
    filePath,
    options,
    (terminated) => {
      if (currentSession === terminated) currentSession = null;
    },
    invalidateMpvRuntimeCache,
  );
  currentSession = session;
  return { ok: true, sessionId: session.id };
}

export function commandMpvPlayback(sessionId: string, command: MpvCommand): boolean {
  return currentSession?.id === sessionId ? currentSession.command(command) : false;
}

export function stopMpvPlayback(sessionId?: string): boolean {
  if (!currentSession || (sessionId && currentSession.id !== sessionId)) return false;
  const stopped = currentSession.stop();
  currentSession = null;
  return stopped;
}

export function stopAllMpvPlayback(): void {
  stopMpvPlayback();
}
