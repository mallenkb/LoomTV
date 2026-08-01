import type { TranscodeCapabilities } from '@loom-media-server/transcode-capabilities';

type NetworkStatusSettings<TPairedDevice> = {
  localNetworkDeviceId?: string;
  localNetworkDeviceName?: string;
  localNetworkPairedDevices?: TPairedDevice[];
};

export type NetworkStatusDependencies<TPairedDevice> = {
  loadSettings: () => NetworkStatusSettings<TPairedDevice>;
  getLanShareToken: () => string;
  getLanServerBase: () => string | null;
  isLanSharingEnabled: () => boolean;
  getLocalNetworkNameFast: () => string;
  getMediaServerPort: () => number;
  getLocalNetworkAddresses: () => string[];
};

export function buildNetworkStatus<TPairedDevice>(deps: NetworkStatusDependencies<TPairedDevice>) {
  const settings = deps.loadSettings();
  const baseUrl = deps.getLanServerBase();
  return {
    sharingEnabled: deps.isLanSharingEnabled(),
    token: deps.getLanShareToken(),
    deviceId: settings.localNetworkDeviceId,
    deviceName: settings.localNetworkDeviceName,
    networkName: deps.getLocalNetworkNameFast(),
    port: baseUrl ? Number(new URL(baseUrl).port) : deps.getMediaServerPort(),
    addresses: deps.getLocalNetworkAddresses(),
    baseUrl,
    libraryUrl: baseUrl ? `${baseUrl}/api/v2/library` : null,
    pairedDevices: settings.localNetworkPairedDevices || [],
  };
}

export function ffmpegAvailability(
  findFFmpeg: () => string | null,
  getTranscodeCapabilities?: (path: string | null) => TranscodeCapabilities,
) {
  const ffmpegPath = findFFmpeg();
  return {
    available: ffmpegPath !== null,
    path: ffmpegPath,
    ...(getTranscodeCapabilities ? { capabilities: getTranscodeCapabilities(ffmpegPath) } : {}),
  };
}
