import os from 'node:os';
import { execFileSync } from 'node:child_process';

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

function cleanNetworkName(value?: string | null): string | null {
  const name = (value || '').trim();
  if (!name || /^<redacted>$/i.test(name) || /not associated/i.test(name)) return null;
  return name;
}

function getWifiDeviceName(): string {
  try {
    const hardwarePorts = execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 1000 });
    return hardwarePorts.match(/Hardware Port: Wi-Fi[\s\S]*?Device: (\S+)/)?.[1] || 'en0';
  } catch {
    return 'en0';
  }
}

function getMacWifiSsid(wifiDevice: string): string | null {
  try {
    const airportNetwork = execFileSync('networksetup', ['-getairportnetwork', wifiDevice], { encoding: 'utf8', timeout: 1000 });
    const match = airportNetwork.match(/Current Wi-Fi Network: (.+)$/m);
    const name = cleanNetworkName(match?.[1]);
    if (name) return name;
  } catch {
    // Try the next source.
  }

  try {
    const summary = execFileSync('ipconfig', ['getsummary', wifiDevice], { encoding: 'utf8', timeout: 1000 });
    const name = cleanNetworkName(summary.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]);
    if (name) return name;
  } catch {
    // Try the next source.
  }

  try {
    const profiler = execFileSync('system_profiler', ['SPAirPortDataType', '-detailLevel', 'mini'], { encoding: 'utf8', timeout: 2500 });
    const currentNetworkBlock = profiler.match(/Current Network Information:\s*\n\s*([^:\n]+):/);
    const name = cleanNetworkName(currentNetworkBlock?.[1] || profiler.match(/^\s*SSID:\s*(.+)$/m)?.[1]);
    if (name) return name;
  } catch {
    // Fall through to interface-based labels.
  }

  return null;
}

function getWindowsWifiSsid(): string | null {
  try {
    const output = execFileSync('netsh', ['wlan', 'show', 'interfaces'], { encoding: 'utf8', timeout: 1500 });
    const connectedBlocks = output.split(/\r?\n\r?\n/).filter((block) => /State\s*:\s*connected/i.test(block));
    const source = connectedBlocks[0] || output;
    const name = cleanNetworkName(source.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]);
    return name;
  } catch {
    return null;
  }
}

function getLinuxWifiSsid(): string | null {
  try {
    const output = execFileSync('iwgetid', ['-r'], { encoding: 'utf8', timeout: 1000 });
    const name = cleanNetworkName(output);
    if (name) return name;
  } catch {
    // Try NetworkManager below.
  }

  try {
    const output = execFileSync('nmcli', ['-t', '-f', 'active,ssid', 'dev', 'wifi'], { encoding: 'utf8', timeout: 1500 });
    const activeLine = output.split(/\r?\n/).find((line) => line.startsWith('yes:'));
    const name = cleanNetworkName(activeLine?.slice('yes:'.length).replace(/\\:/g, ':'));
    if (name) return name;
  } catch {
    // Try iw below.
  }

  try {
    const output = execFileSync('iw', ['dev'], { encoding: 'utf8', timeout: 1000 });
    const interfaces = [...output.matchAll(/Interface\s+(\S+)/g)].map((match) => match[1]);
    for (const networkInterface of interfaces) {
      try {
        const link = execFileSync('iw', ['dev', networkInterface, 'link'], { encoding: 'utf8', timeout: 1000 });
        const name = cleanNetworkName(link.match(/^\s*SSID:\s*(.+)$/m)?.[1]);
        if (name) return name;
      } catch {
        // Try the next interface.
      }
    }
  } catch {
    // Fall through to the generic local label.
  }

  return null;
}

export function getLocalNetworkName(): string {
  if (process.platform === 'darwin') {
    const wifiDevice = getWifiDeviceName();
    const ssid = getMacWifiSsid(wifiDevice);
    if (ssid) return ssid;
  } else if (process.platform === 'win32') {
    const ssid = getWindowsWifiSsid();
    if (ssid) return ssid;
  } else if (process.platform === 'linux') {
    const ssid = getLinuxWifiSsid();
    if (ssid) return ssid;
  }

  return getPrimaryLocalNetworkAddress() ? 'Connected locally' : 'No local network detected';
}

export function getLocalNetworkNameFast(): string {
  return getPrimaryLocalNetworkAddress() ? 'Connected locally' : 'No local network detected';
}
