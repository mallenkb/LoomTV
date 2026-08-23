import type { ZeroconfService } from 'react-native-zeroconf';
import { normalizeCertificateFingerprint } from './server-identity.ts';

export type DiscoveredTvServer = {
  id: string;
  name: string;
  baseUrl: string;
  certificateFingerprint: string;
};

export function discoveredTvServer(service: ZeroconfService): DiscoveredTvServer | null {
  const txt = service.txt || {};
  if (String(txt.protocolVersion || '') !== '2') return null;
  const id = String(txt.instanceId || '').trim();
  const port = Number(service.port || 0);
  let certificateFingerprint: string;
  try { certificateFingerprint = normalizeCertificateFingerprint(String(txt.certFingerprint || '')); }
  catch { return null; }
  if (!id || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  const addresses = service.addresses || [];
  const ipv4 = addresses.find((candidate) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate));
  const ipv6 = addresses.find((candidate) => candidate.includes(':'))?.split('%')[0];
  const host = ipv4 || (ipv6 ? `[${ipv6}]` : '') || String(service.host || '').replace(/\.$/, '');
  if (!host) return null;
  return {
    id,
    name: String(service.name || host).trim() || host,
    baseUrl: `https://${host}:${port}`,
    certificateFingerprint,
  };
}
