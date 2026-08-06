import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * The contract version is deliberately independent from the app version. It
 * identifies the algorithms and vocabulary shared by desktop and headless
 * runtimes, so a catalog can be safely moved between them.
 */
export const MEDIA_CORE_CONTRACT_VERSION = 2;

export {
  classifyVideoFile,
  cleanMediaTitle,
  isLikelyAnimePath,
  isLikelyEpisodeFileName,
  parseEpisodeFileName,
  seriesTitleFromEpisodeName,
} from './classification.mjs';

export const VIDEO_EXTENSIONS = Object.freeze([
  '.3gp', '.avi', '.divx', '.flv', '.m2ts', '.m4v', '.mkv', '.mov',
  '.mp4', '.mpeg', '.mpg', '.mts', '.mxf', '.ogm', '.ogv', '.ts', '.vob',
  '.webm', '.wmv',
]);

export const TRANSCODE_CODECS = Object.freeze(['h264', 'hevc', 'av1']);
export const PROFILE_TYPES = Object.freeze(['owner', 'standard', 'kid', 'guest']);

const videoExtensionSet = new Set(VIDEO_EXTENSIONS);
const transcodeCodecSet = new Set(TRANSCODE_CODECS);
const profileTypeSet = new Set(PROFILE_TYPES);

/** Return true when a path has a media extension understood by both runtimes. */
export function isVideoFilePath(filePath) {
  return videoExtensionSet.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Generate the stable ID used by desktop and headless catalogs.
 *
 * This intentionally keeps the desktop app's existing absolute-path hash
 * algorithm. Headless scans use the same function, so a mounted library does
 * not acquire a second identity just because it was indexed without Electron.
 */
export function createMediaItemId(filePath) {
  return createHash('sha256').update(path.resolve(String(filePath))).digest('hex').slice(0, 32);
}

export function normalizeTranscodeCodec(value, fallback = 'h264') {
  const codec = String(value || '').trim().toLowerCase();
  return transcodeCodecSet.has(codec) ? codec : fallback;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

/**
 * Normalize client playback constraints before a runtime chooses an encoder.
 * Backend selection remains runtime-specific; the request shape does not.
 */
export function normalizePlaybackProfile(input = {}) {
  const codec = normalizeTranscodeCodec(input.codec || input.targetVideoCodec);
  return {
    codec,
    maxWidth: boundedInteger(input.maxWidth, 0, 0, 8_192),
    maxHeight: boundedInteger(input.maxHeight, 0, 0, 8_192),
    videoBitrateKbps: boundedInteger(input.videoBitrateKbps, 0, 0, 100_000),
    audioBitrateKbps: boundedInteger(input.audioBitrateKbps, 160, 32, 1_024),
    toneMap: input.toneMap === true || input.toneMap === '1' || input.toneMap === 1,
  };
}

const DEFAULT_CLIENT_CONTAINERS = Object.freeze(['mp4', 'webm']);
const DEFAULT_CLIENT_VIDEO_CODECS = Object.freeze(['h264', 'vp8', 'vp9', 'av1']);
const DEFAULT_CLIENT_AUDIO_CODECS = Object.freeze(['aac', 'mp3', 'opus', 'vorbis']);

function normalizedList(value, fallback) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const result = [...new Set(values
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean))];
  return result.length ? result : [...fallback];
}

function normalizeContainer(value) {
  const container = String(value || '').trim().toLowerCase();
  if (container.includes('matroska')) return 'mkv';
  if (container.includes('quicktime') || container === 'm4v') return 'mp4';
  if (container.includes('mpegts')) return 'ts';
  return container.replace(/^\./, '') || 'unknown';
}

function normalizeCodec(value) {
  const codec = String(value || '').trim().toLowerCase();
  if (['h265', 'hvc1', 'hev1'].includes(codec)) return 'hevc';
  if (['av01'].includes(codec)) return 'av1';
  if (['vp09'].includes(codec)) return 'vp9';
  if (['mp4a.40.2', 'mp4a'].includes(codec)) return 'aac';
  if (['ac-3', 'ac3'].includes(codec)) return 'ac3';
  if (['ec-3', 'eac3'].includes(codec)) return 'eac3';
  return codec;
}

/**
 * Normalize the capabilities advertised by a desktop, browser, or mobile
 * client. Defaults are deliberately conservative browser capabilities so an
 * older client can omit fields without accidentally receiving an unsupported
 * direct stream.
 */
export function normalizeClientPlaybackCapabilities(input = {}) {
  return {
    containers: normalizedList(input.containers, DEFAULT_CLIENT_CONTAINERS).map(normalizeContainer),
    videoCodecs: normalizedList(input.videoCodecs, DEFAULT_CLIENT_VIDEO_CODECS).map(normalizeCodec),
    audioCodecs: normalizedList(input.audioCodecs, DEFAULT_CLIENT_AUDIO_CODECS).map(normalizeCodec),
    supportsHls: input.supportsHls !== false,
    supportsHdr: input.supportsHdr === true || input.supportsHdr === '1' || input.supportsHdr === 1,
    supportsTextSubtitles: input.supportsTextSubtitles !== false,
    maxWidth: boundedInteger(input.maxWidth, 0, 0, 16_384),
    maxHeight: boundedInteger(input.maxHeight, 0, 0, 16_384),
    maxVideoBitrateKbps: boundedInteger(input.maxVideoBitrateKbps, 0, 0, 500_000),
  };
}

