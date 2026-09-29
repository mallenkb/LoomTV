import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveRuntimePaths } from '../src/index.mjs';

test('Linux defaults match Electron app-data conventions and keep media optional', () => {
  const homeDir = path.resolve('fixture-home');

  assert.deepEqual(resolveRuntimePaths({ env: {}, platform: 'linux', homeDir }), {
    dataDir: path.join(homeDir, '.config', 'LoomTV'),
    cacheDir: path.join(homeDir, '.config', 'LoomTV', 'cache'),
    mediaDir: null,
  });
});

test('platform-specific app-data roots remain stable', () => {
  const homeDir = path.resolve('fixture-home');

  assert.equal(
    resolveRuntimePaths({ env: {}, platform: 'darwin', homeDir }).dataDir,
    path.join(homeDir, 'Library', 'Application Support', 'LoomTV'),
  );
  assert.equal(
    resolveRuntimePaths({ env: {}, platform: 'win32', homeDir }).dataDir,
    path.join(homeDir, 'AppData', 'Roaming', 'LoomTV'),
  );
});

test('explicit options override short and long environment aliases', () => {
  const paths = resolveRuntimePaths({
    env: {
      DATA_DIR: '/env/data',
      LOOMTV_DATA_DIR: '/env/long-data',
      CACHE_DIR: '/env/cache',
      MEDIA_DIR: '/env/media',
    },
    platform: 'linux',
    homeDir: '/home/fixture',
    dataDir: '/option/data',
    cacheDir: '/option/cache',
    mediaDir: '/option/media',
  });

  assert.deepEqual(paths, {
    dataDir: path.resolve('/option/data'),
    cacheDir: path.resolve('/option/cache'),
    mediaDir: path.resolve('/option/media'),
  });
});

test('short aliases win, values are trimmed, and cache follows the chosen data directory', () => {
  const paths = resolveRuntimePaths({
    env: {
      DATA_DIR: '  /short/data  ',
      LOOMTV_DATA_DIR: '/long/data',
      LOOMTV_MEDIA_DIR: '  /long/media  ',
    },
    platform: 'linux',
    homeDir: '/home/fixture',
  });

  assert.deepEqual(paths, {
    dataDir: path.resolve('/short/data'),
    cacheDir: path.resolve('/short/data/cache'),
    mediaDir: path.resolve('/long/media'),
  });
});

test('blank environment values are ignored and explicit null disables media', () => {
  const homeDir = path.resolve('fixture-home');
  const paths = resolveRuntimePaths({
    env: {
      XDG_CONFIG_HOME: path.resolve('fixture-config'),
      DATA_DIR: '  ',
      LOOMTV_DATA_DIR: '\t',
      MEDIA_DIR: '/env/media',
    },
    platform: 'linux',
    homeDir,
    mediaDir: null,
  });

  assert.deepEqual(paths, {
    dataDir: path.resolve('fixture-config', 'LoomTV'),
    cacheDir: path.resolve('fixture-config', 'LoomTV', 'cache'),
    mediaDir: null,
  });
});
