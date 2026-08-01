import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { normalizePlaybackProfile } from '@loom-media-server/media-core';
import { backendEncoder } from '@loom-media-server/transcode-capabilities';

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
};
const DIRECT_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ts']);
const SESSION_TTL_MS = 30 * 60 * 1000;
const PLAYLIST_WAIT_MS = 20_000;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  if (!res.headersSent) {
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
  }
  res.end(body);
}

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function downloadDisposition(filePath) {
  const name = path.basename(filePath).replace(/[\u0000-\u001f\u007f]/g, '_') || 'loomtv-media';
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${asciiName}"`;
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

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stats = await fsPromises.stat(filePath);
      if (stats.size > 0) return true;
    } catch {
      // FFmpeg is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function normalizeProfile(input = {}, health) {
  const requestedPlayback = normalizePlaybackProfile(input);
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
  const backend = requestedBackend === 'software'
    ? (softwareAvailable ? 'software' : null)
    : requestedHardware?.id || preferredHardware?.id || (softwareAvailable ? 'software' : null);
  if (!backend) throw Object.assign(new Error(`FFmpeg cannot produce ${codec.toUpperCase()} on this host.`), { status: 503 });
  const toneMapRequested = requestedPlayback.toneMap;
  return {
    codec,
    backend,
    maxWidth: requestedPlayback.maxWidth,
    maxHeight: requestedPlayback.maxHeight,
    videoBitrateKbps: requestedPlayback.videoBitrateKbps,
    audioBitrateKbps: requestedPlayback.audioBitrateKbps,
    toneMap: toneMapRequested && health.toneMapping === true,
    toneMapRequested,
    hardware: backend !== 'software',
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
  const hardware = profile.backend !== 'software' ? hardwareArgs(health, profile.backend, profile.codec, profile) : null;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(hardware?.beforeInput || []), '-i', filePath, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn'];
  if (hardware) {
    args.push(...hardware.filters, '-c:v', hardware.encoder, ...hardware.options);
  } else {
    const filters = [profile.toneMap ? toneMapFilter() : 'format=yuv420p'];
    const scale = scaleFilter(profile);
    if (scale) filters.push(scale);
    args.push('-vf', filters.join(','), '-c:v', softwareEncoder(health, profile.codec));
    if (profile.codec === 'h264') args.push('-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p');
    if (profile.codec === 'hevc') args.push('-preset', 'medium', '-crf', '28', '-pix_fmt', 'yuv420p');
    if (profile.codec === 'av1') args.push('-preset', '8', '-crf', '32', '-pix_fmt', 'yuv420p');
    if (profile.videoBitrateKbps) args.push('-b:v', `${profile.videoBitrateKbps}k`, '-maxrate', `${profile.videoBitrateKbps}k`, '-bufsize', `${profile.videoBitrateKbps * 2}k`);
  }
  args.push('-c:a', 'aac', '-b:a', `${profile.audioBitrateKbps}k`, '-ac', '2', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '8', '-hls_flags', 'delete_segments+independent_segments', '-hls_segment_filename', path.join(outputDir, 'segment-%05d.ts'), path.join(outputDir, 'index.m3u8'));
  return args;
}

export function createHeadlessMediaService({ adminService, transcoder, cacheDir, authorize }) {
  const sessions = new Map();
  const root = path.join(path.resolve(cacheDir), 'headless-transcodes');

  async function authorizedFor(req, url, permission) {
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

  function cleanupSession(session) {
    if (!session || session.cleaned) return;
    session.cleaned = true;
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (session.process && !session.process.killed) session.process.kill('SIGTERM');
    sessions.delete(session.id);
    void fsPromises.rm(session.outputDir, { recursive: true, force: true }).catch(() => undefined);
  }

  function startProcess(session, profile) {
    session.backend = profile.backend;
    session.profile = profile;
    session.stderr = '';
    const child = spawn(transcoder.path, transcodeArgs(session.filePath, session.outputDir, transcoder.getHealth(), profile), { stdio: ['ignore', 'ignore', 'pipe'] });
    session.process = child;
    child.stderr?.on('data', (chunk) => {
      session.stderr = `${session.stderr}${chunk.toString()}`.slice(-4000);
    });
    child.once('error', (error) => {
      session.error = error instanceof Error ? error.message : String(error);
    });
    child.once('exit', (code) => {
      session.exitCode = code;
      if (code !== 0 && !session.ready && profile.backend !== 'software' && !session.fallbackAttempted) {
        session.fallbackAttempted = true;
        void fsPromises.rm(session.outputDir, { recursive: true, force: true })
          .then(() => fsPromises.mkdir(session.outputDir, { recursive: true }))
          .then(() => startProcess(session, { ...profile, backend: 'software', hardware: false }))
          .catch((error) => { session.error = error instanceof Error ? error.message : String(error); });
      }
    });
    return child;
  }

  async function startTranscode(itemId, requestedProfile = {}, principal) {
    const item = await adminService.resolveMediaPath(itemId, principal);
    const stats = await fsPromises.stat(item.path).catch(() => null);
    if (!stats?.isFile()) throw Object.assign(new Error('Media file is unavailable.'), { status: 409 });
    if (!transcoder.path) throw Object.assign(new Error('FFmpeg is not available on this host.'), { status: 503 });
    await fsPromises.mkdir(root, { recursive: true });
    const id = randomUUID();
    const outputDir = path.join(root, id);
    await fsPromises.mkdir(outputDir, { recursive: true });
    const health = transcoder.getHealth();
    const profile = normalizeProfile(requestedProfile, health);
    const session = { id, itemId, userId: principal.id, filePath: item.path, outputDir, backend: profile.backend, profile, token: randomBytes(24).toString('base64url'), createdAt: Date.now(), lastActivityAt: Date.now(), ready: false, fallbackAttempted: false, cleaned: false };
    session.cleanupTimer = setTimeout(() => cleanupSession(session), SESSION_TTL_MS);
    session.cleanupTimer.unref?.();
    sessions.set(id, session);
    startProcess(session, profile);
    const playlistPath = path.join(outputDir, 'index.m3u8');
    if (!await waitForFile(playlistPath, PLAYLIST_WAIT_MS)) {
      cleanupSession(session);
      throw new Error(session.error || 'FFmpeg did not produce an HLS playlist.');
    }
    session.ready = true;
    const base = `/api/media/transcode/${encodeURIComponent(id)}/index.m3u8`;
    return {
      sessionId: id,
      playlistUrl: `${base}?token=${encodeURIComponent(session.token)}`,
      backend: session.backend,
      codec: session.profile.codec,
      profile: session.profile,
      fallback: session.backend === 'software' && profile.backend !== 'software',
    };
  }

  async function serveFile(req, res, filePath, contentType, allowRange = false, extraHeaders = {}) {
    const stats = await fsPromises.stat(filePath).catch(() => null);
    if (!stats?.isFile()) return json(res, 404, { ok: false, error: 'not_found' });
    if (!allowRange) {
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stats.size, 'Cache-Control': 'no-store', ...extraHeaders });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(filePath);
      stream.once('error', () => { if (!res.destroyed) res.destroy(); });
      return stream.pipe(res);
    }
    const range = parseRange(req.headers.range, stats.size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      return res.end();
    }
    const start = range?.start || 0;
    const end = range?.end ?? stats.size - 1;
    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stats.size}` } : {}),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.once('error', () => { if (!res.destroyed) res.destroy(); });
    return stream.pipe(res);
  }

  async function servePlaylist(req, res, session) {
    const filePath = path.join(session.outputDir, 'index.m3u8');
    const source = await fsPromises.readFile(filePath, 'utf8').catch(() => null);
    if (source === null) return json(res, 404, { ok: false, error: 'playlist_not_ready' });
    const token = encodeURIComponent(session.token);
    const playlist = source.replace(/^(segment-\d+\.ts)$/gm, `$1?token=${token}`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': Buffer.byteLength(playlist),
      'Cache-Control': 'no-store',
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
      return json(res, 200, { ok: true, items: await adminService.listLibraryItems(principal) });
    }
    if (pathname === '/api/media/transcode' && req.method === 'POST') {
      const authorization = await authorizedFor(req, url, 'transcode');
      if (!authorization.ok) return json(res, authorization.status, { ok: false, error: authorization.status === 403 ? 'permission_denied' : 'admin_auth_required' });
      const principal = authorization.principal;
      const itemId = url.searchParams.get('itemId');
      if (!itemId) return json(res, 400, { ok: false, error: 'itemId_required' });
      const requestedProfile = {
        codec: url.searchParams.get('codec') || undefined,
        backend: url.searchParams.get('backend') || undefined,
        maxWidth: url.searchParams.get('maxWidth') || undefined,
        maxHeight: url.searchParams.get('maxHeight') || undefined,
        videoBitrateKbps: url.searchParams.get('videoBitrateKbps') || undefined,
        audioBitrateKbps: url.searchParams.get('audioBitrateKbps') || undefined,
        toneMap: url.searchParams.get('toneMap') || undefined,
      };
      try { return json(res, 202, { ok: true, data: await startTranscode(itemId, requestedProfile, principal) }); } catch (error) { return json(res, error?.status || 500, { ok: false, error: error instanceof Error ? error.message : 'transcode_failed' }); }
    }
    const stopMatch = pathname.match(/^\/api\/media\/transcode\/([0-9a-f-]{36})$/i);
    if (stopMatch && req.method === 'DELETE') {
      const authorization = await authorizedFor(req, url, 'stream');
      if (!authorization.ok) return json(res, authorization.status, { ok: false, error: authorization.status === 403 ? 'permission_denied' : 'admin_auth_required' });
      const session = sessions.get(stopMatch[1]);
      if (session && (session.userId === authorization.principal.id || authorization.principal.type === 'owner')) cleanupSession(session);
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    const transcodeMatch = pathname.match(/^\/api\/media\/transcode\/([0-9a-f-]{36})\/(index\.m3u8|segment-\d{5}\.ts)$/i);
    if (transcodeMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const session = sessions.get(transcodeMatch[1]);
      if (!session || session.cleaned || url.searchParams.get('token') !== session.token) return json(res, 401, { ok: false, error: 'stream_token_invalid' });
      if (typeof adminService.getPrincipalById === 'function') {
        const principal = await adminService.getPrincipalById(session.userId);
        const permitted = principal && (typeof adminService.authorizePrincipal !== 'function'
          || await adminService.authorizePrincipal(principal, 'stream'));
        if (!permitted) {
          cleanupSession(session);
          return json(res, 401, { ok: false, error: 'stream_token_revoked' });
        }
      }
      session.lastActivityAt = Date.now();
      const filePath = path.join(session.outputDir, transcodeMatch[2]);
      if (transcodeMatch[2] === 'index.m3u8') session.ready = true;
      if (transcodeMatch[2] === 'index.m3u8') return servePlaylist(req, res, session);
      return serveFile(req, res, filePath, mimeFor(filePath));
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
      const authorization = await authorizedFor(req, url, 'downloads');
      if (!authorization.ok) return json(res, authorization.status, { ok: false, error: authorization.status === 403 ? 'permission_denied' : 'admin_auth_required' });
      try {
        const item = await adminService.resolveMediaPath(itemMatch[1], authorization.principal);
        return serveFile(req, res, item.path, 'application/octet-stream', true, { 'Content-Disposition': downloadDisposition(item.path) });
      } catch (error) {
        return json(res, error?.status || 404, { ok: false, error: error instanceof Error ? error.message : 'media_not_found' });
      }
    }
    const directMatch = pathname.match(/^\/api\/media\/items\/([a-f0-9]{32})$/i);
    if (directMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const authorization = await authorizedFor(req, url, 'stream');
      if (!authorization.ok) return json(res, authorization.status, { ok: false, error: authorization.status === 403 ? 'permission_denied' : 'admin_auth_required' });
      const principal = authorization.principal;
      try {
        const item = await adminService.resolveMediaPath(directMatch[1], principal);
        if (!DIRECT_EXTENSIONS.has(path.extname(item.path).toLowerCase())) return json(res, 415, { ok: false, error: 'direct_stream_not_supported', message: 'Start an HLS transcode for this media type.' });
        return serveFile(req, res, item.path, mimeFor(item.path), true);
      } catch (error) { return json(res, error?.status || 404, { ok: false, error: error instanceof Error ? error.message : 'media_not_found' }); }
    }
    return false;
  }

  return {
    handle,
    async listSessions() {
      const now = Date.now();
      for (const session of sessions.values()) if (now - session.lastActivityAt > SESSION_TTL_MS) cleanupSession(session);
      return [...sessions.values()].filter((session) => !session.cleaned).map((session) => ({
        id: session.id,
        clientName: 'Headless media client',
        clientType: 'HTTP/HLS',
        mediaTitle: path.basename(session.filePath),
        state: session.ready ? 'transcoding' : 'starting',
        connectedAt: session.createdAt,
        bitrateKbps: undefined,
        backend: session.backend,
        codec: session.profile?.codec,
        profile: session.profile,
      }));
    },
    async stop() {
      for (const session of sessions.values()) cleanupSession(session);
    },
  };
}
