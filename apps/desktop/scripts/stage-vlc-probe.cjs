'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const desktopRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(desktopRoot, '../..');
const target = process.platform;
const name = target === 'darwin' ? 'libloomtv_vlc_probe.dylib'
  : target === 'win32' ? 'loomtv_vlc_probe.dll' : 'libloomtv_vlc_probe.so';
if (!['darwin', 'win32', 'linux'].includes(target)) {
  throw new Error(`The LibVLC decoder probe does not support ${target}.`);
}

const result = spawnSync(process.env.CARGO || 'cargo', [
  'build', '--locked', '--release', '-p', 'loomtv-vlc-probe',
], { cwd: workspaceRoot, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`The LibVLC decoder probe build failed with status ${result.status}.`);

const source = path.join(workspaceRoot, 'target', 'release', name);
const destination = path.join(desktopRoot, 'resources', 'libvlc-probe', name);
fs.mkdirSync(path.dirname(destination), { recursive: true });
const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
try {
  // A loaded macOS image can retain the old vnode and its code-signature
  // cache. Replace the destination by rename instead of writing into it.
  fs.copyFileSync(source, temporary);
  if (target === 'darwin') {
    const signed = spawnSync('codesign', ['--force', '--sign', '-', temporary], { stdio: 'inherit' });
    if (signed.error) throw signed.error;
    if (signed.status !== 0) throw new Error(`The LibVLC decoder probe signing failed with status ${signed.status}.`);
  }
  fs.renameSync(temporary, destination);
} finally {
  try { fs.unlinkSync(temporary); } catch { /* Renamed or already removed. */ }
}
console.log(`[libvlc] Staged decoder probe at ${destination}.`);
