import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../desktop/resources/', import.meta.url));
const destination = fileURLToPath(new URL('../src-tauri/resources/', import.meta.url));
const target = process.env.LOOMTV_TAURI_TARGET || `${process.platform}-${process.arch}`;
const incremental = process.argv.includes('--incremental');

async function shouldCopy(source, output) {
  if (source.endsWith('/libmacosx_plugin.dylib')) return false;
  if (!incremental) return true;
  const input = await lstat(source);
  if (input.isDirectory()) return true;
  let existing;
  try { existing = await lstat(output); }
  catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  if (input.isSymbolicLink() && existing.isSymbolicLink()) {
    return await readlink(source) !== await readlink(output);
  }
  return !input.isFile() || !existing.isFile()
    || input.size !== existing.size
    || Math.abs(input.mtimeMs - existing.mtimeMs) > 1;
}

async function bridgeSignature(directory, include) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ target, include, sdk: process.env.SDKROOT, developer: process.env.DEVELOPER_DIR }));
  for (const folder of [directory, path.join(include, 'mpv')]) {
    for (const name of (await readdir(folder)).sort()) {
      if (!/\.(?:m|c|h|mjs)$/.test(name)) continue;
      hash.update(path.join(folder, name));
      hash.update(await readFile(path.join(folder, name)));
    }
  }
  return hash.digest('hex');
}
const sources = {
  'darwin-arm64': [['libvlc/darwin/arm64/VLC.app/Contents/MacOS/lib', 'libvlc/lib'], ['libvlc/darwin/arm64/VLC.app/Contents/MacOS/plugins', 'libvlc/plugins'], ['libvlc/darwin/arm64/VLC.app/Contents/MacOS/share', 'libvlc/share'], ['ffmpeg/mac', 'ffmpeg']],
  'win32-x64': [['libvlc/win32/x64', 'libvlc'], ['ffmpeg/win', 'ffmpeg']],
  'linux-x64': [['ffmpeg/linux', 'ffmpeg']],
};
if (!sources[target]) throw new Error(`Native runtime staging is not configured for ${target}.`);
const configuredLibMpv = process.env.LOOMTV_LIBMPV_PATH?.trim();
const discoveredLibMpv = target === 'darwin-arm64'
  ? [configuredLibMpv, '/opt/homebrew/lib/libmpv.dylib', '/usr/local/lib/libmpv.dylib'].find(value => value && existsSync(value))
  : configuredLibMpv;
if (discoveredLibMpv) {
  const relative = target.startsWith('darwin-')
    ? 'mpv/lib/libmpv.dylib'
    : target.startsWith('win32-')
      ? 'mpv/mpv.dll'
      : 'mpv/lib/libmpv.so';
  sources[target].push([await realpath(discoveredLibMpv), relative]);
}
await rm(path.join(destination, 'mpv/darwin'), { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const [source, relative] of [...sources[target], ['libvlc/NOTICE.md', 'libvlc/NOTICE.md'], ['ffmpeg/NOTICE.md', 'ffmpeg/NOTICE.md'], ['ffmpeg/COPYING.GPLv3.txt', 'ffmpeg/COPYING.GPLv3.txt'], ['mpv/NOTICE.md', 'mpv/NOTICE.md']]) {
  const input = path.isAbsolute(source) ? source : path.join(root, source);
  await stat(input);
  await cp(input, path.join(destination, relative), {
    recursive: true, dereference: false, preserveTimestamps: true, filter: shouldCopy,
  });
}
if (target === 'darwin-arm64' && discoveredLibMpv) {
  const stagedLibMpv = path.join(destination, 'mpv/lib/libmpv.dylib');
  // Homebrew bottles can be read-only. Tauri preserves that mode when it
  // copies resources into target/, then a later build cannot replace the
  // existing file. Keep both the staged source and prior build outputs
  // owner-writable so repeated `tauri dev` runs remain incremental.
  await chmod(stagedLibMpv, (await stat(stagedLibMpv)).mode | 0o200);
  const cargoTarget = fileURLToPath(new URL('../../../target/', import.meta.url));
  for (const profile of ['debug', 'release']) {
    const previous = path.join(cargoTarget, profile, 'runtimes/mpv/lib/libmpv.dylib');
    try {
      await chmod(previous, (await stat(previous)).mode | 0o200);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const include = process.env.LIBMPV_INCLUDE_DIR?.trim()
    || ['/opt/homebrew/include', '/usr/local/include'].find(value => existsSync(path.join(value, 'mpv/client.h')));
  if (!include) throw new Error('libmpv headers are required to build the embedded playback bridge.');
  const bridgeOutput = path.join(destination, 'mpv/lib/libloomtv_mpv_bridge.dylib');
  const bridgeDirectory = fileURLToPath(new URL('../../desktop/native/libmpv/draft-render-bridge/', import.meta.url));
  // Keep cache metadata outside bundled resources. Release staging always rebuilds.
  const cacheDirectory = fileURLToPath(new URL('../node_modules/.cache/loomtv/', import.meta.url));
  const signaturePath = path.join(cacheDirectory, 'mpv-bridge.sha256');
  const signature = await bridgeSignature(bridgeDirectory, include);
  let previousSignature;
  try { previousSignature = await readFile(signaturePath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!incremental || !existsSync(bridgeOutput) || previousSignature !== signature) {
  const bridgeBuild = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../desktop/native/libmpv/draft-render-bridge/build.mjs', import.meta.url)),
    bridgeOutput,
  ], { env: { ...process.env, LIBMPV_INCLUDE_DIR: include }, stdio: 'inherit' });
  if (bridgeBuild.error) throw bridgeBuild.error;
  if (bridgeBuild.status !== 0) throw new Error(`The embedded libmpv bridge build failed with status ${bridgeBuild.status}.`);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(signaturePath, signature);
  } else {
    console.log('Using the unchanged embedded libmpv bridge.');
  }
}
console.log(`Staged native resources for ${target}.`);
