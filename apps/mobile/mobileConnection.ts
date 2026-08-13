import type { ZeroconfService } from 'react-native-zeroconf';
import { normalizeCertFingerprint } from './mobileDomain.ts';
import type { DiscoveredHost } from './mobileDomain.ts';

export const serverOfflineHint = 'Reconnecting automatically.';

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter the desktop app address.');
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'https:') {
    throw new Error(
      'Use the secure HTTPS LAN address from desktop Settings → Network (for example, https://192.168.1.25:3848).',
    );
  }
  return parsed.origin;
}

export function discoveredHostFromService(service: ZeroconfService): DiscoveredHost | null {
  const txt = service.txt || {};
  if (String(txt.protocolVersion || '') !== '2') return null;
  const deviceId = String(txt.instanceId || '').trim();
  const deviceName = String(service.name || '').trim();
  const certFingerprint = normalizeCertFingerprint(txt.certFingerprint);
  const port = Number(service.port || 0);
  if (!deviceId || !Number.isInteger(port) || port <= 0 || !/^[0-9a-f]{64}$/i.test(certFingerprint)) return null;

  const serviceName = String(service.name || '').trim();
  const addresses = service.addresses || [];
  const ipv4Address = addresses.find((candidate) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate));
  const ipv6Address = addresses.find((candidate) => candidate.includes(':'))?.split('%')[0];
  const resolvedHost = ipv4Address
    || (ipv6Address ? `[${ipv6Address}]` : '')
    || String(service.host || '').trim().replace(/\.$/, '');
  if (!resolvedHost) return null;

  return {
    deviceId,
    deviceName: deviceName || resolvedHost,
    serviceName,
    baseUrl: `https://${resolvedHost}:${port}`,
    certFingerprint,
  };
}

function isLikelyServerOfflineError(error: string): boolean {
  const normalized = error.toLowerCase();
  const statusMatch = normalized.match(/\((\d{3})\)/);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : NaN;
  return (
    normalized.includes('network request failed')
    || normalized.includes('failed to fetch')
    || normalized.includes('econnrefused')
    || normalized.includes('ehostunreach')
    || normalized.includes('enetunreach')
    || normalized.includes('timed out')
    || normalized.includes('did not respond within')
    || status === 502
    || status === 503
    || status === 504
  );
}

export function connectionErrorFor(error: unknown, fallback: string): { message: string; isOffline: boolean } {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return { isOffline: true, message: '' };
    const isOffline = isLikelyServerOfflineError(error.message);
    return {
      isOffline,
      message: isOffline
        ? `Desktop unavailable. ${serverOfflineHint}`
        : error.message || fallback,
    };
  }
  const message = typeof error === 'string' ? error : fallback;
  const isOffline = isLikelyServerOfflineError(message);
  return {
    isOffline,
    message: isOffline
      ? `Desktop unavailable. ${serverOfflineHint}`
      : message,
  };
}
