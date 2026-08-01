import fs from 'node:fs';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { probeTranscodeCapabilities } from '@loom-media-server/transcode-capabilities';

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

export function createHeadlessTranscoder(options = {}) {
  const ffmpegPath = resolveFfmpeg(options.ffmpegPath);
  let lastProbe;
  let lastProbeAt = 0;

  return {
    path: ffmpegPath,
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
