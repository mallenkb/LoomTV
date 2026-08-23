import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ffprobeMediaArguments, parseFfprobeMediaProbe } from '@loom-media-server/media-core';
import { probeTranscodeCapabilities } from '@loom-media-server/transcode-capabilities';

const execFileAsync = promisify(execFile);

function existingExecutable(candidate) {
  if (!candidate) return null;
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function resolveFfmpeg(configuredPath) {
  const explicit = existingExecutable(configuredPath || process.env.LOOMTV_FFMPEG_PATH || process.env.FFMPEG_PATH);
  if (explicit) return explicit;
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const output = execFileSync(command, ['ffmpeg'], { encoding: 'utf8', timeout: 1000 })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find(Boolean);
    return existingExecutable(output);
  } catch {
    return null;
  }
}

function resolveFfprobe(configuredPath, ffmpegPath) {
  const explicit = existingExecutable(configuredPath || process.env.LOOMTV_FFPROBE_PATH || process.env.FFPROBE_PATH);
  if (explicit) return explicit;
  if (ffmpegPath) {
    const sibling = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const bundled = existingExecutable(sibling);
    if (bundled) return bundled;
  }
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const output = execFileSync(command, ['ffprobe'], { encoding: 'utf8', timeout: 1000 })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find(Boolean);
    return existingExecutable(output);
  } catch {
    return null;
  }
}

export function createHeadlessTranscoder(options = {}) {
  const ffmpegPath = resolveFfmpeg(options.ffmpegPath);
  const ffprobePath = resolveFfprobe(options.ffprobePath, ffmpegPath);
  let lastProbe;
  let lastProbeAt = 0;

  return {
    path: ffmpegPath,
    probePath: ffprobePath,
    async probeMedia(filePath, { sourceId = 'primary', signal } = {}) {
      if (!ffprobePath) throw Object.assign(new Error('FFprobe is not available on this host.'), {
        code: 'media_probe_unavailable', status: 503, retryable: true,
      });
      try {
        const { stdout } = await execFileAsync(ffprobePath, ffprobeMediaArguments(filePath), {
          encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, signal,
        });
        return parseFfprobeMediaProbe(stdout, { sourceId });
      } catch (error) {
        if (error?.code === 'media_probe_invalid') throw error;
        if (error?.name === 'AbortError') throw Object.assign(new Error('The media probe was cancelled.'), {
          code: 'operation_cancelled', status: 503, retryable: true,
        });
        throw Object.assign(new Error('The selected media source could not be probed.'), {
          code: 'media_probe_failed', status: 422, retryable: false,
        });
      }
    },
    getCapabilities({ force = false } = {}) {
      const now = Date.now();
      if (!force && lastProbe && now - lastProbeAt < 30_000) return lastProbe;
      lastProbe = probeTranscodeCapabilities(ffmpegPath, { probeTimeoutMs: 5000 });
      lastProbeAt = now;
      return lastProbe;
    },
    getSelfTest() {
      const capabilities = this.getCapabilities({ force: true });
      return {
        startedAt: capabilities.probedAt,
        completedAt: Date.now(),
        ffmpegPath,
        ffprobePath,
        state: capabilities.state,
        recommendedBackend: capabilities.recommendedBackend,
        softwareFallback: capabilities.softwareFallback,
        backends: capabilities.backends.map((backend) => ({
          id: backend.id,
          label: backend.label,
          device: backend.device,
          available: backend.available,
          decode: backend.decode,
          codecs: Object.fromEntries(Object.entries(backend.codecs).map(([codec, result]) => [codec, {
            encoder: result.encoder,
            compiled: result.compiled,
            verified: result.verified,
            available: result.available,
            reason: result.reason,
          }])),
        })),
      };
    },
    getHealth() {
      const capabilities = this.getCapabilities();
      return {
        state: capabilities.state,
        available: capabilities.state !== 'unavailable',
        ffmpegPath,
        ffprobePath,
        probing: Boolean(ffprobePath),
        recommendedBackend: capabilities.recommendedBackend,
        hardwareAcceleration: capabilities.hardwareAcceleration,
        codecs: capabilities.codecs,
        softwareCodecs: capabilities.softwareCodecs,
        softwareEncoders: capabilities.softwareEncoders,
        backends: capabilities.backends,
        softwareFallback: capabilities.softwareFallback,
        toneMapping: capabilities.toneMapping,
        mediaStreaming: true,
        reason: capabilities.reason || 'Direct HTTP streaming and HLS transcode routes are available.',
      };
    },
  };
}
