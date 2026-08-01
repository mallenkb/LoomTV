export interface RuntimePathOptions {
  dataDir?: string;
  cacheDir?: string;
  mediaDir?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export interface RuntimePaths {
  dataDir: string;
  cacheDir: string;
  mediaDir: string | null;
}

/** Resolve stable, absolute paths for a LoomTV runtime. */
export function resolveRuntimePaths(options?: RuntimePathOptions): RuntimePaths;
