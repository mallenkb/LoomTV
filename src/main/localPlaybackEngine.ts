import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { findMPV } from './mediaBinaries';
import { assertLocalMediaPath } from './mediaProbe';
import type { PlaybackState } from './mediaTypes';

const MPV_SOCKET = path.join(os.tmpdir(), 'loomtv-mpv.sock');

let mpvProcess: ChildProcess | null = null;
let activeFilePath: string | undefined;
let activeState: PlaybackState = { backend: 'mpv', state: 'stopped' };

function setState(next: Partial<PlaybackState>, mainWindow?: BrowserWindow | null): PlaybackState {
  activeState = { ...activeState, ...next };
  mainWindow?.webContents.send('media:state', activeState);
  return activeState;
}

function queryMPVSocket(command: Array<string | number | boolean>): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(MPV_SOCKET);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('mpv IPC timeout'));
    }, 900);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ command }) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if ('error' in response) {
            clearTimeout(timer);
            socket.destroy();
            if (response.error === 'success') {
              resolve(response.data);
            } else {
              reject(new Error(response.error));
            }
            return;
          }
        } catch {
          // Wait for a full JSON line.
        }
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function playLocal(filePath: string, mainWindow?: BrowserWindow | null): Promise<PlaybackState> {
  assertLocalMediaPath(filePath);
  const mpv = findMPV();
  if (!mpv) throw new Error('mpv is not available on this device.');

  await stopLocal(mainWindow);
  try { fs.unlinkSync(MPV_SOCKET); } catch {
    // Ignore stale socket cleanup failures.
  }

  activeFilePath = filePath;
  setState({ backend: 'mpv', filePath, state: 'loading', error: undefined }, mainWindow);

  const isIina = mpv.endsWith('iina-cli');
  const args = isIina
    ? ['--separate-windows', '--no-stdin', filePath]
    : [
      `--input-ipc-server=${MPV_SOCKET}`,
      '--force-window=yes',
      '--idle=no',
      '--keep-open=no',
      filePath,
    ];

  mpvProcess = spawn(mpv, args, { stdio: 'ignore' });
  mpvProcess.once('spawn', () => setState({ state: 'playing' }, mainWindow));
  mpvProcess.once('error', (error) => setState({ state: 'error', error: error.message }, mainWindow));
  mpvProcess.once('exit', () => {
    mpvProcess = null;
    activeFilePath = undefined;
    setState({ state: 'stopped', filePath: undefined }, mainWindow);
  });

  return activeState;
}

export async function pauseLocal(): Promise<PlaybackState> {
  await queryMPVSocket(['set_property', 'pause', true]);
  return setState({ state: 'paused' });
}

export async function resumeLocal(): Promise<PlaybackState> {
  await queryMPVSocket(['set_property', 'pause', false]);
  return setState({ state: 'playing' });
}

export async function seekLocal(seconds: number): Promise<PlaybackState> {
  await queryMPVSocket(['seek', seconds, 'relative']);
  return getLocalState();
}

export async function setLocalVolume(value: number): Promise<PlaybackState> {
  const volume = Math.max(0, Math.min(100, value));
  await queryMPVSocket(['set_property', 'volume', volume]);
  return setState({ volume });
}

export async function stopLocal(mainWindow?: BrowserWindow | null): Promise<PlaybackState> {
  if (mpvProcess && !mpvProcess.killed) {
    mpvProcess.kill();
  }
  mpvProcess = null;
  activeFilePath = undefined;
  return setState({ backend: 'mpv', state: 'stopped', filePath: undefined }, mainWindow);
}

export async function getLocalState(): Promise<PlaybackState> {
  if (!mpvProcess) return activeState;

  try {
    const [position, duration, volume, paused] = await Promise.all([
      queryMPVSocket(['get_property', 'time-pos']).catch(() => null),
      queryMPVSocket(['get_property', 'duration']).catch(() => null),
      queryMPVSocket(['get_property', 'volume']).catch(() => null),
      queryMPVSocket(['get_property', 'pause']).catch(() => null),
    ]);
    return setState({
      filePath: activeFilePath,
      positionSeconds: typeof position === 'number' ? position : null,
      durationSeconds: typeof duration === 'number' ? duration : null,
      volume: typeof volume === 'number' ? volume : null,
      state: paused ? 'paused' : 'playing',
    });
  } catch {
    return activeState;
  }
}
