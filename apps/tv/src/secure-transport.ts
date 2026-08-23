import { requireOptionalNativeModule } from 'expo';
import { normalizeCertificateFingerprint } from './server-identity.ts';

type SecureTransportModule = {
  probeCertificate(origin: string): Promise<string>;
  start(origin: string, certificateFingerprint: string): Promise<string>;
  stop(): Promise<void>;
};

const nativeTransport = requireOptionalNativeModule<SecureTransportModule>('LoomTvSecureTransport');

export function secureServerOrigin(value: string): string {
  const text = value.trim().replace(/\/+$/, '');
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Enter only the secure HTTPS LoomTV server address and port.');
  }
  return parsed.origin;
}

function requireTransport(): SecureTransportModule {
  if (!nativeTransport) throw new Error('Certificate-pinned TV networking requires a LoomTV Android TV or Fire TV build.');
  return nativeTransport;
}

export async function probeTvCertificate(origin: string): Promise<string> {
  return normalizeCertificateFingerprint(await requireTransport().probeCertificate(secureServerOrigin(origin)));
}

export async function startTvSecureTransport(origin: string, certificateFingerprint: string): Promise<string> {
  const value = await requireTransport().start(
    secureServerOrigin(origin),
    normalizeCertificateFingerprint(certificateFingerprint),
  );
  const proxy = new URL(value);
  if (proxy.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(proxy.hostname)
    || !/^\/[A-Za-z0-9]+\/?$/.test(proxy.pathname)) {
    throw new Error('The pinned TV transport returned an invalid local endpoint.');
  }
  return `${proxy.origin}${proxy.pathname.replace(/\/$/, '')}`;
}

export async function stopTvSecureTransport(): Promise<void> {
  if (nativeTransport) await nativeTransport.stop();
}
