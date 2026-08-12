import { randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

export const LOCAL_ACCESS_QUERY_PARAM = 'loomtvToken';
export const LOCAL_ACCESS_HEADER = 'x-loomtv-token';

export function createLocalAccessToken(): string {
  return randomBytes(32).toString('hex');
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function normalizeRemoteAddress(address?: string | null): string {
  return (address || '').replace(/^::ffff:/, '');
}

export function isLoopbackAddress(address?: string | null): boolean {
  const normalized = normalizeRemoteAddress(address).toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function requestBearerToken(headers: http.IncomingHttpHeaders): string {
  const bearer = firstHeaderValue(headers.authorization);
  if (bearer.startsWith('Bearer ')) return bearer.slice('Bearer '.length).trim();
  return '';
}

export function requestLanToken(reqUrl: URL, headers: http.IncomingHttpHeaders): string {
  return requestBearerToken(headers) || reqUrl.searchParams.get('token') || '';
}

function requestLocalAccessToken(reqUrl: URL, headers: http.IncomingHttpHeaders): string {
  return firstHeaderValue(headers[LOCAL_ACCESS_HEADER])
    || requestBearerToken(headers)
    || reqUrl.searchParams.get(LOCAL_ACCESS_QUERY_PARAM)
    || '';
}

export function hasValidLocalAccessToken(
  reqUrl: URL,
  headers: http.IncomingHttpHeaders,
  expectedToken: string,
): boolean {
  const token = requestLocalAccessToken(reqUrl, headers);
  return Boolean(token && expectedToken && timingSafeStringEqual(token, expectedToken));
}

export function allowedCorsOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): string | null {
  if (!origin) return null;
  return allowedOrigins.has(origin) ? origin : null;
}

// Query parameters that carry a bearer-equivalent secret. Any one of them is
// enough to replay a loopback or LAN request, so none may reach a log file.
// `streamToken` mirrors HLS_STREAM_TOKEN_QUERY_PARAM in transcodeManager; it is
// spelled out here to keep this module free of transport dependencies.
const REDACTED_QUERY_PARAMS = [LOCAL_ACCESS_QUERY_PARAM, 'token', 'streamToken'];

const REDACTED_QUERY_PATTERN = new RegExp(
  `([?&](?:${REDACTED_QUERY_PARAMS.join('|')})=)[^&#\\s"']+`,
  'gi',
);

const REDACTED_HEADER_PATTERN = new RegExp(
  `((?:${LOCAL_ACCESS_HEADER}|authorization)["']?\\s*[:=]\\s*["']?)(?:Bearer\\s+)?[^\\s,;"'}]+`,
  'gi',
);

/**
 * Strip credential-bearing query parameters and headers from text about to be
 * logged. Errors raised by `fetch`, HTTP plumbing, and child processes
 * routinely embed the full request URL, and those URLs carry the local access
 * token that authorizes every loopback media route.
 */
export function redactRequestSecrets(value: string): string {
  return value
    .replace(REDACTED_QUERY_PATTERN, '$1[redacted]')
    .replace(REDACTED_HEADER_PATTERN, '$1[redacted]');
}

/**
 * Render an unknown thrown value as loggable text with its secrets removed.
 */
export function describeErrorForLog(error: unknown): string {
  const detail = error instanceof Error ? (error.stack || error.message) : String(error);
  return redactRequestSecrets(detail);
}

export function localAccessQuery(token: string): string {
  const params = new URLSearchParams({ [LOCAL_ACCESS_QUERY_PARAM]: token });
  return params.toString();
}

export function addLocalAccessToken(params: URLSearchParams, token: string): URLSearchParams {
  params.set(LOCAL_ACCESS_QUERY_PARAM, token);
  return params;
}
