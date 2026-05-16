import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  try {
    if (fs.existsSync(candidate) && isCompatibleDarwinBinary(candidate)) return candidate;
  } catch {
    // Continue through fallback candidates.
  }
  return null;
}

function systemBinaryCandidates(name: 'ffmpeg' | 'ffprobe'): string[] {
  const executable = binaryName(name);
  const candidates = [
    `/opt/homebrew/bin/${executable}`,
    `/usr/local/bin/${executable}`,
    `/opt/local/bin/${executable}`,
    `/usr/bin/${executable}`,
    `/snap/bin/${executable}`,
  ];

  try {
    const whichResult = execFileSync('which', ['-a', executable], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    candidates.push(...whichResult);
  } catch {
    // Some app launches do not have shell PATH configured.
  }

  return [...new Set(candidates)];
}

function hasEncoder(binaryPath: string, encoder: string): boolean {
  try {
    const output = execFileSync(binaryPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return output.includes(encoder);
  } catch {
    return false;
  }
}

function firstExistingBinary(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const binary = existingCompatibleBinary(candidate);
    if (binary) return binary;
  }
  return null;
}

export function findFFmpeg(): string | null {
  const bundled = bundledBinary('ffmpeg');
  const appNodeModule = path.join(
    app.getAppPath(),
    'node_modules',
    'ffmpeg-static',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  );

  const candidates = [
    bundled,
    ffmpegStatic,
    appNodeModule,
    ...systemBinaryCandidates('ffmpeg'),
  ];

  if (process.platform === 'darwin') {
    for (const candidate of candidates) {
      const binary = existingCompatibleBinary(candidate);
      if (binary && hasEncoder(binary, 'h264_videotoolbox')) return binary;
    }
  }

  return firstExistingBinary(candidates);
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

  return firstExistingBinary(systemBinaryCandidates('ffprobe'));
}