function mediaFacts(media = {}) {
  const metadata = media.localMetadata || media.metadata || media;
  const filePath = media.path || media.filePath || '';
  const extension = path.extname(String(filePath)).replace(/^\./, '').toLowerCase();
  const container = normalizeContainer(metadata.container || media.container || extension);
  const videoCodec = normalizeCodec(metadata.videoCodec || media.videoCodec);
  const audioCodec = normalizeCodec(metadata.audioCodec || media.audioCodec);
  const width = boundedInteger(metadata.width || media.width, 0, 0, 16_384);
  const height = boundedInteger(metadata.height || media.height, 0, 0, 16_384);
  const bitrate = boundedInteger(metadata.bitrateKbps || media.bitrateKbps, 0, 0, 500_000);
  const transfer = String(metadata.colorTransfer || media.colorTransfer || '').toLowerCase();
  const primaries = String(metadata.colorPrimaries || media.colorPrimaries || '').toLowerCase();
  const pixelFormat = String(metadata.pixelFormat || media.pixelFormat || '').toLowerCase();
  const hdr = media.hdr === true || metadata.hdr === true
    || ['smpte2084', 'arib-std-b67', 'hlg'].includes(transfer)
    || primaries.includes('bt2020')
    || (primaries.includes('bt2020') && /10|12/.test(pixelFormat));
  const hasAudio = metadata.audioTracks === 0 || media.audioTracks === 0
    ? false
    : Boolean(audioCodec || metadata.audioTracks || media.audioTracks);
  return { container, videoCodec, audioCodec: hasAudio ? audioCodec : 'none', width, height, bitrate, hdr };
}

/**
 * Select a transport and output profile without starting a process. The
 * server can use this same decision for LAN clients and the desktop renderer
 * can display the reason before a transcode is requested.
 */
export function playbackPlanForMedia(media = {}, input = {}) {
  const capabilities = normalizeClientPlaybackCapabilities(input);
  const facts = mediaFacts(media);
  const containerSupported = capabilities.containers.includes(facts.container);
  const videoSupported = facts.videoCodec && capabilities.videoCodecs.includes(facts.videoCodec);
  const audioSupported = facts.audioCodec === 'none' || capabilities.audioCodecs.includes(facts.audioCodec);
  const sizeSupported = (!capabilities.maxWidth || !facts.width || facts.width <= capabilities.maxWidth)
    && (!capabilities.maxHeight || !facts.height || facts.height <= capabilities.maxHeight);
  const bitrateSupported = !capabilities.maxVideoBitrateKbps
    || !facts.bitrate
    || facts.bitrate <= capabilities.maxVideoBitrateKbps;
  const hdrSupported = !facts.hdr || capabilities.supportsHdr;
  if (containerSupported && videoSupported && audioSupported && sizeSupported && bitrateSupported && hdrSupported) {
    return {
      mode: 'direct',
      reason: 'container, codecs, dimensions, and HDR support match the client',
      sourceAction: 'direct',
      codec: facts.videoCodec,
      backend: 'client-native',
      facts,
    };
  }

  const codec = capabilities.videoCodecs.includes('h264') ? 'h264'
    : capabilities.videoCodecs.find((candidate) => ['hevc', 'av1'].includes(candidate)) || 'h264';
  const reasons = [];
  if (!containerSupported) reasons.push(`${facts.container || 'unknown'} container`);
  if (!videoSupported) reasons.push(`${facts.videoCodec || 'unknown'} video`);
  if (!audioSupported) reasons.push(`${facts.audioCodec || 'unknown'} audio`);
  if (!sizeSupported) reasons.push('client dimensions');
  if (!bitrateSupported) reasons.push('client bitrate');
  if (!hdrSupported) reasons.push('HDR tone mapping');
  if (!capabilities.supportsHls) {
    return {
      mode: 'transcode',
      reason: `The source exceeds the client profile (${reasons.join(', ') || 'compatibility fallback'}), but this client does not advertise HLS support.`,
      sourceAction: 'transcode',
      codec,
      backend: 'unavailable',
      facts,
    };
  }
  return {
    mode: 'transcode',
    reason: `Transcoding is required for ${reasons.join(', ') || 'client compatibility'}.`,
    sourceAction: 'transcode',
    codec,
    backend: 'auto',
    facts,
  };
}

export function normalizeProfileType(value, fallback = 'standard') {
  const type = String(value || '').trim().toLowerCase();
  return profileTypeSet.has(type) ? type : fallback;
}

/**
 * Keep profile-facing data portable without leaking credentials or runtime
 * storage fields through a shared library/session payload.
 */
export function profileView(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    id: String(profile.id || ''),
    name: String(profile.name || 'Viewer').trim().slice(0, 80) || 'Viewer',
    type: normalizeProfileType(profile.type),
    hasPin: profile.hasPin === true,
    isGuest: profile.isGuest === true,
  };
}
