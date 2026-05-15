/**
 * mDNS/Bonjour advertise + browse for LoomTV LAN sharing.
 *
 * Service type: `_loomtv._tcp`. TXT records expose deviceId, deviceName, and
 * the app version so peers can be listed and filtered without hitting any
 * HTTP endpoint first. Replaces the legacy subnet-scan discovery (which
 * broadcast the share code to every IP on the LAN).
 */
import { Bonjour, type Service } from 'bonjour-service';

const SERVICE_TYPE = 'loomtv';

export type LanAdvertiseOptions = {
  port: number;
  deviceId: string;
  deviceName: string;
  appVersion: string;
};

export type LanPeer = {
  deviceId: string;
  deviceName: string;
  host: string;
  port: number;
  addresses: string[];
  appVersion: string;
};

let bonjour: Bonjour | null = null;
let publishedService: Service | null = null;

function ensureBonjour(): Bonjour {
  if (!bonjour) bonjour = new Bonjour();
  return bonjour;
}

export function advertiseLanService(opts: LanAdvertiseOptions): void {
  unadvertiseLanService();
  try {
    const instance = ensureBonjour();
    publishedService = instance.publish({
      name: opts.deviceName,
      type: SERVICE_TYPE,
      port: opts.port,
      txt: {
        deviceId: opts.deviceId,
        deviceName: opts.deviceName,
        appVersion: opts.appVersion,
      },
    });
  } catch (error) {
    console.warn('[mdns] advertise failed:', error);
    publishedService = null;
  }
}

export function unadvertiseLanService(): void {
  if (!publishedService) return;
  try {
    publishedService.stop?.(() => undefined);
  } catch (error) {
    console.warn('[mdns] stop failed:', error);
  }
  publishedService = null;
}

export function discoverLanPeers(timeoutMs: number, excludeDeviceId?: string): Promise<LanPeer[]> {
  return new Promise((resolve) => {
    const instance = ensureBonjour();
    const peers = new Map<string, LanPeer>();
    let resolved = false;

    const browser = instance.find({ type: SERVICE_TYPE });
    const handleService = (service: Service) => {
      const txt = (service.txt || {}) as Record<string, string>;
      const deviceId = String(txt.deviceId || '').trim();
      const deviceName = String(txt.deviceName || service.name || '').trim();
      const appVersion = String(txt.appVersion || '').trim();
      if (!deviceId || (excludeDeviceId && deviceId === excludeDeviceId)) return;

      const addresses = (service.addresses || []).filter((address) => /^[0-9.]+$/.test(address));
      const host = addresses[0] || service.host;
      if (!host) return;

      peers.set(deviceId, {
        deviceId,
        deviceName: deviceName || host,
        host,
        port: service.port,
        addresses,
        appVersion,
      });
    };

    browser.on('up', handleService);

    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        browser.stop();
      } catch {
        // Ignore stop errors
      }
      resolve([...peers.values()].sort((a, b) => a.deviceName.localeCompare(b.deviceName)));
    };

    setTimeout(finish, Math.max(500, timeoutMs));
  });
}

export function destroyLanDiscovery(): void {
  unadvertiseLanService();
  if (bonjour) {
    try {
      bonjour.destroy();
    } catch {
      // Ignore destroy errors
    }
    bonjour = null;
  }
}
