// `pnpm start` runs electron-rebuild, which compiles better-sqlite3 against
// Electron's ABI. The test suite runs under plain node, which then cannot load
// it (NODE_MODULE_VERSION mismatch) and every database test fails with an error
// that looks nothing like a test failure. Rebuild for node, but only when the
// binary is actually built for the wrong runtime — the happy path is free.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let rebuildFailed = false;
try {
  // better-sqlite3 resolves its native binding lazily, so requiring the module
  // is not enough to surface an ABI mismatch — a connection has to be opened.
  new (require('better-sqlite3'))(':memory:').close();
  process.exit(0);
} catch (error) {
  if (!/NODE_MODULE_VERSION/.test(String(error && error.message))) {
    // Something other than an ABI mismatch — let the test run surface it.
    process.exit(0);
  }
}

console.log('[test] better-sqlite3 is built for Electron; rebuilding it for node…');
const workspaceRoot = path.resolve(__dirname, '../../..');
let rebuildRoot = workspaceRoot;
let temporaryLink = null;
if (/\s/.test(workspaceRoot)) {
  temporaryLink = path.join(os.tmpdir(), `loomtv-native-${process.pid}`);
  fs.symlinkSync(workspaceRoot, temporaryLink, 'dir');
  rebuildRoot = temporaryLink;
}
try {
  execFileSync('pnpm', ['rebuild', '-r', 'better-sqlite3'], {
    cwd: rebuildRoot,
    env: { ...process.env, PWD: rebuildRoot },
    stdio: 'inherit',
  });
} catch {
  console.error(
    '[test] Could not rebuild better-sqlite3 for node.\n'
    + '       Run `corepack pnpm rebuild -r better-sqlite3` and try again.',
  );
  rebuildFailed = true;
} finally {
  if (temporaryLink) fs.unlinkSync(temporaryLink);
}
if (rebuildFailed) process.exit(1);
