import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TRANSCODE_BACKENDS = Object.freeze([
  'videotoolbox',
  'nvenc',
  'qsv',
  'vaapi',
  'amf',
  'rkmpp',
]);

const BACKEND_DEFINITIONS = {
  videotoolbox: {
    label: 'Apple VideoToolbox',
    platform: 'darwin',
    encoders: { h264: 'h264_videotoolbox', hevc: 'hevc_videotoolbox' },
    hwaccel: 'videotoolbox',
  },
  nvenc: {
    label: 'NVIDIA NVENC/NVDEC',
    platforms: ['linux', 'win32'],
    encoders: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc' },
    hwaccel: 'cuda',
  },
  qsv: {
    label: 'Intel Quick Sync',
    platforms: ['linux', 'win32'],
    encoders: { h264: 'h264_qsv', hevc: 'hevc_qsv', av1: 'av1_qsv' },
    hwaccel: 'qsv',
  },
  vaapi: {
    label: 'VA-API',
    platform: 'linux',
    encoders: { h264: 'h264_vaapi', hevc: 'hevc_vaapi', av1: 'av1_vaapi' },
    hwaccel: 'vaapi',
  },
  amf: {
    label: 'AMD AMF',
    platform: 'win32',
    encoders: { h264: 'h264_amf', hevc: 'hevc_amf', av1: 'av1_amf' },
    hwaccel: 'd3d11va',
  },
  rkmpp: {
    label: 'Rockchip RKMPP',
    platform: 'linux',
    encoders: { h264: 'h264_rkmpp', hevc: 'hevc_rkmpp' },
    hwaccel: 'rkmpp',
  },
};

const DEFAULT_CACHE_MS = 30_000;
const capabilityCache = new Map();

