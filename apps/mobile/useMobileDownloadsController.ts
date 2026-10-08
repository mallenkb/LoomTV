import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Connection, MobileProfile, PlayTarget } from './mobileDomain';
import { filePathFromUrl } from './mobileLibrary';
import {
  clearMobileDownloads,
  listMobileDownloads,
  reconcileMobileDownloadDirectories,
  removeMobileDownload,
  saveMobileDownload,
  type MobileDownload,
  type MobileDownloadCapability,
} from './mobileDownloads';
import { reportNonFatal } from './mobileDiagnostics';
import { secureLanUrl } from './mobileSecureTransport';

type DownloadClient = {
  createOfflineDownload(baseUrl: string, token: string, mediaId: string): Promise<Response>;
  revokeOfflineDownload(baseUrl: string, token: string, downloadId: string): Promise<Response>;
};

export function createMobileDownloadOperation(revoke: (id: string) => Promise<unknown>) {
  const controller = new AbortController();
  let capabilityId: string | undefined;
  let revocation: Promise<unknown> | undefined;
  const release = async () => {
    const id = capabilityId;
    if (!id) return;
    revocation ??= Promise.resolve().then(() => revoke(id)).catch(() => undefined);
    await revocation;
  };
  return {
    signal: controller.signal,
    setCapability(id: string) {
      capabilityId = id;
      // Scope may have changed while capability creation was still in flight.
      if (controller.signal.aborted) void release();
    },
    cancel() { controller.abort(); return release(); },
    release,
  };
}

export function mediaIdForPlayTarget(target: PlayTarget): string {
  return target.mediaId || filePathFromUrl(target.streamPath);
}

export function useMobileDownloadsController({ activeProfile, client, connection, isServerOffline }: {
  activeProfile: MobileProfile | null;
  client: DownloadClient;
  connection: Connection | null;
  isServerOffline: boolean;
}) {
  const scope = JSON.stringify([connection?.hostDeviceId, activeProfile?.id]);
  const [stored, setStored] = useState<{ scope: string; items: Record<string, MobileDownload> }>({ scope, items: {} });
  const downloads = useMemo(() => stored.scope === scope ? stored.items : {}, [stored, scope]);
  const generation = useRef(0);
  const liveScope = useRef(scope);
  const removed = useRef(new Set<string>());
  const activeOperations = useRef(new Map<string, ReturnType<typeof createMobileDownloadOperation>>());
  const [downloadingMediaId, setDownloadingMediaId] = useState('');
  const cancelDownloads = useCallback(() => {
    for (const operation of activeOperations.current.values()) void operation.cancel();
    activeOperations.current.clear();
  }, []);

  useEffect(() => {
    void reconcileMobileDownloadDirectories().catch((error) => reportNonFatal('downloads.reconcile', error));
  }, []);

  useLayoutEffect(() => {
    liveScope.current = scope;
    generation.current += 1;
    removed.current.clear();
    setStored({ scope, items: {} });
    setDownloadingMediaId('');
    let cancelled = false;
    const hostDeviceId = connection?.hostDeviceId;
    const profileId = activeProfile?.id;
    if (hostDeviceId && profileId) void listMobileDownloads(hostDeviceId, profileId)
      .then((items) => {
        if (!cancelled) setStored((current) => current.scope === scope
          ? { scope, items: { ...Object.fromEntries(items.filter((download) => !removed.current.has(download.mediaId)).map((download) => [download.mediaId, download])), ...current.items } }
          : current);
      })
      .catch((error) => {
        if (!cancelled) reportNonFatal('downloads.list', error);
      });
    return () => { cancelled = true; generation.current += 1; cancelDownloads(); };
  }, [activeProfile?.id, cancelDownloads, connection?.hostDeviceId, scope]);

  const targetWithOfflineDownload = useCallback((target: PlayTarget): PlayTarget | null => {
    const download = downloads[mediaIdForPlayTarget(target)];
    return download && download.hostDeviceId === connection?.hostDeviceId && download.profileId === activeProfile?.id
      ? { ...target, offlineUri: download.uri, transcode: false } : null;
  }, [downloads, connection?.hostDeviceId, activeProfile?.id]);

  const downloadPlayTarget = useCallback(async (target: PlayTarget): Promise<void> => {
    if (!connection || !activeProfile || isServerOffline) throw new Error('Reconnect to the LoomTV server before downloading.');
    const mediaId = mediaIdForPlayTarget(target);
    const operation = JSON.stringify([scope, mediaId]);
    if (activeOperations.current.has(operation)) return;
    const transfer = createMobileDownloadOperation((id) => client.revokeOfflineDownload(connection.baseUrl, connection.deviceToken, id));
    activeOperations.current.set(operation, transfer);
    const startedGeneration = generation.current;
    setDownloadingMediaId(mediaId);
    try {
      const response = await client.createOfflineDownload(connection.baseUrl, connection.deviceToken, mediaId);
      const payload = await response.json() as MobileDownloadCapability & { message?: string };
      if (!response.ok || !payload?.id || !payload?.contentUrl || !payload?.credential?.secret) {
        throw new Error(payload?.message || 'The server could not prepare this download.');
      }
      const capability = payload;
      transfer.setCapability(capability.id);
      if (generation.current !== startedGeneration || liveScope.current !== scope || transfer.signal.aborted) return;
      const saved = await saveMobileDownload({
        hostDeviceId: connection.hostDeviceId,
        profileId: activeProfile.id,
        title: target.title,
        capability,
        isCurrent: () => generation.current === startedGeneration && liveScope.current === scope,
        signal: transfer.signal,
        contentUrl: secureLanUrl(new URL(capability.contentUrl, connection.baseUrl).toString()),
      });
      if (generation.current === startedGeneration && !transfer.signal.aborted) setStored((current) => current.scope === scope
        ? { scope, items: { ...current.items, [mediaId]: saved } } : current);
    } catch (error) {
      if (!transfer.signal.aborted && generation.current === startedGeneration && liveScope.current === scope) throw error;
      if (error instanceof Error && error.name !== 'AbortError') reportNonFatal('downloads.cancel', error);
    } finally {
      await transfer.release();
      if (activeOperations.current.get(operation) === transfer) activeOperations.current.delete(operation);
      if (generation.current === startedGeneration) setDownloadingMediaId((current) => current === mediaId ? '' : current);
    }
  }, [activeProfile, client, connection, isServerOffline, scope]);

  const removeDownloadedTarget = useCallback(async (target: PlayTarget): Promise<void> => {
    const mediaId = mediaIdForPlayTarget(target);
    const download = downloads[mediaId];
    if (!download) return;
    const startedGeneration = generation.current;
    await removeMobileDownload(download);
    if (generation.current !== startedGeneration) return;
    removed.current.add(mediaId);
    setStored((current) => {
      if (current.scope !== scope) return current;
      if (current.items[mediaId]?.uri !== download.uri) return current;
      const next = { ...current.items };
      delete next[mediaId];
      return { scope, items: next };
    });
  }, [downloads, scope]);

  const clearHostDownloads = useCallback((hostDeviceId: string): Promise<void> => {
    generation.current += 1;
    cancelDownloads();
    setStored({ scope, items: {} });
    setDownloadingMediaId('');
    return clearMobileDownloads(hostDeviceId);
  }, [cancelDownloads, scope]);

  return { clearHostDownloads, downloads, downloadingMediaId, downloadPlayTarget, removeDownloadedTarget, targetWithOfflineDownload };
}
