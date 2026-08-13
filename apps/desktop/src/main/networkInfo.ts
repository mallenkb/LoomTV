import os from 'node:os';

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function getLocalNetworkAddresses(): string[] {
  return rankLocalNetworkAddresses(os.networkInterfaces());
}

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  return octets.length === 4 && octets.every(Number.isInteger) && (
    octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  );
}

function interfacePriority(name: string, address: string): number {
  const normalized = name.toLowerCase();
  const virtual = /^(utun|awdl|llw|bridge|docker|vbox|vmnet|tailscale|wg)/.test(normalized);
  const physical = /^(en\d+|eth\d+|wlan\d+|wi-?fi)/.test(normalized);
  return (virtual ? 100 : 0) + (physical ? 0 : 20) + (isPrivateIpv4(address) ? 0 : 10);
}

export function rankLocalNetworkAddresses(interfaces: NetworkInterfaces): string[] {
  return Object.entries(interfaces)
    .flatMap(([name, entries]) => (entries || [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => ({ name, address: entry.address })))
    .sort((left, right) => (
      interfacePriority(left.name, left.address) - interfacePriority(right.name, right.address)
      || left.name.localeCompare(right.name)
      || left.address.localeCompare(right.address)
    ))
    .map((candidate) => candidate.address);
}

export function getPrimaryLocalNetworkAddress(): string | null {
  return getLocalNetworkAddresses()[0] || null;
}

export function getLocalNetworkNameFast(): string {
  return getPrimaryLocalNetworkAddress() ? 'Connected locally' : 'No local network detected';
}
