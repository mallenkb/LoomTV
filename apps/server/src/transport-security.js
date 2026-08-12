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
  const secureProxy = options.trustProxy === true && options.requireSecureTransport === true;
  if (options.trustProxy === true && options.requireSecureTransport !== true) {
    throw configurationError(
      'Trusted-proxy mode also requires --require-secure-transport so forwarded requests without HTTPS are rejected.',
    );
  }
  if (!isLoopbackBindHost(options.host)
    && !directTls
    && !secureProxy
    && options.developmentAllowInsecureNonLoopback !== true) {
    throw configurationError(
      `Refusing cleartext non-loopback bind on ${options.host}. Configure --tls-cert-file and --tls-key-file, use --require-secure-transport --trust-proxy behind a TLS reverse proxy, or set --development-allow-insecure-non-loopback only for an isolated development network.`,
    );
  }
}

export function requestUsesSecureTransport(req, trustProxy = false) {
  if (req.socket?.encrypted === true) return true;
  if (!trustProxy) return false;
  const forwardedProto = req.headers['x-forwarded-proto'];
  // A trusted proxy must replace, rather than append to, this header. Reject
  // arrays and comma-separated chains so a client-supplied leading value can
  // never opt a cleartext request into the secure path.
  return typeof forwardedProto === 'string' && forwardedProto.trim().toLowerCase() === 'https';
}
