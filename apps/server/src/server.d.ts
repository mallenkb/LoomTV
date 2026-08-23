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
  /** Ask headless first-run clients for a generated claim secret. */
  requireBootstrapSecret?: boolean;
  developmentAllowInsecureNonLoopback?: boolean;
  trustedProxies?: string | string[];
  tls?: { cert: string; key: string };
  /** SHA-256 leaf-certificate fingerprint advertised when TLS terminates at a trusted proxy. */
  certificateFingerprint?: string;
  adminHtmlPath?: string;
  adminIconsPath?: string;
  webAppHtmlPath?: string;
  setupHtmlPath?: string;
  /** Per-run secret that authorizes first-owner creation from the desktop's own window. */
  desktopSetupToken?: string;
  /** Native folder picker, offered only to a trusted desktop setup request. */
  pickFolder?: () => Promise<string | null> | string | null;
  /** Optional bridge used by the desktop host to keep its existing renderer data in sync. */
  setupHooks?: {
    ownerCreated?: (input: { name: string; adminToken: string; expiresAt: number }) => Promise<void> | void;
    testMetadata?: (input: { provider: string; apiKey: string }) => Promise<{ ok: boolean; code?: string; message?: string }> | { ok: boolean; code?: string; message?: string };
    saveMetadata?: (input: { keys: Record<string, string>; skipped: boolean }) => Promise<void> | void;
    complete?: (input: {
      roots: Array<{ id: string; path: string; kind: 'movies' | 'tvShows' | 'anime' | 'others'; state?: string }>;
      ownerName: string;
      serverName: string;
      language: string;
    }) => Promise<void> | void;
  };
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
