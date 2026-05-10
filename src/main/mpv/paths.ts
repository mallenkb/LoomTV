/**
 * Cross-platform MPV binary and IPC socket path resolution.
 *
 * Resolution order:
 *   1. MPV_PATH environment variable (dev override)
 *   2. Bundled binary in app resources (production)
 *   3. Common system install locations
 *   4. PATH lookup via `which` / `where`
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { app } from 'electron';

// ─── MPV binary path ─────────────────────────────────────────────────────────

/** Platform-specific candidate paths searched in order. */
const SYSTEM_CANDIDATES: Record<NodeJS.Platform, string[]> = {
  darwin: [
    '/Applications/mpv.app/Contents/MacOS/mpv',
    '/opt/homebrew/bin/mpv',
    '/usr/local/bin/mpv',
    '/usr/bin/mpv',
  ],
  linux: [
    '/usr/bin/mpv',
    '/usr/local/bin/mpv',
    '/snap/bin/mpv',
    '/flatpak/exports/bin/mpv',
  ],
  win32: [
    // Prefer user-local installs; PATH lookup handles the rest.
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'mpv', 'mpv.exe'),
    path.join(process.env['PROGRAMFILES'] ?? '', 'mpv', 'mpv.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'mpv', 'mpv.exe'),
  ],
  // Stubs for other platforms Node.js might report:
  aix: [], android: [], cygwin: [], freebsd: [], haiku: [],
  netbsd: [], openbsd: [], sunos: [],
};

function isCompatibleDarwinBinary(binaryPath: string): boolean {
  if (process.platform !== 'darwin') return true;

  try {
    const description = execFileSync('file', [binaryPath], { encoding: 'utf8' });
    if (process.arch === 'arm64') return description.includes('arm64');
    if (process.arch === 'x64') return description.includes('x86_64');
  } catch {
    return true;
  }

  return true;
}

function existingCompatibleBinary(candidate?: string | null): string | null {
  if (!candidate) return null;
  if (!fs.existsSync(candidate)) return null;
  return isCompatibleDarwinBinary(candidate) ? candidate : null;
}

/**
 * Returns the absolute path to the mpv executable, or `null` if not found.
 *
 * Resolution order:
 *  1. `MPV_PATH` env var
 *  2. Bundled resources/mpv/<platform>/mpv[.exe]
 *  3. Common OS install paths
 *  4. `which`/`where` PATH search
 */
export function getMpvPath(): string | null {
  // 1. Environment variable override (development or custom installs)
  const envPath = existingCompatibleBinary(process.env['MPV_PATH']);
  if (envPath) {
    return envPath;
  }

  // 2. Bundled binary (production packaging)
  const bundled = getBundledMpvPath();
  if (existingCompatibleBinary(bundled)) {
    return bundled;
  }

  // 3. Common OS paths
  const candidates = SYSTEM_CANDIDATES[process.platform] ?? [];
  for (const c of candidates) {
    const candidate = existingCompatibleBinary(c);
    if (candidate) return candidate;
  }

  // 4. PATH lookup
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['mpv'], { encoding: 'utf8' }).trim();
    const first = result.split(/\r?\n/)[0]?.trim();
    const pathCandidate = existingCompatibleBinary(first);
    if (pathCandidate) return pathCandidate;
  } catch {
    // mpv not on PATH
  }

  return null;
}

/** Returns the expected bundled binary path (may not exist if not packaged). */
function getBundledMpvPath(): string {
  let resourcesPath: string;
  try {
    // app.isPackaged is true in production builds
    resourcesPath = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), 'resources');
  } catch {
    resourcesPath = path.join(__dirname, '..', '..', '..', 'resources');
  }

  if (process.platform === 'win32') {
    return path.join(resourcesPath, 'mpv', 'win', 'mpv.exe');
  }
  if (process.platform === 'darwin') {
    return path.join(resourcesPath, 'mpv', 'mac', 'mpv');
  }
  return path.join(resourcesPath, 'mpv', 'linux', 'mpv');
}

// ─── IPC socket / named-pipe path ────────────────────────────────────────────

/**
 * Returns the path for the mpv IPC socket (Unix) or named pipe (Windows).
 * Unique per process to avoid conflicts if multiple instances run.
 */
export function getIpcPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\loomtv-mpv-${process.pid}`;
  }
  try {
    return path.join(app.getPath('temp'), `loomtv-mpv-${process.pid}.sock`);
  } catch {
    // Fallback if app is not ready yet (unlikely in practice)
    return path.join(require('node:os').tmpdir(), `loomtv-mpv-${process.pid}.sock`);
  }
}