function outputOf(ffmpegPath, args, timeout = 3000) {
  try {
    return execFileSync(ffmpegPath, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

function commandSucceeds(ffmpegPath, args, timeout = 5000) {
  try {
    execFileSync(ffmpegPath, args, {
      stdio: 'ignore',
      timeout,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function firstExisting(paths) {
  return paths.find((candidate) => {
    try {
      return Boolean(candidate && fs.existsSync(candidate));
    } catch {
      return false;
    }
  }) || null;
}

function driRenderNode() {
  try {
    const entries = fs.readdirSync('/dev/dri')
      .filter((entry) => /^renderD\d+$/.test(entry))
      .sort();
    return firstExisting(entries.map((entry) => path.join('/dev/dri', entry)));
  } catch {
    return null;
  }
}

function deviceForBackend(backend, platform, environment) {
  if (backend === 'vaapi' || backend === 'qsv') {
    if (platform !== 'linux') return null;
    return firstExisting([
      environment.LOOMTV_VAAPI_DEVICE,
      environment.VAAPI_DEVICE,
      driRenderNode(),
    ]);
  }
  if (backend === 'nvenc') {
    if (platform === 'win32') return 'windows-gpu';
    return firstExisting(['/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm']);
  }
  if (backend === 'rkmpp') {
    return platform === 'linux' ? firstExisting([driRenderNode(), '/dev/mpp_service']) : null;
  }
  if (backend === 'amf') return platform === 'win32' ? 'windows-gpu' : null;
  if (backend === 'videotoolbox') return platform === 'darwin' ? 'system' : null;
  return null;
}

function platformAllowed(definition, platform) {
  if (definition.platform) return definition.platform === platform;
  return definition.platforms.includes(platform);
}

function smokeArgs(backend, encoder, device) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (backend === 'vaapi' && device) args.push('-vaapi_device', device);
  if (backend === 'qsv') args.push('-init_hw_device', 'qsv=hw');
  args.push(
    '-f', 'lavfi',
    '-i', 'color=c=black:s=128x128:r=1',
    '-frames:v', '1',
  );
  if (backend === 'vaapi' || backend === 'qsv') args.push('-vf', 'format=nv12,hwupload');
  args.push('-an', '-c:v', encoder, '-f', 'null', '-');
  // Capability probing must reject Apple's software fallback; playback itself
  // still keeps `-allow_sw 1` so a transient hardware failure can fall back.
  if (backend === 'videotoolbox') args.splice(args.indexOf('-c:v'), 0, '-allow_sw', '0');
  return args;
}

function encoderCapability(ffmpegPath, backend, codec, encoder, device, options) {
  const compiled = Boolean(options.encoders && options.encoders.includes(encoder));
  if (!compiled) return { encoder, compiled: false, available: false, verified: false, reason: 'Encoder is not present in this FFmpeg build.' };
  if (!device) return { encoder, compiled: true, available: false, verified: false, reason: 'Required hardware device is not visible to the process.' };
  const verified = options.skipSmokeTest
    ? true
    : commandSucceeds(ffmpegPath, smokeArgs(backend, encoder, device), options.probeTimeoutMs);
  return {
    encoder,
    compiled: true,
    available: verified,
    verified,
    reason: verified ? 'Encoder passed a one-frame FFmpeg probe.' : 'Encoder is compiled in but failed the FFmpeg device probe.',
  };
}

function cacheKey(ffmpegPath, options) {
  let stamp = '';
  try {
    const stats = fs.statSync(ffmpegPath);
    stamp = `${stats.size}:${stats.mtimeMs}`;
  } catch {
    stamp = 'missing';
  }
  return `${ffmpegPath}:${stamp}:${options.skipSmokeTest ? 'skip' : 'probe'}:${options.environment.LOOMTV_VAAPI_DEVICE || ''}`;
}

export function probeTranscodeCapabilities(ffmpegPath, options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs) ? options.probeTimeoutMs : 5000;
  const now = Date.now();
  let ffmpegAvailable = Boolean(ffmpegPath);
  if (ffmpegAvailable) {
    try {
      ffmpegAvailable = fs.existsSync(ffmpegPath)
        || (!ffmpegPath.includes('/') && !ffmpegPath.includes('\\') && commandSucceeds(ffmpegPath, ['-version'], 1000));
    } catch {
      ffmpegAvailable = false;
    }
  }
  if (!ffmpegAvailable) {
    return {
      state: 'unavailable',
      ffmpegPath: null,
      platform,
      backends: [],
      recommendedBackend: 'software',
      hardwareAcceleration: false,
      softwareFallback: true,
      codecs: { h264: false, hevc: false, av1: false },
      softwareCodecs: { h264: false, hevc: false, av1: false },
      softwareEncoders: {},
      toneMapping: false,
      probedAt: now,
      reason: 'FFmpeg is not available.',
    };
  }

  const key = cacheKey(ffmpegPath, { ...options, environment });
  const cached = capabilityCache.get(key);
  const cacheMs = Number.isFinite(options.cacheMs) ? options.cacheMs : DEFAULT_CACHE_MS;
  if (cached && now - cached.probedAt < cacheMs) return cached;

  const encoders = outputOf(ffmpegPath, ['-hide_banner', '-encoders'], probeTimeoutMs);
  const decoders = outputOf(ffmpegPath, ['-hide_banner', '-decoders'], probeTimeoutMs);
  const hwaccels = outputOf(ffmpegPath, ['-hide_banner', '-hwaccels'], probeTimeoutMs);
  const filters = outputOf(ffmpegPath, ['-hide_banner', '-filters'], probeTimeoutMs);
  const encoderNames = Object.values(BACKEND_DEFINITIONS)
    .flatMap((definition) => Object.values(definition.encoders));
  const resultBackends = TRANSCODE_BACKENDS.map((backend) => {
    const definition = BACKEND_DEFINITIONS[backend];
    const device = platformAllowed(definition, platform) ? deviceForBackend(backend, platform, environment) : null;
    const codecCapabilities = Object.fromEntries(Object.entries(definition.encoders).map(([codec, encoder]) => [
      codec,
      encoderCapability(ffmpegPath, backend, codec, encoder, device, {
        encoders: encoderNames.filter((name) => encoders.includes(name)),
        skipSmokeTest: options.skipSmokeTest,
        probeTimeoutMs,
      }),
    ]));
    const available = Object.values(codecCapabilities).some((capability) => capability.available);
    const hasHwaccel = hwaccels.includes(definition.hwaccel);
    return {
      id: backend,
      label: definition.label,
      hwaccel: definition.hwaccel,
      platformSupported: platformAllowed(definition, platform),
      device,
      hwaccelAvailable: hasHwaccel,
      available,
      codecs: codecCapabilities,
      decode: {
        advertised: hasHwaccel || decoders.includes(definition.hwaccel),
        available: hasHwaccel && Boolean(device),
      },
    };
  });

  const order = platform === 'darwin'
    ? ['videotoolbox', 'qsv', 'nvenc']
    : platform === 'win32'
      ? ['nvenc', 'qsv', 'amf', 'videotoolbox']
      : ['nvenc', 'qsv', 'vaapi', 'rkmpp'];
  const recommendedBackend = order.find((backend) => resultBackends.find((entry) => entry.id === backend)?.available) || 'software';
  const h264 = resultBackends.some((entry) => entry.codecs.h264?.available);
  const hevc = resultBackends.some((entry) => entry.codecs.hevc?.available);
  const av1 = resultBackends.some((entry) => entry.codecs.av1?.available);
  const softwareCodecs = {
    h264: encoders.includes('libx264'),
    hevc: encoders.includes('libx265'),
    av1: encoders.includes('libsvtav1') || encoders.includes('libaom-av1'),
  };
  const softwareEncoders = {
    h264: encoders.includes('libx264') ? 'libx264' : null,
    hevc: encoders.includes('libx265') ? 'libx265' : null,
    av1: encoders.includes('libsvtav1') ? 'libsvtav1' : encoders.includes('libaom-av1') ? 'libaom-av1' : null,
  };
  const result = {
    state: h264 ? 'available' : 'limited',
    ffmpegPath,
    platform,
    backends: resultBackends,
    recommendedBackend,
    hardwareAcceleration: h264,
    softwareFallback: true,
    codecs: { h264, hevc, av1 },
    softwareCodecs,
    softwareEncoders,
    toneMapping: filters.includes('zscale') && filters.includes('tonemap'),
    probedAt: now,
    reason: h264 ? undefined : 'No hardware H.264 encoder passed the device probe; software transcoding remains available.',
  };
  capabilityCache.set(key, result);
  return result;
}

export function clearTranscodeCapabilityCache() {
  capabilityCache.clear();
}

export function backendEncoder(capabilities, backend, codec = 'h264') {
  return capabilities?.backends?.find((entry) => entry.id === backend)?.codecs?.[codec]?.encoder || null;
}
