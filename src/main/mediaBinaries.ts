import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

function platformFolder(): 'win' | 'mac' | 'linux' {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function binaryName(name: 'ffmpeg' | 'ffprobe'): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function bundledBinary(name: 'ffmpeg' | 'ffprobe'): string | null {
  const relative = path.join('ffmpeg', platformFolder(), binaryName(name));
  const candidates = [
    path.join(process.resourcesPath || '', relative),
    path.join(app.getAppPath(), 'resources', relative),
    path.join(process.cwd(), 'resources', relative),
  ];

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // Continue through fallback candidates.
    }
  }

  return null;
}

export function findFFmpeg(): string | null {
  const bundled = bundledBinary('ffmpeg');
  if (bundled) return bundled;

  try {
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  } catch {
    // Fall through.
  }

  try {
    const candidate = path.join(
      app.getAppPath(),
      'node_modules',
      'ffmpeg-static',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    );
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // Fall through.
  }

  try {
    const result = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    return result || null;
  } catch {
    return null;
  }
}

export function findFFprobe(): string | null {
  const bundled = bundledBinary('ffprobe');
  if (bundled) return bundled;

  try {
    if (ffprobeStatic?.path && fs.existsSync(ffprobeStatic.path)) return ffprobeStatic.path;
  } catch {
    // Fall through.
  }

  try {
    const candidate = path.join(
      app.getAppPath(),
      'node_modules',
      'ffprobe-static',
      'bin',
      process.platform,
      process.arch,
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
    );
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // Fall through.
  }

  try {
    if (ffmpegStatic) {
      const sibling = path.join(path.dirname(ffmpegStatic), binaryName('ffprobe'));
      if (fs.existsSync(sibling)) return sibling;
    }
  } catch {
    // Fall through.
  }

  try {
    const result = execSync('which ffprobe', { encoding: 'utf8' }).trim();
    return result || null;
  } catch {
    return null;
  }
}

export function findMPV(): string | null {
  const mpvBinary = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  const candidates = [
    path.join(process.resourcesPath || '', 'mpv', platformFolder(), mpvBinary),
    path.join(app.getAppPath(), 'resources', 'mpv', platformFolder(), mpvBinary),
    path.join(process.cwd(), 'resources', 'mpv', platformFolder(), mpvBinary),
    '/Applications/mpv.app/Contents/MacOS/mpv',
    '/Applications/IINA.app/Contents/MacOS/iina-cli',
    '/opt/homebrew/bin/mpv',
    '/usr/local/bin/mpv',
    '/usr/bin/mpv',
    '/snap/bin/mpv',
  ];

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // Keep looking.
    }
  }

  try {
    const result = execFileSync('which', ['mpv'], { encoding: 'utf8' }).trim();
    return result || null;
  } catch {
    return null;
  }
}
