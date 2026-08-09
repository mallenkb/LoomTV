import type http from 'node:http';
import { allowedCorsOrigin } from './serverSecurity.ts';

/**
 * The renderer bootstrap route. It no longer serves anything: the local access
 * token reaches the renderer over sender-validated Electron IPC
 * (`renderer:session`). The name is kept so the HTTP surface can refuse it
 * explicitly instead of letting a future handler re-open it.
 */
export const RENDERER_SESSION_ROUTE = '/api/renderer/session';

const RENDERER_ROUTE_PREFIX = '/api/renderer/';

export function rendererRequestOrigin(headers: http.IncomingHttpHeaders): string | null {
  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (origin) return origin;

  // Same-origin GET requests may omit Origin. Accept the referrer only when
  // Chromium also identifies the request as same-origin; this keeps ordinary
  // originless localhost clients outside the renderer compatibility surface.
  if (headers['sec-fetch-site'] !== 'same-origin') return null;
  const referer = Array.isArray(headers.referer) ? headers.referer[0] : headers.referer;
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * Whether the request presents an origin the renderer surface recognises.
 *
 * `Origin` and `Referer` are written by the caller, so this is not a network
 * credential. The server may use it only as part of the loopback-only browser
 * renderer policy; it never returns or exposes the Electron local access token.
 */
export function isTrustedRendererHttpOrigin(input: {
  headers: http.IncomingHttpHeaders;
  allowedOrigins: ReadonlySet<string>;
  loopbackServerPort: number;
}): boolean {
  const origin = rendererRequestOrigin(input.headers);
  if (!origin) return false;
  if (allowedCorsOrigin(origin, input.allowedOrigins)) return true;

  // The optional /app/ browser renderer is served by this process. Its port is
  // selected at runtime, so admit only the exact loopback media-server origin.
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    const isLoopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
    return parsed.protocol === 'http:'
      && isLoopbackHost
      && parsed.port === String(input.loopbackServerPort);
  } catch {
    return false;
  }
}

export type RendererHttpDecision =
  | { allowed: true }
  | { allowed: false; status: 403 | 410; error: string };

const ALLOWED: RendererHttpDecision = { allowed: true };

const TRUSTED_ORIGIN_REQUIRED: RendererHttpDecision = {
  allowed: false,
  status: 403,
  error: 'A trusted renderer origin is required.',
};

const SESSION_ROUTE_RETIRED: RendererHttpDecision = {
  allowed: false,
  status: 410,
  error: 'The renderer session credential is available only through validated Electron IPC.',
};

/**
 * Gate for the loopback-only `/api/renderer/*` compatibility surface.
 *
 * Callers reaching this point have either satisfied local-access-token or
 * paired-device authorization, or passed the loopback browser-renderer policy;
 * this only narrows what remains. The session route is refused unconditionally,
 * so no HTTP request can obtain the local access token.
 */
export function authorizeRendererHttpRequest(input: {
  pathname: string;
  loopbackRequest: boolean;
  /** Evaluated only for renderer routes, so streams pay nothing for it. */
  trustedOrigin: () => boolean;
}): RendererHttpDecision {
  if (input.pathname === RENDERER_SESSION_ROUTE) return SESSION_ROUTE_RETIRED;
  if (!input.pathname.startsWith(RENDERER_ROUTE_PREFIX)) return ALLOWED;
  if (!input.loopbackRequest) return TRUSTED_ORIGIN_REQUIRED;
  if (!input.trustedOrigin()) return TRUSTED_ORIGIN_REQUIRED;
  return ALLOWED;
}
