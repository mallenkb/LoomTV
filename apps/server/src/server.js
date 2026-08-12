import fs from 'node:fs/promises';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import process from 'node:process';
import { MEDIA_CORE_CONTRACT_VERSION } from '@loom-media-server/media-core';
import { createAdminApiHandler, createAdminPage } from './admin-page.js';
import { createHeadlessAdminService } from './admin-service.js';
import { createHeadlessClientState } from './client-state.js';
import { createHeadlessMediaService } from './media-service.js';
import { createPublicApiHandler } from './public-api.js';
import { createBootstrapSecurity } from './secure-bootstrap.js';
import { createHeadlessTranscoder } from './transcoder.js';
import { assertTransportConfiguration, requestUsesSecureTransport } from './transport-security.js';
import { createWebAppPage } from './web-app.js';

const SERVICE_NAME = 'loomtv-headless-server';
const CONTRACT_VERSION = 1;

function verifyDirectTls(tls) {
  if (!tls) return false;
  if (!tls.cert || !tls.key) {
    throw Object.assign(new Error('Direct TLS requires both certificate and private-key material.'), {
      code: 'TLS_CONFIGURATION_INVALID',
    });
  }
  try {
    const certificate = new X509Certificate(tls.cert);
    const privateKey = createPrivateKey(tls.key);
    if (!certificate.checkPrivateKey(privateKey)) throw new Error('The TLS certificate does not match the private key.');
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    const now = Date.now();
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now > validTo) {
      throw new Error('The TLS certificate is not currently valid.');
    }
    return true;
  } catch (error) {
    throw Object.assign(new Error(`Direct TLS configuration is invalid: ${error.message}`), {
      code: 'TLS_CONFIGURATION_INVALID',
      cause: error,
    });
  }
}

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

/** @param {{ host: string, port: number, paths: import('@loom-media-server/runtime-paths').RuntimePaths, version: string }} options */
export function createHeadlessServer(options) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const directTls = verifyDirectTls(options.tls);
  const transport = directTls ? 'https' : 'http';
  let server;
  let stopPromise;
  const transcoder = createHeadlessTranscoder({ ffmpegPath: options.ffmpegPath });
  let mediaService;
  const clientState = createHeadlessClientState({ dataDir: options.paths.dataDir });
  const bootstrapSecurity = options.bootstrapSecurity || createBootstrapSecurity({
    dataDir: options.paths.dataDir,
    secret: options.bootstrapSecret,
    secretFile: options.bootstrapSecretFile,
    onGenerated: options.onBootstrapSecretGenerated,
    onWarning: options.onBootstrapWarning,
  });
  const requestIsSecure = (req) => requestUsesSecureTransport(req, options.trustProxy === true);

  const healthPayload = async () => {
    const address = formatAddress(server, options.host);
    const port = address.port || options.port;
    const transcoderHealth = transcoder.getHealth();
    return {
      ok: true,
      status: 'ready',
      service: SERVICE_NAME,
      contractVersion: CONTRACT_VERSION,
      mediaCoreContractVersion: MEDIA_CORE_CONTRACT_VERSION,
      version: options.version,
      headless: true,
      port,
      transport,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
      server: {
        host: options.host,
        port,
        address: `${transport}://${address.host}:${port}`,
        transport,
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
      transcoder: transcoderHealth,
    };
  };

  const adminService = createHeadlessAdminService({
    dataDir: options.paths.dataDir,
    mediaDir: options.paths.mediaDir,
    version: options.version,
    baseUrl: options.host === '0.0.0.0' ? undefined : `${transport}://${options.host}:${options.port}`,
    getRuntimeHealth: healthPayload,
    getSessions: () => mediaService?.listSessions() || [],
    getClientState: () => clientState.exportState(),
    replaceClientState: (snapshot) => clientState.importState(snapshot),
    bootstrapSecurity,
  });
  mediaService = createHeadlessMediaService({
    adminService,
    transcoder,
    cacheDir: options.paths.cacheDir,
    authorize: adminService.authorizeRequest,
  });
  const adminPage = createAdminPage({ htmlPath: options.adminHtmlPath });
  const adminApi = createAdminApiHandler({
    service: adminService,
    authorize: adminService.authorizeRequest,
    ownerConfigured: adminService.isOwnerConfigured,
    requireSecureTransport: options.requireSecureTransport === true,
    trustProxy: options.trustProxy === true,
    requestIsSecure,
  });
  const webApp = createWebAppPage({ htmlPath: options.webAppHtmlPath });
  const publicApi = createPublicApiHandler({
    service: adminService,
    clientState,
    mediaService,
    getRuntimeHealth: healthPayload,
    version: options.version,
    requireSecureTransport: options.requireSecureTransport === true,
    trustProxy: options.trustProxy === true,
    requestIsSecure,
  });

  const handleRequest = async (req, res) => {
    try {
      applySecurityHeaders(res);
      const requestUrl = new URL(req.url || '/', `${transport}://${req.headers.host || 'localhost'}`);
      const isPublicCleartextRoute = (req.method === 'GET' || req.method === 'HEAD') && (
        requestUrl.pathname === '/'
        || requestUrl.pathname === '/healthz'
        || requestUrl.pathname === '/api/health'
        || requestUrl.pathname === '/api/ping'
        || requestUrl.pathname === '/api/v1'
        || requestUrl.pathname === '/api/v1/discovery'
        || requestUrl.pathname === '/api/v1/health'
        || requestUrl.pathname === '/api/v1/auth/onboarding'
        || requestUrl.pathname === '/api/v1/openapi.json'
        || requestUrl.pathname === '/api/admin/bootstrap'
      );
      if (options.requireSecureTransport === true && !isPublicCleartextRoute && !requestIsSecure(req)) {
        jsonResponse(res, 426, {
          ok: false,
          error: 'secure_transport_required',
          message: 'Use HTTPS for credential, API, and media requests.',
        }, req.method);
        return;
      }
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
        jsonResponse(res, 200, await healthPayload(), req.method);
        return;
      }
      if (requestUrl.pathname === '/api/transcoder/capabilities' && (req.method === 'GET' || req.method === 'HEAD')) {
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
  };
  server = directTls
    ? https.createServer({ cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.2' }, handleRequest)
    : http.createServer(handleRequest);

  return {
    address() {
      return formatAddress(server, options.host);
    },
    async start() {
      if (server.listening) return this.address();
      assertTransportConfiguration({
        host: options.host,
        directTls,
        trustProxy: options.trustProxy === true,
        requireSecureTransport: options.requireSecureTransport === true,
        developmentAllowInsecureNonLoopback: options.developmentAllowInsecureNonLoopback === true,
      });
      await bootstrapSecurity.initialize({ ownerConfigured: await adminService.isOwnerConfigured() });
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
      stopPromise = new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        // Stop accepting new work and release keep-alive sockets while the
        // close callback waits for any request already in flight.
        server.closeIdleConnections?.();
        server.close((error) => {
          if (error) { reject(error); return; }
          void mediaService.stop().finally(resolve);
        });
      });
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
