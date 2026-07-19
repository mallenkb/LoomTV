export type LanRouteScope = 'catalog:read' | 'media:stream' | 'playback:write' | 'device:self';
export type MediaServerRouteAccess =
  | { kind: 'public' }
  | { kind: 'pairing' }
  | { kind: 'legacy' }
  | { kind: 'ipc-only' }
  | { kind: 'stream' }
  | { kind: 'artwork' }
  | { kind: 'scoped'; scope: LanRouteScope }
  | { kind: 'desktop' };

export function lanRouteScope(pathname: string, method = 'GET'): LanRouteScope | null {
  if (pathname === '/api/v2/library' && method === 'GET') return 'catalog:read';
  if (pathname === '/api/v2/client-config' && method === 'GET') return 'catalog:read';
  if (pathname === '/api/v2/profiles' && method === 'GET') return 'catalog:read';
  if (pathname === '/api/v2/profiles' && method === 'POST') return 'playback:write';
  if (pathname === '/api/v2/profiles/active' && method === 'GET') return 'catalog:read';
  if (pathname === '/api/v2/profiles/select' && method === 'POST') return 'catalog:read';
  if (pathname === '/api/v2/profiles/lock' && method === 'POST') return 'catalog:read';
  if (pathname === '/api/v2/profiles/auto-sign-in' && method === 'POST') return 'catalog:read';
  if (pathname === '/api/v2/profile-preferences' && (method === 'GET' || method === 'PATCH')) return 'playback:write';
  if (pathname === '/api/v2/profile-lists' && (method === 'GET' || method === 'PUT' || method === 'DELETE')) return 'playback:write';
  if (pathname === '/api/v2/start-hls' && method === 'POST') return 'media:stream';
  if (pathname === '/api/v2/progress' && (method === 'GET' || method === 'POST')) return 'playback:write';
  if (pathname === '/api/v2/playback-track-preferences' && (method === 'GET' || method === 'POST')) return 'playback:write';
  if (pathname === '/api/v2/playback/segments' && method === 'GET') return 'catalog:read';
  if (pathname === '/api/v2/unpair' && method === 'POST') return 'device:self';
  return null;
}

export function deviceHasLanScope(scopes: readonly string[], requiredScope: LanRouteScope): boolean {
  return requiredScope === 'device:self' || scopes.includes(requiredScope);
}

const IPC_ONLY_HTTP_ROUTES = new Set([
  '/api/lan/status',
  '/api/lan/artwork/refresh',
  '/api/library',
  '/api/library/scan',
  '/api/library/add-folder',
  '/api/library/remove-folder',
  '/api/settings',
  '/api/metadata/test-keys',
  '/api/artwork/playback-logo',
  '/api/progress',
  '/api/progress/import',
  '/api/playback-track-preferences',
  '/api/playback/segments',
  '/api/artwork',
  '/api/artwork/refresh-official',
  '/api/artwork/official-candidates',
  '/api/artwork/apply-official',
  '/api/artwork/import',
  '/api/database/backup',
  '/api/database/clear',
  '/api/ffmpeg',
  '/api/ffprobe',
  '/api/media-server-port',
  '/api/media/probe',
  '/api/media/start-transcode',
  '/api/media/stop-transcode',
  '/api/play-media',
]);

const LEGACY_LAN_ROUTES = new Set([
  '/api/lan/pair',
  '/api/lan/library',
  '/api/lan/start-hls',
]);

export function isIpcOnlyHttpRoute(pathname: string): boolean {
  return IPC_ONLY_HTTP_ROUTES.has(pathname);
}

export function isLegacyLanRoute(pathname: string): boolean {
  return LEGACY_LAN_ROUTES.has(pathname);
}

export function mediaServerRouteAccess(pathname: string, method = 'GET'): MediaServerRouteAccess {
  if (method === 'GET' && (pathname === '/' || pathname === '/pair' || pathname === '/api/ping' || pathname === '/api/lan/info')) {
    return { kind: 'public' };
  }
  if (isLegacyLanRoute(pathname)) return { kind: 'legacy' };
  if (method === 'POST' && (pathname === '/api/v2/pair' || pathname === '/api/v2/auth/refresh')) {
    return { kind: 'pairing' };
  }
  if (isIpcOnlyHttpRoute(pathname)) return { kind: 'ipc-only' };
  if (pathname === '/stream' || pathname === '/subtitle' || pathname.startsWith('/hls/')) {
    return { kind: 'stream' };
  }
  if (
    pathname === '/api/cached-artwork'
    || pathname === '/api/local-image'
    || pathname === '/api/thumbnail'
    || pathname === '/api/custom-artwork'
  ) {
    return { kind: 'artwork' };
  }
  const scope = lanRouteScope(pathname, method);
  return scope ? { kind: 'scoped', scope } : { kind: 'desktop' };
}
