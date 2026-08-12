import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { createOperation, type CacheStatus } from './observability.ts';

type ResolvedAddress = { address: string; family: number };
type LookupImplementation = (hostname: string, options: { all: true; verbatim: true }) => Promise<ResolvedAddress[]>;
type PinnedRequestImplementation = (url: URL, init: RequestInit, address: string, maxBytes: number) => Promise<Response>;

export type SafeFetchOptions = {
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  maxRedirects?: number;
  /** Injectable only for deterministic resolver/request boundary tests. */
  lookup?: LookupImplementation;
  /** Injectable only for deterministic resolver/request boundary tests. */
  requestImpl?: PinnedRequestImplementation;
  operation?: string;
  provider?: string;
  cacheStatus?: CacheStatus;
};

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

const IPV6_BITS = 128n;

function parseIpv6(address: string): bigint | null {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!normalized || normalized.includes(':::')) return null;
  const separator = normalized.indexOf('::');
  if (separator !== -1 && normalized.indexOf('::', separator + 2) !== -1) return null;
  const expandSide = (side: string): number[] | null => {
    if (!side) return [];
    const parts = side.split(':');
    const words: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.includes('.')) {
        if (index !== parts.length - 1 || !net.isIPv4(part)) return null;
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      words.push(Number.parseInt(part, 16));
    }
    return words;
  };
  const left = expandSide(separator === -1 ? normalized : normalized.slice(0, separator));
  const right = expandSide(separator === -1 ? '' : normalized.slice(separator + 2));
  if (!left || !right) return null;
  const omitted = 8 - left.length - right.length;
  if ((separator === -1 && omitted !== 0) || (separator !== -1 && omitted < 1)) return null;
  const words = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (words.length !== 8) return null;
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

function ipv6CidrContains(address: bigint, prefix: string, bits: number): boolean {
  const network = parseIpv6(prefix);
  if (network === null || bits < 0 || bits > Number(IPV6_BITS)) return false;
  if (bits === 0) return true;
  const shift = IPV6_BITS - BigInt(bits);
  return (address >> shift) === (network >> shift);
}

/**
 * Return true for every IPv6 address that must not be contacted by provider
 * transports. Provider fetches are fail-closed: only ordinary global unicast
 * space is accepted, with IANA special-purpose, documentation, deprecated,
 * mapped, and transition ranges denied explicitly.
 */
function isNonGlobalIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return true;

  // Global unicast is currently 2000::/3. This single allow-boundary also
  // rejects unspecified, loopback, IPv4-compatible/mapped, NAT64 WKPs
  // (64:ff9b::/96 and 64:ff9b:1::/48), discard-only 100::/64, ULA,
  // link-local, deprecated site-local fec0::/10, and multicast space.
  if (!ipv6CidrContains(value, '2000::', 3)) return true;

  return [
    // IETF protocol assignments, benchmarking/ORCHID/Teredo allocations,
    // documentation space, and other non-ordinary assignments in 2001::/23.
    ['2001::', 23],
    // 6to4 embeds an IPv4 destination and must not bypass the IPv4 policy.
    ['2002::', 16],
    // Former 6bone and documentation prefixes.
    ['3ffe::', 16],
  ].some(([prefix, bits]) => ipv6CidrContains(value, String(prefix), Number(bits)));
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(normalized)) return isPrivateIpv4(normalized);
  if (!net.isIPv6(normalized)) return true;
  return isNonGlobalIpv6(normalized);
}

function hostAllowed(hostname: string, allowedHosts?: readonly string[]): boolean {
  if (!allowedHosts?.length) return true;
  const normalized = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    return normalized === allowed || (allowed.startsWith('.') && normalized.endsWith(allowed));
  });
}

