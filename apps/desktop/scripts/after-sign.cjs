const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { generateLibVlcPluginCache } = require('./generate-libvlc-plugin-cache.cjs');

const execFileAsync = promisify(execFile);

async function macSigningIdentity(appPath) {
  try {
    const result = await execFileAsync('/usr/bin/codesign', ['--display', '--verbose=4', appPath]);
    const output = `${result.stdout}\n${result.stderr}`;
    return output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function findAppBundle(appOutDir, productFilename) {
  const expected = path.join(appOutDir, `${productFilename}.app`);
  if (fs.existsSync(expected)) return expected;

  const fallback = fs.readdirSync(appOutDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (!fallback) throw new Error(`No macOS app bundle found under ${appOutDir}.`);
  return path.join(appOutDir, fallback.name);
}

function findBundlesNamed(root, bundleName) {
  if (!fs.existsSync(root)) return [];
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.name === bundleName) {
        matches.push(entryPath);
        continue;
      }
      visit(entryPath);
    }
  };
  visit(root);
  return matches;
}

async function signatureDetails(codePath) {
  try {
    const result = await execFileAsync('/usr/bin/codesign', ['--display', '--verbose=4', codePath]);
    return `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    return `${error.stdout || ''}\n${error.stderr || ''}`;
  }
}

async function resignAdHocMpvBundles(appPath) {
  const resourcesPath = path.join(appPath, 'Contents', 'Resources', 'mpv');
  const mpvBundles = findBundlesNamed(resourcesPath, 'mpv.app');

  for (const mpvBundle of mpvBundles) {
    // Electron Builder signs every nested Mach-O with hardened runtime. In an
    // ad-hoc build those independent signatures have no shared Team ID, so
    // mpv's library validation rejects its own dylibs at launch. Explicitly
    // signing the nested app without --options runtime disables that validation
    // for the mpv process while retaining a sealed ad-hoc bundle.
    await execFileAsync('/usr/bin/codesign', [
      '--force', '--deep', '--sign', '-', mpvBundle,
    ]);

    const executablePath = path.join(mpvBundle, 'Contents', 'MacOS', 'mpv');
    const details = await signatureDetails(executablePath);
    if (/flags=.*\bruntime\b/.test(details)) {
      throw new Error(`Ad-hoc MPV executable still has hardened runtime enabled: ${executablePath}`);
    }
  }
}

// Signing rewrote every VLC plugin, so VLC's shipped plugins.dat no longer
// matches and VLC would dlopen all of them at startup. Rebuild it against the
// signed files. Only the host architecture can be loaded to do this.
function regenerateLibVlcPluginCaches(appPath) {
  const root = path.join(appPath, 'Contents', 'Resources', 'libvlc', 'darwin');
  if (!fs.existsSync(root)) return false;
  let regenerated = false;
  for (const arch of fs.readdirSync(root)) {
    const runtimeRoot = path.join(root, arch);
    if (!fs.existsSync(path.join(runtimeRoot, 'lib', 'libvlc.dylib'))) continue;
    if (arch !== process.arch) {
      console.warn(`[libvlc] Skipping the ${arch} plugin cache on a ${process.arch} host; VLC will load its plugins without it.`);
      continue;
    }
    generateLibVlcPluginCache(runtimeRoot);
    regenerated = true;
  }
  return regenerated;
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = findAppBundle(context.appOutDir, context.packager.appInfo.productFilename);
  const teamIdentifier = await macSigningIdentity(appPath);
  // Developer ID builds are already notarized here, so the bundle can't
  // change. VLC falls back to loading its plugins without the cache there.
  if (teamIdentifier && !/^(?:not set|none|-|unknown)$/i.test(teamIdentifier)) return;

  console.log(`[mac-signing] Applying consistent ad-hoc signature to ${appPath}`);

  await resignAdHocMpvBundles(appPath);

  // Seal the complete fallback bundle without hardened runtime so local/test
  // releases can launch when no Developer ID is configured.
  await execFileAsync('/usr/bin/codesign', [
    '--force', '--deep', '--sign', '-', appPath,
  ]);
  await execFileAsync('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=2', appPath,
  ]);

  // The plugins are now final. Write the cache, then reseal only the outer
  // bundle so the plugin signatures and mtimes the cache records stay intact.
  if (regenerateLibVlcPluginCaches(appPath)) {
    await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', appPath]);
    await execFileAsync('/usr/bin/codesign', [
      '--verify', '--deep', '--strict', '--verbose=2', appPath,
    ]);
  }
};
