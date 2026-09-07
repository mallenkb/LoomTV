import { cp, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../desktop/resources/', import.meta.url));
const destination = fileURLToPath(new URL('../src-tauri/resources/', import.meta.url));
const target = process.env.LOOMTV_TAURI_TARGET || `${process.platform}-${process.arch}`;
const sources = {
  'darwin-arm64': [['libvlc/darwin/arm64/VLC.app/Contents/MacOS/lib', 'libvlc/lib'], ['libvlc/darwin/arm64/VLC.app/Contents/MacOS/plugins', 'libvlc/plugins'], ['libvlc/darwin/arm64/VLC.app/Contents/MacOS/share', 'libvlc/share'], ['ffmpeg/mac', 'ffmpeg'], ['mpv/darwin/arm64', 'mpv/darwin/arm64']],
  'win32-x64': [['libvlc/win32/x64', 'libvlc'], ['ffmpeg/win', 'ffmpeg']],
  'linux-x64': [['ffmpeg/linux', 'ffmpeg']],
};
if (!sources[target]) throw new Error(`Native runtime staging is not configured for ${target}.`);
const configuredLibMpv = process.env.LOOMTV_LIBMPV_PATH?.trim();
if (configuredLibMpv) {
  const relative = target.startsWith('darwin-')
    ? 'mpv/lib/libmpv.dylib'
    : target.startsWith('win32-')
      ? 'mpv/mpv.dll'
      : 'mpv/lib/libmpv.so';
  sources[target].push([configuredLibMpv, relative]);
}
await mkdir(destination, { recursive: true });
for (const [source, relative] of [...sources[target], ['libvlc/NOTICE.md', 'libvlc/NOTICE.md'], ['ffmpeg/NOTICE.md', 'ffmpeg/NOTICE.md'], ['ffmpeg/COPYING.GPLv3.txt', 'ffmpeg/COPYING.GPLv3.txt'], ['mpv/NOTICE.md', 'mpv/NOTICE.md']]) {
  const input = path.isAbsolute(source) ? source : path.join(root, source);
  await stat(input);
  await cp(input, path.join(destination, relative), { recursive: true, dereference: false, filter: source => !source.endsWith('/libmacosx_plugin.dylib') });
}
console.log(`Staged native resources for ${target}.`);
