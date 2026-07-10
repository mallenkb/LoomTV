import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export type H264HardwareEncoder = 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv';

function platformFolder(): 'win' | 'mac' | 'linux' {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function binaryName(name: 'ffmpeg' | 'ffprobe'): string {
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
  const candidates: H264HardwareEncoder[] =
    process.platform === 'darwin'
      ? ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv']
      : ['h264_nvenc', 'h264_qsv', 'h264_videotoolbox'];

  return candidates.find((encoder) => hasFFmpegEncoder(binaryPath, encoder)) || null;
}

export function appendH264EncoderOptions(args: string[], encoder: H264HardwareEncoder): void {
  if (encoder === 'h264_videotoolbox') {
    args.push(
      '-allow_sw', '1',
      '-realtime', '1',
      '-b:v', '6500k',
      '-maxrate', '8500k',
      '-bufsize', '12000k',
      '-profile:v', 'main',
    );
    return;
  }

  if (encoder === 'h264_nvenc') {
    args.push('-preset', 'p4', '-cq', '23', '-b:v', '0');
    return;
  }

  args.push('-global_quality', '23', '-look_ahead', '0');
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

  for (const candidate of candidates) {
    const binary = existingCompatibleBinary(candidate);
    if (binary && preferredH264HardwareEncoder(binary)) return binary;
  }

  return firstExistingBinary(candidates);
}

export function findFFprobe(): string | null {
  const bundled = bundledBinary('ffprobe');
  if (bundled) return bundled;

  try {
    const staticBinary = existingCompatibleBinary(ffprobeStatic?.path);
    if (staticBinary) return staticBinary;
  } catch {
    // Fall through.
  }

  try {
    if (ffmpegStatic) {
      const sibling = path.join(path.dirname(ffmpegStatic), binaryName('ffprobe'));
      const siblingBinary = existingCompatibleBinary(sibling);
      if (siblingBinary) return siblingBinary;
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
    if (bundledModuleBinary) return bundledModuleBinary;
  } catch {
    // Fall through.
  }

  return firstExistingBinary(systemBinaryCandidates('ffprobe'));
}
