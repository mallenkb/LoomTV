import dns from 'node:dns/promises';
import net from 'node:net';

export type SafeFetchOptions = {
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  maxRedirects?: number;
};

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (net.isIPv4(normalized)) return isPrivateIpv4(normalized);
  if (!net.isIPv6(normalized)) return true;
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? isPrivateIpv4(mapped) : false;
}

function hostAllowed(hostname: string, allowedHosts?: readonly string[]): boolean {
  if (!allowedHosts?.length) return true;
  const normalized = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    return normalized === allowed || (allowed.startsWith('.') && normalized.endsWith(allowed));
  });
}

async function assertSafeUrl(url: URL, allowedHosts?: readonly string[]): Promise<void> {
  if (url.protocol !== 'https:') throw new Error('Only HTTPS provider URLs are allowed.');
  if (!hostAllowed(url.hostname, allowedHosts)) throw new Error(`Provider host is not allowed: ${url.hostname}`);
  if (net.isIP(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new Error('Private network provider addresses are not allowed.');
    return;
  }
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Provider host resolved to a private or invalid address.');
  }
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

async function fetchAttempt(input: string | URL, init: RequestInit, options: Required<Omit<SafeFetchOptions, 'allowedHosts'>> & Pick<SafeFetchOptions, 'allowedHosts'>): Promise<Response> {
  let url = new URL(input.toString());
  let method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    await assertSafeUrl(url, options.allowedHosts);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(url, { ...init, method, body, redirect: 'manual', signal: controller.signal });
      if (response.status < 300 || response.status >= 400) return await boundedResponse(response, options.maxBytes);
      const location = response.headers.get('location');
      if (!location) return await boundedResponse(response, options.maxBytes);
      if (redirects === options.maxRedirects) throw new Error('Provider redirected too many times.');
      url = new URL(location, url);
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
  const resolved = {
    allowedHosts: options.allowedHosts,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
    retries: options.retries ?? 0,
    maxRedirects: options.maxRedirects ?? 3,
  };
  const method = (init.method || 'GET').toUpperCase();
  const mayRetry = method === 'GET' || method === 'HEAD';
  for (let attempt = 0; attempt <= resolved.retries; attempt += 1) {
    const response = await fetchAttempt(input, init, resolved);
    if (mayRetry && (response.status === 429 || response.status >= 500) && attempt < resolved.retries) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt) + Math.floor(Math.random() * 150)));
      continue;
    }
    return response;
  }
  throw new Error('Provider request failed.');
}
