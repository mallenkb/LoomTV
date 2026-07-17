import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export { appendH264EncoderOptions, type H264HardwareEncoder } from './transcodeFilters.ts';
import type { H264HardwareEncoder } from './transcodeFilters.ts';

let cachedFFmpegPath: string | null | undefined;
let cachedFFprobePath: string | null | undefined;
let cachedFpcalcPath: string | null | undefined;
let ffmpegCheckedAt = 0;
let ffprobeCheckedAt = 0;
let fpcalcCheckedAt = 0;
const MISSING_BINARY_CACHE_MS = 30_000;
const encoderCache = new Map<string, { size: number; modifiedAtMs: number; encoder: H264HardwareEncoder | null }>();

function platformFolder(): 'win' | 'mac' | 'linux' {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function binaryName(name: 'ffmpeg' | 'ffprobe' | 'fpcalc'): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function isCompatibleDarwinBinary(binaryPath: string): boolean {
  if (process.platform !== 'darwin') return true;

  try {
    const description = execFileSync('file', [binaryPath], { encoding: 'utf8', timeout: 1000 });
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

function firstExistingBinary(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const binary = existingCompatibleBinary(candidate);
    if (binary) return binary;
  }
  return null;
}

function bundledBinary(name: 'ffmpeg' | 'ffprobe'): string | null {
  const relative = path.join('ffmpeg', platformFolder(), binaryName(name));
  return firstExistingBinary([
    path.join(process.resourcesPath || '', relative),
    path.join(app.getAppPath(), 'resources', relative),
    path.join(process.cwd(), 'resources', relative),
  ]);
}

function systemBinaryCandidates(name: 'ffmpeg' | 'ffprobe' | 'fpcalc'): string[] {
  const executable = binaryName(name);
  const candidates = [
    `/opt/homebrew/bin/${executable}`,
    `/usr/local/bin/${executable}`,
    `/opt/local/bin/${executable}`,
    `/usr/bin/${executable}`,
    `/snap/bin/${executable}`,
  ];

  try {
    const whichResult = execFileSync('which', ['-a', executable], { encoding: 'utf8', timeout: 1000 })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    candidates.push(...whichResult);
  } catch {
    // Some app launches do not have shell PATH configured.
  }

  return [...new Set(candidates)];
}

function hasFFmpegEncoder(binaryPath: string, encoder: string): boolean {
  try {
    const output = execFileSync(binaryPath, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 3000 });
    return output.includes(encoder);
  } catch {
    return false;
  }
}

export function preferredH264HardwareEncoder(binaryPath: string): H264HardwareEncoder | null {
  try {
    const stats = fs.statSync(binaryPath);
    const cached = encoderCache.get(binaryPath);
    if (cached && cached.size === stats.size && cached.modifiedAtMs === stats.mtimeMs) return cached.encoder;

    const candidates: H264HardwareEncoder[] =
      process.platform === 'darwin'
        ? ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv']
        : ['h264_nvenc', 'h264_qsv', 'h264_videotoolbox'];
    const encoder = candidates.find((candidate) => hasFFmpegEncoder(binaryPath, candidate)) || null;
    encoderCache.set(binaryPath, { size: stats.size, modifiedAtMs: stats.mtimeMs, encoder });
    return encoder;
  } catch {
    return null;
  }
}

export function findFFmpeg(): string | null {
  if (cachedFFmpegPath !== undefined
    && (cachedFFmpegPath ? fs.existsSync(cachedFFmpegPath) : Date.now() - ffmpegCheckedAt < MISSING_BINARY_CACHE_MS)) {
    return cachedFFmpegPath;
  }
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

  for (const candidate of candidates) {
    const binary = existingCompatibleBinary(candidate);
    if (binary && preferredH264HardwareEncoder(binary)) {
      cachedFFmpegPath = binary;
      ffmpegCheckedAt = Date.now();
      return binary;
    }
  }

  cachedFFmpegPath = firstExistingBinary(candidates);
  ffmpegCheckedAt = Date.now();
  return cachedFFmpegPath;
}

export function findFFprobe(): string | null {
  if (cachedFFprobePath !== undefined
    && (cachedFFprobePath ? fs.existsSync(cachedFFprobePath) : Date.now() - ffprobeCheckedAt < MISSING_BINARY_CACHE_MS)) {
    return cachedFFprobePath;
  }
  const bundled = bundledBinary('ffprobe');
  if (bundled) {
    cachedFFprobePath = bundled;
    ffprobeCheckedAt = Date.now();
    return bundled;
  }

  try {
    const staticBinary = existingCompatibleBinary(ffprobeStatic?.path);
    if (staticBinary) {
      cachedFFprobePath = staticBinary;
      ffprobeCheckedAt = Date.now();
      return staticBinary;
    }
  } catch {
    // Fall through.
  }

  try {
    if (ffmpegStatic) {
      const sibling = path.join(path.dirname(ffmpegStatic), binaryName('ffprobe'));
      const siblingBinary = existingCompatibleBinary(sibling);
      if (siblingBinary) {
        cachedFFprobePath = siblingBinary;
        ffprobeCheckedAt = Date.now();
        return siblingBinary;
      }
    }
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
    const bundledModuleBinary = existingCompatibleBinary(candidate);
    if (bundledModuleBinary) {
      cachedFFprobePath = bundledModuleBinary;
      ffprobeCheckedAt = Date.now();
      return bundledModuleBinary;
    }
  } catch {
    // Fall through.
  }

  cachedFFprobePath = firstExistingBinary(systemBinaryCandidates('ffprobe'));
  ffprobeCheckedAt = Date.now();
  return cachedFFprobePath;
}

export function findFpcalc(): string | null {
  if (cachedFpcalcPath !== undefined
    && (cachedFpcalcPath ? fs.existsSync(cachedFpcalcPath) : Date.now() - fpcalcCheckedAt < MISSING_BINARY_CACHE_MS)) {
    return cachedFpcalcPath;
  }
  const executable = binaryName('fpcalc');
  const relative = path.join('fpcalc', platformFolder(), executable);
  cachedFpcalcPath = firstExistingBinary([
    process.env.LOOMTV_FPCALC_PATH,
    path.join(process.resourcesPath || '', relative),
    path.join(app.getAppPath(), 'resources', relative),
    path.join(process.cwd(), 'resources', relative),
    ...systemBinaryCandidates('fpcalc'),
  ]);
  fpcalcCheckedAt = Date.now();
  return cachedFpcalcPath;
}
