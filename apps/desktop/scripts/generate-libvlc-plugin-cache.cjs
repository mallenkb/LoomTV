#!/usr/bin/env node
// Rebuild VLC's plugins.dat against the final, signed plugin files.
//
// VLC validates each cache entry by the plugin's size and mtime. Code signing
// rewrites every plugin, so the plugins.dat shipped with VLC goes stale and
// VLC falls back to dlopening all ~335 plugins at startup (+32 MB, 630 ms).
// This asks libvlc itself to rewrite the cache (the same thing vlc-cache-gen
// does), then checks in a fresh process that the cache is actually used.
//
// Usage: node scripts/generate-libvlc-plugin-cache.cjs <runtime-root>
// where <runtime-root> contains lib/libvlc.dylib and plugins/.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// A cached instance maps libvlc, libvlccore and a couple of system images.
// An uncached one maps hundreds. Anything below this means the cache works.
const MAX_IMAGES_WITH_VALID_CACHE = 32;

function runChild(mode, runtimeRoot) {
  const pluginsPath = path.join(runtimeRoot, 'plugins');
  const output = execFileSync(process.execPath, [__filename, '--child', mode, runtimeRoot], {
    env: { ...process.env, VLC_PLUGIN_PATH: pluginsPath },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output.trim().split('\n').pop());
}

function child(mode, runtimeRoot) {
  const koffi = require('koffi');
  koffi.load(path.join(runtimeRoot, 'lib', 'libvlccore.dylib'));
  const libvlc = koffi.load(path.join(runtimeRoot, 'lib', 'libvlc.dylib'));
  const newInstance = libvlc.func('void *libvlc_new(int, const char **)');
  const release = libvlc.func('void libvlc_release(void *)');
  const imageCount = koffi.load('/usr/lib/libSystem.B.dylib').func('uint32 _dyld_image_count()');

  const args = mode === 'write' ? ['--quiet', '--reset-plugins-cache'] : ['--quiet'];
  const before = imageCount();
  const instance = newInstance(args.length, args);
  if (!instance) throw new Error('libvlc_new failed.');
  const imagesLoaded = imageCount() - before;
  release(instance);
  process.stdout.write(`${JSON.stringify({ imagesLoaded })}\n`);
}

function generate(runtimeRoot) {
  if (process.platform !== 'darwin') throw new Error('LibVLC plugin cache generation is implemented for macOS only.');
  const cachePath = path.join(runtimeRoot, 'plugins', 'plugins.dat');
  if (!fs.existsSync(path.join(runtimeRoot, 'lib', 'libvlc.dylib'))) {
    throw new Error(`No libvlc.dylib under ${runtimeRoot}/lib.`);
  }

  runChild('write', runtimeRoot);
  if (!fs.existsSync(cachePath)) throw new Error(`libvlc did not write ${cachePath}.`);

  const { imagesLoaded } = runChild('check', runtimeRoot);
  if (imagesLoaded > MAX_IMAGES_WITH_VALID_CACHE) {
    throw new Error(`The regenerated LibVLC plugin cache is not being used: libvlc_new mapped ${imagesLoaded} images.`);
  }
  console.log(`[libvlc] Regenerated ${cachePath}; libvlc_new now maps ${imagesLoaded} images.`);
}

if (process.argv[2] === '--child') {
  child(process.argv[3], process.argv[4]);
} else if (require.main === module) {
  const runtimeRoot = process.argv[2];
  if (!runtimeRoot) {
    console.error('Usage: node scripts/generate-libvlc-plugin-cache.cjs <runtime-root>');
    process.exit(2);
  }
  generate(path.resolve(runtimeRoot));
}

module.exports = { generateLibVlcPluginCache: generate };
