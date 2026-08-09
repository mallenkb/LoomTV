import net from 'node:net';

function configurationError(message) {
  return Object.assign(new Error(message), { code: 'INSECURE_TRANSPORT_CONFIGURATION' });
}

export function isLoopbackBindHost(host) {
  const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (net.isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
}

export function assertTransportConfiguration(options) {
  const directTls = options.directTls === true;
  const trustedProxyConfigured = options.proxyPolicy?.trustedProxies?.length > 0;
  const secureProxy = trustedProxyConfigured && options.requireSecureTransport === true;
  if (trustedProxyConfigured && options.requireSecureTransport !== true) {
    throw configurationError(
      'Trusted proxies also require --require-secure-transport so forwarded requests without HTTPS are rejected.',
    );
  }
  if (!isLoopbackBindHost(options.host)
    && !directTls
    && !secureProxy
    && options.developmentAllowInsecureNonLoopback !== true) {
    throw configurationError(
      `Refusing cleartext non-loopback bind on ${options.host}. Configure --tls-cert-file and --tls-key-file, use --require-secure-transport with an explicit --trusted-proxies allowlist behind a TLS reverse proxy, or set --development-allow-insecure-non-loopback only for an isolated development network.`,
    );
  }
}
