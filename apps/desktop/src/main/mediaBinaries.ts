import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  probeTranscodeCapabilities,
  type TranscodeCapabilities,
} from '@loom-media-server/transcode-capabilities';

export { appendH264EncoderOptions, type H264HardwareEncoder, type HardwareVideoEncoder } from './transcodeFilters.ts';
import type { HardwareVideoEncoder } from './transcodeFilters.ts';

let cachedFFmpegPath: string | null | undefined;
let cachedFFprobePath: string | null | undefined;
let cachedFpcalcPath: string | null | undefined;
let ffmpegCheckedAt = 0;
let ffprobeCheckedAt = 0;
let fpcalcCheckedAt = 0;
const MISSING_BINARY_CACHE_MS = 30_000;

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
  const candidates: Array<string | null | undefined> = [
    path.join(process.resourcesPath || '', relative),
    path.join(app.getAppPath(), 'resources', relative),
  ];
  if (!app.isPackaged) candidates.push(path.join(process.cwd(), 'resources', relative));
  return firstExistingBinary(candidates);
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

export function preferredHardwareEncoder(binaryPath: string, codec: 'h264' | 'hevc' | 'av1' = 'h264'): HardwareVideoEncoder | null {
  const capabilities = getTranscodeCapabilities(binaryPath);
  const preferred = capabilities.backends.find((entry) => entry.id === capabilities.recommendedBackend);
  const backend = preferred?.codecs[codec]?.available
    ? preferred
    : capabilities.backends.find((entry) => entry.codecs[codec]?.available);
  return backend?.codecs[codec]?.encoder as HardwareVideoEncoder | undefined || null;
}

export function getTranscodeCapabilities(binaryPath = findFFmpeg()): TranscodeCapabilities {
  return probeTranscodeCapabilities(binaryPath, { probeTimeoutMs: 5000 });
}

export function findFFmpeg(): string | null {
  if (cachedFFmpegPath !== undefined
    && (cachedFFmpegPath ? fs.existsSync(cachedFFmpegPath) : Date.now() - ffmpegCheckedAt < MISSING_BINARY_CACHE_MS)) {
    return cachedFFmpegPath;
  }
  const bundled = bundledBinary('ffmpeg');
  if (bundled) {
    cachedFFmpegPath = bundled;
    ffmpegCheckedAt = Date.now();
    return bundled;
  }

  cachedFFmpegPath = firstExistingBinary(systemBinaryCandidates('ffmpeg'));
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
