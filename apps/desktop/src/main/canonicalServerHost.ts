import {
  createCanonicalVideoServer,
  type CanonicalVideoServer,
  type CanonicalCompatibilityHandler,
} from 'loom-media-server-headless/runtime';

type RuntimePaths = {
  dataDir: string;
  cacheDir: string;
  mediaDir: string | null;
};

export type { CanonicalCompatibilityHandler } from 'loom-media-server-headless/runtime';

export type CanonicalServerHostOptions = {
  /** Set only after the canonical migration report is committed successfully. */
  migrationReady: boolean;
  host?: string;
  port?: number;
  paths: RuntimePaths;
  version: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  requireSecureTransport?: boolean;
  trustedProxies?: string | string[];
  tls?: { cert: string; key: string };
  certificateFingerprint?: string;
  bootstrapSecret?: string;
  bootstrapSecretFile?: string;
  adminHtmlPath?: string;
  adminIconsPath?: string;
  webAppHtmlPath?: string;
  /** Must delegate to the supplied canonical services and must not open desktop persistence. */
  compatibilityHandler: CanonicalCompatibilityHandler;
  /** Validates the compatibility-window PIN only; canonical services issue and persist the credential. */
  authorizeLegacyPairing?: (request: {
    code: string;
    deviceName: string;
    address: string;
    requestId: string;
  }) => boolean | { accountId?: string; permissions?: string[] } | Promise<boolean | { accountId?: string; permissions?: string[] }>;
};

/**
 * Desktop cutover host for the canonical server. It deliberately cannot call
 * the legacy startMediaServer function or open the desktop database.
 */
export function createCanonicalServerHost(options: CanonicalServerHostOptions) {
  let runtime: CanonicalVideoServer | null = null;
  let startPromise: Promise<{ host: string; port: number }> | null = null;
  let stopPromise: Promise<void> | null = null;

  return {
    async start(): Promise<{ host: string; port: number }> {
      if (!options.migrationReady) {
        throw Object.assign(new Error('Canonical desktop hosting requires a completed migration.'), {
          code: 'canonical_migration_required',
        });
      }
      if (stopPromise) throw Object.assign(new Error('Canonical desktop hosting is stopping.'), { code: 'server_draining' });
      if (startPromise) return startPromise;

      startPromise = (async () => {
        const nextRuntime = createCanonicalVideoServer({
          host: options.host || '127.0.0.1',
          port: options.port ?? 3847,
          paths: options.paths,
          version: options.version,
          ffmpegPath: options.ffmpegPath,
          ffprobePath: options.ffprobePath,
          requireSecureTransport: options.requireSecureTransport,
          trustedProxies: options.trustedProxies,
          tls: options.tls,
          certificateFingerprint: options.certificateFingerprint,
          bootstrapSecret: options.bootstrapSecret,
          bootstrapSecretFile: options.bootstrapSecretFile,
          adminHtmlPath: options.adminHtmlPath,
          adminIconsPath: options.adminIconsPath,
          webAppHtmlPath: options.webAppHtmlPath,
          deploymentMode: 'desktop-hosted',
          compatibilityHandler: options.compatibilityHandler,
          authorizeLegacyPairing: options.authorizeLegacyPairing,
        });
        runtime = nextRuntime;
        try {
          return await nextRuntime.start();
        } catch (error) {
          await nextRuntime.stop().catch(() => undefined);
          if (runtime === nextRuntime) runtime = null;
          throw error;
        }
      })();
      return startPromise;
    },

    address(): { host: string; port: number } | null {
      return runtime?.address() || null;
    },

    async stop(): Promise<void> {
      if (!stopPromise) {
        stopPromise = (async () => {
          if (startPromise) await startPromise.catch(() => undefined);
          await runtime?.stop();
          runtime = null;
        })();
      }
      return stopPromise;
    },
  };
}
