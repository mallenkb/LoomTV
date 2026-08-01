import os from 'node:os';
import path from 'node:path';

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function envValue(env, shortName, longName) {
  return nonEmpty(env[shortName]) || nonEmpty(env[longName]);
}

function defaultDataRoot(env, platform, homeDir) {
  if (platform === 'win32') {
    return env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support');
  }
  // Electron's appData path follows XDG_CONFIG_HOME on Linux. Keeping this
  // default means the headless process can adopt an existing desktop profile
  // without moving its database or settings first.
  return env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
}

/**
 * Resolve stable, absolute paths for a LoomTV runtime.
 *
 * The short environment names are convenient for containers (DATA_DIR,
 * CACHE_DIR, and MEDIA_DIR). The LOOMTV_* aliases are kept for service files
 * and for coexistence with the desktop application's environment settings.
 */
export function resolveRuntimePaths(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const appDataName = 'LoomTV';

  const dataRoot = defaultDataRoot(env, platform, homeDir);
  const dataDir = options.dataDir
    || envValue(env, 'DATA_DIR', 'LOOMTV_DATA_DIR')
    || path.join(dataRoot, appDataName);
  const cacheDir = options.cacheDir
    || envValue(env, 'CACHE_DIR', 'LOOMTV_CACHE_DIR')
    || path.join(dataDir, 'cache');
  const configuredMediaDir = options.mediaDir === undefined
    ? envValue(env, 'MEDIA_DIR', 'LOOMTV_MEDIA_DIR')
    : options.mediaDir;

  return {
    dataDir: path.resolve(dataDir),
    cacheDir: path.resolve(cacheDir),
    mediaDir: configuredMediaDir ? path.resolve(configuredMediaDir) : null,
  };
}
