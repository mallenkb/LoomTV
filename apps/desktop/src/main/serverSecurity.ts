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
  if (origin === 'null' || origin === 'file://') return origin;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    return allowedOrigins.has(parsed.origin) || (isHttp && isLoopbackAddress(hostname))
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

export function localAccessQuery(token: string): string {
  const params = new URLSearchParams({ [LOCAL_ACCESS_QUERY_PARAM]: token });
  return params.toString();
}

export function addLocalAccessToken(params: URLSearchParams, token: string): URLSearchParams {
  params.set(LOCAL_ACCESS_QUERY_PARAM, token);
  return params;
}
