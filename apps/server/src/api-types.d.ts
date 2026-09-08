import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CanonicalRuntimeOptions } from './server.js';

export type AdminService = ReturnType<typeof import('./admin-service.js').createHeadlessAdminService>;
export type ClientState = ReturnType<typeof import('./client-state.js').createHeadlessClientState>;
export type MediaService = ReturnType<typeof import('./media-service.js').createHeadlessMediaService>;
export type PairingService = ReturnType<typeof import('./pairing-service.js').createPairingService>;
export type RemotePolicy = ReturnType<typeof import('./remote-policy.js').createRemotePolicyService>;
export type Principal = import('./server-media-types.js').Principal;
export type MediaItem = NonNullable<Awaited<ReturnType<AdminService['getLibraryItem']>>>;
export type ProfileContext = Awaited<ReturnType<ClientState['requireActivePlaybackProfile']>>;
export type ScanStatus = Awaited<ReturnType<AdminService['getScanStatus']>>;
export type ApiRequest = IncomingMessage & {
  __loomRemoteContext?: ReturnType<RemotePolicy['preflight']>;
  __loomCookieSessionToken?: string;
};
export type ApiResponse = ServerResponse & { __loomtvPublicApi?: boolean };

export interface RuntimeHealth {
  status?: string;
  mediaCoreContractVersion?: number;
  media?: { configured?: boolean; state?: string; readable?: boolean };
  transcoder?: { available?: boolean; hardwareAcceleration?: boolean; recommendedBackend?: string; state?: string };
  capabilities?: { transcoding?: boolean; hardwareAcceleration?: boolean };
  server?: { certificateFingerprint?: string };
}

export interface PublicApiOptions {
  service: AdminService & { appendOperationalLog?: (level: string, message: string) => void | Promise<void> };
  clientState: ClientState;
  mediaService: MediaService;
  pairingService: PairingService;
  remotePolicy: RemotePolicy;
  setupService?: ReturnType<typeof import('./setup-service.js').createSetupService>;
  setupHooks?: CanonicalRuntimeOptions['setupHooks'];
  getRuntimeHealth: () => Promise<RuntimeHealth>;
  version: string;
  requireSecureTransport?: boolean;
  requireBootstrapSecret?: boolean;
  proxyPolicy?: ReturnType<typeof import('./trusted-proxy.js').createTrustedProxyPolicy>;
  castSessions?: ReturnType<typeof import('./cast-session-registry.js').createCastSessionRegistry>;
  desktopSetupChannel?: ReturnType<typeof import('./desktop-setup-channel.js').createDesktopSetupChannel>;
  pickFolder?: CanonicalRuntimeOptions['pickFolder'];
  deploymentMode?: 'standalone' | 'desktop-hosted';
}
