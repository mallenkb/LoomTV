import os from 'node:os';

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function getLocalNetworkAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

export function getPrimaryLocalNetworkAddress(): string | null {
  return getLocalNetworkAddresses()[0] || null;
}

export function getLocalNetworkNameFast(): string {
  return getPrimaryLocalNetworkAddress() ? 'Connected locally' : 'No local network detected';
}
