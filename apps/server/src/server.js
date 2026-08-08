import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { MEDIA_CORE_CONTRACT_VERSION } from '@loom-media-server/media-core';
import { createAdminApiHandler, createAdminPage } from './admin-page.js';
import { createHeadlessAdminService } from './admin-service.js';
import { createHeadlessClientState } from './client-state.js';
import { createHeadlessMediaService } from './media-service.js';
import { createPublicApiHandler, publicHealthSummary } from './public-api.js';
import { createHeadlessTranscoder } from './transcoder.js';
import { createTrustedProxyPolicy } from './trusted-proxy.js';
import { createWebAppPage } from './web-app.js';

const SERVICE_NAME = 'loomtv-headless-server';
const CONTRACT_VERSION = 1;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_TERM_GRACE_MS = 2_000;

function jsonResponse(res, status, payload, method = 'GET') {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function formatAddress(server, fallbackHost) {
  const address = server.address();
  if (!address || typeof address === 'string') return { host: fallbackHost, port: 0 };
  const host = address.address === '::' ? 'localhost' : address.address;
  return { host, port: address.port };
}

async function inspectMediaPath(mediaDir) {
  if (!mediaDir) return { configured: false, state: 'unconfigured', path: null };
  try {
    const stat = await fs.stat(mediaDir);
    return {
      configured: true,
      state: stat.isDirectory() ? 'online' : 'not-directory',
      path: mediaDir,
      readable: true,
    };
  } catch (error) {
    return {
      configured: true,
      state: error?.code === 'EACCES' ? 'permission-denied' : 'offline',
      path: mediaDir,
      readable: false,
    };
  }
}

/** @param {{ host: string, port: number, paths: import('@loom-media-server/runtime-paths').RuntimePaths, version: string, trustedProxies?: string | string[] }} options */
export function createHeadlessServer(options) {
  // Parse before constructing services so malformed trust configuration fails
  // startup without opening a listener or silently falling back to broad trust.
  const proxyPolicy = createTrustedProxyPolicy(options.trustedProxies);
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let server;
  let stopPromise;
  let draining = false;
  const transcoder = createHeadlessTranscoder({ ffmpegPath: options.ffmpegPath });
  let mediaService;
  const clientState = createHeadlessClientState({ dataDir: options.paths.dataDir });

  const healthPayload = async () => {
    const address = formatAddress(server, options.host);
    const port = address.port || options.port;
    const transcoderHealth = transcoder.getHealth();
    const admission = mediaService?.getAdmissionHealth?.();
    const quotaPromise = mediaService?.getCacheQuotaHealth?.();
    const quota = quotaPromise ? await Promise.resolve(quotaPromise).catch(() => null) : null;
    const admissionHealth = admission
      ? { ...admission, ...(quota ? { quota } : {}) }
      : quota ? { quota } : null;
    return {
      ok: true,
      status: draining ? 'draining' : 'ready',
      service: SERVICE_NAME,
      contractVersion: CONTRACT_VERSION,
      mediaCoreContractVersion: MEDIA_CORE_CONTRACT_VERSION,
      version: options.version,
      headless: true,
      port,
      transport: 'http',
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
      server: {
        host: options.host,
        port,
        address: `http://${address.host}:${port}`,
        transport: 'http',
      },
      paths: {
        data: options.paths.dataDir,
        cache: options.paths.cacheDir,
        media: options.paths.mediaDir,
      },
      media: await inspectMediaPath(options.paths.mediaDir),
      capabilities: {
        headless: true,
        adminUi: true,
        webApp: true,
        publicApi: true,
        profiles: true,
        watchProgress: true,
        desktopRoutes: false,
        mediaStreaming: true,
        libraryScanning: true,
        transcoding: transcoderHealth.available,
        hardwareAcceleration: transcoderHealth.hardwareAcceleration,
      },
      transcoder: { ...transcoderHealth, ...(admissionHealth ? { admission: admissionHealth } : {}) },
    };
  };

  const adminService = createHeadlessAdminService({
    dataDir: options.paths.dataDir,
    mediaDir: options.paths.mediaDir,
    version: options.version,
    baseUrl: options.host === '0.0.0.0' ? undefined : `http://${options.host}:${options.port}`,
    getRuntimeHealth: healthPayload,
    getSessions: () => mediaService?.listSessions() || [],
    getClientState: () => clientState.exportState(),
    replaceClientState: (snapshot) => clientState.importState(snapshot),
    onPlaybackSessionsRevoked: (principalId, reason) => mediaService?.revokePrincipal?.(principalId, reason),
    onPlaybackSessionsRevokedForItem: (itemId, reason) => mediaService?.revokeItem?.(itemId, reason),
    onAllPlaybackSessionsRevoked: (reason) => mediaService?.revokeAllPlaybackSessions?.(reason),
  });
  mediaService = createHeadlessMediaService({
    adminService,
    transcoder,
    cacheDir: options.paths.cacheDir,
    authorize: adminService.authorizeRequest,
    clock: options.clock,
    playbackSessionRegistry: options.playbackSessionRegistry,
    playbackSessionOptions: options.playbackSessionOptions,
    transcodeAdmission: options.transcodeAdmission,
    transcodeAdmissionOptions: options.transcodeAdmissionOptions,
    cacheQuotaOptions: options.cacheQuotaOptions,
    transcodeQuotaOptions: options.transcodeQuotaOptions,
    cacheFileSystem: options.cacheFileSystem,
    spawnProcess: options.spawnProcess,
  });
  const adminPage = createAdminPage({ htmlPath: options.adminHtmlPath });
  const adminApi = createAdminApiHandler({
    service: adminService,
    authorize: adminService.authorizeRequest,
    ownerConfigured: adminService.isOwnerConfigured,
    requireSecureTransport: options.requireSecureTransport === true,
    proxyPolicy,
  });
  const webApp = createWebAppPage({ htmlPath: options.webAppHtmlPath });
  const publicApi = createPublicApiHandler({
    service: adminService,
    clientState,
    mediaService,
    getRuntimeHealth: healthPayload,
    version: options.version,
    requireSecureTransport: options.requireSecureTransport === true,
    proxyPolicy,
  });

  const sockets = new Set();
  const shutdownTimeoutMs = Number.isFinite(options.shutdownTimeoutMs)
    ? Math.max(100, Math.min(60_000, Math.trunc(options.shutdownTimeoutMs)))
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const termGraceMs = Number.isFinite(options.termGraceMs)
    ? Math.max(0, Math.min(30_000, Math.trunc(options.termGraceMs)))
    : DEFAULT_TERM_GRACE_MS;
  let closeListenerPromise;

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
  }

  function closeListener() {
    if (closeListenerPromise) return closeListenerPromise;
    if (!server.listening) {
      closeListenerPromise = Promise.resolve();
      return closeListenerPromise;
    }
    closeListenerPromise = new Promise((resolve) => {
      try {
        server.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') console.error('[loomtv-server] listener close failed:', error);
          resolve();
        });
      } catch (error) {
        if (error?.code !== 'ERR_SERVER_NOT_RUNNING') console.error('[loomtv-server] listener close failed:', error);
        resolve();
      }
    });
    return closeListenerPromise;
  }

  server = http.createServer(async (req, res) => {
    try {
      applySecurityHeaders(res);
      if (draining) {
        jsonResponse(res, 503, { ok: false, error: 'server_draining' }, req.method);
        return;
      }
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (await webApp(req, res)) return;
      if (await adminPage(req, res)) return;
      if (await adminApi(req, res)) return;
      if (await publicApi(req, res)) return;
      // Media handlers return false only when the pathname is not theirs;
      // a successful response may itself resolve to undefined after piping.
      if ((await mediaService.handle(req, res, requestUrl)) !== false) return;
      const isHealth = requestUrl.pathname === '/healthz'
        || requestUrl.pathname === '/api/health'
        || requestUrl.pathname === '/api/ping';
      if (isHealth && (req.method === 'GET' || req.method === 'HEAD')) {
        const health = await healthPayload();
        jsonResponse(res, 200, {
          ok: true,
          service: SERVICE_NAME,
          contractVersion: CONTRACT_VERSION,
          mediaCoreContractVersion: MEDIA_CORE_CONTRACT_VERSION,
          ...publicHealthSummary(health),
        }, req.method);
        return;
      }
      if (requestUrl.pathname === '/api/transcoder/capabilities' && (req.method === 'GET' || req.method === 'HEAD')) {
        const principal = await adminService.authenticateRequest(req);
        if (!principal) {
          jsonResponse(res, 401, { ok: false, error: 'admin_auth_required' }, req.method);
          return;
        }
        if (!await adminService.authorizePrincipal(principal, 'admin.read')) {
          jsonResponse(res, 403, { ok: false, error: 'permission_denied' }, req.method);
          return;
        }
        jsonResponse(res, 200, { ok: true, data: transcoder.getHealth() }, req.method);
        return;
      }
      if (requestUrl.pathname === '/api/transcoder/self-test' && (req.method === 'GET' || req.method === 'HEAD')) {
        const principal = await adminService.authenticateRequest(req);
        if (!principal) {
          jsonResponse(res, 401, { ok: false, error: 'admin_auth_required' }, req.method);
          return;
        }
        if (!await adminService.authorizePrincipal(principal, 'admin.read')) {
          jsonResponse(res, 403, { ok: false, error: 'permission_denied' }, req.method);
          return;
        }
        jsonResponse(res, 200, { ok: true, data: transcoder.getSelfTest() }, req.method);
        return;
      }
      if (requestUrl.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        jsonResponse(res, 200, {
          ok: true,
          service: SERVICE_NAME,
          message: 'LoomTV headless service is running.',
          health: '/api/health',
        }, req.method);
        return;
      }
      jsonResponse(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      console.error('[loomtv-server] request failed:', error);
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, error: 'internal_error' });
      else res.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (draining) socket.end();
  });

  return {
    address() {
      return formatAddress(server, options.host);
    },
    async start() {
      if (draining) throw Object.assign(new Error('The server is shutting down.'), { code: 'server_draining' });
      if (server.listening) return this.address();
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port, options.host);
      });
      return this.address();
    },
    async stop() {
      if (stopPromise) return stopPromise;
      draining = true;
      stopPromise = (async () => {
        // Mark the service draining before closing the listener so requests
        // already queued by a keep-alive connection cannot start new work.
        server.closeIdleConnections?.();
        const listenerClosed = closeListener();
        const servicesStopped = Promise.allSettled([
          adminService.stop?.(),
          mediaService.stop({ termGraceMs }),
        ]);
        await Promise.race([
          Promise.all([listenerClosed, servicesStopped]),
          delay(shutdownTimeoutMs),
        ]);
        if (sockets.size) {
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections?.();
        }
        await Promise.race([listenerClosed, delay(250)]);
      })();
      return stopPromise;
    },
  };
}

export async function readServerVersion(packageRoot) {
  try {
    const packageJson = JSON.parse(await fs.readFile(`${packageRoot}/package.json`, 'utf8'));
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
