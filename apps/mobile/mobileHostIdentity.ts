import { normalizeCertFingerprint, type DiscoveredHost, type SavedConnection } from './mobileDomain.ts';

export type SavedHostReconciliation =
  | { kind: 'unchanged'; connection: SavedConnection }
  | { kind: 'updated'; connection: SavedConnection }
  | { kind: 'identity-mismatch' };

type PairIdentity = {
  certFingerprint: string;
  hostDeviceId?: string;
};

export function validatePairIdentity(
  payload: PairIdentity,
  observedFingerprint: string,
  discovered?: Pick<DiscoveredHost, 'certFingerprint' | 'deviceId'>,
): string {
  const certFingerprint = normalizeCertFingerprint(payload.certFingerprint);
  const observed = normalizeCertFingerprint(observedFingerprint);
  const discoveredFingerprint = normalizeCertFingerprint(discovered?.certFingerprint);
  if (!certFingerprint) {
    throw new Error('This desktop does not provide a secure host identity. Update LoomTV on the desktop, then pair again.');
  }
  if (!observed || certFingerprint !== observed) {
    throw new Error('The desktop TLS identity changed during pairing. Refresh discovery and try again.');
  }
  if (discoveredFingerprint && discoveredFingerprint !== certFingerprint) {
    throw new Error('The desktop security fingerprint changed during pairing. Refresh devices and approve the connection again.');
  }
  if (discovered?.deviceId && payload.hostDeviceId && discovered.deviceId !== payload.hostDeviceId) {
    throw new Error('The desktop identity changed during pairing. Refresh devices and approve the connection again.');
  }
  return certFingerprint;
}

/** A discovery result may update only the address bound to the saved host ID and certificate pin. */
export function reconcileSavedHost(
  saved: SavedConnection,
  discovered: DiscoveredHost,
): SavedHostReconciliation {
  const discoveredFingerprint = normalizeCertFingerprint(discovered.certFingerprint);
  if (
    discovered.deviceId !== saved.hostDeviceId
    || !discoveredFingerprint
    || discoveredFingerprint !== normalizeCertFingerprint(saved.certFingerprint)
  ) return { kind: 'identity-mismatch' };

  if (discovered.baseUrl === saved.baseUrl) return { kind: 'unchanged', connection: saved };
  return {
    kind: 'updated',
    connection: {
      ...saved,
      baseUrl: discovered.baseUrl,
      certFingerprint: discoveredFingerprint,
    },
  };
}
