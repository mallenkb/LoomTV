import { requireOptionalNativeModule } from 'expo';
import { normalizeLoopbackProxyBaseUrl, rewriteSecureLanUrl } from './mobileSecureTransportUrl.ts';

type SecureTransportNativeModule = {
  probeCertificate(origin: string): Promise<string>;
  start(origin: string, certFingerprint: string): Promise<string>;
  stop(): Promise<void>;
};

type ActiveTransport = {
  remoteOrigin: string;
  proxyBaseUrl: string;
  certFingerprint: string;
};

const nativeTransport = requireOptionalNativeModule<SecureTransportNativeModule>('LoomTvSecureTransport');
let activeTransport: ActiveTransport | null = null;
let pendingConfiguration: Promise<ActiveTransport> | null = null;

function normalizedFingerprint(value: string): string {
  const normalized = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('The server did not provide a valid TLS certificate fingerprint. Pair again with a current LoomTV server.');
  }
  return normalized;
}

function secureOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') {
    throw new Error('LoomTV requires a secure HTTPS server address. Select the server again and re-pair.');
  }
  return parsed.origin;
}

function requireTransport(): SecureTransportNativeModule {
  if (!nativeTransport) {
    throw new Error('Secure LAN transport requires a LoomTV development or store build. Rebuild the mobile app, then pair again.');
  }
  return nativeTransport;
}

export async function probeLanCertificate(baseUrl: string): Promise<string> {
  const remoteOrigin = secureOrigin(baseUrl);
  const fingerprint = await requireTransport().probeCertificate(remoteOrigin);
  return normalizedFingerprint(fingerprint);
}

export async function configureSecureLanTransport(
  baseUrl: string,
  certFingerprint: string,
): Promise<ActiveTransport> {
  const remoteOrigin = secureOrigin(baseUrl);
  const fingerprint = normalizedFingerprint(certFingerprint);
  if (activeTransport?.remoteOrigin === remoteOrigin && activeTransport.certFingerprint === fingerprint) {
    return activeTransport;
  }
  if (pendingConfiguration) await pendingConfiguration;
  if (activeTransport?.remoteOrigin === remoteOrigin && activeTransport.certFingerprint === fingerprint) {
    return activeTransport;
  }

  const transport = requireTransport();
  pendingConfiguration = transport.start(remoteOrigin, fingerprint).then((proxyBaseUrl) => {
    activeTransport = {
      remoteOrigin,
      proxyBaseUrl: normalizeLoopbackProxyBaseUrl(proxyBaseUrl),
      certFingerprint: fingerprint,
    };
    return activeTransport;
  }).finally(() => {
    pendingConfiguration = null;
  });
  return pendingConfiguration;
}

export function secureLanUrl(value: string): string {
  if (!activeTransport) return value;
  return rewriteSecureLanUrl(value, activeTransport.remoteOrigin, activeTransport.proxyBaseUrl);
}

export async function stopSecureLanTransport(): Promise<void> {
  activeTransport = null;
  pendingConfiguration = null;
  if (nativeTransport) await nativeTransport.stop();
}
