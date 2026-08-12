const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(desktopRoot, '../..');
const electronExecutable = require('electron');
const electronRebuildExecutable = path.join(desktopRoot, 'node_modules', '.bin', 'electron-rebuild');
const probeScript = "const Database = require('better-sqlite3'); new Database(':memory:').close();";

function electronNativeModuleLoads() {
  try {
    execFileSync(electronExecutable, ['-e', probeScript], {
      cwd: workspaceRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

if (electronNativeModuleLoads()) process.exit(0);

console.log('[desktop] Rebuilding better-sqlite3 for Electron...');

let rebuildRoot = desktopRoot;
let temporaryLink = null;
if (/\s/.test(workspaceRoot)) {
  temporaryLink = path.join(os.tmpdir(), `loomtv-electron-native-${process.pid}`);
  fs.symlinkSync(workspaceRoot, temporaryLink, 'dir');
  rebuildRoot = path.join(temporaryLink, 'apps', 'desktop');
}

try {
  execFileSync(electronRebuildExecutable, ['-f', '-w', 'better-sqlite3'], {
    cwd: rebuildRoot,
    env: { ...process.env, PWD: rebuildRoot },
    stdio: 'inherit',
  });
} catch {
  // electron-rebuild can report a cleanup failure after node-gyp has already
  // produced a valid binary. The compatibility probe below is authoritative.
} finally {
  if (temporaryLink) fs.unlinkSync(temporaryLink);
}

if (!electronNativeModuleLoads()) {
  console.error('[desktop] better-sqlite3 is not compatible with this Electron runtime.');
  process.exit(1);
}

