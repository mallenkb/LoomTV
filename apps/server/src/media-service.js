import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { normalizePlaybackProfile, playbackPlanForMedia } from '@loom-media-server/media-core';
import { backendEncoder } from '@loom-media-server/transcode-capabilities';
import { openContainedFile, resolveContainedPath, statContainedFile } from './media-path-guard.js';
import {
  createPlaybackSessionRegistry,
  DEFAULT_PLAYBACK_ABSOLUTE_TIMEOUT_MS,
} from './playback-session-registry.js';
import { createTranscodeAdmission } from './transcode-admission.js';
import { createTranscodeCacheQuota } from './transcode-cache-quota.js';
import { canonicalPublicError } from './public-error.js';

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/x-ssa; charset=utf-8',
  '.ssa': 'text/x-ssa; charset=utf-8',
};
const DIRECT_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ts']);
const SESSION_TTL_MS = 30 * 60 * 1000;
const MEDIA_TOKEN_TTL_MS = 5 * 60 * 1000;
const PLAYLIST_WAIT_MS = 20_000;
const HLS_ABSOLUTE_TIMEOUT_MS = Math.max(DEFAULT_PLAYBACK_ABSOLUTE_TIMEOUT_MS, SESSION_TTL_MS * 2);
const HLS_NO_CLIENT_GRACE_MS = 30 * 1000;
const PROCESS_TERM_GRACE_MS = 2_000;

function json(res, status, payload) {
  const retryAfterSeconds = Number.isFinite(payload?.retryAfter)
    ? Math.max(1, Math.ceil(payload.retryAfter))
    : undefined;
  let publicPayload = payload;
  if (res.__loomtvPublicApi && payload?.ok === false && typeof payload.error === 'string') {
    const { retryAfter: _legacyRetryAfter, message: _legacyMessage, ...safePayload } = payload;
    publicPayload = { ...safePayload, error: {
      code: canonicalPublicError({ status, code: payload.error }).code,
      message: status >= 500
        ? 'The media request could not be completed.'
        : payload.message || 'The media request was rejected.',
      ...(retryAfterSeconds ? { retryAfterMs: retryAfterSeconds * 1_000 } : {}),
    } };
  }
  const body = JSON.stringify(publicPayload);
  if (!res.headersSent) {
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...(res.__loomtvPublicApi ? { 'X-LoomTV-API-Version': '1' } : {}),
      ...(res.__loomtvPublicApi && retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}),
    });
  }
  // Returning the response matters: `/api/v1/media/:id/download` forwards this
  // handler's return value as "did you handle it", and a bare `res.end()`
  // returned undefined, so every error response fell through to the outer 404
  // and wrote a second set of headers. Containment rejections take this path.
  return res.end(body);
}

/**
 * The versioned API strips `path` from every catalog DTO. This legacy listing
 * route did not, so any account with library.read — a viewer, by default —
 * could read absolute server paths for the whole library.
 */
function redactedLibraryItem(item) {
  if (!item || typeof item !== 'object') return item;
  const safeItem = {};
  for (const field of ['id', 'rootId', 'type', 'title', 'kind', 'extension']) {
    if (typeof item[field] === 'string' && item[field].length <= 4_096 && !item[field].includes('\u0000')) safeItem[field] = item[field];
  }
  for (const field of ['year', 'sizeBytes', 'modifiedAtMs', 'indexedAt']) {
    if (Number.isFinite(item[field])) safeItem[field] = Number(item[field]);
  }
  if (typeof item.available === 'boolean') safeItem.available = item.available;
  if (typeof item.relativePath === 'string' && item.relativePath.length <= 4_096
    && !path.isAbsolute(item.relativePath) && !path.win32.isAbsolute(item.relativePath)
    && !item.relativePath.includes('\u0000')) safeItem.relativePath = item.relativePath;
  if (item.animeLikely === true) safeItem.animeLikely = true;
  if (item.series && typeof item.series === 'object' && typeof item.series.title === 'string') {
    safeItem.series = {
      title: item.series.title.slice(0, 500),
      ...(Number.isSafeInteger(item.series.season) ? { season: item.series.season } : {}),
      ...(Number.isSafeInteger(item.series.episode) ? { episode: item.series.episode } : {}),
    };
  }
  return safeItem;
}

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function downloadDisposition(filePath) {
  const name = path.basename(filePath).replace(/[\u0000-\u001f\u007f]/g, '_') || 'loomtv-media';
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${asciiName}"`;
}

function directCapabilityFileVersion(source) {
  const dev = Number(source?.fileId?.dev);
  const ino = Number(source?.fileId?.ino);
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) {
    throw playbackError('source_unavailable', 'The media source identity is unavailable.', 409);
  }
  return createHash('sha256')
    .update(String(source.sourceId || ''))
    .update('\0')
    .update(String(dev))
    .update('\0')
    .update(String(ino))
    .digest('base64url');
}

function parseRange(header, size) {
  if (!header || !header.startsWith('bytes=') || header.includes(',')) return null;
  const [startText, endText] = header.slice(6).split('-', 2);
  let start = startText ? Number(startText) : NaN;
  let end = endText ? Number(endText) : size - 1;
  if (!Number.isFinite(start)) {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return 'invalid';
  end = Math.min(end, size - 1);
  return { start, end };
}

function tokenFromRequest(req, url) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.headers['x-loom-admin-token'] || url.searchParams.get('token') || '';
}

function cancelledError() {
  return Object.assign(new Error('The media operation was cancelled.'), { code: 'operation_cancelled', status: 503 });
}

function playbackError(code, message, status = 503, details = {}) {
  return Object.assign(new Error(message), { code, status, retryable: status >= 500, ...details });
}

function publicPlaybackErrorCode(error) {
  if (['transcode_principal_limit', 'transcode_global_limit', 'transcode_cache_unavailable', 'transcode_cache_free_space_unknown', 'transcode_cache_quota', 'transcode_cache_free_space', 'playback_capacity_exceeded'].includes(error?.code)) return 'playback_capacity_exceeded';
  if (error?.code === 'media_probe_unavailable') return 'transcoder_unavailable';
  if (['profile_required', 'profile_locked', 'stale_profile_selection', 'source_unavailable', 'playback_not_supported', 'transcoder_unavailable', 'transcode_failed', 'playback_session_invalid', 'permission_denied', 'invalid_request'].includes(error?.code)) return error.code;
  return 'transcode_failed';
}

function optionalStreamIndex(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index > 65_535) {
    throw playbackError('invalid_request', `${field} must be a non-negative stream index.`, 400);
  }
  return index;
}

function subtitleKindForProbe(plan, probe) {
  const codec = probe?.tracks?.find((track) => track.id === plan.selectedSubtitleTrackId)?.codec;
  return ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'].includes(codec) ? 'text' : 'bitmap';
}

function externalSubtitleTracks(source) {
  return (Array.isArray(source?.subtitleSidecars) ? source.subtitleSidecars : []).slice(0, 64).map((sidecar, ordinal) => ({
    id: sidecar.id,
    index: 60_000 + ordinal,
    kind: 'subtitle',
    codec: sidecar.codec || sidecar.format,
    ...(sidecar.language ? { language: sidecar.language } : {}),
    ...(sidecar.title ? { title: sidecar.title } : {}),
    default: sidecar.default === true,
    forced: sidecar.forced === true,
    external: true,
  }));
}

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once?.('aborted', abort);
  res.once?.('close', abort);
  if (req.aborted) abort();
  return {
    signal: controller.signal,
    cleanup() {
      req.off?.('aborted', abort);
      res.off?.('close', abort);
    },
  };
}

async function waitForFile(rootPath, filePath, timeoutMs, options = {}) {
  const now = options.now || (() => Date.now());
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const signal = options.signal;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (signal?.aborted) throw cancelledError();
    try {
      const { stats } = await statContainedFile(rootPath, filePath);
      if (stats.size > 0) return true;
    } catch {
      // FFmpeg is still starting.
    }
    await new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => {
        clearTimeoutFn(timer);
        signal?.removeEventListener?.('abort', onAbort);
        reject(cancelledError());
      };
      timer = setTimeoutFn(() => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve();
      }, 100);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
  return false;
}

export function terminateChild(child, graceMs = PROCESS_TERM_GRACE_MS) {
  if (!child || child.exitCode != null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let killTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      child.off?.('exit', finish);
      child.off?.('close', finish);
      child.off?.('error', finish);
      resolve();
    };
    child.once?.('exit', finish);
    child.once?.('close', finish);
    child.once?.('error', finish);
    try { child.kill?.('SIGTERM'); } catch { /* the process may have exited between the check and kill */ }
    killTimer = setTimeout(() => {
      if (settled) return;
      try { child.kill?.('SIGKILL'); } catch { /* already gone */ }
      // A misbehaving child mock or platform process must not hold shutdown
      // forever after the escalation deadline.
      killTimer = setTimeout(finish, graceMs);
    }, graceMs);
  });
}

