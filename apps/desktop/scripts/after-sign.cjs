const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function findAppBundle(appOutDir, productFilename) {
  const expected = path.join(appOutDir, `${productFilename}.app`);
  if (fs.existsSync(expected)) return expected;

  const fallback = fs.readdirSync(appOutDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (!fallback) throw new Error(`No macOS app bundle found under ${appOutDir}.`);
  return path.join(appOutDir, fallback.name);
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const developerIdConfigured = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
  const signingDisabled = process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false';
  if (developerIdConfigured || !signingDisabled) return;

  const appPath = findAppBundle(context.appOutDir, context.packager.appInfo.productFilename);
  console.log(`[mac-signing] Applying consistent ad-hoc signature to ${appPath}`);

  // Electron Builder's ad-hoc hardened-runtime signatures can give the main
  // executable and Electron Framework incompatible library-validation
  // identities. Re-sign the complete fallback bundle without hardened runtime
  // so local/test releases can launch when no Developer ID is configured.
  await execFileAsync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
  await execFileAsync('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=2', appPath,
  ]);
};
