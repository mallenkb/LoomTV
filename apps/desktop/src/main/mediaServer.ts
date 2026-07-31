import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Socket as NodeSocket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { getImageMimeType, getMimeType, getSubtitleMimeType } from './mimeTypes';
import { findFFmpeg, preferredH264HardwareEncoder } from './mediaBinaries';
import {
  parseSubtitleStyle,
  queryNumber,
} from './transcodeFilters';
import { parseIntegerTag } from './mediaTags';
import { srtToVtt } from './libraryItemHelpers';
import {
  authorizeHlsStreamRequest,
  HLS_STREAM_TOKEN_QUERY_PARAM,
  issueHlsStreamCredential,
  registerTranscodeSessionDisposalListener,
  serveHls,
  startTranscode,
  stopTranscode,
} from './transcodeManager';
import { acquireFfmpegToolSlot, acquirePlaybackActivityLease, registerPlaybackProcess, touchPlaybackProcess } from './ffmpegGovernor';
import { buildEmbeddedSubtitleVttArgs } from './transcodePlan';
import { cachedArtworkResponseHeaders } from './artworkCache';
import { trackServerConnections } from './updateInstall';
import {
  cacheArtworkSource,
  createProfile,
  getAllProgress,
  getCachedArtwork,
  getCustomArtworkData,
  getPlaybackTrackPreferences,
  getProfileLists,
  getProfilePreferences,
  savePlaybackTrackPreferences,
  saveProfilePreferences,
  saveProgress,
  setProfileListEntry,
} from './database';
import { getLocalNetworkAddresses, getLocalNetworkName } from './networkInfo';
import type { TranscodeOptions } from './mediaTypes';
import { browserPlaybackPlan } from './transcodeDecision';
import { probeMedia } from './mediaProbe';
import { isSubtitleFileName, isVideoFileName } from './fileClassification';
import { streamStartFailure } from './streamStartErrors';
import { parseHttpByteRange } from './httpByteRange';
import {
  bindHlsProfile,
  consumeHlsStartBudget,
  deleteHlsProfileBinding,
  getHlsProfileBinding,
} from './hlsRequestPolicy';
import { registerResource, resolveExternalArtworkResource, resolveLocalResource } from './resourceRegistry';
import {
  createAndSelectGuest,
  broadcastProfilesChanged,
  DESKTOP_DEVICE_ID,
  getActiveProfileState,
  lockProfile,
  ProfileError,
  profileSummaries,
  requireDesktopProfileId,
  requireOwner,
  revokeDeviceProfileAccess,
  resolveLanProfileId,
  selectProfile,
  setAutomaticSignIn,
} from './profileService';
import type { ProfileListKind } from './database.ts';
import { canWriteResponse, handleResponseErrors, pipeResponse } from './httpResponses';
import {
  deviceHasLanScope,
  mediaServerRouteAccess,
  type LanRouteScope,
} from './lanRoutePolicy';
import type { AppSettings, LanPairedDevice } from './appContracts.ts';
import type { LanTlsIdentity } from './lanTlsIdentity.ts';
import {
  sanitizeRendererSettingsPatch,
  settingsForRenderer,
} from './rendererSettings.ts';
import { buildBrowserStreamArgs } from './streamTranscodePlan.ts';
import type {
  LibraryIndexPayload,
  LibraryItemDetailsPayload,
  LibraryPayload,
  MediaSegmentResponse,
} from '../shared/desktopProtocol.ts';

