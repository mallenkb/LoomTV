import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * HTTP contract for the headless LoomTV control plane.
 *
 * The desktop media server deliberately owns no admin state. A headless host
 * can compose this handler with the same core services used by Electron by
 * implementing `HeadlessAdminService` and passing an admin-token verifier.
 * Keeping the adapter here makes the browser control plane usable by a future
 * apps/server package without coupling it to Electron or better-sqlite3.
 */

export const HEADLESS_ADMIN_UI_PATH = '/admin/';
export const HEADLESS_ADMIN_API_PREFIX = '/api/admin';
export const HEADLESS_ADMIN_API_VERSION = 1;

export type AdminRootKind = 'movies' | 'tvShows' | 'anime' | 'others';
export type AdminRootState = 'online' | 'offline' | 'degraded' | 'scanning';
export type AdminScanMode = 'quick' | 'metadata' | 'full';
export type AdminScanState = 'idle' | 'queued' | 'scanning' | 'completed' | 'failed';
export type AdminHealthState = 'healthy' | 'degraded' | 'offline';

export interface AdminLibraryRoot {
  id: string;
  path: string;
  kind: AdminRootKind;
  state: AdminRootState;
  isNetworkLike?: boolean;
  itemCount?: number;
  lastScanAt?: number;
  message?: string;
}

export interface AdminScanStatus {
  state: AdminScanState;
  mode?: AdminScanMode;
  rootId?: string;
  startedAt?: number;
  completedAt?: number;
  scannedFiles?: number;
  totalFiles?: number;
  error?: string;
}

export interface AdminHealth {
  state: AdminHealthState;
  version: string;
  uptimeSeconds: number;
  database: 'healthy' | 'degraded' | 'unavailable';
  transcoder: 'available' | 'limited' | 'unavailable';
  storage?: {
    dataPath?: string;
    freeBytes?: number;
    totalBytes?: number;
  };
  checks?: Array<{
    name: string;
    state: 'pass' | 'warn' | 'fail';
    message?: string;
  }>;
}

export interface AdminSession {
  id: string;
  profileName?: string;
  clientName: string;
  clientType?: 'desktop' | 'browser' | 'mobile' | 'tv' | 'unknown';
  state: 'playing' | 'paused' | 'idle' | 'transcoding';
  mediaTitle?: string;
  bitrateKbps?: number;
  connectedAt: number;
  lastSeenAt: number;
  remoteAddress?: string;
}

