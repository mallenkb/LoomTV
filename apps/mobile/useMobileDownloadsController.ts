import { useCallback, useEffect, useState } from 'react';

import type { Connection, MobileProfile, PlayTarget } from './mobileDomain';
import { filePathFromUrl } from './mobileLibrary';
import {
  listMobileDownloads,
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

export function mediaIdForPlayTarget(target: PlayTarget): string {
  return target.mediaId || filePathFromUrl(target.streamPath);
}

export function useMobileDownloadsController({ activeProfile, client, connection, isServerOffline }: {
  activeProfile: MobileProfile | null;
  client: DownloadClient;
  connection: Connection | null;
  isServerOffline: boolean;
}) {
  const [downloads, setDownloads] = useState<Record<string, MobileDownload>>({});
  const [downloadingMediaId, setDownloadingMediaId] = useState('');

  useEffect(() => {
    let cancelled = false;
    const hostDeviceId = connection?.hostDeviceId;
    const profileId = activeProfile?.id;
    if (!hostDeviceId || !profileId) {
      setDownloads({});
      return undefined;
    }
    void listMobileDownloads(hostDeviceId, profileId)
      .then((items) => {
        if (!cancelled) setDownloads(Object.fromEntries(items.map((download) => [download.mediaId, download])));
      })
      .catch((error) => {
        if (!cancelled) reportNonFatal('downloads.list', error);
      });
    return () => { cancelled = true; };
  }, [activeProfile?.id, connection?.hostDeviceId]);

  const targetWithOfflineDownload = useCallback((target: PlayTarget): PlayTarget | null => {
    const download = downloads[mediaIdForPlayTarget(target)];
    return download ? { ...target, streamPath: download.uri, offlineUri: download.uri, transcode: false } : null;
  }, [downloads]);

  const downloadPlayTarget = useCallback(async (target: PlayTarget): Promise<void> => {
    if (!connection || !activeProfile || isServerOffline) throw new Error('Reconnect to the LoomTV server before downloading.');
    const mediaId = mediaIdForPlayTarget(target);
    setDownloadingMediaId(mediaId);
    let capability: MobileDownloadCapability | null = null;
    try {
      const response = await client.createOfflineDownload(connection.baseUrl, connection.deviceToken, mediaId);
      const payload = await response.json() as MobileDownloadCapability & { message?: string };
      if (!response.ok || !payload?.id || !payload?.contentUrl || !payload?.credential?.secret) {
        throw new Error(payload?.message || 'The server could not prepare this download.');
      }
      capability = payload;
      const saved = await saveMobileDownload({
        hostDeviceId: connection.hostDeviceId,
        profileId: activeProfile.id,
        title: target.title,
        capability,
        contentUrl: secureLanUrl(new URL(capability.contentUrl, connection.baseUrl).toString()),
      });
      setDownloads((current) => ({ ...current, [mediaId]: saved }));
    } finally {
      if (capability?.id) {
        await client.revokeOfflineDownload(connection.baseUrl, connection.deviceToken, capability.id).catch(() => undefined);
      }
      setDownloadingMediaId('');
    }
  }, [activeProfile, client, connection, isServerOffline]);

  const removeDownloadedTarget = useCallback(async (target: PlayTarget): Promise<void> => {
    const mediaId = mediaIdForPlayTarget(target);
    const download = downloads[mediaId];
    if (!download) return;
    await removeMobileDownload(download);
    setDownloads((current) => {
      const next = { ...current };
      delete next[mediaId];
      return next;
    });
  }, [downloads]);

  return { downloads, downloadingMediaId, downloadPlayTarget, removeDownloadedTarget, targetWithOfflineDownload };
}
