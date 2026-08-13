import type { DiscoveredHost, SavedConnection } from './mobileDomain.ts';

export const MOBILE_AUTOMATIC_CONNECT_RETRY_MS = 15_000;

export function upsertDiscoveredHost(
  current: readonly DiscoveredHost[],
  host: DiscoveredHost,
): DiscoveredHost[] {
  return [
    ...current.filter((candidate) => candidate.deviceId !== host.deviceId),
    host,
  ].sort((left, right) => left.deviceName.localeCompare(right.deviceName));
}

export function automaticDiscoveredHost(
  hosts: readonly DiscoveredHost[],
  savedConnection: SavedConnection | null,
): DiscoveredHost | null {
  if (savedConnection) {
    return hosts.find((host) => host.deviceId === savedConnection.hostDeviceId) || null;
  }
  return hosts.length === 1 ? hosts[0] : null;
}

export function automaticHostAttemptKey(host: DiscoveredHost): string {
  return `${host.deviceId}:${host.baseUrl}:${host.certFingerprint}`;
}

export function automaticHostAttemptDelay(
  lastAttemptAt: number | undefined,
  now = Date.now(),
): number {
  if (!lastAttemptAt) return 0;
  return Math.max(0, MOBILE_AUTOMATIC_CONNECT_RETRY_MS - (now - lastAttemptAt));
}
