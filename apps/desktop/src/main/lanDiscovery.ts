/**
 * mDNS/Bonjour advertise + browse for LoomTV LAN sharing.
 *
 * Service type: `_loomtv._tcp`. TXT records are deliberately limited to
 * protocol metadata and never contain pairing credentials or API secrets.
 */
import { Bonjour, type Service } from 'bonjour-service';
import { spawn, type ChildProcess } from 'node:child_process';

const SERVICE_TYPE = 'loomtv';

export type LanAdvertiseOptions = {
  port: number;
  instanceId: string;
  deviceName: string;
  protocolVersion: '2';
  certFingerprint?: string;
};

export type LanPeer = {
  deviceId: string;
  deviceName: string;
  host: string;
  port: number;
  addresses: string[];
  appVersion: string;
  certFingerprint: string;
};

let bonjour: Bonjour | null = null;
let publishedService: Service | null = null;
let nativeMacAdvertiser: ChildProcess | null = null;
let lastMdnsWarningAt = 0;
let suppressedMdnsWarnings = 0;

const MDNS_WARNING_INTERVAL_MS = 30_000;

type MdnsEmitter = {
  on: (event: 'error' | 'warning', listener: (error: NodeJS.ErrnoException) => void) => void;
};

type BonjourInternals = {
  server?: {
    mdns?: MdnsEmitter;
  };
};

function handleMdnsError(error: unknown): void {
  const now = Date.now();
  if (now - lastMdnsWarningAt < MDNS_WARNING_INTERVAL_MS) {
    suppressedMdnsWarnings += 1;
    return;
  }

  const detail = error instanceof Error ? error.message : String(error);
  const suppressed = suppressedMdnsWarnings > 0
    ? ` (${suppressedMdnsWarnings} similar warning${suppressedMdnsWarnings === 1 ? '' : 's'} suppressed)`
    : '';
  console.warn(`[mdns] Local discovery is temporarily unavailable: ${detail}${suppressed}`);
  lastMdnsWarningAt = now;
  suppressedMdnsWarnings = 0;
}

function ensureBonjour(): Bonjour {
  if (!bonjour) {
    // bonjour-service throws asynchronous UDP send failures by default. mDNS
    // is an optional convenience layer, so an unavailable multicast route must
    // never take down the HTTP media server or interrupt direct-IP clients.
    bonjour = new Bonjour({}, handleMdnsError);
    const mdns = (bonjour as unknown as BonjourInternals).server?.mdns;
    mdns?.on('error', handleMdnsError);
    mdns?.on('warning', handleMdnsError);
  }
  return bonjour;
}

// Android's NsdManager cannot resolve mDNS instance names that contain dots
// (hostnames like "Marlons-Macbook.local" get escaped to "…\.local" on the
// wire and the resolve query never matches), so the advertised instance name
// must be dot-free. The full device name still travels in the TXT record.
function instanceNameFor(deviceName: string): string {
  return deviceName.replace(/\.local\.?$/i, '').replace(/\./g, '-').trim() || 'LoomTV';
}

function advertiseWithMacDnsSd(opts: LanAdvertiseOptions): boolean {
  if (process.platform !== 'darwin') return false;

  try {
    const child = spawn('/usr/bin/dns-sd', [
      '-R',
      instanceNameFor(opts.deviceName),
      '_loomtv._tcp',
      'local.',
      String(opts.port),
      `protocolVersion=${opts.protocolVersion}`,
      `instanceId=${opts.instanceId}`,
      `port=${opts.port}`,
      ...(opts.certFingerprint ? [`certFingerprint=${opts.certFingerprint}`] : []),
    ], {
      stdio: 'ignore',
    });

    nativeMacAdvertiser = child;
    child.once('error', (error) => {
      if (nativeMacAdvertiser === child) nativeMacAdvertiser = null;
      handleMdnsError(error);
    });
    child.once('exit', (code, signal) => {
      if (nativeMacAdvertiser !== child) return;
      nativeMacAdvertiser = null;
      if (code && code !== 0 && signal !== 'SIGTERM') {
        handleMdnsError(new Error(`macOS DNS-SD advertiser exited with code ${code}`));
      }
    });
    return true;
  } catch (error) {
    handleMdnsError(error);
    return false;
  }
}

export function advertiseLanService(opts: LanAdvertiseOptions): void {
  unadvertiseLanService();
  if (advertiseWithMacDnsSd(opts)) return;

  try {
    const instance = ensureBonjour();
    publishedService = instance.publish({
      name: instanceNameFor(opts.deviceName),
      type: SERVICE_TYPE,
      port: opts.port,
      txt: {
        protocolVersion: opts.protocolVersion,
        instanceId: opts.instanceId,
        port: String(opts.port),
        ...(opts.certFingerprint ? { certFingerprint: opts.certFingerprint } : {}),
      },
    });
  } catch (error) {
    console.warn('[mdns] advertise failed:', error);
    publishedService = null;
  }
}

export function unadvertiseLanService(): void {
  if (nativeMacAdvertiser) {
    const child = nativeMacAdvertiser;
    nativeMacAdvertiser = null;
    try {
      child.kill('SIGTERM');
    } catch (error) {
      console.warn('[mdns] native advertiser stop failed:', error);
    }
  }

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
    const peers = new Map<string, LanPeer>();
    let resolved = false;
    let instance: Bonjour;

    try {
      instance = ensureBonjour();
    } catch (error) {
      handleMdnsError(error);
      resolve([]);
      return;
    }

    let browser: ReturnType<Bonjour['find']>;
    try {
      browser = instance.find({ type: SERVICE_TYPE });
    } catch (error) {
      handleMdnsError(error);
      resolve([]);
      return;
    }
    const handleService = (service: Service) => {
      const txt = (service.txt || {}) as Record<string, string>;
      if (String(txt.protocolVersion || '') !== '2') return;
      const deviceId = String(txt.instanceId || '').trim();
      const deviceName = String(service.name || '').trim();
      const appVersion = 'protocol-v2';
      const certFingerprint = String(txt.certFingerprint || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
      if (
        !deviceId
        || !/^[0-9a-f]{64}$/.test(certFingerprint)
        || (excludeDeviceId && deviceId === excludeDeviceId)
      ) return;

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
        certFingerprint,
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
