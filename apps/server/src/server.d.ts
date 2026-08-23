import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimePaths } from '@loom-media-server/runtime-paths';

export type CanonicalDeploymentMode = 'standalone' | 'desktop-hosted';

export interface CanonicalCompatibilityContext {
  adminService: unknown;
  clientState: unknown;
  mediaService: unknown;
  pairingService: unknown;
  persistence: unknown;
  deploymentMode: CanonicalDeploymentMode;
}

export type CanonicalCompatibilityHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  context: CanonicalCompatibilityContext,
) => boolean | Promise<boolean>;

export interface CanonicalRuntimeOptions {
  host: string;
  port: number;
  paths: RuntimePaths;
  version: string;
  deploymentMode?: CanonicalDeploymentMode;
  ffmpegPath?: string;
  ffprobePath?: string;
  requireSecureTransport?: boolean;
  developmentAllowInsecureNonLoopback?: boolean;
  trustedProxies?: string | string[];
  tls?: { cert: string; key: string };
  /** SHA-256 leaf-certificate fingerprint advertised when TLS terminates at a trusted proxy. */
  certificateFingerprint?: string;
  compatibilityHandler?: CanonicalCompatibilityHandler;
  authorizeLegacyPairing?: (request: {
    code: string;
    deviceName: string;
    address: string;
    requestId: string;
  }) => boolean | { accountId?: string; permissions?: string[] } | Promise<boolean | { accountId?: string; permissions?: string[] }>;
  [option: string]: unknown;
}

export interface CanonicalVideoServer {
  address(): { host: string; port: number };
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export function createCanonicalVideoServer(options: CanonicalRuntimeOptions): CanonicalVideoServer;
export const createHeadlessServer: typeof createCanonicalVideoServer;
export function readServerVersion(packageRoot: string): Promise<string>;
