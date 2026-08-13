export function normalizeLoopbackProxyBaseUrl(value: string): string {
  const proxy = new URL(value);
  if (
    proxy.protocol !== 'http:'
    || (proxy.hostname !== 'localhost' && proxy.hostname !== '127.0.0.1')
    || !/^\/[A-Za-z0-9]+\/?$/.test(proxy.pathname)
  ) {
    throw new Error('The secure LAN transport returned an invalid loopback endpoint.');
  }
  return `${proxy.origin}${proxy.pathname.replace(/\/$/, '')}`;
}

export function rewriteSecureLanUrl(
  value: string,
  remoteOrigin: string,
  proxyBaseUrl: string,
): string {
  if (!/^https?:/i.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== remoteOrigin) return value;
    return `${proxyBaseUrl}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return value;
  }
}
