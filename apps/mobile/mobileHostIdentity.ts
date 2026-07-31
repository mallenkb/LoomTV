import { normalizeCertFingerprint, type DiscoveredHost, type SavedConnection } from './mobileDomain.ts';

export type SavedHostReconciliation =
  | { kind: 'unchanged'; connection: SavedConnection }
  | { kind: 'updated'; connection: SavedConnection }
  | { kind: 'identity-mismatch' };

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
