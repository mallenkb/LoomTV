import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * The contract version is deliberately independent from the app version. It
 * identifies the algorithms and vocabulary shared by desktop and headless
 * runtimes, so a catalog can be safely moved between them.
 */
export const MEDIA_CORE_CONTRACT_VERSION = 1;

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
