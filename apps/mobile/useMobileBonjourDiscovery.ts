import { useCallback, useEffect, useState } from 'react';
import Zeroconf from 'react-native-zeroconf';

import { discoveredHostFromService } from './mobileConnection';
import type { Connection, DiscoveredHost } from './mobileDomain';
import { upsertDiscoveredHost } from './mobileDiscoveryExperience';
import { reportNonFatal } from './mobileDiagnostics';

export function useMobileBonjourDiscovery({ connection, isServerOffline }: {
  connection: Connection | null;
  isServerOffline: boolean;
}) {
  const [discoveredHosts, setDiscoveredHosts] = useState<DiscoveredHost[]>([]);
  const [isDiscoveringHosts, setIsDiscoveringHosts] = useState(true);
  const [discoveryError, setDiscoveryError] = useState('');
  const [scanGeneration, setScanGeneration] = useState(0);
  const refreshDiscovery = useCallback(() => {
    setDiscoveryError('');
    setScanGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    const zeroconf = new Zeroconf();
    const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let scanWindow: ReturnType<typeof setTimeout> | null = null;
    let nextScan: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    zeroconf.on('resolved', (service) => {
      const host = discoveredHostFromService(service);
      if (!host) return;
      const pendingRemoval = removalTimers.get(host.serviceName);
      if (pendingRemoval) clearTimeout(pendingRemoval);
      removalTimers.delete(host.serviceName);
      setDiscoveryError('');
      setDiscoveredHosts((current) => upsertDiscoveredHost(current, host));
    });
    zeroconf.on('remove', (name) => {
      const existing = removalTimers.get(name);
      if (existing) clearTimeout(existing);
      removalTimers.set(name, setTimeout(() => {
        removalTimers.delete(name);
        setDiscoveredHosts((current) => current.filter((host) => host.serviceName !== name));
      }, 5_000));
    });
    zeroconf.on('error', (error) => {
      reportNonFatal('zeroconf.discovery', error);
      setDiscoveryError('Open LoomTV on your desktop, or connect manually.');
      setIsDiscoveringHosts(false);
    });
    zeroconf.on('start', () => setIsDiscoveringHosts(true));

    const startScan = () => {
      if (stopped) return;
      setIsDiscoveringHosts(true);
      setDiscoveryError('');
      try {
        zeroconf.scan('loomtv', 'tcp', 'local.');
      } catch (error) {
        reportNonFatal('zeroconf.scan', error);
        setDiscoveryError('Open LoomTV on your desktop, or connect manually.');
        setIsDiscoveringHosts(false);
      }
      scanWindow = setTimeout(() => {
        try { zeroconf.stop(); } catch (error) { reportNonFatal('zeroconf.stop', error); }
        setIsDiscoveringHosts(false);
        const rescanDelay = connection && !isServerOffline ? 30_000 : 5_000;
        nextScan = setTimeout(startScan, rescanDelay);
      }, 5_000);
    };

    startScan();
    return () => {
      stopped = true;
      if (scanWindow) clearTimeout(scanWindow);
      if (nextScan) clearTimeout(nextScan);
      for (const timer of removalTimers.values()) clearTimeout(timer);
      try { zeroconf.stop(); } catch (error) { reportNonFatal('zeroconf.stop', error); }
      zeroconf.removeAllListeners();
      zeroconf.removeDeviceListeners();
    };
  }, [connection, isServerOffline, scanGeneration]);

  return { discoveredHosts, discoveryError, isDiscoveringHosts, refreshDiscovery };
}
