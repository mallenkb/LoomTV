/**
 * High-level mpv controller.
 *
 * Manages the mpv child process lifecycle and exposes playback control
 * methods (launch, pause, resume, seek, stop, getPosition).
 *
 * One global instance is used per app — call `mpvController` from main.ts.
 */

import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { getMpvPath, getIpcPath } from './paths';
import { MpvIpc } from './mpvIpc';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface MpvLaunchOptions {
  /** Window title shown in the OS taskbar / title bar. */
  title?: string;
  /** Start playback at this position in seconds. */
  startSeconds?: number;
  /** Open mpv in fullscreen mode. */
  fullscreen?: boolean;
  /** Paths or URLs of external subtitle files to pre-load. */
  subtitles?: string[];
}

export interface MpvPlaybackState {
  position: number;
  duration: number;
  paused: boolean;
}

export class MpvController {
  private proc: ChildProcess | undefined;
  private ipc: MpvIpc | undefined;
  /** Updated IPC path per launch (pid-scoped). */
  private ipcPath = getIpcPath();
  /** Listeners notified when mpv exits naturally (not killed by us). */
  private exitListeners: Array<() => void> = [];
  /** Flag to suppress the exit event when we killed the process ourselves. */
  private suppressExitEvent = false;

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Launch mpv with the given file path or URL.
   * Kills any running instance first.
   */
  async launch(filePath: string, options: MpvLaunchOptions = {}): Promise<void> {
    await this.stop({ suppressEvent: true });

    // Refresh IPC path (new pid = new path)
    this.ipcPath = getIpcPath();

    // Remove stale socket on Unix
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.ipcPath); } catch (_e) { /* stale socket may not exist */ }
    }

    const mpvBin = getMpvPath();
    if (!mpvBin) {
      throw new Error(
        'mpv could not be found. Install mpv or set the MPV_PATH environment variable to the mpv executable.',
      );
    }

    const args = this.buildArgs(filePath, options);

    this.proc = spawn(mpvBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      if (process.env['DEBUG_MPV']) console.debug('[mpv]', chunk.toString().trim());
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      if (process.env['DEBUG_MPV']) console.debug('[mpv stderr]', chunk.toString().trim());
    });

    this.proc.on('exit', (code) => {
      console.log(`[mpv] exited with code ${code}`);
      this.proc = undefined;
      this.ipc?.close();
      this.ipc = undefined;

      if (!this.suppressExitEvent) {
        for (const listener of this.exitListeners) listener();
      }
      this.suppressExitEvent = false;
    });

    // Wait for mpv to create the IPC socket (up to 5 seconds)
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const ipc = new MpvIpc(this.ipcPath);
        await ipc.connect();
        this.ipc = ipc;
        return; // Connected successfully
      } catch {
        await sleep(100);
      }
    }

    // Kill the process if IPC never became available
    this.proc?.kill();
    this.proc = undefined;
    throw new Error('Timed out waiting for mpv IPC socket.');
  }

  /** Stop playback and kill mpv. Safe to call even if mpv is not running. */
  async stop(opts: { suppressEvent?: boolean } = {}): Promise<void> {
    if (opts.suppressEvent) this.suppressExitEvent = true;

    // Ask mpv to quit gracefully first
    try {
      await this.ipc?.command(['quit']);
    } catch {
      // ignore — mpv may already be gone
    }

    this.ipc?.close();
    this.ipc = undefined;

    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGKILL');
    }
    this.proc = undefined;
  }

  /** Register a callback fired when mpv exits on its own (not killed by us). */
  onExit(listener: () => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      this.exitListeners = this.exitListeners.filter((l) => l !== listener);
    };
  }

  get isRunning(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  // ─── Playback controls ───────────────────────────────────────────────────────

  async pause(): Promise<void> {
    await this.ipc?.setProperty('pause', true);
  }

  async resume(): Promise<void> {
    await this.ipc?.setProperty('pause', false);
  }

  async togglePause(): Promise<void> {
    const paused = await this.isPaused();
    await this.ipc?.setProperty('pause', !paused);
  }

  /**
   * Seek to a position.
   * @param seconds Offset in seconds.
   * @param mode    "relative" (default) | "absolute" — relative to current position or from start.
   */
  async seek(seconds: number, mode: 'relative' | 'absolute' = 'relative'): Promise<void> {
    await this.ipc?.command(['seek', seconds, mode === 'absolute' ? 'absolute' : 'relative']);
  }

  async getTimePosition(): Promise<number> {
    const val = await this.ipc?.getProperty('time-pos');
    return typeof val === 'number' ? val : 0;
  }

  async getDuration(): Promise<number> {
    const val = await this.ipc?.getProperty('duration');
    return typeof val === 'number' ? val : 0;
  }

  async isPaused(): Promise<boolean> {
    const val = await this.ipc?.getProperty('pause');
    return Boolean(val);
  }

  async getPlaybackState(): Promise<MpvPlaybackState | null> {
    if (!this.isRunning || !this.ipc?.isConnected) return null;
    try {
      const [position, duration, paused] = await Promise.all([
        this.getTimePosition(),
        this.getDuration(),
        this.isPaused(),
      ]);
      return { position, duration, paused };
    } catch {
      return null;
    }
  }

  /**
   * Launch mpv embedded inside a native window specified by `wid`.
   * The caller is responsible for creating a frameless BrowserWindow and
   * passing its native handle as `wid` (decimal string).
   */
  async launchEmbedded(filePath: string, wid: string, options: MpvLaunchOptions = {}): Promise<void> {
    await this.stop({ suppressEvent: true });

    this.ipcPath = getIpcPath();
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.ipcPath); } catch (_e) { /* stale socket may not exist */ }
    }

    const mpvBin = getMpvPath();
    if (!mpvBin) {
      throw new Error(
        'mpv could not be found. Install mpv or set the MPV_PATH environment variable to the mpv executable.',
      );
    }

    const args = this.buildEmbeddedArgs(filePath, wid, options);

    this.proc = spawn(mpvBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      if (process.env['DEBUG_MPV']) console.debug('[mpv-embedded]', chunk.toString().trim());
    });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      if (process.env['DEBUG_MPV']) console.debug('[mpv-embedded stderr]', chunk.toString().trim());
    });

    this.proc.on('exit', (code) => {
      console.log(`[mpv-embedded] exited with code ${code}`);
      this.proc = undefined;
      this.ipc?.close();
      this.ipc = undefined;

      if (!this.suppressExitEvent) {
        for (const listener of this.exitListeners) listener();
      }
      this.suppressExitEvent = false;
    });

    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const ipc = new MpvIpc(this.ipcPath);
        await ipc.connect();
        this.ipc = ipc;
        return;
      } catch {
        await sleep(100);
      }
    }

    this.proc?.kill();
    this.proc = undefined;
    throw new Error('Timed out waiting for mpv IPC socket.');
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private buildArgs(filePath: string, options: MpvLaunchOptions): string[] {
    const args: string[] = [
      `--input-ipc-server=${this.ipcPath}`,
      '--idle=no',
      '--force-window=yes',
      '--keep-open=no',
      '--save-position-on-quit=no',
      '--hwdec=auto-safe',
      '--osd-level=1',
    ];

    if (options.startSeconds && options.startSeconds > 5) {
      args.push(`--start=${Math.floor(options.startSeconds)}`);
    }

    if (options.fullscreen) {
      args.push('--fullscreen');
    }

    if (options.title) {
      args.push(`--title=${options.title}`);
    }

    for (const sub of options.subtitles ?? []) {
      args.push('--sub-file', sub);
    }

    args.push(filePath);
    return args;
  }

  private buildEmbeddedArgs(filePath: string, wid: string, options: MpvLaunchOptions): string[] {
    const args: string[] = [
      `--input-ipc-server=${this.ipcPath}`,
      `--wid=${wid}`,
      '--idle=no',
      '--force-window=no',
      '--keep-open=yes',
      '--save-position-on-quit=no',
      '--hwdec=auto-safe',
      '--osd-level=0',
      '--no-border',
      '--no-osc',
      '--no-terminal',
    ];

    if (options.startSeconds && options.startSeconds > 5) {
      args.push(`--start=${Math.floor(options.startSeconds)}`);
    }

    for (const sub of options.subtitles ?? []) {
      args.push('--sub-file', sub);
    }

    args.push(filePath);
    return args;
  }
}

/** Singleton controller used throughout the main process. */
export const mpvController = new MpvController();