export interface MediaServerDependencies {
  ALLOWED_CORS_ORIGINS: ReadonlySet<string>;
  LOCAL_ACCESS_HEADER: string;
  LOCAL_ACCESS_TOKEN: string;
  allowedCorsOrigin: (origin: string | undefined, allowedOrigins: ReadonlySet<string>) => string | null;
  authorizeLanRequest: (reqUrl: URL, req: http.IncomingMessage) => { ok: boolean; device?: LanPairedDevice };
  authorizeLocalRequest: (reqUrl: URL, req: http.IncomingMessage) => boolean;
  assertProfileCanAccessPath: (profileId: string, filePath: string) => void;
  assertSubtitleCanAccessMediaPath: (profileId: string, mediaFilePath: string, subtitleFilePath: string) => void;
  decodeDataUrl: (dataUrl: string) => { buffer: Buffer; mimeType: string } | null;
  getLanServerBase: () => string | null;
  getLibraryRevision: () => number;
  getMediaSegments: (request: { mediaId: string; season?: number; episode?: number }) => Promise<MediaSegmentResponse>;
  getWebRendererDevServerUrl: () => string | null;
  getWebRendererRoot: () => string | null;
  handleLanPairRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  handleLanRefreshRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  isExternalArtworkUrl: (source: string) => boolean;
  isImageFileName: (fileName: string) => boolean;
  isLanSharingEnabled: () => boolean;
  isLoopbackRequest: (req: http.IncomingMessage) => boolean;
  isSignedLanRequestValid: (reqUrl: URL) => boolean;
  lanTlsIdentity: LanTlsIdentity;
  libraryEtagFor: (payload: unknown) => string;
  compactLibraryIndexForLocalNetwork: (profileId: string, deviceId: string | undefined, revision: number) => LibraryIndexPayload;
  compactLibraryItemForLocalNetwork: (mediaId: string, profileId: string, deviceId: string | undefined, revision: number) => LibraryItemDetailsPayload | null;
  compactLibraryIndexForRenderer: (revision: number) => LibraryIndexPayload;
  compactLibraryItemForRenderer: (mediaId: string, revision: number) => LibraryItemDetailsPayload | null;
  getRendererCatalogIdentity: () => string;
  libraryForLocalNetwork: (profileId?: string, deviceId?: string) => LibraryPayload;
  profileRestrictionIdentity: (profileId: string) => string;
  libraryForRenderer: () => LibraryPayload;
  loadLibrary: () => { libraryFolders: string[] };
  loadSettings: () => AppSettings;
  readJsonBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>;
  requireLocalOrLanAccess: (reqUrl: URL, req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  requireStreamAccess: (reqUrl: URL, req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  safeEndResponse: (res: http.ServerResponse) => void;
  saveSettings: (settings: AppSettings) => void;
  writeJson: (res: http.ServerResponse, status: number, payload: unknown) => void;
}

let mediaServer: http.Server | null = null;
let lanMediaServer: https.Server | null = null;
let mediaServerPort = 3847;
let lanMediaServerPort = 0;
let lanCertificateFingerprint = '';
const mediaServerSockets = new Set<NodeSocket>();
const lanMediaServerSockets = new Set<NodeSocket>();
const LAN_IMAGE_CACHE_QUERY_PARAM = 'loomtvImageCache';
const LAN_IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable';
const THUMBNAIL_SCALE_FILTER = "scale='min(640,iw)':-2";
const ALL_LOCAL_RESOURCE_KINDS = new Set(['media', 'subtitle', 'image'] as const);
const MEDIA_RESOURCE_KIND = new Set(['media'] as const);
const SUBTITLE_RESOURCE_KIND = new Set(['subtitle'] as const);
const OPAQUE_RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SIDECAR_SUBTITLE_BYTES = 8 * 1024 * 1024;
const SUBTITLE_READ_CHUNK_BYTES = 64 * 1024;
const V2_LIBRARY_ITEM_PREFIX = '/api/v2/library/items/';
const RENDERER_LIBRARY_ITEM_PREFIX = '/api/renderer/library/items/';

registerTranscodeSessionDisposalListener((sessionId) => {
  deleteHlsProfileBinding(sessionId);
});

function libraryItemIdFromPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const encodedId = pathname.slice(prefix.length);
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
}

export function getMediaServer(): http.Server | null { return mediaServer; }
export function getLanMediaServer(): https.Server | null { return lanMediaServer; }
export function getMediaServerPort(): number { return mediaServerPort; }
export function getLanMediaServerPort(): number { return lanMediaServerPort; }
export function getLanCertificateFingerprint(): string { return lanCertificateFingerprint; }
export function getMediaServerSockets(): Set<NodeSocket> { return mediaServerSockets; }
export function getLanMediaServerSockets(): Set<NodeSocket> { return lanMediaServerSockets; }
export function setMediaServer(server: http.Server | null): void { mediaServer = server; }
export function setLanMediaServer(server: https.Server | null): void { lanMediaServer = server; }

class SubtitleFileTooLargeError extends Error {}

async function readBoundedUtf8Subtitle(filePath: string, signal: AbortSignal): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Subtitle resource is not a regular file.');
    if (stats.size > MAX_SIDECAR_SUBTITLE_BYTES) throw new SubtitleFileTooLargeError();

    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.allocUnsafe(SUBTITLE_READ_CHUNK_BYTES);
    let bytesReadTotal = 0;
    const bodyChunks: string[] = [];
    while (!signal.aborted) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return bodyChunks.join('') + decoder.end();
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > MAX_SIDECAR_SUBTITLE_BYTES) throw new SubtitleFileTooLargeError();
      bodyChunks.push(decoder.write(chunk.subarray(0, bytesRead)));
    }
    throw new Error('Subtitle request was cancelled.');
  } finally {
    await handle.close();
  }
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function writeLanLandingPage(
  res: http.ServerResponse,
  details: {
    baseUrl: string | null;
    deviceName: string;
    networkName: string;
    sharingEnabled: boolean;
  },
): void {
  const baseUrl = details.baseUrl || `http://127.0.0.1:${mediaServerPort}`;
  const statusCopy = details.sharingEnabled
    ? 'Local Network Sharing is on. Library and stream endpoints stay private until a device pairs with the code shown in desktop Settings.'
    : 'Local Network Sharing is off. Turn it on in desktop Settings before pairing a phone or tablet.';
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LoomTV</title>
<style>
:root{color-scheme:dark;--bg:#050505;--panel:#101010;--line:#2a2a2a;--text:#fff;--muted:#a4a4a4;--accent:#FC9C03;}
*{box-sizing:border-box;letter-spacing:normal!important}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;display:grid;place-items:center;padding:24px}
main{width:min(680px,100%);background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.38)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}.mark{width:38px;height:38px;border-radius:12px;background:var(--accent);display:grid;place-items:center;color:#08101a;font-weight:900}.name{font-size:24px;font-weight:800}
.eyebrow{font-size:12px;font-weight:800;text-transform:uppercase;color:var(--accent);margin-bottom:8px}h1{font-size:clamp(28px,7vw,44px);line-height:1.06;margin:0 0 12px}p{margin:0;color:var(--muted)}
.box{border:1px solid var(--line);border-radius:14px;background:#080808;padding:16px;margin-top:18px}.label{font-size:12px;font-weight:800;text-transform:uppercase;color:#767676;margin-bottom:6px}.value{font:700 18px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
ol{margin:18px 0 0;padding-left:22px;color:var(--muted)}li{margin:8px 0}b{color:var(--text)}footer{margin-top:22px;border-top:1px solid var(--line);padding-top:16px;font-size:13px;color:#7b7b7b}
</style>
</head>
<body>
<main>
<div class="brand"><div class="mark">L</div><div class="name">loomtv</div></div>
<div class="eyebrow">LAN host online</div>
<h1>This is your private LoomTV library.</h1>
<p>${htmlEscape(statusCopy)}</p>
<div class="box"><div class="label">Desktop address</div><div class="value">${htmlEscape(baseUrl)}</div></div>
<ol>
<li>Open <b>LoomTV mobile</b>, not this browser page.</li>
<li>In the mobile app, choose <b>Pair device</b>.</li>
<li>Enter this desktop address and the <b>6-digit pairing PIN shown in desktop Settings &gt; Network</b>.</li>
</ol>
<footer>${htmlEscape(details.deviceName)} &middot; ${htmlEscape(details.networkName)}</footer>
</main>
</body>
</html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const WEB_ASSET_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveWebRendererAsset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqUrl: URL,
  rendererRoot: string,
): void {
  if (reqUrl.pathname === '/app') {
    res.writeHead(302, { Location: '/app/', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(reqUrl.pathname.slice('/app/'.length)) || 'index.html';
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  const root = path.resolve(rendererRoot);
  const candidate = path.resolve(root, relativePath);
  const relativeCandidate = path.relative(root, candidate);
  if (relativeCandidate.startsWith('..') || path.isAbsolute(relativeCandidate)) {
    res.writeHead(403);
    res.end();
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }

  const extension = path.extname(candidate).toLowerCase();
  res.writeHead(200, {
    'Content-Type': WEB_ASSET_CONTENT_TYPES[extension] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(candidate).pipe(res);
}

function proxyWebRendererAsset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqUrl: URL,
  devServerUrl: string,
): void {
  const target = new URL(devServerUrl);
  target.pathname = reqUrl.pathname.startsWith('/app/')
    ? `/${reqUrl.pathname.slice('/app/'.length)}`
    : reqUrl.pathname;
  target.search = reqUrl.search;
  const proxyRequest = http.request(target, {
    method: req.method,
    headers: {
      ...req.headers,
      host: target.host,
    },
  }, (proxyResponse) => {
    res.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
    proxyResponse.pipe(res);
  });
  proxyRequest.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('The LoomTV web development server is unavailable.');
  });
  proxyRequest.end();
}

function applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse, deps: MediaServerDependencies): boolean {
  const { allowedCorsOrigin, ALLOWED_CORS_ORIGINS, LOCAL_ACCESS_HEADER } = deps;
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  const allowedOrigin = allowedCorsOrigin(origin, ALLOWED_CORS_ORIGINS);
  res.setHeader('Vary', 'Origin');
  if (!allowedOrigin) return !origin;

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', `Range, Content-Type, Authorization, If-None-Match, X-Loom-Profile-Api-Version, ${LOCAL_ACCESS_HEADER}`);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  return true;
}

function listenWithPortRetries(
  server: http.Server | https.Server,
  initialPort: number,
  host: string,
  label: string,
): Promise<number> {
  const maxAttempts = 20;
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = (port: number) => {
      attempts += 1;
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && attempts < maxAttempts && port < 65_535) {
          attempt(port + 1);
          return;
        }
        reject(error.code === 'EADDRINUSE'
          ? new Error(`${label} could not bind after ${attempts} ports from ${initialPort}.`, { cause: error })
          : error);
      };
      server.once('error', onError);
      try {
        server.listen(port, host, () => {
          server.off('error', onError);
          server.on('error', (error) => console.error(`[media-server] ${label} error:`, error));
          resolve(port);
        });
      } catch (error) {
        server.off('error', onError);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    attempt(initialPort);
  });
}

function rendererRequestOrigin(req: http.IncomingMessage): string | null {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (origin) return origin;

  // Same-origin GET requests may omit Origin. Accept the referrer only when
  // Chromium also identifies the request as same-origin; this keeps ordinary
  // originless localhost clients outside the renderer compatibility surface.
  if (req.headers['sec-fetch-site'] !== 'same-origin') return null;
  const referer = Array.isArray(req.headers.referer) ? req.headers.referer[0] : req.headers.referer;
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function isTrustedRendererHttpOrigin(
  req: http.IncomingMessage,
  deps: MediaServerDependencies,
): boolean {
  const origin = rendererRequestOrigin(req);
  if (!origin) return false;
  if (deps.allowedCorsOrigin(origin, deps.ALLOWED_CORS_ORIGINS)) return true;

  // The optional /app/ browser renderer is served by this process. Its port is
  // selected at runtime, so admit only the exact loopback media-server origin.
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    const isLoopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
    return parsed.protocol === 'http:'
      && isLoopbackHost
      && parsed.port === String(mediaServerPort);
  } catch {
    return false;
  }
}

export async function startMediaServer(deps: MediaServerDependencies): Promise<number> {
  const {
    LOCAL_ACCESS_TOKEN,
    authorizeLanRequest,
    authorizeLocalRequest,
    assertProfileCanAccessPath,
    assertSubtitleCanAccessMediaPath,
    decodeDataUrl,
    getLanServerBase,
    getLibraryRevision,
    getMediaSegments,
    getWebRendererDevServerUrl,
    getWebRendererRoot,
    handleLanPairRequest,
    handleLanRefreshRequest,
    isExternalArtworkUrl,
    isImageFileName,
    isLanSharingEnabled,
    isLoopbackRequest,
    isSignedLanRequestValid,
    lanTlsIdentity,
    libraryEtagFor,
    compactLibraryIndexForLocalNetwork,
    compactLibraryItemForLocalNetwork,
    compactLibraryIndexForRenderer,
    compactLibraryItemForRenderer,
    getRendererCatalogIdentity,
    libraryForLocalNetwork,
    libraryForRenderer,
    loadLibrary,
    loadSettings,
    profileRestrictionIdentity,
    readJsonBody,
    requireLocalOrLanAccess,
    requireStreamAccess,
    safeEndResponse,
    saveSettings,
    writeJson,
  } = deps;
  const createRequestHandler = (listenerScope: 'loopback' | 'lan') => (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
      handleResponseErrors(res);
      const corsAllowed = applyCorsHeaders(req, res, deps);
      // Listener identity, not a request-controlled address, defines the trust
      // boundary. Calls to the TLS listener remain LAN-scoped even if a local
      // process reaches it through 127.0.0.1.
      const loopbackRequest = listenerScope === 'loopback' && isLoopbackRequest(req);

      if (req.method === 'OPTIONS') {
        res.writeHead(corsAllowed ? 204 : 403);
        res.end();
        return;
      }
      if (!corsAllowed && !loopbackRequest) {
        writeJson(res, 403, { error: 'Browser origins are not accepted by the LAN API.' });
        return;
      }

      const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${mediaServerPort}`);
      const routeAccess = mediaServerRouteAccess(reqUrl.pathname, req.method || 'GET');
      // The paired device behind this request, when LAN-authorized. Local
      // desktop requests keep null and resolve to the desktop's profile.
      let lanDeviceId: string | null = null;
      let lanAuthorization: { ok: boolean; device?: LanPairedDevice } | undefined;
      const getLanAuthorization = (): { ok: boolean; device?: LanPairedDevice } => {
        lanAuthorization ??= authorizeLanRequest(reqUrl, req);
        return lanAuthorization;
      };
      const requireV2Scope = (requiredScope: LanRouteScope): boolean => {
        if (authorizeLocalRequest(reqUrl, req)) return true;
        if (loopbackRequest) {
          writeJson(res, 401, { error: 'Authenticated desktop access is required.' });
          return false;
        }
        const authorization = getLanAuthorization();
        const device = authorization.device;
        lanDeviceId = device?.id ?? null;
        const authorized = Boolean(device && deviceHasLanScope(device.scopes, requiredScope));
        if (!authorized) {
          writeJson(res, authorization.ok ? 403 : 401, {
            error: authorization.ok
              ? `The paired device does not have the ${requiredScope} scope.`
              : 'A valid paired-device access token is required.',
          });
        }
        return authorized;
      };
      const usesProfileApi = req.headers['x-loom-profile-api-version'] === '1';
      const writeProfileError = (error: unknown): void => {
        if (error instanceof ProfileError) {
          const status = error.code === 'profile_required' || error.code === 'stale_profile_selection'
            ? 409
            : error.code === 'content_restricted' || error.code === 'owner_required'
              ? 403
              : 401;
          writeJson(res, status, {
            error: error.code,
            ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
          });
          return;
        }
        writeJson(res, 500, { error: 'profile_operation_failed' });
      };
      const profileIdForRequest = (): string | null => {
        try {
          return resolveLanProfileId(lanDeviceId, usesProfileApi);
        } catch (error) {
          writeProfileError(error);
          return null;
        }
      };
      const profileDeviceIdForRequest = (): string | null => (
        lanDeviceId || (authorizeLocalRequest(reqUrl, req) ? DESKTOP_DEVICE_ID : null)
      );
      const catalogProfileIdentity = (profileId: string): object => ({
        restrictions: profileRestrictionIdentity(profileId),
        deviceId: lanDeviceId || DESKTOP_DEVICE_ID,
        selectionRevision: lanDeviceId ? getActiveProfileState(lanDeviceId).selectionRevision : 0,
        delivery: libraryEtagFor({
          baseAddress: getLanServerBase() || `http://127.0.0.1:${mediaServerPort}`,
          signingSecret: loadSettings().localNetworkHmacSecret || '',
        }),
      });
      const catalogEtag = (
        representation: 'index' | 'item',
        revision: number,
        profileIdentity: unknown,
        mediaId?: string,
      ): string => `"${libraryEtagFor({
        catalogVersion: 1,
        representation,
        libraryRevision: revision,
        profile: profileIdentity,
        ...(mediaId ? { mediaId } : {}),
      })}"`;
      const writeCatalogRepresentation = (etag: string, payload: () => unknown): void => {
        const requestEtag = String(req.headers['if-none-match'] || '');
        if (requestEtag === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' });
          res.end();
          return;
        }
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        writeJson(res, 200, payload());
      };
      const assertCurrentSelectionRevision = (body: Record<string, unknown>): void => {
        if (!usesProfileApi || !lanDeviceId) return;
        const expected = Number(body.selectionRevision);
        const active = getActiveProfileState(lanDeviceId);
        if (!Number.isSafeInteger(expected) || expected !== active.selectionRevision) {
          throw new ProfileError('stale_profile_selection', 'The profile selection changed before this request completed.');
        }
      };
      const profileIdentityForMedia = (): { deviceId: string; profileId: string; selectionRevision: number } | null => {
        const boundDeviceId = reqUrl.searchParams.get('deviceId') || '';
        const boundProfileId = reqUrl.searchParams.get('profileId') || '';
        const boundRevision = Number(reqUrl.searchParams.get('selectionRevision'));
        const credentialDeviceId = authorizeLocalRequest(reqUrl, req)
          ? DESKTOP_DEVICE_ID
          : getLanAuthorization().device?.id || lanDeviceId || '';
        if (credentialDeviceId && boundDeviceId && credentialDeviceId !== boundDeviceId) return null;
        const signedDeviceId = !credentialDeviceId && isSignedLanRequestValid(reqUrl) ? boundDeviceId : '';
        const authorizedDeviceId = credentialDeviceId || signedDeviceId;
        if (authorizedDeviceId) {
          const active = getActiveProfileState(authorizedDeviceId);
          const profileId = boundProfileId || active.profileId;
          if (
            !profileId
            || (boundProfileId && active.profileId !== boundProfileId)
            || (Number.isFinite(boundRevision) && boundRevision > 0 && active.selectionRevision !== boundRevision)
          ) return null;
          return { deviceId: authorizedDeviceId, profileId, selectionRevision: active.selectionRevision };
        }
        const profileId = profileIdForRequest();
        return profileId ? { deviceId: '', profileId, selectionRevision: 0 } : null;
      };
      const requireProfileMediaAccess = (candidatePath: string): { deviceId: string; profileId: string; selectionRevision: number } | null => {
        const identity = profileIdentityForMedia();
        if (!identity) {
          writeJson(res, 409, { error: 'stale_profile_selection' });
          return null;
        }
        try {
          assertProfileCanAccessPath(identity.profileId, candidatePath);
          return identity;
        } catch (error) {
          writeProfileError(error);
          return null;
        }
      };
      const requestedPath = reqUrl.searchParams.get('path') || '';
      const resourceId = reqUrl.searchParams.get('resourceId') || '';
      let libraryRoots: string[] | null = null;
      const getLibraryRoots = (): string[] => {
        libraryRoots ??= loadLibrary().libraryFolders || [];
        return libraryRoots;
      };
      let filePath = requestedPath;
      if (!loopbackRequest) {
        filePath = resourceId
          ? (() => {
              try {
                return resolveLocalResource(resourceId, ALL_LOCAL_RESOURCE_KINDS, getLibraryRoots());
              } catch {
                return '';
              }
            })()
          : '';
      }
      const startSec = parseFloat(reqUrl.searchParams.get('t') || '0');

      const webDevServerUrl = getWebRendererDevServerUrl();
      const isWebAppRoute = reqUrl.pathname === '/app' || reqUrl.pathname.startsWith('/app/');
      const isViteAssetRoute = Boolean(webDevServerUrl) && (
        reqUrl.pathname.startsWith('/@')
        || reqUrl.pathname.startsWith('/src/')
        || reqUrl.pathname.startsWith('/node_modules/')
        || reqUrl.pathname === '/package.json'
      );
      if ((req.method === 'GET' || req.method === 'HEAD') && (isWebAppRoute || isViteAssetRoute)) {
        if (!loopbackRequest) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (webDevServerUrl) {
          proxyWebRendererAsset(req, res, reqUrl, webDevServerUrl);
          return;
        }
        const rendererRoot = getWebRendererRoot();
        if (!rendererRoot) {
          res.writeHead(404);
          res.end();
          return;
        }
        serveWebRendererAsset(req, res, reqUrl, rendererRoot);
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/' && loopbackRequest) {
        res.writeHead(302, { Location: '/app/', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (req.method === 'GET' && (reqUrl.pathname === '/' || reqUrl.pathname === '/pair')) {
        const settings = loadSettings();
        writeLanLandingPage(res, {
          baseUrl: getLanServerBase(),
          deviceName: settings.localNetworkDeviceName || os.hostname(),
          networkName: getLocalNetworkName(),
          sharingEnabled: isLanSharingEnabled(),
        });
        return;
      }

      if (reqUrl.pathname === '/api/ping' && req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store');
        writeJson(res, 200, {
          ok: true,
          port: loopbackRequest ? mediaServerPort : lanMediaServerPort,
          transport: loopbackRequest ? 'loopback-http' : 'tls',
          ...(!loopbackRequest ? { certFingerprint: lanCertificateFingerprint } : {}),
        });
        return;
      }

      if (reqUrl.pathname === '/api/renderer/session' && req.method === 'POST') {
        if (!loopbackRequest || !isTrustedRendererHttpOrigin(req, deps)) {
          writeJson(res, 403, { error: 'A trusted renderer origin is required.' });
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        writeJson(res, 200, { localAccessToken: LOCAL_ACCESS_TOKEN });
        return;
      }

      if (reqUrl.pathname === '/api/lan/info') {
        const settings = loadSettings();
        writeJson(res, 200, {
          ok: true,
          app: 'LoomTV',
          deviceId: settings.localNetworkDeviceId,
          deviceName: settings.localNetworkDeviceName || os.hostname(),
          sharingEnabled: Boolean(settings.localNetworkSharingEnabled),
          networkName: getLocalNetworkName(),
          port: loopbackRequest ? mediaServerPort : lanMediaServerPort,
          transport: loopbackRequest ? 'loopback-http' : 'tls',
          ...(!loopbackRequest ? { certFingerprint: lanCertificateFingerprint } : {}),
          addresses: getLocalNetworkAddresses(),
        });
        return;
      }

      if (routeAccess.kind === 'legacy') {
        writeJson(res, 426, {
          error: 'This LoomTV client must be upgraded and paired again using LAN protocol v2.',
          protocolVersion: 2,
        });
        return;
      }

      if (reqUrl.pathname === '/api/v2/pair' && req.method === 'POST') {
        handleLanPairRequest(req, res).catch((error) => {
          console.error('[lan/pair] error', error);
          writeJson(res, 500, { error: 'Pairing failed' });
        });
        return;
      }

      if (reqUrl.pathname === '/api/v2/auth/refresh' && req.method === 'POST') {
        handleLanRefreshRequest(req, res).catch((error) => {
          console.error('[lan/refresh] error', error);
          writeJson(res, 500, { error: 'Credential refresh failed' });
        });
        return;
      }

      if (reqUrl.pathname === '/api/v2/unpair' && req.method === 'POST') {
        if (!requireV2Scope('device:self')) return;
        const authenticatedDevice = getLanAuthorization().device;
        if (!authenticatedDevice) {
          writeJson(res, 401, { error: 'A paired-device credential is required to revoke this device.' });
          return;
        }
        readJsonBody(req)
          .then((body) => {
            if (Object.prototype.hasOwnProperty.call(body, 'deviceId')) {
              writeJson(res, 409, {
                error: 'device_identity_is_credential_bound',
                message: 'Update LoomTV and retry without a caller-supplied deviceId.',
              });
              return;
            }
            const settings = loadSettings();
            if (!(settings.localNetworkPairedDevices || []).some((device) => device.id === authenticatedDevice.id)) {
              writeJson(res, 401, { error: 'The paired-device credential has already been revoked.' });
              return;
            }
            const remaining = (settings.localNetworkPairedDevices || []).filter((device) => device.id !== authenticatedDevice.id);
            revokeDeviceProfileAccess(authenticatedDevice.id);
            saveSettings({ ...settings, localNetworkPairedDevices: remaining });
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => {
            console.error('[lan/unpair] error', error);
            writeJson(res, 500, { error: 'Unpair failed' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/v2/library' && req.method === 'GET') {
        if (!requireV2Scope('catalog:read')) return;
        const profileId = profileIdForRequest();
        if (!profileId) return;
        const payload = libraryForLocalNetwork(profileId, lanDeviceId || undefined);
        const etag = `"${libraryEtagFor({ payload, profile: profileRestrictionIdentity(profileId), libraryRevision: getLibraryRevision() })}"`;
        const requestEtag = (req.headers['if-none-match'] || '') as string;
        if (requestEtag && requestEtag === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'no-cache');
        writeJson(res, 200, payload);
        return;
      }

      if (reqUrl.pathname === '/api/v2/library/index' && req.method === 'GET') {
        if (!requireV2Scope('catalog:read')) return;
        const profileId = profileIdForRequest();
        if (!profileId) return;
        const revision = getLibraryRevision();
        const etag = catalogEtag('index', revision, catalogProfileIdentity(profileId));
        writeCatalogRepresentation(etag, () => compactLibraryIndexForLocalNetwork(
          profileId,
          lanDeviceId || undefined,
          revision,
        ));
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname.startsWith(V2_LIBRARY_ITEM_PREFIX)) {
        if (!requireV2Scope('catalog:read')) return;
        const profileId = profileIdForRequest();
        if (!profileId) return;
        const mediaId = libraryItemIdFromPath(reqUrl.pathname, V2_LIBRARY_ITEM_PREFIX);
        if (!mediaId) {
          writeJson(res, 404, { error: 'media_not_found' });
          return;
        }
        const revision = getLibraryRevision();
        const payload = compactLibraryItemForLocalNetwork(
          mediaId,
          profileId,
          lanDeviceId || undefined,
          revision,
        );
        if (!payload) {
          writeJson(res, 404, { error: 'media_not_found' });
          return;
        }
        const etag = catalogEtag('item', revision, catalogProfileIdentity(profileId), mediaId);
        writeCatalogRepresentation(etag, () => payload);
        return;
      }


      if (reqUrl.pathname === '/api/v2/start-hls' && req.method === 'POST') {
        if (!requireV2Scope('media:stream')) return;
        readJsonBody(req)
          .then(async (body) => {
            assertCurrentSelectionRevision(body);
            if (lanDeviceId) {
              const budget = consumeHlsStartBudget(lanDeviceId);
              if (!budget.allowed) {
                res.setHeader('Retry-After', String(Math.ceil((budget.retryAfterMs || 1) / 1000)));
                writeJson(res, 429, {
                  ok: false,
                  code: 'PLAYBACK_START_RATE_LIMITED',
                  error: 'Too many playback restarts. Wait briefly, then try again.',
                  retryable: true,
                });
                return;
              }
            }
            const base = getLanServerBase();
            if (!base) {
              writeJson(res, 500, {
                ok: false,
                code: 'LAN_ADDRESS_UNAVAILABLE',
                error: 'The desktop network address is unavailable. Restart Local Network Sharing, then retry.',
                retryable: true,
              });
              return;
            }

            const mediaResourceId = String(body.mediaId || '');
            let filePath = '';
            try {
              filePath = resolveLocalResource(mediaResourceId, MEDIA_RESOURCE_KIND, getLibraryRoots());
            } catch {
              // The 404 response below intentionally does not reveal path details.
            }
            if (!filePath || !fs.existsSync(filePath)) {
              writeJson(res, 404, {
                ok: false,
                code: 'MEDIA_NOT_FOUND',
                error: 'The media file is unavailable. Reconnect its NAS or storage location, then retry.',
                retryable: true,
              });
              return;
            }
            const identity = requireProfileMediaAccess(filePath);
            if (!identity) return;

            const options = { ...((body.options || {}) as TranscodeOptions) };
            for (const field of ['subtitleFilePath', 'secondarySubtitleFilePath'] as const) {
              const subtitleResourceId = options[field];
              if (!subtitleResourceId) continue;
              try {
                if (!OPAQUE_RESOURCE_ID_PATTERN.test(subtitleResourceId)) {
                  throw new Error('Invalid subtitle resource identifier.');
                }
                const subtitleFilePath = resolveLocalResource(
                  subtitleResourceId,
                  SUBTITLE_RESOURCE_KIND,
                  getLibraryRoots(),
                  filePath,
                );
                if (!isSubtitleFileName(subtitleFilePath)) throw new Error('Unsupported subtitle file.');
                assertProfileCanAccessPath(identity.profileId, subtitleFilePath);
                options[field] = subtitleFilePath;
              } catch {
                writeJson(res, 404, {
                  ok: false,
                  code: 'SUBTITLE_NOT_FOUND',
                  error: 'The selected subtitle is unavailable for this media item. Refresh the shared library, then retry.',
                  retryable: true,
                });
                return;
              }
            }

            const session = await startTranscode(
              filePath,
              options,
              base,
              `lan:${identity.deviceId}:${identity.profileId}:${identity.selectionRevision}`,
            );
            bindHlsProfile(session.sessionId, identity, filePath);
            writeJson(res, 200, { ok: true, data: session });
          })
          .catch((error) => {
            if (error instanceof ProfileError) {
              writeProfileError(error);
              return;
            }
            console.error('LAN start HLS API error:', error);
            writeJson(res, 500, { ok: false, ...streamStartFailure(error) });
          });
        return;
      }

      if (routeAccess.kind === 'ipc-only') {
        writeJson(res, 410, { error: 'This operation is available only through validated Electron IPC.' });
        return;
      }

      // Stream-like endpoints accept signed LAN URLs.
      const isStreamRoute = routeAccess.kind === 'stream';
      const isArtworkRoute = routeAccess.kind === 'artwork';
      const hasValidSignature = isLanSharingEnabled() && isSignedLanRequestValid(reqUrl);
      const isCacheableLanImageRequest = hasValidSignature && reqUrl.searchParams.get(LAN_IMAGE_CACHE_QUERY_PARAM) === '1';
      const hasLocalAccess = authorizeLocalRequest(reqUrl, req);
      if (
        isArtworkRoute
        && !loopbackRequest
        && hasValidSignature
        && (!reqUrl.searchParams.get('deviceId') || !reqUrl.searchParams.get('profileId') || !profileIdentityForMedia())
      ) {
        writeJson(res, 409, { error: 'stale_profile_selection' });
        return;
      }
      const scope = routeAccess.kind === 'scoped' ? routeAccess.scope : null;
      if (!loopbackRequest && !isStreamRoute && !(isArtworkRoute && hasValidSignature) && !scope) {
        writeJson(res, 403, { error: 'This operation is only available to the desktop application.' });
        return;
      }
      if (
        !isStreamRoute
        && !(isArtworkRoute && (hasLocalAccess || hasValidSignature))
        && !(scope ? requireV2Scope(scope) : requireLocalOrLanAccess(reqUrl, req, res))
      ) return;

      // Browser-rendered development sessions do not have Electron's preload
      // bridge. Keep their read/write surface narrowly scoped, authenticated,
      // and local-only so they render the same library and preferences as the
      // desktop window without exposing IPC administration routes.
      if (reqUrl.pathname.startsWith('/api/renderer/') && !isTrustedRendererHttpOrigin(req, deps)) {
        writeJson(res, 403, { error: 'A trusted renderer origin is required.' });
        return;
      }

      if (reqUrl.pathname === '/api/renderer/library/index' && req.method === 'GET') {
        const revision = getLibraryRevision();
        const etag = catalogEtag('index', revision, getRendererCatalogIdentity());
        writeCatalogRepresentation(etag, () => compactLibraryIndexForRenderer(revision));
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname.startsWith(RENDERER_LIBRARY_ITEM_PREFIX)) {
        const mediaId = libraryItemIdFromPath(reqUrl.pathname, RENDERER_LIBRARY_ITEM_PREFIX);
        if (!mediaId) {
          writeJson(res, 404, { error: 'media_not_found' });
          return;
        }
        const revision = getLibraryRevision();
        const payload = compactLibraryItemForRenderer(mediaId, revision);
        if (!payload) {
          writeJson(res, 404, { error: 'media_not_found' });
          return;
        }
        const etag = catalogEtag('item', revision, getRendererCatalogIdentity(), mediaId);
        writeCatalogRepresentation(etag, () => payload);
        return;
      }

      if (reqUrl.pathname === '/api/renderer/library' && req.method === 'GET') {
        writeJson(res, 200, libraryForRenderer());
        return;
      }

      if (reqUrl.pathname === '/api/renderer/settings') {
        if (req.method === 'GET') {
          try {
            requireOwner();
          } catch (error) {
            writeProfileError(error);
            return;
          }
          res.setHeader('Cache-Control', 'no-store');
          writeJson(res, 200, settingsForRenderer(loadSettings()));
          return;
        }
        if (req.method === 'POST') {
          try {
            requireOwner();
          } catch (error) {
            writeProfileError(error);
            return;
          }
          readJsonBody(req)
            .then((patch) => {
              saveSettings({
                ...loadSettings(),
                ...sanitizeRendererSettingsPatch(patch),
              });
              writeJson(res, 200, { ok: true });
            })
            .catch(() => writeJson(res, 400, { ok: false, error: 'Invalid settings payload.' }));
          return;
        }
      }

      if (reqUrl.pathname === '/api/renderer/ffmpeg' && req.method === 'GET') {
        const ffmpegPath = findFFmpeg();
        writeJson(res, 200, { available: Boolean(ffmpegPath), path: ffmpegPath });
        return;
      }

      if (reqUrl.pathname === '/api/renderer/media/probe' && req.method === 'POST') {
        readJsonBody(req)
          .then(async (body) => {
            try {
              const requestedFilePath = String(body.filePath || '');
              assertProfileCanAccessPath(requireDesktopProfileId(), requestedFilePath);
              const data = await probeMedia(requestedFilePath);
              writeJson(res, 200, { ok: true, data });
            } catch (error) {
              writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : 'Unable to inspect media.' });
            }
          })
          .catch(() => writeJson(res, 400, { ok: false, error: 'Invalid media probe payload.' }));
        return;
      }

      if (reqUrl.pathname === '/api/renderer/media/subtitle-resource' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            try {
              const mediaFilePath = String(body.mediaFilePath || '');
              const subtitleFilePath = String(body.subtitleFilePath || '');
              const profileId = requireDesktopProfileId();
              assertProfileCanAccessPath(profileId, mediaFilePath);
              assertSubtitleCanAccessMediaPath(profileId, mediaFilePath, subtitleFilePath);
              if (!isSubtitleFileName(subtitleFilePath)) throw new Error('Unsupported subtitle file.');
              const resourceId = registerResource(
                loadSettings().localNetworkHmacSecret || '',
                'subtitle',
                subtitleFilePath,
                mediaFilePath,
              );
              // Resolve immediately so protocol-shaped paths, missing files,
              // non-regular files, and paths outside a configured root never
              // become usable stream capabilities.
              resolveLocalResource(resourceId, SUBTITLE_RESOURCE_KIND, getLibraryRoots(), mediaFilePath);
              writeJson(res, 200, { resourceId });
            } catch {
              writeJson(res, 404, { error: 'subtitle_not_found' });
            }
          })
          .catch(() => writeJson(res, 400, { error: 'invalid_subtitle_resource_payload' }));
        return;
      }

      if (reqUrl.pathname === '/api/renderer/media/start-transcode' && req.method === 'POST') {
        readJsonBody(req)
          .then(async (body) => {
            try {
              const requestedFilePath = String(body.filePath || '');
              assertProfileCanAccessPath(requireDesktopProfileId(), requestedFilePath);
              const session = await startTranscode(
                requestedFilePath,
                (body.options || {}) as TranscodeOptions,
                `http://127.0.0.1:${mediaServerPort}`,
              );
              writeJson(res, 200, {
                ok: true,
                data: session,
              });
            } catch (error) {
              writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : 'Unable to start local stream.' });
            }
          })
          .catch(() => writeJson(res, 400, { ok: false, error: 'Invalid transcode payload.' }));
        return;
      }

      if (reqUrl.pathname === '/api/renderer/media/stop-transcode' && req.method === 'POST') {
        readJsonBody(req)
          .then((body) => writeJson(res, 200, { ok: true, data: stopTranscode(String(body.sessionId || '')) }))
          .catch(() => writeJson(res, 400, { ok: false, error: 'Invalid transcode payload.' }));
        return;
      }

      if (reqUrl.pathname === '/api/v2/client-config' && req.method === 'GET') {
        if (!requireV2Scope('catalog:read')) return;
        const profileId = usesProfileApi && lanDeviceId
          ? getActiveProfileState(lanDeviceId).profileId
          : resolveLanProfileId(lanDeviceId, false);
        const settings = loadSettings();
        const preferences = profileId ? getProfilePreferences(profileId) : {};
        writeJson(res, 200, {
          profileApiVersion: 1,
          capabilities: {
            profiles: true,
            profileCreation: true,
            profilePins: true,
            kidsRestrictions: true,
            profilePreferences: true,
            profileLists: true,
          },
          appThemeMode: preferences.appThemeMode ?? settings.appThemeMode,
          appThemeColor: preferences.appThemeColor ?? settings.appThemeColor,
          appDarkTheme: preferences.appDarkTheme ?? settings.appDarkTheme,
          appLoaderStyle: preferences.appLoaderStyle ?? settings.appLoaderStyle,
          appHomeStyle: preferences.appHomeStyle,
          appModernHeroMode: preferences.appModernHeroMode,
          playbackSkipBackSeconds: preferences.playbackSkipBackSeconds ?? settings.playbackSkipBackSeconds,
          playbackSkipForwardSeconds: preferences.playbackSkipForwardSeconds ?? settings.playbackSkipForwardSeconds,
          autoplayNextEnabled: preferences.autoplayNextEnabled ?? true,
        });
        return;
      }

      if (reqUrl.pathname === '/api/v2/profiles' && req.method === 'GET') {
        if (!requireV2Scope('catalog:read')) return;
        const profileDeviceId = profileDeviceIdForRequest();
        writeJson(res, 200, {
          profiles: [
            ...profileSummaries(profileDeviceId ?? undefined),
            {
              id: 'guest',
              name: 'Guest',
              avatarKey: 'weave-08',
              colorKey: 'slate',
              type: 'guest',
              hasPin: false,
              isGuest: true,
              sortOrder: 9999,
            },
          ],
        });
        return;
      }

      if (reqUrl.pathname === '/api/v2/profiles' && req.method === 'POST') {
        if (!requireV2Scope('playback:write')) return;
        const profileDeviceId = profileDeviceIdForRequest();
        if (!profileDeviceId) {
          writeJson(res, 409, { error: 'profile_required' });
          return;
        }
        readJsonBody(req)
          .then((body) => {
            requireOwner(profileDeviceId);
            const created = createProfile({
              name: String(body.name || ''),
              avatarKey: typeof body.avatarKey === 'string' ? body.avatarKey : undefined,
              colorKey: typeof body.colorKey === 'string' ? body.colorKey : undefined,
              type: body.type === 'kid' ? 'kid' : 'standard',
            });
            broadcastProfilesChanged();
            writeJson(res, 201, { profile: created, profiles: profileSummaries() });
          })
          .catch((error) => error instanceof ProfileError
            ? writeProfileError(error)
            : writeJson(res, 400, {
                error: error instanceof Error ? error.message : 'The profile could not be created.',
              }));
        return;
      }

      if (reqUrl.pathname === '/api/v2/profiles/active' && req.method === 'GET') {
        if (!requireV2Scope('catalog:read')) return;
        const profileDeviceId = profileDeviceIdForRequest();
        if (!profileDeviceId) {
          writeJson(res, 409, { error: 'profile_required' });
          return;
        }
        writeJson(res, 200, getActiveProfileState(profileDeviceId));
        return;
      }

      if (reqUrl.pathname === '/api/v2/profiles/select' && req.method === 'POST') {
        if (!requireV2Scope('catalog:read')) return;
        const profileDeviceId = profileDeviceIdForRequest();
        if (!profileDeviceId) {
          writeJson(res, 409, { error: 'profile_required' });
          return;
        }
        const deviceId = profileDeviceId;
        readJsonBody(req).then(async (body) => {
          const profileId = String(body.profileId || '');
          const selected = profileId === 'guest'
            ? createAndSelectGuest(deviceId)
            : await selectProfile(deviceId, profileId, typeof body.pin === 'string' ? body.pin : undefined, req.socket.remoteAddress || 'lan');
          writeJson(res, 200, { profile: selected, active: getActiveProfileState(deviceId) });
        }).catch(writeProfileError);
        return;
      }

      if (reqUrl.pathname === '/api/v2/profiles/lock' && req.method === 'POST') {
        if (!requireV2Scope('catalog:read')) return;
        const profileDeviceId = profileDeviceIdForRequest();
        if (!profileDeviceId) {
          writeJson(res, 409, { error: 'profile_required' });
          return;
        }
        writeJson(res, 200, lockProfile(profileDeviceId));
        return;
      }

      if (reqUrl.pathname === '/api/v2/profiles/auto-sign-in' && req.method === 'POST') {
        if (!requireV2Scope('catalog:read')) return;
        const profileDeviceId = profileDeviceIdForRequest();
        if (!profileDeviceId) {
          writeJson(res, 409, { error: 'profile_required' });
          return;
        }
        const deviceId = profileDeviceId;
        readJsonBody(req)
          .then((body) => writeJson(res, 200, setAutomaticSignIn(deviceId, Boolean(body.enabled))))
          .catch(writeProfileError);
        return;
      }

      if (reqUrl.pathname === '/api/v2/profile-preferences') {
        if (!requireV2Scope('playback:write')) return;
        const profileId = profileIdForRequest();
        if (!profileId) return;
        if (req.method === 'GET') {
          writeJson(res, 200, getProfilePreferences(profileId));
          return;
        }
        if (req.method === 'PATCH') {
          readJsonBody(req)
            .then((body) => { assertCurrentSelectionRevision(body); writeJson(res, 200, saveProfilePreferences(profileId, body)); })
            .catch((error) => error instanceof ProfileError ? writeProfileError(error) : writeJson(res, 400, { error: 'invalid_profile_preferences' }));
          return;
        }
      }

      if (reqUrl.pathname === '/api/v2/profile-lists') {
        if (!requireV2Scope('playback:write')) return;
        const profileId = profileIdForRequest();
        if (!profileId) return;
        const kindValue = reqUrl.searchParams.get('kind');
        const kind = kindValue === 'watchlist' || kindValue === 'favorite' ? kindValue : undefined;
        if (req.method === 'GET') {
          writeJson(res, 200, getProfileLists(profileId, kind));
          return;
        }
        if (req.method === 'PUT' || req.method === 'DELETE') {
          readJsonBody(req).then((body) => {
            assertCurrentSelectionRevision(body);
            const bodyKind = body.kind === 'watchlist' || body.kind === 'favorite' ? body.kind as ProfileListKind : null;
            if (!bodyKind || !body.mediaId) {
              writeJson(res, 400, { error: 'mediaId_and_kind_required' });
              return;
            }
            writeJson(res, 200, setProfileListEntry(profileId, String(body.mediaId), bodyKind, req.method === 'PUT'));
          }).catch((error) => error instanceof ProfileError ? writeProfileError(error) : writeJson(res, 400, { error: 'invalid_profile_list_entry' }));
          return;
        }
      }


      if (reqUrl.pathname === '/api/v2/progress' && req.method === 'GET') {
        if (!requireV2Scope('playback:write')) return;
        const profileId = profileIdForRequest();
        if (!profileId) return;
        const secret = loadSettings().localNetworkHmacSecret || '';
        writeJson(res, 200, Object.fromEntries(
          Object.entries(getAllProgress(profileId)).map(([storedPath, progress]) => [
            registerResource(secret, 'media', storedPath),
            progress,
          ]),
        ));
        return;
      }

      if (reqUrl.pathname === '/api/v2/progress' && req.method === 'POST') {
        if (!requireV2Scope('playback:write')) return;
        const profileId = profileIdForRequest();
        if (!profileId) return;
        readJsonBody(req)
          .then((body) => {
            assertCurrentSelectionRevision(body);
            let file = '';
            try {
              file = resolveLocalResource(String(body.mediaId || ''), MEDIA_RESOURCE_KIND, getLibraryRoots());
            } catch {
              // Avoid revealing whether a resource identifier exists.
            }
            if (!file) {
              writeJson(res, 400, { error: 'mediaId is required' });
              return;
            }
            writeJson(res, 200, saveProgress(profileId, file, Number(body.position) || 0, Number(body.duration) || 0));
          })
          .catch((error) => {
            if (error instanceof ProfileError) {
              writeProfileError(error);
              return;
            }
            console.error('save progress API error:', error);
            writeJson(res, 500, { error: 'Failed to save progress' });
          });
        return;
      }


      if (reqUrl.pathname === '/api/v2/playback-track-preferences' && req.method === 'GET') {
        if (!requireV2Scope('playback:write')) return;
        const profileId = profileIdForRequest();
        if (!profileId) return;
        const scope = reqUrl.searchParams.get('scope') || '';
        writeJson(res, 200, getPlaybackTrackPreferences(profileId, scope));
        return;
      }

      if (reqUrl.pathname === '/api/v2/playback-track-preferences' && req.method === 'POST') {
        if (!requireV2Scope('playback:write')) return;
        const profileId = profileIdForRequest();
        if (!profileId) return;
        readJsonBody(req)
          .then((body) => {
            assertCurrentSelectionRevision(body);
            const scope = String(body.scope || '').trim();
            if (!scope) {
              writeJson(res, 400, { error: 'scope is required' });
              return;
            }
            writeJson(res, 200, savePlaybackTrackPreferences(profileId, scope, body.preferences || {}));
          })
          .catch((error) => {
            if (error instanceof ProfileError) {
              writeProfileError(error);
              return;
            }
            console.error('save playback track preferences API error:', error);
            writeJson(res, 500, { error: 'Failed to save playback track preferences' });
          });
        return;
      }

      if (reqUrl.pathname === '/api/v2/playback/segments' && req.method === 'GET') {
        if (!requireV2Scope('catalog:read')) return;
        const mediaId = reqUrl.searchParams.get('mediaId') || '';
        if (!mediaId) {
          writeJson(res, 400, { error: 'mediaId is required' });
          return;
        }
        const seasonValue = reqUrl.searchParams.get('season');
        const episodeValue = reqUrl.searchParams.get('episode');
        void getMediaSegments({
          mediaId,
          season: seasonValue === null ? undefined : Number(seasonValue),
          episode: episodeValue === null ? undefined : Number(episodeValue),
        }).then((result) => writeJson(res, 200, result)).catch((error) => {
          console.error('playback segments API error:', error);
          writeJson(res, 500, { error: 'Failed to load playback segments' });
        });
        return;
      }










      if (reqUrl.pathname === '/api/cached-artwork') {
        let sourceUrl = reqUrl.searchParams.get('source') || '';
        if (!loopbackRequest) {
          try {
            sourceUrl = resolveExternalArtworkResource(resourceId);
          } catch {
            sourceUrl = '';
          }
        }
        if (!sourceUrl || !isExternalArtworkUrl(sourceUrl)) {
          res.writeHead(400);
          res.end('Invalid artwork source');
          return;
        }

        const sendArtwork = (cachedArtwork: NonNullable<ReturnType<typeof getCachedArtwork>>) => {
          if (!canWriteResponse(res)) return;
          if (cachedArtwork.cachePath) {
            res.writeHead(200, cachedArtworkResponseHeaders(
              cachedArtwork.mimeType,
              cachedArtwork.byteLength,
              isCacheableLanImageRequest ? LAN_IMAGE_CACHE_CONTROL : undefined,
            ));
            const stream = fs.createReadStream(cachedArtwork.cachePath);
            pipeResponse(stream, res);
            return;
          }

          const decoded = cachedArtwork.dataUrl ? decodeDataUrl(cachedArtwork.dataUrl) : null;
          if (!decoded) {
            res.writeHead(404);
            res.end();
            return;
          }

          res.writeHead(200, cachedArtworkResponseHeaders(
            cachedArtwork.mimeType || decoded.mimeType,
            decoded.buffer.byteLength,
            isCacheableLanImageRequest ? LAN_IMAGE_CACHE_CONTROL : undefined,
          ));
          res.end(decoded.buffer);
        };

        const cachedArtwork = getCachedArtwork(sourceUrl);
        if (cachedArtwork) {
          sendArtwork(cachedArtwork);
          return;
        }

        void cacheArtworkSource(sourceUrl)
          .then((fetchedArtwork) => {
            if (fetchedArtwork) {
              sendArtwork(fetchedArtwork);
              return;
            }
            res.writeHead(502);
            res.end('Artwork is unavailable from the desktop server.');
          })
          .catch(() => {
            res.writeHead(502);
            res.end('Artwork is unavailable from the desktop server.');
          });
        return;
      }

      if (reqUrl.pathname === '/api/custom-artwork') {
        const mediaId = reqUrl.searchParams.get('mediaId') || '';
        const target = reqUrl.searchParams.get('target') || '';
        const artwork = mediaId && target ? getCustomArtworkData(mediaId, target) : null;
        if (!artwork) {
          res.writeHead(404);
          res.end();
          return;
        }

        const decoded = decodeDataUrl(artwork.dataUrl);
        if (!decoded) {
          res.writeHead(404);
          res.end();
          return;
        }

        res.writeHead(200, {
          ...cachedArtworkResponseHeaders(decoded.mimeType, decoded.buffer.byteLength),
          'Cache-Control': isCacheableLanImageRequest ? LAN_IMAGE_CACHE_CONTROL : 'no-store',
          ETag: `"${createHash('sha1').update(artwork.dataUrl).digest('hex')}"`,
        });
        res.end(decoded.buffer);
        return;
      }

      if (reqUrl.pathname === '/api/local-image') {
        if (!filePath || !isImageFileName(path.basename(filePath)) || !fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end();
          return;
        }

        res.writeHead(200, {
          'Content-Type': getImageMimeType(filePath),
          'Cache-Control': isCacheableLanImageRequest ? LAN_IMAGE_CACHE_CONTROL : 'public, max-age=3600',
        });
        const stream = fs.createReadStream(filePath);
        pipeResponse(stream, res);
        return;
      }

      if (reqUrl.pathname === '/api/thumbnail') {
        const time = reqUrl.searchParams.get('t') || '00:01:00';
        const embedded = reqUrl.searchParams.get('embedded') === '1';
        const streamIndex = parseIntegerTag(reqUrl.searchParams.get('stream') || undefined);
        const ffmpegPath = findFFmpeg();
        if (!ffmpegPath || !filePath) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (!requireProfileMediaAccess(filePath)) return;
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': isCacheableLanImageRequest ? LAN_IMAGE_CACHE_CONTROL : 'private, max-age=3600',
        });
        const args = embedded
          ? [
              '-i', filePath,
              ...(streamIndex !== undefined ? ['-map', `0:${streamIndex}`] : ['-map', '0:v:0']),
              '-vf', THUMBNAIL_SCALE_FILTER,
              '-frames:v', '1',
              '-f', 'image2',
              '-vcodec', 'mjpeg',
              '-q:v', '2',
              'pipe:1',
            ]
          : ['-ss', time, '-i', filePath, '-vf', THUMBNAIL_SCALE_FILTER, '-vframes', '1', '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1'];
        // Thumbnail requests arrive in bursts (one per episode row); the tool
        // queue keeps them to a couple of concurrent ffmpeg processes.
        acquireFfmpegToolSlot('thumbnail')
          .then((release) => {
            if (res.destroyed || res.writableEnded) {
              release();
              return;
            }
            try {
              const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
              proc.once('exit', release);
              if (proc.stdout) pipeResponse(proc.stdout, res);
              proc.once('error', (error) => {
                console.error('thumbnail FFmpeg spawn error:', error);
                release();
                safeEndResponse(res);
              });
              proc.stderr?.on('data', () => { /* drain stderr so the pipe never stalls */ });
              res.once('close', () => {
                if (!proc.killed) proc.kill('SIGKILL');
              });
            } catch (error) {
              console.error('thumbnail FFmpeg spawn failed:', error);
              release();
              safeEndResponse(res);
            }
          })
          .catch(() => safeEndResponse(res));
        return;
      }







      if (reqUrl.pathname === '/subtitle') {
        if (!requireStreamAccess(reqUrl, req, res)) return;

        const requestedStreamOrdinal = queryNumber(reqUrl.searchParams.get('streamOrdinal'));
        const streamOrdinal = typeof requestedStreamOrdinal === 'number' && requestedStreamOrdinal >= 0
          ? requestedStreamOrdinal
          : null;
        const isEmbeddedSubtitle = streamOrdinal !== null;
        let subtitleFilePath = requestedPath;
        if (!loopbackRequest) {
          try {
            // Embedded tracks are extracted from a media resource; sidecars
            // must remain subtitle resources. Never inherit the broader set
            // used by unrelated legacy routes.
            subtitleFilePath = resolveLocalResource(
              resourceId,
              isEmbeddedSubtitle ? MEDIA_RESOURCE_KIND : SUBTITLE_RESOURCE_KIND,
              getLibraryRoots(),
            );
          } catch {
            subtitleFilePath = '';
          }
        }

        if (!subtitleFilePath || !fs.existsSync(subtitleFilePath) || !fs.statSync(subtitleFilePath).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        if (!requireProfileMediaAccess(subtitleFilePath)) return;

        if (isEmbeddedSubtitle) {
          if (!isVideoFileName(subtitleFilePath)) {
            res.writeHead(415, { 'Content-Type': 'text/plain' });
            res.end('Unsupported embedded subtitle source');
            return;
          }
          const ffmpegPath = findFFmpeg();
          if (!ffmpegPath) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('FFmpeg is not available');
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          acquireFfmpegToolSlot('subtitle extract')
            .then((release) => {
              if (res.destroyed || res.writableEnded) {
                release();
                return;
              }
              try {
                const proc = spawn(ffmpegPath, buildEmbeddedSubtitleVttArgs(subtitleFilePath, streamOrdinal), { stdio: ['ignore', 'pipe', 'pipe'] });
                proc.once('exit', release);
                if (proc.stdout) pipeResponse(proc.stdout, res);
                proc.once('error', (error) => {
                  console.error('subtitle FFmpeg spawn error:', error);
                  release();
                  safeEndResponse(res);
                });
                proc.stderr?.on('data', () => { /* drain stderr so the pipe never stalls */ });
                res.once('close', () => {
                  if (!proc.killed) proc.kill('SIGKILL');
                });
              } catch (error) {
                console.error('subtitle FFmpeg spawn failed:', error);
                release();
                safeEndResponse(res);
              }
            })
            .catch(() => safeEndResponse(res));
          return;
        }

        if (!isSubtitleFileName(subtitleFilePath)) {
          res.writeHead(415, { 'Content-Type': 'text/plain' });
          res.end('Unsupported subtitle format');
          return;
        }

        const ext = path.extname(subtitleFilePath).toLowerCase();
        const readController = new AbortController();
        res.once('close', () => readController.abort());
        readBoundedUtf8Subtitle(subtitleFilePath, readController.signal)
          .then((body) => {
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(200, {
              'Content-Type': ext === '.srt' ? 'text/vtt; charset=utf-8' : getSubtitleMimeType(subtitleFilePath),
              'Cache-Control': 'no-store',
            });
            res.end(ext === '.srt' ? srtToVtt(body) : body);
          })
          .catch((error) => {
            if (readController.signal.aborted || res.destroyed || res.writableEnded) return;
            if (error instanceof SubtitleFileTooLargeError) {
              res.writeHead(413, { 'Content-Type': 'text/plain' });
              res.end('Subtitle file is too large');
              return;
            }
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Could not read subtitle');
          });
        return;
      }

      if (reqUrl.pathname.startsWith('/hls/')) {
        const sessionId = reqUrl.pathname.split('/')[2] || '';
        const hasSessionCredential = authorizeHlsStreamRequest(reqUrl);
        if (!hasSessionCredential && !requireStreamAccess(reqUrl, req, res)) return;
        const binding = getHlsProfileBinding(sessionId);
        if (binding) {
          if (binding.deviceId) {
            const active = getActiveProfileState(binding.deviceId);
            if (active.profileId !== binding.profileId || active.selectionRevision !== binding.selectionRevision) {
              writeJson(res, 409, { error: 'stale_profile_selection' });
              return;
            }
          }
          try {
            assertProfileCanAccessPath(binding.profileId, binding.filePath);
          } catch (error) {
            writeProfileError(error);
            return;
          }
          binding.lastAccessAt = Date.now();
        }
        const requestStreamToken = reqUrl.searchParams.get(HLS_STREAM_TOKEN_QUERY_PARAM) || '';
        const playlistStreamToken = hasSessionCredential
          ? requestStreamToken
          : issueHlsStreamCredential(sessionId);
        const playlistQuery = playlistStreamToken
          ? `${HLS_STREAM_TOKEN_QUERY_PARAM}=${encodeURIComponent(playlistStreamToken)}`
          : '';
        if (serveHls(reqUrl, res, playlistQuery)) return;
      }

      if (reqUrl.pathname !== '/stream') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      if (!requireStreamAccess(reqUrl, req, res)) return;

      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const streamIdentity = requireProfileMediaAccess(filePath);
      if (!streamIdentity) return;

      if (reqUrl.searchParams.has('subtitleFile') || reqUrl.searchParams.has('secondarySubtitleFile')) {
        writeJson(res, 400, {
          error: 'subtitle_resource_required',
          message: 'Refresh the library and request subtitles with opaque resource identifiers.',
        });
        return;
      }

      const resolveStreamSubtitle = (parameter: 'subtitleResourceId' | 'secondarySubtitleResourceId'): string | undefined => {
        const subtitleResourceId = reqUrl.searchParams.get(parameter);
        if (!subtitleResourceId) return undefined;
        if (!OPAQUE_RESOURCE_ID_PATTERN.test(subtitleResourceId)) {
          throw new Error('Invalid subtitle resource identifier.');
        }
        const subtitleFilePath = resolveLocalResource(
          subtitleResourceId,
          SUBTITLE_RESOURCE_KIND,
          getLibraryRoots(),
          filePath,
        );
        if (!isSubtitleFileName(subtitleFilePath)) throw new Error('Unsupported subtitle file.');
        assertProfileCanAccessPath(streamIdentity.profileId, subtitleFilePath);
        return subtitleFilePath;
      };

      let subtitleFilePath: string | undefined;
      let secondarySubtitleFilePath: string | undefined;
      try {
        subtitleFilePath = resolveStreamSubtitle('subtitleResourceId');
        secondarySubtitleFilePath = resolveStreamSubtitle('secondarySubtitleResourceId');
      } catch {
        writeJson(res, 404, {
          error: 'subtitle_not_found',
          message: 'The selected subtitle is unavailable for this media item. Refresh the library, then retry.',
        });
        return;
      }

      const releaseStreamLease = acquirePlaybackActivityLease(
        `http-stream:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        `stream ${path.basename(filePath)}`,
      );
      res.once('close', releaseStreamLease);
      res.once('finish', releaseStreamLease);

      const ffmpegPath = findFFmpeg();
      const streamOptions: TranscodeOptions = {
        startSeconds: Number.isFinite(startSec) && startSec > 0 ? startSec : undefined,
        videoTrackIndex: queryNumber(reqUrl.searchParams.get('video')),
        audioTrackIndex: queryNumber(reqUrl.searchParams.get('audio')),
        subtitleTrackIndex: queryNumber(reqUrl.searchParams.get('subtitle')),
        subtitleStreamOrdinal: queryNumber(reqUrl.searchParams.get('subtitleOrdinal')),
        subtitleCodec: reqUrl.searchParams.get('subtitleCodec') || undefined,
        subtitleFilePath,
        secondarySubtitleTrackIndex: queryNumber(reqUrl.searchParams.get('secondarySubtitle')),
        secondarySubtitleStreamOrdinal: queryNumber(reqUrl.searchParams.get('secondarySubtitleOrdinal')),
        secondarySubtitleCodec: reqUrl.searchParams.get('secondarySubtitleCodec') || undefined,
        secondarySubtitleFilePath,
        subtitleStyle: parseSubtitleStyle(reqUrl.searchParams.get('subtitleStyle')),
        forceTranscode: reqUrl.searchParams.get('forceTranscode') === '1',
      };
      const playbackPlan = browserPlaybackPlan(filePath, streamOptions);

      if (playbackPlan.requiresFfmpeg && !ffmpegPath) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end(`FFmpeg is required for ${playbackPlan.mode} playback but is not available.`);
        return;
      }

      if (playbackPlan.requiresFfmpeg && ffmpegPath) {
        // ── Jellyfin-style remux/direct-stream/transcode ─────────────────────
        // Copy browser-safe streams first; encode only the streams that need it.
        const videoCodec = playbackPlan.videoCodec;
        const audioCodec = playbackPlan.audioCodec;
        const copyVideo = playbackPlan.copyVideo;
        const copyAudio = playbackPlan.copyAudio;
        const hardwareEncoder = copyVideo ? null : preferredH264HardwareEncoder(ffmpegPath);

        console.log(`[stream] ${path.basename(filePath)} | mode:${playbackPlan.mode} reason:${playbackPlan.reason} video:${videoCodec}(${copyVideo ? 'copy' : hardwareEncoder || 'libx264'}) audio:${audioCodec}(${copyAudio ? 'copy' : 'encode'})`);

        res.writeHead(200, {
          'Content-Type': playbackPlan.contentType,
          'Transfer-Encoding': 'chunked',
          'X-Playback-Mode': playbackPlan.mode,
          'X-Video-Codec': videoCodec,
          'X-Audio-Codec': audioCodec,
        });

        const args = buildBrowserStreamArgs({
          filePath,
          options: streamOptions,
          copyVideo,
          copyAudio,
          hardwareEncoder,
        });

        try {
          const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          // One managed encoder per source file: a seek restart replaces the
          // previous process, and the global playback cap holds across
          // in-app playback and LAN sharing.
          registerPlaybackProcess(proc, `stream:${filePath}`, `${playbackPlan.mode} stream for ${path.basename(filePath)}`);
          // While the client keeps consuming output this stream counts as
          // active, so cap eviction prefers genuinely idle encoders.
          let lastStreamTouch = 0;
          proc.stdout?.on('data', () => {
            const now = Date.now();
            if (now - lastStreamTouch > 5000) {
              lastStreamTouch = now;
              touchPlaybackProcess(proc);
            }
          });
          if (proc.stdout) pipeResponse(proc.stdout, res);
          res.once('close', () => {
            if (!proc.killed) proc.kill('SIGKILL');
          });
          proc.stderr?.on('data', (d: Buffer) => console.log('[ffmpeg]', d.toString().trim().split('\n').pop()));
          proc.once('error', (err) => {
            console.error('FFmpeg spawn error:', err);
            safeEndResponse(res);
          });
          proc.once('exit', (code) => {
            if (code !== 0 && code !== null) console.warn(`[ffmpeg] exited with code ${code}`);
            // stdout owns the response lifecycle. Ending here can race its
            // final buffered chunk and trigger ERR_STREAM_WRITE_AFTER_END.
            if (!proc.stdout) safeEndResponse(res);
          });
        } catch (error) {
          console.error('FFmpeg spawn failed:', error);
          safeEndResponse(res);
        }
      } else {
        // Direct streaming with range request support (essential for seeking)
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          res.writeHead(500);
          res.end();
          return;
        }

        const fileSize = stat.size;
        const mimeType = getMimeType(filePath);
        const range = req.headers.range;

        if (range) {
          const parsedRange = parseHttpByteRange(range, fileSize);
          if (!parsedRange) {
            res.writeHead(416, {
              'Content-Range': `bytes */${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': '0',
            });
            res.end();
            return;
          }
          const { start, end } = parsedRange;
          const chunkSize = end - start + 1;

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mimeType,
          });

          const stream = fs.createReadStream(filePath, { start, end });
          pipeResponse(stream, res);
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Accept-Ranges': 'bytes',
            'Content-Type': mimeType,
          });

          const stream = fs.createReadStream(filePath);
          pipeResponse(stream, res);
        }
      }
    };

  const localServer = http.createServer(createRequestHandler('loopback'));
  mediaServer = localServer;
  trackServerConnections(localServer, mediaServerSockets);
  try {
    mediaServerPort = await listenWithPortRetries(localServer, mediaServerPort, '127.0.0.1', 'Loopback media server');
  } catch (error) {
    if (mediaServer === localServer) mediaServer = null;
    throw error;
  }

  const secureServer = https.createServer({
    key: lanTlsIdentity.privateKeyPem,
    cert: lanTlsIdentity.certificatePem,
    minVersion: 'TLSv1.2',
  }, createRequestHandler('lan'));
  lanMediaServer = secureServer;
  lanCertificateFingerprint = lanTlsIdentity.certFingerprint;
  trackServerConnections(secureServer, lanMediaServerSockets);
  try {
    lanMediaServerPort = await listenWithPortRetries(
      secureServer,
      Math.min(mediaServerPort + 1, 65_535),
      '0.0.0.0',
      'TLS LAN media server',
    );
  } catch (error) {
    if (lanMediaServer === secureServer) lanMediaServer = null;
    lanCertificateFingerprint = '';
    try { localServer.close(); } catch { /* The startup error below is authoritative. */ }
    if (mediaServer === localServer) mediaServer = null;
    throw error;
  }

  console.log(`Loopback media server on http://127.0.0.1:${mediaServerPort}`);
  console.log(`TLS LAN media server on port ${lanMediaServerPort}`);
  return mediaServerPort;
}
