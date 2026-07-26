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
  MpvPlaybackState,
  MpvPlaybackTrack,
  MpvStartOptions,
} from '../shared/desktopProtocol.ts';

type MpvJsonMessage = {
  event?: string;
  name?: string;
  data?: unknown;
  error?: string;
  reason?: string;
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
] as const;

function executableName(): string {
  return process.platform === 'win32' ? 'mpv.exe' : 'mpv';
}

function packagedCandidates(): string[] {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const name = executableName();
  return [
    path.join(process.resourcesPath, 'mpv', platform, process.arch, name),
    path.join(process.resourcesPath, 'mpv', platform, name),
    path.join(process.resourcesPath, 'mpv', name),
  ];
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

function resolveMpvExecutable(): string | null {
  const configured = process.env.LOOMTV_MPV_PATH?.trim();
  const directCandidates = [configured, ...packagedCandidates(), ...systemCandidates()]
    .filter((candidate): candidate is string => Boolean(candidate));
  const directMatch = directCandidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (directMatch) return directMatch;

  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const output = execFileSync(locator, [executableName()], { encoding: 'utf8', windowsHide: true });
    return output.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || null;
  } catch {
    return null;
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

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function playbackTracks(
  value: unknown,
  subtitleSources: Map<string, 'sidecar' | 'opensubtitles'>,
): MpvPlaybackTrack[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): MpvPlaybackTrack[] => {
    if (!entry || typeof entry !== 'object') return [];
    const track = entry as Record<string, unknown>;
    const type = track.type === 'video' || track.type === 'audio' || track.type === 'sub'
      ? track.type
      : null;
    const id = numeric(track.id);
    if (!type || id === undefined) return [];
    const externalPath = typeof track['external-filename'] === 'string'
      ? path.resolve(track['external-filename'])
      : null;
    return [{
      id,
      type: type === 'sub' ? 'subtitle' : type,
      codec: typeof track.codec === 'string' ? track.codec : undefined,
      language: typeof track.lang === 'string' ? track.lang : undefined,
      title: typeof track.title === 'string' ? track.title : undefined,
      channels: typeof track['demux-channel-count'] === 'number' ? track['demux-channel-count'] : undefined,
      default: track.default === true,
      forced: track.forced === true,
      selected: track.selected === true,
      external: track.external === true,
      source: externalPath ? subtitleSources.get(externalPath) || 'sidecar' : 'embedded',
    }];
  });
}

class MpvPlaybackSession {
  readonly id = crypto.randomUUID();
  private readonly address = ipcAddress(this.id);
  private readonly process: ChildProcess;
  private socket: net.Socket | null = null;
  private buffer = '';
  private stopped = false;
  private ended = false;
  private connectAttempts = 0;
  private requestId = 1;
  private lastPositionEventAt = 0;
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
  ) {
    this.state = { sessionId: this.id, status: 'starting' };
    this.subtitleSources = new Map(
      (options.subtitleFiles || []).map((subtitle) => [path.resolve(subtitle.path), subtitle.source]),
    );
    if (process.platform !== 'win32') fs.rmSync(this.address, { force: true });
    const args = [
      '--no-config',
      '--no-border',
      '--force-window=immediate',
      '--keep-open=no',
      '--idle=no',
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
      if (message) console.warn('[mpv]', message.slice(0, 1000));
    });
    this.process.once('error', (error) => this.fail(error.message));
    this.process.once('exit', (code, signal) => {
      this.cleanup();
      if (!this.stopped && !this.ended) {
        this.fail(`mpv exited unexpectedly (${signal || code || 'unknown'}).`);
      }
      this.emit({ status: 'closed' });
      this.onTerminated(this);
    });

    const syncGeometry = () => this.send(['set_property', 'geometry', mpvGeometry(this.ownerWindow)]);
    this.ownerWindow.on('move', syncGeometry);
    this.ownerWindow.on('resize', syncGeometry);
    this.ownerWindow.on('maximize', syncGeometry);
    this.ownerWindow.on('unmaximize', syncGeometry);
    this.ownerWindow.on('enter-full-screen', syncGeometry);
    this.ownerWindow.on('leave-full-screen', syncGeometry);
    this.windowListeners.push(() => {
      this.ownerWindow.removeListener('move', syncGeometry);
      this.ownerWindow.removeListener('resize', syncGeometry);
      this.ownerWindow.removeListener('maximize', syncGeometry);
      this.ownerWindow.removeListener('unmaximize', syncGeometry);
      this.ownerWindow.removeListener('enter-full-screen', syncGeometry);
      this.ownerWindow.removeListener('leave-full-screen', syncGeometry);
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
        this.send(['observe_property', index + 1, property]);
      });
      this.ownerWindow.show();
      this.ownerWindow.focus();
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
          this.handleMessage(JSON.parse(line) as MpvJsonMessage);
        } catch {
          console.warn('[mpv] Ignored malformed IPC message.');
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleMessage(message: MpvJsonMessage): void {
    if (message.event === 'file-loaded') {
      this.emit({ status: 'ready' });
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
      const position = numeric(message.data);
      this.state = { ...this.state, position };
      const now = Date.now();
      if (now - this.lastPositionEventAt >= 250) {
        this.lastPositionEventAt = now;
        this.emit({ position });
      }
    }
    else if (message.name === 'duration') this.emit({ duration: numeric(message.data) });
    else if (message.name === 'pause') this.emit({ paused: message.data === true });
    else if (message.name === 'volume') this.emit({ volume: numeric(message.data) === undefined ? undefined : Number(message.data) / 100 });
    else if (message.name === 'mute') this.emit({ muted: message.data === true });
    else if (message.name === 'speed') this.emit({ speed: numeric(message.data) });
    else if (message.name === 'track-list') this.emit({ tracks: playbackTracks(message.data, this.subtitleSources) });
    else if (message.name === 'video-params' && message.data && typeof message.data === 'object') {
      const params = message.data as Record<string, unknown>;
      this.emit({ videoWidth: numeric(params.w), videoHeight: numeric(params.h) });
    }
  }

  private emit(patch: Partial<MpvPlaybackState>): void {
    this.state = { ...this.state, ...patch, sessionId: this.id };
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

  private send(command: unknown[]): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(`${JSON.stringify({ command, request_id: this.requestId++ })}\n`);
    return true;
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
    this.socket?.destroy();
    this.socket = null;
    this.windowListeners.splice(0).forEach((remove) => remove());
    if (process.platform !== 'win32') fs.rmSync(this.address, { force: true });
  }
}

let currentSession: MpvPlaybackSession | null = null;

export function mpvAvailability(): MpvAvailability {
  const executablePath = resolveMpvExecutable();
  return executablePath
    ? { available: true, executablePath }
    : {
      available: false,
      reason: 'Install mpv or set LOOMTV_MPV_PATH to try the experimental desktop playback backend.',
    };
}

export function startMpvPlayback(
  owner: WebContents,
  filePath: string,
  options: MpvStartOptions = {},
): { ok: boolean; sessionId?: string; error?: string } {
  const executable = resolveMpvExecutable();
  const ownerWindow = BrowserWindow.fromWebContents(owner);
  if (!executable) return { ok: false, error: mpvAvailability().reason };
  if (!ownerWindow || ownerWindow.isDestroyed()) return { ok: false, error: 'The LoomTV window is unavailable.' };
  currentSession?.stop();
  const session = new MpvPlaybackSession(executable, owner, ownerWindow, filePath, options, (terminated) => {
    if (currentSession === terminated) currentSession = null;
  });
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
