import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const app = path.resolve(process.argv[2] || path.join(root, 'target/release/bundle/macos/LoomTV Tauri.app'));
const forbidden = /^(?:Electron(?: Framework)?\.framework|electron(?:\.exe)?|node(?:\.exe)?|bun(?:\.exe)?|app\.asar|node_modules)$/i;
let files = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (forbidden.test(entry.name)) throw new Error(`Unexpected runtime dependency: ${entry.name}`);
    if (entry.isDirectory()) await walk(path.join(directory, entry.name));
    else if (entry.isFile()) files++;
  }
}
await walk(app);
if (process.platform === 'darwin') {
  const plist = await readFile(path.join(app, 'Contents/Info.plist'), 'utf8');
  if (!plist.includes('com.mallenkb.loomtv.tauri')) throw new Error('The bundle has the wrong application identity.');
  await stat(path.join(app, 'Contents/MacOS/loomtv-desktop-tauri'));
  await stat(path.join(app, 'Contents/Resources/runtimes/libvlc/lib/libvlc.dylib'));
  await stat(path.join(app, 'Contents/Resources/runtimes/ffmpeg/ffprobe'));
}
console.log(`Inspected ${files} packaged files. The expected app identity and native resources are present; no Electron, Node, or Bun runtime was found.`);
console.log('This is a static bundle inspection. Playback, installation, signing, and updates are unverified.');
