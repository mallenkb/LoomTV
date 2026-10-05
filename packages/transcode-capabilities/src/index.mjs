import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const runCommand = async (command, args, options) => (await execFileAsync(command, args, options)).stdout;

const TRANSCODE_BACKENDS = Object.freeze([
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

const capabilityCache = new Map();

async function outputOf(ffmpegPath, args, timeout = 3000, commandRunner = runCommand) {
  try {
    const output = await commandRunner(ffmpegPath, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return typeof output === 'string' ? output : Buffer.isBuffer(output) ? output.toString('utf8') : '';
  } catch {
    return '';
  }
}

async function commandSucceeds(ffmpegPath, args, timeout = 5000, commandRunner = runCommand) {
  try {
    await commandRunner(ffmpegPath, args, {
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
  if (backend === 'qsv' && platform === 'win32') return 'windows-gpu';
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

async function encoderCapability(ffmpegPath, backend, codec, encoder, device, options) {
  const compiled = Boolean(options.encoders && options.encoders.includes(encoder));
  if (!compiled) return { encoder, compiled: false, available: false, verified: false, reason: 'Encoder is not present in this FFmpeg build.' };
  if (!device) return { encoder, compiled: true, available: false, verified: false, reason: 'Required hardware device is not visible to the process.' };
  const verified = options.skipSmokeTest
    ? true
    : await commandSucceeds(
      ffmpegPath,
      smokeArgs(backend, encoder, device),
      options.probeTimeoutMs,
      options.commandRunner,
    );
  return {
    encoder,
    compiled: true,
    available: verified,
    verified,
    reason: verified ? 'Encoder passed a one-frame FFmpeg probe.' : 'Encoder is compiled in but failed the FFmpeg device probe.',
  };
}

function emptyCapabilities(ffmpegPath, platform, state = 'unavailable') {
  return {
    state,
    ffmpegPath,
    platform,
    backends: [],
    recommendedBackend: 'software',
    hardwareAcceleration: false,
    softwareFallback: true,
    codecs: { h264: false, hevc: false, av1: false },
    softwareCodecs: { h264: false, hevc: false, av1: false },
    softwareEncoders: {},
    toneMapping: false,
    probedAt: 0,
    reason: state === 'probing' ? 'FFmpeg capability probing is in progress.' : 'FFmpeg is not available.',
  };
}

const runnerIds = new WeakMap();
let nextRunnerId = 0;

function probeIdentity(ffmpegPath, options) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  let binary = ffmpegPath;
  if (binary && !binary.includes('/') && !binary.includes('\\')) {
    const names = platform === 'win32' && !binary.endsWith('.exe') ? [binary, `${binary}.exe`] : [binary];
    binary = firstExisting((environment.PATH || '').split(path.delimiter).flatMap((directory) => names.map((name) => path.join(directory, name))));
  }
  let stats;
  try { stats = fs.statSync(binary); } catch { return { platform, binary: null }; }
  if (!stats.isFile()) return { platform, binary: null };
  binary = path.resolve(binary);
  const key = JSON.stringify([
    1, binary, stats.size, stats.mtimeMs, platform, process.arch, os.release(), os.version(),
    Boolean(options.skipSmokeTest), environment.LOOMTV_VAAPI_DEVICE || '', environment.VAAPI_DEVICE || '',
  ]);
  let runnerId = 0;
  if (options.commandRunner) {
    if (!runnerIds.has(options.commandRunner)) runnerIds.set(options.commandRunner, ++nextRunnerId);
    runnerId = runnerIds.get(options.commandRunner);
  }
  return { platform, binary, key, memoryKey: `${key}:${runnerId}` };
}

function validCapabilities(value) {
  const booleans = (object) => object && ['h264', 'hevc', 'av1'].every((codec) => typeof object[codec] === 'boolean');
  return value && ['available', 'limited'].includes(value.state)
    && typeof value.ffmpegPath === 'string' && typeof value.platform === 'string'
    && Number.isFinite(value.probedAt) && typeof value.toneMapping === 'boolean'
    && typeof value.hardwareAcceleration === 'boolean' && value.softwareFallback === true
    && [...TRANSCODE_BACKENDS, 'software'].includes(value.recommendedBackend)
    && booleans(value.codecs) && booleans(value.softwareCodecs)
    && value.softwareEncoders && ['h264', 'hevc', 'av1'].every((codec) =>
      value.softwareEncoders[codec] === null || typeof value.softwareEncoders[codec] === 'string')
    && Array.isArray(value.backends) && value.backends.length === TRANSCODE_BACKENDS.length
    && value.backends.every((backend) => backend && TRANSCODE_BACKENDS.includes(backend.id)
      && typeof backend.label === 'string' && typeof backend.hwaccel === 'string'
      && typeof backend.available === 'boolean' && typeof backend.platformSupported === 'boolean'
      && typeof backend.hwaccelAvailable === 'boolean' && (backend.device === null || typeof backend.device === 'string')
      && backend.decode && typeof backend.decode.available === 'boolean' && typeof backend.decode.advertised === 'boolean'
      && backend.codecs && Object.values(backend.codecs).every((codec) => codec
        && typeof codec.encoder === 'string' && typeof codec.compiled === 'boolean'
        && typeof codec.available === 'boolean' && typeof codec.verified === 'boolean' && typeof codec.reason === 'string'));
}

async function loadOrProbe(identity, options) {
  const target = options.cacheDir && !options.commandRunner
    ? path.join(options.cacheDir, `${createHash('sha256').update(identity.key).digest('hex')}.json`)
    : null;
  if (target && !options.force) {
    try {
      const saved = JSON.parse(await fs.promises.readFile(target, 'utf8'));
      if (saved.key === identity.key && validCapabilities(saved.capabilities)
        && saved.capabilities.ffmpegPath === identity.binary && saved.capabilities.platform === identity.platform) {
        return saved.capabilities;
      }
    } catch { /* A missing or damaged cache is rebuilt asynchronously. */ }
  }
  const result = await runProbe(identity.binary, { ...options, platform: identity.platform });
  if (target) {
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.promises.mkdir(options.cacheDir, { recursive: true });
      await fs.promises.writeFile(temporary, JSON.stringify({ key: identity.key, capabilities: result }), { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(temporary, target);
    } catch {
      // A read-only cache must not prevent playback or cause repeated probes.
      await fs.promises.unlink(temporary).catch(() => undefined);
    }
  }
  return result;
}

function capabilityEntry(ffmpegPath, options) {
  const identity = probeIdentity(ffmpegPath, options);
  if (!identity.binary) return { result: emptyCapabilities(null, identity.platform) };
  let entry = capabilityCache.get(identity.memoryKey);
  if (entry && (!options.force || entry.pending)) return entry;
  entry = { result: emptyCapabilities(identity.binary, identity.platform, 'probing'), pending: null };
  capabilityCache.set(identity.memoryKey, entry);
  entry.pending = loadOrProbe(identity, options).catch(() => ({
    ...emptyCapabilities(identity.binary, identity.platform),
    reason: 'FFmpeg capability probing failed.',
  })).then((result) => {
    entry.result = result;
    entry.pending = null;
    return result;
  });
  return entry;
}

export function getTranscodeCapabilities(ffmpegPath, options = {}) {
  return capabilityEntry(ffmpegPath, options).result;
}

export function probeTranscodeCapabilities(ffmpegPath, options = {}) {
  const entry = capabilityEntry(ffmpegPath, options);
  return entry.pending || Promise.resolve(entry.result);
}

async function runProbe(ffmpegPath, options) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const commandRunner = options.commandRunner || runCommand;
  const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs) ? options.probeTimeoutMs : 5000;
  const now = Date.now();
  const encoders = await outputOf(ffmpegPath, ['-hide_banner', '-encoders'], probeTimeoutMs, commandRunner);
  const decoders = await outputOf(ffmpegPath, ['-hide_banner', '-decoders'], probeTimeoutMs, commandRunner);
  const hwaccels = await outputOf(ffmpegPath, ['-hide_banner', '-hwaccels'], probeTimeoutMs, commandRunner);
  const filters = await outputOf(ffmpegPath, ['-hide_banner', '-filters'], probeTimeoutMs, commandRunner);
  const encoderNames = Object.values(BACKEND_DEFINITIONS)
    .flatMap((definition) => Object.values(definition.encoders));
  const resultBackends = [];
  for (const backend of TRANSCODE_BACKENDS) {
    const definition = BACKEND_DEFINITIONS[backend];
    const device = platformAllowed(definition, platform) ? deviceForBackend(backend, platform, environment) : null;
    const codecCapabilities = {};
    for (const [codec, encoder] of Object.entries(definition.encoders)) {
      codecCapabilities[codec] = await encoderCapability(ffmpegPath, backend, codec, encoder, device, {
        encoders: encoderNames.filter((name) => encoders.includes(name)),
        skipSmokeTest: options.skipSmokeTest,
        probeTimeoutMs,
        commandRunner,
      });
    }
    const available = Object.values(codecCapabilities).some((capability) => capability.available);
    const hasHwaccel = hwaccels.includes(definition.hwaccel);
    resultBackends.push({
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
    });
  }

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
  return result;
}

export function clearTranscodeCapabilityCache() {
  capabilityCache.clear();
}