function normalizeProfile(input = {}, health) {
  const requestedPlayback = normalizePlaybackProfile(input);
  const mode = ['remux', 'transcode'].includes(input.mode) ? input.mode : 'transcode';
  const copyVideo = mode === 'remux' || input.copyVideo === true || input.copyVideo === '1';
  const copyAudio = input.copyAudio === true || input.copyAudio === '1';
  const burnSubtitles = input.burnSubtitles === true || input.burnSubtitles === '1';
  const selectedVideoTrackIndex = optionalStreamIndex(input.selectedVideoTrackIndex, 'selectedVideoTrackIndex');
  const selectedAudioTrackIndex = optionalStreamIndex(input.selectedAudioTrackIndex, 'selectedAudioTrackIndex');
  const selectedSubtitleTrackIndex = optionalStreamIndex(input.selectedSubtitleTrackIndex, 'selectedSubtitleTrackIndex');
  const selectedSubtitleTrackOrdinal = optionalStreamIndex(input.selectedSubtitleTrackOrdinal, 'selectedSubtitleTrackOrdinal');
  const subtitleFontSize = input.subtitleFontSize === undefined
    ? undefined : Math.max(1, Math.min(128, Math.round(Number(input.subtitleFontSize) || 0)));
  const requestedBackend = String(input.backend || 'auto').toLowerCase();
  const { codec } = requestedPlayback;
  const softwareAvailable = health.softwareCodecs?.[codec] === true;
  const hardwareBackends = (health.backends || []).filter((entry) => (
    entry.available && entry.codecs?.[codec]?.available
  ));
  const requestedHardware = requestedBackend !== 'auto'
    ? hardwareBackends.find((entry) => entry.id === requestedBackend)
    : null;
  const preferredHardware = hardwareBackends.find((entry) => entry.id === health.recommendedBackend)
    || hardwareBackends[0];
  let backend = requestedBackend === 'software'
    ? (softwareAvailable ? 'software' : null)
    : requestedHardware?.id || preferredHardware?.id || (softwareAvailable ? 'software' : null);
  if (copyVideo && !burnSubtitles) backend = 'copy';
  if (burnSubtitles) backend = softwareAvailable ? 'software' : null;
  if (!backend) throw playbackError('transcoder_unavailable', `FFmpeg cannot produce ${codec.toUpperCase()} on this host.`, 503);
  const toneMapRequested = requestedPlayback.toneMap;
  if (toneMapRequested && health.toneMapping !== true) {
    throw playbackError('playback_not_supported', 'This host cannot tone-map the selected HDR source.', 422);
  }
  return {
    mode, codec, copyVideo: copyVideo && !burnSubtitles, copyAudio,
    burnSubtitles,
    subtitleKind: input.subtitleKind === 'bitmap' ? 'bitmap' : 'text',
    selectedVideoTrackIndex,
    selectedAudioTrackIndex,
    selectedSubtitleTrackIndex,
    selectedSubtitleTrackOrdinal,
    subtitleFontSize,
    ...(typeof input.externalSubtitlePath === 'string' ? { externalSubtitlePath: input.externalSubtitlePath } : {}),
    ...(input.externalSubtitleFileId && typeof input.externalSubtitleFileId === 'object'
      ? { externalSubtitleFileId: { ...input.externalSubtitleFileId } } : {}),
    startSeconds: Math.max(0, Math.min(86_400, Number(input.startSeconds) || 0)),
    backend,
    maxWidth: requestedPlayback.maxWidth,
    maxHeight: requestedPlayback.maxHeight,
    videoBitrateKbps: requestedPlayback.videoBitrateKbps,
    audioBitrateKbps: requestedPlayback.audioBitrateKbps,
    toneMap: toneMapRequested && health.toneMapping === true,
    toneMapRequested,
    softwareFallbackAvailable: softwareAvailable,
    hardware: !['software', 'copy'].includes(backend),
  };
}

function scaleFilter(profile) {
  if (!profile.maxWidth && !profile.maxHeight) return null;
  return `scale=${profile.maxWidth || -2}:${profile.maxHeight || -2}:force_original_aspect_ratio=decrease`;
}

function toneMapFilter() {
  return 'zscale=transfer=linear:npl=100,format=gbrpf32le,tonemap=mobius,zscale=transfer=bt709:primaries=bt709:matrix=bt709,format=yuv420p';
}

function softwareEncoder(health, codec) {
  return health.softwareEncoders?.[codec] || 'libx264';
}

function ffmpegFilterPath(filePath) {
  return String(filePath).replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'");
}

function hardwareArgs(health, backend, codec, profile) {
  const entry = health.backends?.find((candidate) => candidate.id === backend);
  const encoder = backendEncoder(health, backend, codec);
  if (!entry || !encoder) return null;
  const beforeInput = [];
  if (backend === 'vaapi' && entry.device) beforeInput.push('-vaapi_device', entry.device);
  const filters = [];
  const scale = scaleFilter(profile);
  if (profile.toneMap) filters.push(toneMapFilter());
  if (scale) filters.push(scale);
  const hasFilters = filters.length > 0;
  const zeroCopy = !hasFilters && ['nvenc', 'qsv', 'vaapi'].includes(backend);
  if (zeroCopy && backend === 'nvenc') beforeInput.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  if (zeroCopy && backend === 'qsv') beforeInput.push('-init_hw_device', 'qsv=hw', '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
  if (zeroCopy && backend === 'vaapi') beforeInput.push('-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi');
  if (hasFilters && ['vaapi', 'qsv'].includes(backend)) filters.push('format=nv12,hwupload');
  return {
    encoder,
    beforeInput,
    filters: filters.length ? ['-vf', filters.join(',')] : [],
    zeroCopy,
    options: backend === 'nvenc'
      ? profile.videoBitrateKbps
        ? ['-preset', 'p4', '-b:v', `${profile.videoBitrateKbps}k`, '-maxrate', `${profile.videoBitrateKbps}k`, '-bufsize', `${profile.videoBitrateKbps * 2}k`]
        : ['-preset', 'p4', '-cq', '23', '-b:v', '0']
      : backend === 'qsv'
        ? profile.videoBitrateKbps
          ? ['-b:v', `${profile.videoBitrateKbps}k`, '-maxrate', `${profile.videoBitrateKbps}k`]
          : ['-global_quality', '23', '-look_ahead', '0']
        : backend === 'vaapi'
          ? profile.videoBitrateKbps ? ['-b:v', `${profile.videoBitrateKbps}k`] : ['-qp', '23']
          : backend === 'amf'
            ? profile.videoBitrateKbps
              ? ['-quality', 'balanced', '-b:v', `${profile.videoBitrateKbps}k`, '-maxrate', `${profile.videoBitrateKbps}k`]
              : ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23']
            : backend === 'rkmpp'
              ? profile.videoBitrateKbps ? ['-b:v', `${profile.videoBitrateKbps}k`] : ['-qp_init', '23']
              : ['-allow_sw', '1', '-realtime', '1', '-b:v', '6500k', '-maxrate', '8500k', '-bufsize', '12000k', '-profile:v', 'main'],
  };
}

function transcodeArgs(filePath, outputDir, health, profile) {
  const hardware = profile.hardware ? hardwareArgs(health, profile.backend, profile.codec, profile) : null;
  const seek = profile.startSeconds > 0 ? ['-ss', String(profile.startSeconds)] : [];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...seek, ...(hardware?.beforeInput || []), '-i', filePath];
  const videoMap = profile.selectedVideoTrackIndex === undefined ? '0:v:0?' : `0:${profile.selectedVideoTrackIndex}`;
  const audioMap = profile.selectedAudioTrackIndex === undefined ? null : `0:${profile.selectedAudioTrackIndex}`;
  if (profile.burnSubtitles && profile.selectedSubtitleTrackIndex !== undefined && profile.subtitleKind === 'bitmap') {
    const filters = [];
    if (profile.toneMap) filters.push(toneMapFilter());
    const scale = scaleFilter(profile);
    if (scale) filters.push(scale);
    const tail = filters.length ? `,${filters.join(',')}` : '';
    args.push('-filter_complex', `[${videoMap}][0:${profile.selectedSubtitleTrackIndex}]overlay${tail}[loomtv_video]`, '-map', '[loomtv_video]');
  } else {
    args.push('-map', videoMap);
  }
  if (audioMap) args.push('-map', audioMap);
  else args.push('-an');
  args.push('-sn', '-dn');
  if (profile.copyVideo) {
    args.push('-c:v', 'copy');
  } else if (hardware) {
    args.push(...hardware.filters, '-c:v', hardware.encoder, ...hardware.options);
  } else {
    const filters = [];
    if (profile.burnSubtitles && profile.selectedSubtitleTrackIndex !== undefined && profile.subtitleKind !== 'bitmap') {
      const subtitleInput = profile.externalSubtitlePath || filePath;
      const streamSelection = profile.externalSubtitlePath ? '' : `:si=${profile.selectedSubtitleTrackOrdinal || 0}`;
      filters.push(`subtitles='${ffmpegFilterPath(subtitleInput)}'${streamSelection}${profile.subtitleFontSize ? `:force_style='FontSize=${profile.subtitleFontSize}'` : ''}`);
    }
    if (profile.toneMap) filters.push(toneMapFilter());
    else filters.push('format=yuv420p');
    const scale = scaleFilter(profile);
    if (scale) filters.push(scale);
    if (!(profile.burnSubtitles && profile.subtitleKind === 'bitmap')) args.push('-vf', filters.join(','));
    args.push('-c:v', softwareEncoder(health, profile.codec));
    if (profile.codec === 'h264') args.push('-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p');
    if (profile.codec === 'hevc') args.push('-preset', 'medium', '-crf', '28', '-pix_fmt', 'yuv420p');
    if (profile.codec === 'av1') args.push('-preset', '8', '-crf', '32', '-pix_fmt', 'yuv420p');
    if (profile.videoBitrateKbps) args.push('-b:v', `${profile.videoBitrateKbps}k`, '-maxrate', `${profile.videoBitrateKbps}k`, '-bufsize', `${profile.videoBitrateKbps * 2}k`);
  }
  // LAN playback favors a short startup while retaining enough runway for
  // normal network jitter. The client keeps a smaller local buffer profile;
  // this headless service is the stable two-second LAN profile.
  if (audioMap) {
    if (profile.copyAudio) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', `${profile.audioBitrateKbps}k`, '-ac', '2');
  }
  args.push('-f', 'hls', '-hls_time', '2', '-hls_list_size', '45', '-hls_flags', 'delete_segments+independent_segments', '-hls_segment_filename', path.join(outputDir, 'segment-%05d.ts'), path.join(outputDir, 'index.m3u8'));
  return args;
}