async function assertSafeUrl(
  url: URL,
  allowedHosts: readonly string[] | undefined,
  lookup: LookupImplementation,
): Promise<string> {
  if (url.protocol !== 'https:') throw new Error('Only HTTPS provider URLs are allowed.');
  if (!hostAllowed(url.hostname, allowedHosts)) throw new Error(`Provider host is not allowed: ${url.hostname}`);
  if (net.isIP(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new Error('Private network provider addresses are not allowed.');
    return url.hostname;
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Provider host resolved to a private or invalid address.');
  }
  // The resolver result is part of the security decision. The request below
  // must use this exact public address; resolving once and then letting the
  // HTTP client perform a second lookup leaves a DNS-rebinding window.
  return addresses[0].address;
}

async function pinnedHttpsRequest(url: URL, init: RequestInit, address: string, maxBytes: number): Promise<Response> {
  const headers = new Headers(init.headers);
  // Keep the virtual host for routing and certificate SNI while connecting to
  // the already-validated address. Never allow a caller-provided Host header
  // to change the authority that was checked above.
  headers.set('host', url.host);
  const body = init.body === undefined || init.body === null
    ? undefined
    : typeof init.body === 'string'
      ? init.body
      : init.body instanceof ArrayBuffer
        ? Buffer.from(init.body)
        : ArrayBuffer.isView(init.body)
          ? Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength)
          : (() => { throw new Error('Streaming request bodies are not supported by the safe provider transport.'); })();

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const request = https.request({
      protocol: 'https:',
      hostname: address,
      port: url.port || '443',
      path: `${url.pathname}${url.search}`,
      method: (init.method || 'GET').toUpperCase(),
      headers: Object.fromEntries(headers.entries()),
      servername: url.hostname,
      signal: init.signal || undefined,
      // Prevent a second resolver call inside https.request. The address is
      // still checked by the TLS certificate against the original hostname.
      lookup: (_hostname, _options, callback) => callback(null, address, net.isIPv4(address) ? 4 : 6),
    }, (response) => {
      const chunks: Buffer[] = [];
      let byteLength = 0;
      response.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.byteLength;
        if (byteLength > maxBytes) {
          settled = true;
          response.destroy();
          reject(new Error(`Provider response exceeds ${maxBytes} bytes.`));
          return;
        }
        chunks.push(bytes);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers: responseHeaders,
        }));
      });
      response.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function boundedResponse(response: Response, maxBytes: number): Promise<Response> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) throw new Error(`Provider response exceeds ${maxBytes} bytes.`);
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let reading = true;
  try {
    while (reading) {
      const { done, value } = await reader.read();
      if (done) {
        reading = false;
        continue;
      }
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Provider response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const REDIRECT_SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
  'proxy-authenticate',
  'set-cookie',
  'x-api-key',
  'x-api-secret',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-client-secret',
  'x-config',
  'x-credential',
  'x-forwarded-authorization',
  'x-forwarded-cookie',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  'referer',
]);

function stripRedirectSensitiveHeaders(headers: HeadersInit | undefined): Headers {
  const safe = new Headers(headers);
  for (const name of REDIRECT_SENSITIVE_HEADERS) safe.delete(name);
  for (const [name] of safe) {
    const normalized = name.toLowerCase();
    if (/(?:auth|cookie|secret|token|credential|config|password|signature|session)/i.test(normalized)) safe.delete(name);
  }
  return safe;
}

type SafeFetchTransportOptions = Required<Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes' | 'retries' | 'maxRedirects'>>
  & Pick<SafeFetchOptions, 'allowedHosts' | 'lookup' | 'requestImpl'>;

async function fetchAttempt(input: string | URL, init: RequestInit, options: SafeFetchTransportOptions): Promise<Response> {
  let url = new URL(input.toString());
  let method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  let headers: HeadersInit | undefined = init.headers;
  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    const address = await assertSafeUrl(url, options.allowedHosts, options.lookup || (dns.lookup as LookupImplementation));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await (options.requestImpl || pinnedHttpsRequest)(
        url,
        { ...init, headers, method, body, redirect: 'manual', signal: controller.signal },
        address,
        options.maxBytes,
      );
      if (response.status < 300 || response.status >= 400) return await boundedResponse(response, options.maxBytes);
      const location = response.headers.get('location');
      if (!location) return await boundedResponse(response, options.maxBytes);
      if (redirects === options.maxRedirects) throw new Error('Provider redirected too many times.');
      const nextUrl = new URL(location, url);
      if (nextUrl.origin !== url.origin) {
        // A provider redirect is a new authority. Do not allow credentials,
        // cookies, config fields, or similarly named secret headers to follow
        // it even when the caller supplied them on the original request.
        headers = stripRedirectSensitiveHeaders(headers);
      }
      url = nextUrl;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    }
  }
  throw new Error('Provider redirected too many times.');
}

export async function safeFetch(input: string | URL, init: RequestInit = {}, options: SafeFetchOptions = {}): Promise<Response> {
  const target = input instanceof URL ? input : new URL(input);
  const operation = createOperation(options.operation ?? 'provider.fetch');
  const provider = options.provider ?? target.hostname;
  const resolved = {
    allowedHosts: options.allowedHosts,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
    retries: options.retries ?? 0,
    maxRedirects: options.maxRedirects ?? 3,
    lookup: options.lookup,
    requestImpl: options.requestImpl,
  };
  const method = (init.method || 'GET').toUpperCase();
  const mayRetry = method === 'GET' || method === 'HEAD';
  let retryCount = 0;
  try {
    for (let attempt = 0; attempt <= resolved.retries; attempt += 1) {
      const response = await fetchAttempt(input, init, resolved);
      if (mayRetry && (response.status === 429 || response.status >= 500) && attempt < resolved.retries) {
        retryCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt) + Math.floor(Math.random() * 150)));
        continue;
      }
      operation.finish({
        resultCode: response.ok ? 'success' : 'http_error',
        cacheStatus: options.cacheStatus ?? 'not-applicable',
        provider,
        retryCount,
        context: { method, status: response.status, routeFamily: 'provider' },
      });
      return response;
    }
  } catch (error) {
    operation.finish({
      resultCode: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'failed',
      cacheStatus: options.cacheStatus ?? 'not-applicable',
      provider,
      retryCount,
      context: { method, routeFamily: 'provider' },
    });
    throw error;
  }
  throw new Error('Provider request failed.');
}
