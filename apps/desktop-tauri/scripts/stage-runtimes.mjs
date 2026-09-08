import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../desktop/resources/', import.meta.url));
const destination = fileURLToPath(new URL('../src-tauri/resources/', import.meta.url));
const target = process.env.LOOMTV_TAURI_TARGET || `${process.platform}-${process.arch}`;
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
  await cp(input, path.join(destination, relative), { recursive: true, dereference: false, filter: source => !source.endsWith('/libmacosx_plugin.dylib') });
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
  const bridgeBuild = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../desktop/native/libmpv/draft-render-bridge/build.mjs', import.meta.url)),
    bridgeOutput,
  ], { env: { ...process.env, LIBMPV_INCLUDE_DIR: include }, stdio: 'inherit' });
  if (bridgeBuild.error) throw bridgeBuild.error;
  if (bridgeBuild.status !== 0) throw new Error(`The embedded libmpv bridge build failed with status ${bridgeBuild.status}.`);
}
console.log(`Staged native resources for ${target}.`);