export interface AdminLogEntry {
  id: string;
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AdminBackupStatus {
  state: 'ready' | 'running' | 'completed' | 'failed' | 'never';
  lastBackupAt?: number;
  destination?: string;
  sizeBytes?: number;
  error?: string;
  nextBackupAt?: number;
}

export interface AdminBootstrapPayload {
  apiVersion: typeof HEADLESS_ADMIN_API_VERSION;
  app: {
    name: 'LoomTV';
    version: string;
    uptimeSeconds: number;
    baseUrl?: string;
  };
  ownerConfigured: boolean;
  health: AdminHealth;
  library: {
    roots: AdminLibraryRoot[];
    scan: AdminScanStatus;
  };
  sessions: AdminSession[];
  backup: AdminBackupStatus;
}

export interface AdminOwnerInput {
  name: string;
  password: string;
}

export interface AdminOwnerResult {
  ownerId?: string;
  adminToken?: string;
  expiresAt?: number;
}

export interface AdminSessionInput {
  password: string;
}

export interface AdminSessionResult {
  adminToken: string;
  expiresAt?: number;
}

export interface AdminRootInput {
  path: string;
  kind?: AdminRootKind;
}

export interface AdminLibraryDirectory {
  name: string;
  path: string;
}

export interface AdminLibraryDirectoryResult {
  rootPath: string;
  path: string;
  parentPath: string | null;
  directories: AdminLibraryDirectory[];
}

export interface AdminScanInput {
  mode?: AdminScanMode;
  rootId?: string;
}

export interface AdminBackupInput {
  destination?: string;
}

export interface HeadlessAdminService {
  getBootstrap(): Promise<AdminBootstrapPayload> | AdminBootstrapPayload;
  createOwner(input: AdminOwnerInput): Promise<AdminOwnerResult> | AdminOwnerResult;
  createSession(input: AdminSessionInput): Promise<AdminSessionResult> | AdminSessionResult;
  listLibraryRoots(): Promise<AdminLibraryRoot[]> | AdminLibraryRoot[];
  listLibraryDirectories?(path?: string): Promise<AdminLibraryDirectoryResult> | AdminLibraryDirectoryResult;
  addLibraryRoot(input: AdminRootInput): Promise<AdminLibraryRoot> | AdminLibraryRoot;
  removeLibraryRoot(rootId: string): Promise<void> | void;
  getScanStatus(): Promise<AdminScanStatus> | AdminScanStatus;
  startLibraryScan(input: AdminScanInput): Promise<AdminScanStatus> | AdminScanStatus;
  getHealth(): Promise<AdminHealth> | AdminHealth;
  listSessions(): Promise<AdminSession[]> | AdminSession[];
  listLogs(limit: number): Promise<AdminLogEntry[]> | AdminLogEntry[];
  getBackupStatus(): Promise<AdminBackupStatus> | AdminBackupStatus;
  startBackup(input: AdminBackupInput): Promise<AdminBackupStatus> | AdminBackupStatus;
}

export interface HeadlessAdminHandlerOptions {
  service: HeadlessAdminService;
  /** Return true for a valid admin bearer token or trusted local request. */
  authorize: (req: IncomingMessage) => Promise<boolean> | boolean;
  /** A first-run bootstrap can be viewed before an owner exists. */
  ownerConfigured?: () => Promise<boolean> | boolean;
  /** Optional HTML provider; the static `headless/admin.html` is the default asset. */
  getAdminHtml?: () => Promise<string> | string;
  maxBodyBytes?: number;
  log?: (message: string, error?: unknown) => void;
}

export type HeadlessAdminHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

class AdminRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AdminRequestError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new AdminRequestError(400, `${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new AdminRequestError(400, `${field} is required.`);
  if (normalized.length > maxLength) throw new AdminRequestError(400, `${field} is too long.`);
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, field, maxLength);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AdminRequestError(400, `${field} is invalid.`);
  }
  return value as T;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  if (status === 204) {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  if (res.req?.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: code, message });
}

function sendHtml(res: ServerResponse, html: string): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  if (res.req?.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(html);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      reject(new AdminRequestError(413, 'Request body is too large.'));
      return;
    }

    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new AdminRequestError(408, 'Request body timed out.'));
    }, 10_000);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        chunks.length = 0;
        req.resume();
        finish(() => reject(new AdminRequestError(413, 'Request body is too large.')));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks, size).toString('utf8').trim();
      if (!raw) {
        finish(() => resolve({}));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) throw new AdminRequestError(400, 'JSON body must be an object.');
        finish(() => resolve(parsed));
      } catch (error) {
        finish(() => reject(error instanceof AdminRequestError
          ? error
          : new AdminRequestError(400, 'Request body is not valid JSON.')));
      }
    });
    req.on('error', (error) => finish(() => reject(error)));
  });
}

function queryLimit(value: string | null): number {
  if (!value) return 100;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new AdminRequestError(400, 'limit must be an integer between 1 and 500.');
  }
  return parsed;
}

function pathFor(req: IncomingMessage): URL {
  return new URL(req.url || '/', 'http://loomtv.local');
}

/**
 * Build a request handler that returns `true` only for routes owned by the
 * admin surface. Callers can fall through to media playback routes otherwise.
 */
export function createHeadlessAdminHandler(options: HeadlessAdminHandlerOptions): HeadlessAdminHandler {
  const {
    service,
    authorize,
    ownerConfigured = async () => (await service.getBootstrap()).ownerConfigured,
    getAdminHtml,
    maxBodyBytes = 128 * 1024,
    log = (message, error) => console.error(`[headless-admin] ${message}`, error || ''),
  } = options;

  return async (req, res): Promise<boolean> => {
    const requestUrl = pathFor(req);
    const pathname = requestUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();
    const isAdminPage = pathname === '/admin' || pathname === HEADLESS_ADMIN_UI_PATH;
    const isAdminApi = pathname === HEADLESS_ADMIN_API_PREFIX || pathname.startsWith(`${HEADLESS_ADMIN_API_PREFIX}/`);
    if (!isAdminPage && !isAdminApi) return false;

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Loom-Admin-Token',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return true;
    }

    if (isAdminPage) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', 'The admin page only supports GET.');
        return true;
      }
      if (!getAdminHtml) {
        sendError(res, 503, 'admin_ui_unavailable', 'The headless admin UI asset is not configured.');
        return true;
      }
      sendHtml(res, await getAdminHtml());
      return true;
    }

    const isBootstrap = pathname === `${HEADLESS_ADMIN_API_PREFIX}/bootstrap`;
    const isOwnerCreate = pathname === `${HEADLESS_ADMIN_API_PREFIX}/onboarding/owner` && method === 'POST';
    const isSessionCreate = pathname === `${HEADLESS_ADMIN_API_PREFIX}/session` && method === 'POST';
    const configured = await ownerConfigured();
    const isPublicBootstrap = isBootstrap && !configured;
    // Session creation is deliberately public so the first browser request can
    // exchange the owner password for a short-lived admin bearer token. The
    // service must rate-limit and verify that password before issuing a token.
    if (!isPublicBootstrap && !isOwnerCreate && !isSessionCreate) {
      let authorized = false;
      try {
        authorized = await authorize(req);
      } catch (error) {
        log('authorization failed', error);
      }
      if (!authorized) {
        sendError(res, 401, 'admin_auth_required', 'A valid LoomTV admin token is required.');
        return true;
      }
    }

    try {
      if (isBootstrap && method === 'GET') {
        sendJson(res, 200, await service.getBootstrap());
        return true;
      }

      if (isOwnerCreate) {
        if (configured) {
          sendError(res, 409, 'owner_already_configured', 'The LoomTV owner has already been created.');
          return true;
        }
        const body = await readBody(req, maxBodyBytes);
        const result = await service.createOwner({
          name: requiredString(body.name, 'name', 80),
          password: requiredString(body.password, 'password', 256),
        });
        sendJson(res, 201, result);
        return true;
      }

      if (pathname === `${HEADLESS_ADMIN_API_PREFIX}/session` && method === 'POST') {
        const body = await readBody(req, maxBodyBytes);
        const result = await service.createSession({
          password: requiredString(body.password, 'password', 256),
        });
        sendJson(res, 200, result);
        return true;
      }

      if (pathname === `${HEADLESS_ADMIN_API_PREFIX}/library/roots`) {
        if (method === 'GET') {
          sendJson(res, 200, { roots: await service.listLibraryRoots() });
          return true;
        }
        if (method === 'POST') {
          const body = await readBody(req, maxBodyBytes);
          const kind = oneOf(body.kind, ['movies', 'tvShows', 'anime', 'others'] as const, 'kind');
          const root = await service.addLibraryRoot({
            path: requiredString(body.path, 'path', 4_096),
            ...(kind ? { kind } : {}),
          });
          sendJson(res, 201, root);
          return true;
        }
      }

      if (pathname === `${HEADLESS_ADMIN_API_PREFIX}/library/browse` && method === 'GET') {
        if (typeof service.listLibraryDirectories !== 'function') {
          sendError(res, 501, 'mounted_folder_browsing_unavailable', 'Mounted-folder browsing is not available on this server. Enter the server path manually.');
          return true;
        }
        const requestedPath = optionalString(requestUrl.searchParams.get('path'), 'path', 4_096);
        sendJson(res, 200, await service.listLibraryDirectories(requestedPath));
        return true;
      }

      if (pathname.startsWith(`${HEADLESS_ADMIN_API_PREFIX}/library/roots/`) && method === 'DELETE') {
        const rootId = decodeURIComponent(pathname.slice(`${HEADLESS_ADMIN_API_PREFIX}/library/roots/`.length));
        if (!rootId || rootId.length > 512) throw new AdminRequestError(400, 'rootId is invalid.');
        await service.removeLibraryRoot(rootId);
        sendJson(res, 204, null);
        return true;
      }

      if (pathname === `${HEADLESS_ADMIN_API_PREFIX}/library/scan`) {
        if (method === 'GET') {
          sendJson(res, 200, await service.getScanStatus());
          return true;
        }
        if (method === 'POST') {
          const body = await readBody(req, maxBodyBytes);
          const mode = oneOf(body.mode, ['quick', 'metadata', 'full'] as const, 'mode');
          const rootId = optionalString(body.rootId, 'rootId', 512);
          sendJson(res, 202, await service.startLibraryScan({
            ...(mode ? { mode } : {}),
            ...(rootId ? { rootId } : {}),
          }));
          return true;
        }
      }

      if (pathname === `${HEADLESS_ADMIN_API_PREFIX}/health` && method === 'GET') {
        sendJson(res, 200, await service.getHealth());
        return true;
      }

      if (pathname === `${HEADLESS_ADMIN_API_PREFIX}/sessions` && method === 'GET') {
        sendJson(res, 200, { sessions: await service.listSessions() });
        return true;
      }

      if (pathname === `${HEADLESS_ADMIN_API_PREFIX}/logs` && method === 'GET') {
        sendJson(res, 200, { logs: await service.listLogs(queryLimit(requestUrl.searchParams.get('limit'))) });
        return true;
      }

      if (pathname === `${HEADLESS_ADMIN_API_PREFIX}/backup`) {
        if (method === 'GET') {
          sendJson(res, 200, await service.getBackupStatus());
          return true;
        }
        if (method === 'POST') {
          const body = await readBody(req, maxBodyBytes);
          const destination = optionalString(body.destination, 'destination', 4_096);
          sendJson(res, 202, await service.startBackup(destination ? { destination } : {}));
          return true;
        }
      }

      sendError(res, 404, 'admin_route_not_found', 'The requested admin route does not exist.');
      return true;
    } catch (error) {
      if (error instanceof AdminRequestError) {
        sendError(res, error.status, 'invalid_request', error.message);
        return true;
      }
      log(`request failed: ${method} ${pathname}`, error);
      sendError(res, 500, 'admin_request_failed', 'The admin request could not be completed.');
      return true;
    }
  };
}