export function createHeadlessMediaService({
  adminService,
  clientState,
  transcoder,
  cacheDir,
  authorize,
  clock = {},
  playbackSessionRegistry,
  playbackSessionOptions = {},
  transcodeAdmission,
  transcodeAdmissionOptions = {},
  cacheQuotaOptions = {},
  transcodeQuotaOptions = {},
  cacheFileSystem,
  spawnProcess = spawn,
  clientAddress,
  remotePolicy,
} = {}) {
  const sessions = new Map();
  const transcodePlans = new Map();
  const configuredCacheDir = path.resolve(cacheDir);

  async function resolveBoundPrincipal(principalId, profile) {
    if (profile?.invitationSessionId && remotePolicy?.resolveInvitationPrincipal) {
      return remotePolicy.resolveInvitationPrincipal(profile.invitationSessionId);
    }
    return adminService.getPrincipalById?.(principalId);
  }

  async function requireBoundProfile(principal, profileContext, media) {
    if (principal?.authentication === 'invitation-session' && remotePolicy?.invitationProfileContext) {
      return remotePolicy.invitationProfileContext(principal, media);
    }
    return clientState.requireActivePlaybackProfile(principal.id, profileContext?.deviceId, media);
  }
  const root = path.join(configuredCacheDir, 'headless-transcodes');
  const now = typeof clock.now === 'function' ? clock.now : () => Date.now();
  const setTimeoutFn = typeof clock.setTimeout === 'function' ? clock.setTimeout : setTimeout;
  const clearTimeoutFn = typeof clock.clearTimeout === 'function' ? clock.clearTimeout : clearTimeout;
  const setIntervalFn = typeof clock.setInterval === 'function' ? clock.setInterval : setInterval;
  const clearIntervalFn = typeof clock.clearInterval === 'function' ? clock.clearInterval : clearInterval;
  const ownsPlaybackRegistry = !playbackSessionRegistry;
  const ownsAdmission = !transcodeAdmission;
  const cleanupTasks = new Set();
  let stopping = false;
  let stopPromise;
  let reconciliationPromise = null;
  let quotaSweepPromise = null;
  const cacheQuota = createTranscodeCacheQuota({
    ...transcodeQuotaOptions,
    ...cacheQuotaOptions,
    rootPath: root,
    now,
    ...(cacheFileSystem ? { fileSystem: cacheFileSystem } : {}),
  });
  let quotaSweepTimer = null;

  function trackCleanup(task) {
    if (!task || typeof task.then !== 'function') return task;
    cleanupTasks.add(task);
    task.finally(() => cleanupTasks.delete(task)).catch(() => undefined);
    return task;
  }

  let playbackRegistry;
  const registryOptions = {
    ...playbackSessionOptions,
    now,
    onRevoke: (entry, reason) => {
      const session = sessions.get(entry.id);
      if (session && !session.cleanupStarting) trackCleanup(cleanupSession(session, { revokeRegistry: false, reason }));
    },
  };
  playbackRegistry = playbackSessionRegistry || createPlaybackSessionRegistry(registryOptions);
  const admission = transcodeAdmission || createTranscodeAdmission(transcodeAdmissionOptions);

  /**
   * Transcode output is a media decision point too: every segment this service
   * later serves is written here. Creating the directory and then proving the
   * created directory still resolves inside the cache root stops a symlinked
   * `headless-transcodes` from redirecting FFmpeg's writes outside it.
   */
  async function ensureTranscodeRoot() {
    await fsPromises.mkdir(root, { recursive: true });
    const cacheRoot = await resolveContainedPath(configuredCacheDir, configuredCacheDir);
    const verified = await resolveContainedPath(cacheRoot.realPath, root);
    return verified.realPath;
  }

  async function reconcileOrphanedTranscodes() {
    if (reconciliationPromise) return reconciliationPromise;
    reconciliationPromise = (async () => {
      let transcodeRoot;
      try {
        transcodeRoot = await resolveContainedPath(configuredCacheDir, root);
      } catch {
        return 0;
      }
      const active = new Set([...sessions.values()]
        .filter((session) => !session.cleaned)
        .map((session) => path.resolve(session.outputDir)));
      const entries = await fsPromises.readdir(transcodeRoot.realPath, { withFileTypes: true }).catch(() => []);
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(transcodeRoot.realPath, entry.name);
        if (active.has(path.resolve(candidate))) continue;
        try {
          const verified = await resolveContainedPath(configuredCacheDir, candidate);
          await fsPromises.rm(verified.realPath, { recursive: true, force: true });
          removed += 1;
        } catch {
          // An escaped or replaced orphan is left in place rather than turning
          // reconciliation into a deletion primitive outside the cache root.
        }
      }
      return removed;
    })().finally(() => { reconciliationPromise = null; });
    return reconciliationPromise;
  }

  async function enforceCacheQuota() {
    if (stopping) return null;
    if (quotaSweepPromise) return quotaSweepPromise;
    quotaSweepPromise = (async () => {
      await reconcileOrphanedTranscodes();
      const current = await cacheQuota.status();
      const sessionsByAge = [...sessions.values()]
        .filter((session) => !session.cleaned)
        .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
      const oversized = sessionsByAge.filter((session) => (current.sessionBytes.get(session.id) || 0) > cacheQuota.maxSessionBytes);
      const cleanup = new Set(oversized);
      if (current.totalBytes + current.reservedBytes >= cacheQuota.maxTotalBytes
        || (current.freeBytes !== null && current.freeBytes < cacheQuota.minFreeBytes)
        || (current.freeBytes === null && cacheQuota.minFreeBytes > 0)) {
        for (const session of sessionsByAge) cleanup.add(session);
      }
      for (const session of cleanup) {
        trackCleanup(cleanupSession(session, { reason: 'transcode_quota_exceeded' }));
      }
      return current;
    })().catch(() => null).finally(() => { quotaSweepPromise = null; });
    return quotaSweepPromise;
  }

  async function enforceSessionQuota(session) {
    try {
      const current = await cacheQuota.sessionBytes(session.id);
      const exceeded = current.bytes > cacheQuota.maxSessionBytes
        || current.totalBytes + (cacheQuota.snapshot().reservedBytes || 0) >= cacheQuota.maxTotalBytes
        || (current.freeBytes !== null && current.freeBytes < cacheQuota.minFreeBytes)
        || (current.freeBytes === null && cacheQuota.minFreeBytes > 0);
      if (!exceeded) return true;
    } catch {
      // A quota check that cannot inspect the cache is a failed admission, not
      // permission to continue serving an unbounded output directory.
    }
    trackCleanup(cleanupSession(session, { reason: 'transcode_quota_exceeded' }));
    return false;
  }

  function startQuotaSweeper() {
    if (cacheQuota.sweepIntervalMs <= 0) return;
    quotaSweepTimer = setIntervalFn(() => { void enforceCacheQuota(); }, cacheQuota.sweepIntervalMs);
    quotaSweepTimer?.unref?.();
  }

  function touchTranscodeSession(session, touchOptions = {}) {
    const touched = playbackRegistry.touch(session.registryId || session.id, now(), touchOptions);
    if (touched) session.lastActivityAt = touched.lastActivityAt;
    return touched;
  }

  startQuotaSweeper();
  // Populate the internal snapshot on startup. Public health reads the
  // cached value and never triggers an unbounded filesystem scan itself.
  void enforceCacheQuota();

  function issuePlaybackToken(itemId, userId, action, profileContext = null) {
    if (stopping) throw Object.assign(new Error('The media service is shutting down.'), { status: 503, code: 'server_draining' });
    if (action === 'download') throw playbackError('download_not_allowed', 'Offline downloads require a persistent download lease.', 410);
    const session = playbackRegistry.create({
      itemId,
      principalId: userId,
      action,
      profile: profileContext ? {
        profileId: profileContext.profileId,
        deviceId: profileContext.deviceId,
        selectionRevision: profileContext.selectionRevision,
        ...(profileContext.authenticationSessionId ? { authenticationSessionId: profileContext.authenticationSessionId } : {}),
        ...(profileContext.invitationSessionId ? { invitationSessionId: profileContext.invitationSessionId } : {}),
        remoteAccess: profileContext.remoteAccess === true,
        ...(profileContext.sourceId ? { sourceId: profileContext.sourceId } : {}),
        ...(profileContext.fileId ? { fileId: { ...profileContext.fileId } } : {}),
        ...(profileContext.externalSubtitleTrackId ? { externalSubtitleTrackId: profileContext.externalSubtitleTrackId } : {}),
        ...(profileContext.externalSubtitleFileId ? { externalSubtitleFileId: { ...profileContext.externalSubtitleFileId } } : {}),
      } : null,
      idleTimeoutMs: MEDIA_TOKEN_TTL_MS,
      absoluteTimeoutMs: SESSION_TTL_MS,
    });
    return {
      token: session.token,
      sessionId: session.id,
      expiresAt: session.expiresAt,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  async function authorizePlaybackToken(token, url, permission, req) {
    const expectedAction = permission === 'downloads' ? 'download' : 'direct';
    const itemId = url.searchParams.get('itemId');
    const entry = playbackRegistry.authorize(token, {
      ...(itemId ? { itemId } : {}),
      action: expectedAction,
    });
    if (!entry) return null;
    const principal = await resolveBoundPrincipal(entry.principalId, entry.profile);
    if (!principal) return null;
    try { remotePolicy?.assertPrincipal?.(req, principal, 'media'); } catch { return null; }
    if (entry.profile?.profileId && clientState?.requireActivePlaybackProfile) {
      try {
        const media = await adminService.resolveMediaPath(entry.itemId, principal, entry.profile.sourceId);
        const current = await requireBoundProfile(principal, entry.profile, media);
        if (current.profileId !== entry.profile.profileId || current.selectionRevision !== entry.profile.selectionRevision) return null;
      } catch { return null; }
    }
    const permitted = typeof adminService.authorizePrincipal === 'function'
      ? await adminService.authorizePrincipal(principal, permission)
      : await authorize({ headers: { authorization: `Bearer ${token}` } }, permission);
    return permitted ? { ok: true, principal, playbackSession: entry } : null;
  }

  async function authorizedFor(req, url, permission, capabilityOnly = false) {
    const headerToken = req.headers.authorization || req.headers['x-loom-admin-token'] || '';
    const queryToken = url.searchParams.get('token') || '';
    if (capabilityOnly) {
      if (!queryToken) return { ok: false, status: 401 };
      const playback = await authorizePlaybackToken(queryToken, url, permission, req);
      return playback || { ok: false, status: 401 };
    }
    if (!headerToken && queryToken) {
      const playback = await authorizePlaybackToken(queryToken, url, permission, req);
      if (playback) return playback;
    }
    const token = tokenFromRequest(req, url);
    if (!token) return { ok: false, status: 401 };
    const authenticatedRequest = {
      ...req,
      headers: { ...req.headers, authorization: `Bearer ${token}` },
    };
    const principal = await adminService.authenticateRequest(authenticatedRequest);
    if (!principal) return { ok: false, status: 401 };
    const permitted = typeof adminService.authorizePrincipal === 'function'
      ? await adminService.authorizePrincipal(principal, permission)
      : await authorize(authenticatedRequest, permission);
    return permitted ? { ok: true, principal } : { ok: false, status: 403, principal };
  }

  async function cleanupSession(session, { revokeRegistry = true, reason = 'revoked', termGraceMs = PROCESS_TERM_GRACE_MS } = {}) {
    if (!session) return;
    if (session.cleanupPromise) return session.cleanupPromise;
    session.cleaned = true;
    session.abortController?.abort();
    session.cleanupStarting = true;
    try {
      if (revokeRegistry) playbackRegistry.revoke(session.registryId || session.id, reason, now());
    } finally {
      session.cleanupStarting = false;
    }
    session.cleanupPromise = Promise.resolve().then(async () => {
      try {
        await terminateChild(session.process, termGraceMs);
        sessions.delete(session.id);
        const permit = session.permit;
        session.permit = null;
        permit?.release?.();
        // Never let a replaced session directory redefine the deletion root.
        // Resolve it against the configured cache immediately before removal; an
        // escaped or already-missing path is deliberately left alone.
        await resolveContainedPath(configuredCacheDir, session.outputDir)
          .then(({ realPath }) => fsPromises.rm(realPath, { recursive: true, force: true }))
          .catch(() => undefined);
      } finally {
        cacheQuota.release(session.quotaReservationId || session.id);
      }
    });
    return session.cleanupPromise;
  }

  async function startProcess(session, profile) {
    // FFmpeg opens both paths by name. Recheck the authorized input identity
    // and anchor the output to the configured cache at the last async boundary
    // before spawn, including hardware-to-software fallback attempts.
    const input = await statContainedFile(session.mediaRootPath, session.filePath, { expectedFileId: session.fileId });
    const output = await resolveContainedPath(configuredCacheDir, session.outputDir);
    session.filePath = input.realPath;
    session.outputDir = output.realPath;
    session.backend = profile.backend;
    session.profile = profile;
    session.stderr = '';
    if (session.cleaned || stopping) throw cancelledError();
    const child = spawnProcess(transcoder.path, transcodeArgs(session.filePath, session.outputDir, transcoder.getHealth(), profile), { stdio: ['ignore', 'ignore', 'pipe'] });
    session.process = child;
    child.stderr?.on('data', (chunk) => {
      session.stderr = `${session.stderr}${chunk.toString()}`.slice(-4000);
    });
    child.once('error', (error) => {
      session.error = error instanceof Error ? error.message : String(error);
    });
    child.once('exit', (code) => {
      session.exitCode = code;
      if (session.process === child) session.process = null;
      if (session.cleaned || stopping) return;
      if (code === 0) {
        const permit = session.permit;
        session.permit = null;
        permit?.release?.();
        return;
      }
      if (session.ready) {
        admission.recordFailure?.();
        trackCleanup(cleanupSession(session, { reason: 'transcode_failed' }));
        return;
      }
      if (code !== 0 && !session.ready && profile.hardware && profile.softwareFallbackAvailable && !session.fallbackAttempted) {
        session.fallbackAttempted = true;
        void resolveContainedPath(configuredCacheDir, session.outputDir)
          .then(({ realPath }) => fsPromises.rm(realPath, { recursive: true, force: true }))
          .then(async () => {
            if (session.cleaned || stopping) throw cancelledError();
            await resolveContainedPath(configuredCacheDir, session.outputDir, { allowMissing: true });
            await fsPromises.mkdir(session.outputDir, { recursive: true });
            const containedOutput = (await resolveContainedPath(configuredCacheDir, session.outputDir)).realPath;
            if (session.cleaned || stopping) {
              await fsPromises.rm(containedOutput, { recursive: true, force: true }).catch(() => undefined);
              throw cancelledError();
            }
            session.outputDir = containedOutput;
          })
          .then(() => startProcess(session, { ...profile, backend: 'software', hardware: false }))
          .catch((error) => {
            session.error = error instanceof Error ? error.message : String(error);
            if (['operation_cancelled', 'server_draining'].includes(error?.code)) admission.recordCancelled?.();
            else admission.recordFailure?.();
            trackCleanup(cleanupSession(session, { reason: 'transcode_failed' }));
          });
      } else {
        session.failureError = profile.hardware && !profile.softwareFallbackAvailable
          ? playbackError('playback_capacity_exceeded', 'The hardware encoder failed and no software fallback is available.', 503)
          : playbackError('transcode_failed', 'FFmpeg could not produce the requested playback stream.', 502);
        session.error ||= session.failureError.message;
        admission.recordFailure?.();
        trackCleanup(cleanupSession(session, { reason: 'transcode_failed' }));
      }
    });
    return child;
  }

  async function startTranscode(itemId, requestedProfile = {}, principal, requestSignal = null) {
    if (stopping) throw Object.assign(new Error('The media service is shutting down.'), { status: 503, code: 'server_draining' });
    if (requestedProfile.planToken) {
      const stored = transcodePlans.get(requestedProfile.planToken);
      transcodePlans.delete(requestedProfile.planToken);
      if (!stored || stored.expiresAt <= now() || stored.itemId !== itemId || stored.principalId !== principal.id) {
        throw playbackError('playback_session_invalid', 'The playback plan is expired or does not belong to this account.', 401);
      }
      requestedProfile = { ...stored.execution, profileContext: stored.profileContext };
    } else if (requestedProfile.canonicalPlanRequired) {
      throw playbackError('playback_session_invalid', 'A server-issued playback plan is required.', 401);
    }
    const item = await adminService.resolveMediaPath(itemId, principal, requestedProfile.sourceId);
    if (requestedProfile.expectedFileId
      && (item.fileId?.dev !== requestedProfile.expectedFileId.dev || item.fileId?.ino !== requestedProfile.expectedFileId.ino)) {
      throw playbackError('source_unavailable', 'The media source changed after the playback plan was created.', 409);
    }
    if (requestedProfile.profileContext && clientState?.requireActivePlaybackProfile) {
      const current = await requireBoundProfile(principal, requestedProfile.profileContext, item);
      if (current.profileId !== requestedProfile.profileContext.profileId
        || current.selectionRevision !== requestedProfile.profileContext.selectionRevision) {
        throw playbackError('stale_profile_selection', 'The selected playback profile has changed.', 409);
      }
      requestedProfile.profileContext = { ...requestedProfile.profileContext, ...current };
    } else if (requestedProfile.profileId && clientState?.requireActivePlaybackProfile) {
      const current = await clientState.requireActivePlaybackProfile(principal.id, requestedProfile.deviceId, item);
      if (current.profileId !== requestedProfile.profileId
        || current.selectionRevision !== Number(requestedProfile.selectionRevision)) {
        throw playbackError('stale_profile_selection', 'The selected playback profile has changed.', 409);
      }
      requestedProfile.profileContext = current;
    } else if (clientState?.requireActivePlaybackProfile) {
      throw playbackError('profile_required', 'An active profile is required for playback.', 409);
    }
    if (!transcoder.path) throw playbackError('transcoder_unavailable', 'FFmpeg is not available on this host.', 503);
    // FFmpeg reopens the input by name, so the strongest check available here
    // is to prove — immediately before the spawn — that the name still
    // resolves inside the root to the same file authorization saw.
    const verified = await statContainedFile(item.rootPath, item.path, { expectedFileId: item.fileId });
    if (requestedProfile.externalSubtitlePath) {
      if (path.dirname(requestedProfile.externalSubtitlePath) !== path.dirname(item.path)) {
        throw playbackError('source_unavailable', 'The external subtitle is no longer beside this video.', 409);
      }
      const subtitle = await statContainedFile(item.rootPath, requestedProfile.externalSubtitlePath, {
        expectedFileId: requestedProfile.externalSubtitleFileId,
      });
      requestedProfile.externalSubtitlePath = subtitle.realPath;
      requestedProfile.externalSubtitleFileId = subtitle.fileId;
    }
    // Establish and validate the output root before profile selection or
    // queueing. This keeps containment failures deterministic and prevents
    // queued requests from creating untracked output directories.
    await reconcileOrphanedTranscodes();
    const transcodeRoot = await ensureTranscodeRoot();
    const health = transcoder.getHealth();
    const profile = normalizeProfile(requestedProfile, health);
    await cacheQuota.checkAdmission();
    const permit = await admission.acquire(principal, { signal: requestSignal });
    let session;
    let createdOutputDir = null;
    let quotaReservationId = null;
    let detachRequestAbort = null;
    try {
      if (stopping || requestSignal?.aborted) throw cancelledError();
      const id = randomUUID();
      quotaReservationId = id;
      await cacheQuota.reserve(id, principal.id);
      const outputDir = path.join(transcodeRoot, id);
      const registrySession = playbackRegistry.create({
        id,
        principalId: principal.id,
        principalType: principal.type,
        itemId,
        action: 'hls',
        profile: requestedProfile.profileContext ? {
          profileId: requestedProfile.profileContext.profileId,
          deviceId: requestedProfile.profileContext.deviceId,
          selectionRevision: requestedProfile.profileContext.selectionRevision,
          ...(requestedProfile.profileContext.authenticationSessionId
            ? { authenticationSessionId: requestedProfile.profileContext.authenticationSessionId } : {}),
          ...(requestedProfile.profileContext.invitationSessionId
            ? { invitationSessionId: requestedProfile.profileContext.invitationSessionId } : {}),
          remoteAccess: requestedProfile.profileContext.remoteAccess === true,
          sourceId: item.sourceId,
        } : null,
        idleTimeoutMs: HLS_NO_CLIENT_GRACE_MS,
        // Segment/playlist requests already touch the lease. Once a client
        // stops making requests, reclaim the FFmpeg process after the same
        // short idle boundary used by direct playback; the absolute cap stays
        // independent and non-renewable.
        activeIdleTimeoutMs: MEDIA_TOKEN_TTL_MS,
        absoluteTimeoutMs: HLS_ABSOLUTE_TIMEOUT_MS,
      });
      session = {
        id,
        registryId: registrySession.id,
        itemId,
        sourceId: item.sourceId,
        userId: principal.id,
        mediaRootPath: verified.rootRealPath,
        filePath: verified.realPath,
        fileId: verified.fileId,
        outputDir,
        backend: profile.backend,
        profile,
        playbackProfile: requestedProfile.profileContext ? {
          profileId: requestedProfile.profileContext.profileId,
          deviceId: requestedProfile.profileContext.deviceId,
          selectionRevision: requestedProfile.profileContext.selectionRevision,
          ...(requestedProfile.profileContext.invitationSessionId
            ? { invitationSessionId: requestedProfile.profileContext.invitationSessionId } : {}),
        } : null,
        token: registrySession.token,
        createdAt: registrySession.createdAt,
        lastActivityAt: registrySession.lastActivityAt,
        ready: false,
        fallbackAttempted: false,
        cleaned: false,
        permit,
        quotaReservationId,
        abortController: new AbortController(),
      };
      if (requestSignal) {
        if (requestSignal.aborted) throw cancelledError();
        const onAbort = () => session.abortController.abort();
        requestSignal.addEventListener('abort', onAbort, { once: true });
        detachRequestAbort = () => requestSignal.removeEventListener('abort', onAbort);
      }
      sessions.set(id, session);
      if (session.cleaned || stopping) throw cancelledError();
      await resolveContainedPath(configuredCacheDir, outputDir, { allowMissing: true });
      await fsPromises.mkdir(outputDir, { recursive: true });
      const containedOutputDir = (await resolveContainedPath(configuredCacheDir, outputDir)).realPath;
      createdOutputDir = containedOutputDir;
      session.outputDir = containedOutputDir;
      if (session.cleaned || stopping) {
        // Shutdown/revocation can win the race with mkdir. Cleanup may already
        // have completed before the directory became visible, so remove this
        // newly-created path at the same boundary before reporting cancellation.
        await fsPromises.rm(containedOutputDir, { recursive: true, force: true }).catch(() => undefined);
        throw cancelledError();
      }
      await startProcess(session, profile);
      const playlistPath = path.join(session.outputDir, 'index.m3u8');
      let playlistReady;
      try {
        playlistReady = await waitForFile(configuredCacheDir, playlistPath, PLAYLIST_WAIT_MS, {
          now,
          setTimeout: setTimeoutFn,
          clearTimeout: clearTimeoutFn,
          signal: session.abortController.signal,
        });
      } catch (error) {
        throw session.failureError || error;
      }
      if (!playlistReady) throw session.failureError
        || playbackError('transcode_failed', 'FFmpeg did not produce the requested playback stream.', 502);
      session.ready = true;
      const base = `/api/media/transcode/${encodeURIComponent(id)}/index.m3u8`;
      return {
        sessionId: id,
        playlistUrl: `${base}?token=${encodeURIComponent(session.token)}`,
        renewUrl: `/api/v1/media/${encodeURIComponent(itemId)}/transcode/renew`,
        backend: session.backend,
        codec: session.profile.codec,
        profile: session.profile,
        expiresAt: registrySession.expiresAt,
        absoluteExpiresAt: registrySession.absoluteExpiresAt,
        fallback: session.backend === 'software' && profile.backend !== 'software',
      };
    } catch (error) {
      detachRequestAbort?.();
      if (session) await cleanupSession(session, { reason: 'transcode_failed' });
      else {
        permit.release();
        cacheQuota.release(quotaReservationId);
        if (createdOutputDir) await fsPromises.rm(createdOutputDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (['operation_cancelled', 'transcode_request_cancelled', 'transcode_admission_closed', 'server_draining'].includes(error?.code)) admission.recordCancelled?.();
      else admission.recordFailure?.();
      throw error;
    } finally {
      detachRequestAbort?.();
    }
  }

  async function planPlayback(itemId, request = {}, principal, profileContext = null) {
    const catalogItem = await adminService.getLibraryItem?.(itemId, principal);
    if (!catalogItem) throw playbackError('media_not_found', 'Media item was not found.', 404);
    let source;
    try {
      source = await adminService.resolveMediaPath(itemId, principal, request.sourceId);
    } catch (error) {
      if (error?.code === 'permission_denied') throw error;
      throw playbackError(
        error?.code === 'EACCES' ? 'media_source_unreadable' : 'source_unavailable',
        'The selected media source is not currently readable.', 409,
        { sourceState: error?.code === 'EACCES' ? 'unreadable' : 'offline' },
      );
    }
    if (clientState?.requireActivePlaybackProfile) {
      const current = await requireBoundProfile(principal, profileContext, source);
      if (!profileContext || current.profileId !== profileContext.profileId
        || current.selectionRevision !== profileContext.selectionRevision) {
        throw playbackError('stale_profile_selection', 'The selected playback profile has changed.', 409);
      }
    }
    const sourceId = String(source.sourceId || catalogItem.sourceId || `${itemId}:primary`);
    let probe;
    try {
      probe = await transcoder.probeMedia(source.path, { sourceId });
      await adminService.recordMediaProbe?.(itemId, sourceId, probe).catch(() => undefined);
    } catch (error) {
      const cacheMatches = source.localMetadata?.sourceId === sourceId
        && Array.isArray(source.localMetadata?.tracks)
        && source.recordedSizeBytes === source.sizeBytes
        && Math.abs(Number(source.recordedModifiedAtMs) - Number(source.modifiedAtMs)) < 1;
      if (!cacheMatches) throw error;
      probe = { ...source.localMetadata, sourceId };
    }
    const sidecarTracks = externalSubtitleTracks(source);
    if (sidecarTracks.length) {
      const sidecarIds = new Set(sidecarTracks.map((track) => track.id));
      probe = {
        ...probe,
        tracks: [...(probe.tracks || []).filter((track) => !sidecarIds.has(track.id)), ...sidecarTracks],
        adapterGaps: (probe.adapterGaps || []).filter((gap) => gap !== 'external_sidecar_subtitles'),
      };
    }
    let plan = playbackPlanForMedia({ ...probe, sourceId, sourceState: 'online' }, request.capabilities || {}, request);
    if (plan.toneMap && transcoder.getHealth().toneMapping !== true) {
      throw playbackError('playback_not_supported', 'This host cannot tone-map the selected HDR source.', 422);
    }
    const selectedSidecar = plan.selectedSubtitleTrackId
      ? (source.subtitleSidecars || []).find((sidecar) => sidecar.id === plan.selectedSubtitleTrackId)
      : null;
    if (selectedSidecar && selectedSidecar.format !== 'vtt' && plan.sourceAction === 'direct') {
      plan = playbackPlanForMedia(
        { ...probe, sourceId, sourceState: 'online' },
        { ...(request.capabilities || {}), subtitleModes: ['burn-in'] },
        request,
      );
    }
    let externalSubtitle = null;
    if (selectedSidecar) {
      if (path.dirname(selectedSidecar.path) !== path.dirname(source.path)) {
        throw playbackError('source_unavailable', 'The external subtitle is no longer beside this video.', 409);
      }
      const verifiedSubtitle = await statContainedFile(source.rootPath, selectedSidecar.path);
      externalSubtitle = {
        trackId: selectedSidecar.id,
        path: verifiedSubtitle.realPath,
        fileId: verifiedSubtitle.fileId,
        format: selectedSidecar.format,
      };
    }
    return { item: catalogItem, probe, plan, sourceIdentity: { fileId: source.fileId }, externalSubtitle };
  }

  async function describeDirectCapability(itemId, principal, profileContext, sourceId = undefined) {
    const source = await adminService.resolveMediaPath(itemId, principal, sourceId);
    if (clientState?.requireActivePlaybackProfile) {
      const current = await requireBoundProfile(principal, profileContext, source);
      if (!profileContext || current.profileId !== profileContext.profileId
        || current.selectionRevision !== profileContext.selectionRevision) {
        throw playbackError('stale_profile_selection', 'The selected playback profile has changed.', 409);
      }
    }
    return {
      sourceId: source.sourceId,
      fileVersion: directCapabilityFileVersion(source),
    };
  }

  async function serveDirectCapability(req, res, {
    itemId, principal, profileContext, sourceId, fileVersion,
  }) {
    const source = await adminService.resolveMediaPath(itemId, principal, sourceId);
    if (directCapabilityFileVersion(source) !== fileVersion) {
      return json(res, 409, { ok: false, error: 'source_unavailable', message: 'The media source changed.' });
    }
    if (clientState?.requireActivePlaybackProfile) {
      const current = await requireBoundProfile(principal, profileContext, source);
      if (!profileContext || current.profileId !== profileContext.profileId
        || current.selectionRevision !== profileContext.selectionRevision) {
        return json(res, 409, { ok: false, error: 'stale_profile_selection' });
      }
    }
    if (!DIRECT_EXTENSIONS.has(path.extname(source.path).toLowerCase())) {
      return json(res, 415, { ok: false, error: 'direct_stream_not_supported', message: 'Start an HLS transcode for this media type.' });
    }
    return serveFile(req, res, source.rootPath, source.path, mimeFor(source.path), true, {}, source.fileId);
  }

  async function serveExternalSubtitleCapability(req, res, { itemId, trackId, token }) {
    const authorizationUrl = new URL(`http://loomtv.local/subtitle?itemId=${encodeURIComponent(itemId)}`);
    const authorization = await authorizePlaybackToken(token, authorizationUrl, 'stream', req);
    if (!authorization?.ok || authorization.playbackSession?.itemId !== itemId) {
      return json(res, 401, { ok: false, error: 'playback_session_invalid' });
    }
    const binding = authorization.playbackSession.profile;
    if (!binding?.externalSubtitleTrackId || binding.externalSubtitleTrackId !== trackId || !binding.externalSubtitleFileId) {
      return json(res, 401, { ok: false, error: 'playback_session_invalid' });
    }
    const source = await adminService.resolveMediaPath(itemId, authorization.principal, binding.sourceId);
    const sidecar = (source.subtitleSidecars || []).find((entry) => entry.id === trackId);
    if (!sidecar || path.dirname(sidecar.path) !== path.dirname(source.path)) {
      return json(res, 404, { ok: false, error: 'source_unavailable' });
    }
    return serveFile(req, res, source.rootPath, sidecar.path, mimeFor(sidecar.path), false, {}, binding.externalSubtitleFileId,
      () => playbackRegistry.touch(authorization.playbackSession.id, now()));
  }

  async function serveOfflineDownload(req, res, authorization) {
    const { lease, source } = authorization || {};
    if (!lease || !source) return json(res, 401, { ok: false, error: 'session_expired' });
    return serveFile(req, res, source.rootPath, source.path, 'application/octet-stream', true,
      { 'Content-Disposition': downloadDisposition(source.path) }, source.fileId);
  }

  function issueTranscodePlan(itemId, principalId, plan, probe, request, profileContext, sourceIdentity = null) {
    const token = randomUUID();
    const cutoff = now() - MEDIA_TOKEN_TTL_MS;
    for (const [id, entry] of transcodePlans) if (entry.createdAt < cutoff) transcodePlans.delete(id);
    while (transcodePlans.size >= 4_096) transcodePlans.delete(transcodePlans.keys().next().value);
    transcodePlans.set(token, {
      itemId, principalId, createdAt: now(), expiresAt: now() + MEDIA_TOKEN_TTL_MS,
      profileContext,
      execution: {
        sourceId: plan.sourceId, mode: plan.mode, codec: plan.codec, backend: 'auto',
        copyVideo: plan.copyVideo, copyAudio: plan.copyAudio, burnSubtitles: plan.burnSubtitles,
        selectedVideoTrackIndex: plan.selectedVideoTrackIndex,
        selectedAudioTrackIndex: plan.selectedAudioTrackIndex,
        selectedSubtitleTrackIndex: plan.selectedSubtitleTrackIndex,
        selectedSubtitleTrackOrdinal: plan.selectedSubtitleTrackOrdinal,
        subtitleFontSize: plan.subtitleFontSize,
        subtitleKind: plan.selectedSubtitleTrackId ? subtitleKindForProbe(plan, probe) : undefined,
        ...(request.externalSubtitle ? {
          externalSubtitlePath: request.externalSubtitle.path,
          externalSubtitleFileId: request.externalSubtitle.fileId,
        } : {}),
        maxWidth: plan.maxWidth, maxHeight: plan.maxHeight,
        videoBitrateKbps: plan.videoBitrateKbps, audioBitrateKbps: plan.audioBitrateKbps,
        toneMap: plan.toneMap, startSeconds: request.startSeconds,
        expectedFileId: sourceIdentity?.fileId,
      },
    });
    return { token, expiresAt: now() + MEDIA_TOKEN_TTL_MS };
  }

  /**
   * Serve a file that has been proven to live inside `rootPath`.
   *
   * The response body comes from the descriptor `openContainedFile` returned,
   * not from a second open by name, so the size in the headers and the bytes on
   * the wire are the same file — even if the path is replaced mid-response.
   */
  async function serveFile(req, res, rootPath, filePath, contentType, allowRange = false, extraHeaders = {}, expectedFileId = null, onSuccess = null) {
    let opened;
    try {
      opened = await openContainedFile(rootPath, filePath, { expectedFileId });
    } catch (error) {
      // A containment failure is reported as such; everything else stays the
      // indistinguishable 404 this route has always returned for a file that
      // is simply not there.
      if (error?.code === 'media_path_escape') return json(res, 403, { ok: false, error: 'media_path_escape' });
      if (error?.code === 'media_path_substituted') return json(res, 409, { ok: false, error: 'media_path_substituted' });
      return json(res, 404, { ok: false, error: 'not_found' });
    }
    const { handle, stats } = opened;
    const closeHandle = () => { void handle.close().catch(() => undefined); };
    const pipeFrom = (streamOptions) => {
      const stream = handle.createReadStream({ autoClose: false, ...streamOptions });
      stream.once('error', () => { if (!res.destroyed) res.destroy(); });
      stream.once('close', closeHandle);
      res.once('close', closeHandle);
      return stream.pipe(res);
    };
    if (!allowRange) {
      onSuccess?.();
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stats.size, 'Cache-Control': 'no-store', ...(res.__loomtvPublicApi ? { 'X-LoomTV-API-Version': '1' } : {}), ...extraHeaders });
      if (req.method === 'HEAD') { closeHandle(); return res.end(); }
      return pipeFrom({});
    }
    const range = parseRange(req.headers.range, stats.size);
    if (range === 'invalid') {
      closeHandle();
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}`, ...(res.__loomtvPublicApi ? { 'X-LoomTV-API-Version': '1' } : {}) });
      return res.end();
    }
    const start = range?.start || 0;
    const end = range?.end ?? stats.size - 1;
    onSuccess?.();
    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stats.size}` } : {}),
      'Cache-Control': 'no-store',
      ...(res.__loomtvPublicApi ? { 'X-LoomTV-API-Version': '1' } : {}),
      ...extraHeaders,
    });
    if (req.method === 'HEAD') { closeHandle(); return res.end(); }
    if (stats.size === 0) { closeHandle(); return res.end(); }
    return pipeFrom({ start, end });
  }

  async function servePlaylist(req, res, session) {
    const filePath = path.join(session.outputDir, 'index.m3u8');
    const source = await openContainedFile(configuredCacheDir, filePath)
      .then(async (opened) => {
        try { return await opened.handle.readFile('utf8'); } finally { await opened.handle.close().catch(() => undefined); }
      })
      .catch(() => null);
    if (source === null) return json(res, 404, { ok: false, error: 'playlist_not_ready' });
    if (!touchTranscodeSession(session, { activate: true })) {
      return json(res, 401, { ok: false, error: 'stream_token_invalid' });
    }
    const token = encodeURIComponent(session.token);
    const playlist = source.replace(/^(segment-\d+\.ts)$/gm, `$1?token=${token}`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': Buffer.byteLength(playlist),
      'Cache-Control': 'no-store',
      ...(res.__loomtvPublicApi ? { 'X-LoomTV-API-Version': '1' } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(playlist);
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (pathname === '/api/media/items' && req.method === 'GET') {
      const authorization = await authorizedFor(req, url, 'library.read');
      if (!authorization.ok) return json(res, authorization.status, { ok: false, error: authorization.status === 403 ? 'permission_denied' : 'admin_auth_required' });
      const principal = authorization.principal;
      return json(res, 200, { ok: true, items: (await adminService.listLibraryItems(principal)).map(redactedLibraryItem) });
    }
    if (pathname === '/api/media/transcode' && req.method === 'POST') {
      const authorization = await authorizedFor(req, url, 'transcode');
      if (!authorization.ok) return json(res, authorization.status, { ok: false, error: authorization.status === 403 ? 'permission_denied' : 'admin_auth_required' });
      const principal = authorization.principal;
      const itemId = url.searchParams.get('itemId');
      if (!itemId) return json(res, 400, { ok: false, error: 'itemId_required' });
      const requestedProfile = {
        planToken: url.searchParams.get('planToken') || undefined,
        canonicalPlanRequired: res.__loomtvPublicApi === true,
        sourceId: url.searchParams.get('sourceId') || undefined,
        profileId: url.searchParams.get('profileId') || undefined,
        deviceId: url.searchParams.get('deviceId') || undefined,
        selectionRevision: url.searchParams.get('selectionRevision') || undefined,
        mode: url.searchParams.get('mode') || undefined,
        codec: url.searchParams.get('codec') || undefined,
        backend: url.searchParams.get('backend') || undefined,
        copyVideo: url.searchParams.get('copyVideo') || undefined,
        copyAudio: url.searchParams.get('copyAudio') || undefined,
        burnSubtitles: url.searchParams.get('burnSubtitles') || undefined,
        subtitleKind: url.searchParams.get('subtitleKind') || undefined,
        selectedVideoTrackIndex: url.searchParams.get('selectedVideoTrackIndex') || undefined,
        selectedAudioTrackIndex: url.searchParams.get('selectedAudioTrackIndex') || undefined,
        selectedSubtitleTrackIndex: url.searchParams.get('selectedSubtitleTrackIndex') || undefined,
        selectedSubtitleTrackOrdinal: url.searchParams.get('selectedSubtitleTrackOrdinal') || undefined,
        startSeconds: url.searchParams.get('startSeconds') || undefined,
        maxWidth: url.searchParams.get('maxWidth') || undefined,
        maxHeight: url.searchParams.get('maxHeight') || undefined,
        videoBitrateKbps: url.searchParams.get('videoBitrateKbps') || undefined,
        audioBitrateKbps: url.searchParams.get('audioBitrateKbps') || undefined,
        toneMap: url.searchParams.get('toneMap') || undefined,
      };
      const requestLifecycle = requestAbortSignal(req, res);
      try {
        return json(res, 202, { ok: true, data: await startTranscode(itemId, requestedProfile, principal, requestLifecycle.signal) });
      } catch (error) {
        return json(res, error?.status || 500, {
          ok: false,
          error: publicPlaybackErrorCode(error),
          message: error instanceof Error ? error.message : 'The transcode could not be started.',
          ...(error?.retryAfter ? { retryAfter: error.retryAfter } : {}),
        });
      } finally {
        requestLifecycle.cleanup();
      }
    }
    const stopMatch = pathname.match(/^\/api\/media\/transcode\/([0-9a-f-]{36})$/i);
    if (stopMatch && req.method === 'DELETE') {
      const authorization = await authorizedFor(req, url, 'stream');
      if (!authorization.ok) return json(res, authorization.status, { ok: false, error: authorization.status === 403 ? 'permission_denied' : 'admin_auth_required' });
      const session = sessions.get(stopMatch[1]);
      if (session && (session.userId === authorization.principal.id || authorization.principal.type === 'owner')) {
        trackCleanup(cleanupSession(session, { reason: 'user_revoked' }));
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    const transcodeMatch = pathname.match(/^\/api\/media\/transcode\/([0-9a-f-]{36})\/(index\.m3u8|segment-\d{5}\.ts)$/i);
    if (transcodeMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      // Hls.js refreshes its loader headers when a lease rotates, which lets
      // the client hand off the new capability without rebuilding the media
      // source. Native HLS still uses the short-lived URL overlap below.
      const token = tokenFromRequest(req, url);
      const playback = playbackRegistry.authorize(token, { action: 'hls' });
      const session = playback && playback.id === transcodeMatch[1] ? sessions.get(playback.id) : null;
      if (!session || session.cleaned) return json(res, 401, { ok: false, error: 'stream_token_invalid' });
      session.token = playback.token;
      let principal = null;
      if (typeof adminService.getPrincipalById === 'function') {
        principal = await resolveBoundPrincipal(session.userId, playback.profile);
        try { remotePolicy?.assertPrincipal?.(req, principal, 'media'); } catch {
          trackCleanup(cleanupSession(session, { reason: 'remote_access_revoked' }));
          return json(res, 403, { ok: false, error: 'remote_access_disabled' });
        }
        const permitted = principal && (typeof adminService.authorizePrincipal !== 'function'
          || await adminService.authorizePrincipal(principal, 'stream'));
        if (!permitted) {
          trackCleanup(cleanupSession(session, { reason: 'principal_revoked' }));
          return json(res, 401, { ok: false, error: 'stream_token_revoked' });
        }
      }
      if (principal && typeof adminService.resolveMediaPath === 'function') {
        try {
          const source = await adminService.resolveMediaPath(session.itemId, principal, session.sourceId);
          if (session.playbackProfile && clientState?.requireActivePlaybackProfile) {
            const current = await requireBoundProfile(principal, session.playbackProfile, source);
            if (current.profileId !== session.playbackProfile.profileId
              || current.selectionRevision !== session.playbackProfile.selectionRevision) throw new Error('Profile selection changed.');
          }
          const sameFile = source.fileId?.dev === session.fileId?.dev && source.fileId?.ino === session.fileId?.ino;
          if (source.rootPath !== session.mediaRootPath || !sameFile) throw Object.assign(new Error('The media source changed.'), { status: 409 });
        } catch {
          trackCleanup(cleanupSession(session, { reason: 'source_revoked' }));
          return json(res, 409, { ok: false, error: 'stream_source_revoked' });
        }
      }
      if (!await enforceSessionQuota(session)) return json(res, 507, { ok: false, error: 'transcode_cache_quota' });
      const filePath = path.join(session.outputDir, transcodeMatch[2]);
      if (transcodeMatch[2] === 'index.m3u8') {
        const result = await servePlaylist(req, res, session);
        if (!res.destroyed && !session.cleaned) session.ready = true;
        return result;
      }
      return serveFile(req, res, configuredCacheDir, filePath, mimeFor(filePath), false, {}, null, () => {
        touchTranscodeSession(session, { activate: true });
      });
    }
    const itemMatch = pathname.match(/^\/api\/media\/items\/([a-f0-9]{32})(?:\/(download))?$/i);
    if (itemMatch && req.method === 'DELETE' && !itemMatch[2]) {
      const authorization = await authorizedFor(req, url, 'media.delete');
      if (!authorization.ok) return json(res, authorization.status, { ok: false, error: authorization.status === 403 ? 'permission_denied' : 'admin_auth_required' });
      try {
        return json(res, 200, { ok: true, data: await adminService.deleteLibraryItem(itemMatch[1], authorization.principal) });
      } catch (error) {
        return json(res, error?.status || 500, { ok: false, error: error instanceof Error ? error.message : 'media_delete_failed' });
      }
    }
    if (itemMatch && itemMatch[2] === 'download' && (req.method === 'GET' || req.method === 'HEAD')) {
      return json(res, 410, { ok: false, error: 'download_not_allowed',
        message: 'Create an offline download lease through POST /api/v1/downloads.' });
    }
    const directMatch = pathname.match(/^\/api\/media\/items\/([^/]+)$/i);
    if (directMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const authorization = await authorizedFor(req, url, 'stream', res.__loomtvPublicApi === true);
      if (!authorization.ok) return json(res, authorization.status, { ok: false, error: authorization.status === 403 ? 'permission_denied' : 'admin_auth_required' });
      const principal = authorization.principal;
      try {
        const item = await adminService.resolveMediaPath(
          decodeURIComponent(directMatch[1]), principal, authorization.playbackSession?.profile?.sourceId,
        );
        const expectedFileId = authorization.playbackSession?.profile?.fileId;
        if (expectedFileId && (item.fileId?.dev !== expectedFileId.dev || item.fileId?.ino !== expectedFileId.ino)) {
          return json(res, 409, { ok: false, error: 'source_unavailable', message: 'The media source changed.' });
        }
        if (!DIRECT_EXTENSIONS.has(path.extname(item.path).toLowerCase())) return json(res, 415, { ok: false, error: 'direct_stream_not_supported', message: 'Start an HLS transcode for this media type.' });
        if (authorization.playbackSession && authorization.playbackSession.itemId !== decodeURIComponent(directMatch[1])) return json(res, 401, { ok: false, error: 'stream_token_invalid' });
        return serveFile(req, res, item.rootPath, item.path, mimeFor(item.path), true, {}, item.fileId, authorization.playbackSession ? () => playbackRegistry.touch(authorization.playbackSession.id, now()) : null);
      } catch (error) { return json(res, error?.status || 404, { ok: false, error: error instanceof Error ? error.message : 'media_not_found' }); }
    }
    return false;
  }

  return {
    handle,
    planPlayback,
    describeDirectCapability,
    serveDirectCapability,
    serveExternalSubtitleCapability,
    serveOfflineDownload,
    issuePlaybackToken,
    issueTranscodePlan,
    startTranscodePlan(itemId, planToken, principal, requestSignal = null) {
      return startTranscode(itemId, { planToken, canonicalPlanRequired: true }, principal, requestSignal);
    },
    async renewPlaybackSession(identifier, principal, itemId, action = undefined, req = undefined) {
      const current = playbackRegistry.authorize(identifier, {
        ...(itemId ? { itemId } : {}),
        ...(action ? { action } : {}),
      }, now());
      if (!current) return null;
      if (playbackRegistry.isSessionIdentifier?.(identifier) && !principal) return null;
      const resolvedPrincipal = principal || await resolveBoundPrincipal(current.principalId, current.profile);
      if (!resolvedPrincipal) return null;
      try { remotePolicy?.assertPrincipal?.(req, resolvedPrincipal, 'media'); } catch { return null; }
      const permitted = typeof adminService.authorizePrincipal !== 'function'
        || await adminService.authorizePrincipal(resolvedPrincipal, 'stream');
      if (!permitted || resolvedPrincipal.id !== current.principalId) return null;
      const targetItemId = itemId || current.itemId;
      if (current.profile?.profileId && clientState?.requireActivePlaybackProfile) {
        try {
          const media = await adminService.resolveMediaPath(targetItemId, resolvedPrincipal, current.profile.sourceId);
          const context = await requireBoundProfile(resolvedPrincipal, current.profile, media);
          if (context.profileId !== current.profile.profileId || context.selectionRevision !== current.profile.selectionRevision) return null;
        } catch { return null; }
      }
      if (typeof adminService.resolveMediaPath === 'function') {
        try {
          const source = await adminService.resolveMediaPath(targetItemId, resolvedPrincipal, current.profile?.sourceId);
          const session = sessions.get(current.id);
          const sameHlsFile = current.action !== 'hls' || (
            session && source.rootPath === session.mediaRootPath
            && source.fileId?.dev === session.fileId?.dev
            && source.fileId?.ino === session.fileId?.ino
          );
          if (!sameHlsFile) return null;
        } catch {
          return null;
        }
      }
      const renewed = playbackRegistry.renew(identifier, {
        principalId: resolvedPrincipal.id,
        itemId: targetItemId,
        ...(action ? { action } : {}),
      }, now());
      if (!renewed) return null;
      const session = sessions.get(renewed.id);
      if (session) session.token = renewed.token;
      return renewed;
    },
    async stopPlaybackSession(identifier, principal, itemId) {
      const current = playbackRegistry.authorize(identifier, {
        ...(itemId ? { itemId } : {}),
        action: ['direct', 'hls'],
      }, now());
      if (!current) return null;
      const owner = principal?.type === 'owner' || principal?.role === 'owner';
      if (playbackRegistry.isSessionIdentifier?.(identifier) && !principal) return null;
      if (principal && principal.id !== current.principalId && !owner) return null;
      if (principal && !owner
        && typeof adminService.authorizePrincipal === 'function'
        && !await adminService.authorizePrincipal(principal, 'stream')) return null;
      const session = sessions.get(current.id);
      if (session) trackCleanup(cleanupSession(session, { reason: 'user_stopped' }));
      else playbackRegistry.revoke(identifier, 'user_stopped', now());
      return { id: current.id, action: current.action, stopped: true };
    },
    revokePlaybackSession(identifier, reason = 'user_revoked') {
      return playbackRegistry.revoke(identifier, reason, now());
    },
    revokePrincipal(principalId, reason = 'principal_revoked') {
      for (const [id, entry] of transcodePlans) if (entry.principalId === principalId) transcodePlans.delete(id);
      return playbackRegistry.revokeByPrincipal(principalId, reason, now());
    },
    revokeDevice(deviceId, reason = 'device_revoked') {
      for (const [id, entry] of transcodePlans) {
        if (entry.profileContext?.deviceId === deviceId) transcodePlans.delete(id);
      }
      return playbackRegistry.revokeByDevice(deviceId, reason, now());
    },
    revokeAuthenticationSession(authenticationSessionId, reason = 'auth_session_revoked') {
      for (const [id, entry] of transcodePlans) {
        if (entry.profileContext?.authenticationSessionId === authenticationSessionId) transcodePlans.delete(id);
      }
      return playbackRegistry.revokeByAuthenticationSession(authenticationSessionId, reason, now());
    },
    revokeItem(itemId, reason = 'item_revoked') {
      for (const [id, entry] of transcodePlans) if (entry.itemId === itemId) transcodePlans.delete(id);
      return playbackRegistry.revokeByItem(itemId, reason, now());
    },
    revokeAllPlaybackSessions(reason = 'revoked') {
      transcodePlans.clear();
      return playbackRegistry.revokeAll(reason, now());
    },
    getAdmissionHealth() {
      return { ...admission.stats(), quota: cacheQuota.snapshot() };
    },
    getCacheQuotaHealth() {
      return cacheQuota.snapshot();
    },
    async listSessions() {
      return playbackRegistry.list(now()).filter((entry) => entry.action === 'direct' || entry.action === 'hls').map((entry) => {
        const session = sessions.get(entry.id);
        return {
          id: entry.id,
          principalId: entry.principalId,
          clientName: 'Headless media client',
          clientType: entry.action === 'hls' ? 'HTTP/HLS' : 'HTTP/direct',
          mediaTitle: session ? path.basename(session.filePath) : entry.itemId,
          state: entry.action === 'hls' ? (session?.ready ? 'transcoding' : 'starting') : 'playing',
          connectedAt: entry.createdAt,
          lastActivityAt: entry.lastActivityAt,
          expiresAt: entry.expiresAt,
          bitrateKbps: undefined,
          backend: session?.backend,
          codec: session?.profile?.codec,
          profile: entry.profile || session?.profile,
        };
      });
    },
    async stop(options = {}) {
      if (stopPromise) return stopPromise;
      stopping = true;
      transcodePlans.clear();
      const termGraceMs = Number.isFinite(options.termGraceMs)
        ? Math.max(0, Math.min(30_000, Math.trunc(options.termGraceMs)))
        : PROCESS_TERM_GRACE_MS;
      stopPromise = (async () => {
        if (quotaSweepTimer) clearIntervalFn(quotaSweepTimer);
        quotaSweepTimer = null;
        if (quotaSweepPromise) await Promise.allSettled([quotaSweepPromise]);
        if (ownsAdmission) admission.close();
        const activeSessions = [...sessions.values()];
        await Promise.all(activeSessions.map((session) => trackCleanup(cleanupSession(session, { reason: 'shutdown', termGraceMs }))));
        if (cleanupTasks.size) await Promise.allSettled([...cleanupTasks]);
        if (ownsPlaybackRegistry) playbackRegistry.close('shutdown');
        else playbackRegistry.revokeAll?.('shutdown', now());
        await reconcileOrphanedTranscodes();
      })();
      return stopPromise;
    },
  };
}
