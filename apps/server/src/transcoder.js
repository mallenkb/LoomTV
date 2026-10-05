import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffprobeMediaArguments, parseFfprobeMediaProbe } from '@loom-media-server/media-core';
import { getTranscodeCapabilities, probeTranscodeCapabilities } from '@loom-media-server/transcode-capabilities';

const execFileAsync = promisify(execFile);

/** @param {string | null | undefined} candidate */
function existingExecutable(candidate) {
  if (!candidate) return null;
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * First match on PATH, like `which`/`where.exe`, without a synchronous child
 * process (this module also runs inside the desktop app's main process).
 * @param {string} name
 */
function onPath(name) {
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const candidate of names) {
      const found = existingExecutable(path.join(directory, candidate));
      if (found) return found;
    }
  }
  return null;
}

/** @param {string | undefined} configuredPath */
function resolveFfmpeg(configuredPath) {
  const explicit = existingExecutable(configuredPath || process.env.LOOMTV_FFMPEG_PATH || process.env.FFMPEG_PATH);
  if (explicit) return explicit;
  return onPath('ffmpeg');
}

/** @param {string | undefined} configuredPath @param {string | null} ffmpegPath */
function resolveFfprobe(configuredPath, ffmpegPath) {
  const explicit = existingExecutable(configuredPath || process.env.LOOMTV_FFPROBE_PATH || process.env.FFPROBE_PATH);
  if (explicit) return explicit;
  if (ffmpegPath) {
    const sibling = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const bundled = existingExecutable(sibling);
    if (bundled) return bundled;
  }
  return onPath('ffprobe');
}

/** @param {{ ffmpegPath?: string, ffprobePath?: string, cacheDir?: string }} options */
export function createHeadlessTranscoder(options = {}) {
  const ffmpegPath = resolveFfmpeg(options.ffmpegPath);
  const ffprobePath = resolveFfprobe(options.ffprobePath, ffmpegPath);
  const probeOptions = { cacheDir: options.cacheDir, probeTimeoutMs: 5000 };

  return {
    path: ffmpegPath,
    probePath: ffprobePath,
    /** @param {string} filePath @param {{ sourceId?: string, signal?: AbortSignal }} options */
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
        if (error && typeof error === 'object' && 'code' in error && error.code === 'media_probe_invalid') throw error;
        if (error instanceof Error && error.name === 'AbortError') throw Object.assign(new Error('The media probe was cancelled.', { cause: error }), {
          code: 'operation_cancelled', status: 503, retryable: true,
        });
        throw Object.assign(new Error('The selected media source could not be probed.', { cause: error }), {
          code: 'media_probe_failed', status: 422, retryable: false,
        });
      }
    },
    getCapabilities() {
      return getTranscodeCapabilities(ffmpegPath, probeOptions);
    },
    async awaitCapabilities() {
      return probeTranscodeCapabilities(ffmpegPath, probeOptions);
    },
    async getSelfTest() {
      const capabilities = await probeTranscodeCapabilities(ffmpegPath, { ...probeOptions, force: true });
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
        probing: capabilities.state === 'probing',
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
