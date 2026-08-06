const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

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

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = findAppBundle(context.appOutDir, context.packager.appInfo.productFilename);
  const teamIdentifier = await macSigningIdentity(appPath);
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
};
