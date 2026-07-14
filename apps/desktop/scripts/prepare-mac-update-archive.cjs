const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const LEGACY_APP_BUNDLE_NAME = 'LoomTV.app';

/**
 * Keep the macOS update ZIP consumable by LoomTV 1.0.36's fallback installer.
 * That shipped helper requires a top-level LoomTV.app even though the product
 * has since been renamed to Loom Media Server. DMGs and the signed bundle keep
 * the current product name; only the updater ZIP's outer directory is renamed.
 */
exports.default = async function prepareMacUpdateArchive(event) {
  if (process.platform !== 'darwin' || !event.file.endsWith('.zip')) return;

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loomtv-update-archive-'));
  const extractDir = path.join(tempDir, 'extracted');
  const replacementZip = path.join(tempDir, path.basename(event.file));

  try {
    await fs.promises.mkdir(extractDir, { recursive: true });
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', event.file, extractDir]);

    const entries = await fs.promises.readdir(extractDir, { withFileTypes: true });
    const appBundles = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
    if (appBundles.length !== 1) {
      throw new Error(`Expected one app bundle in ${event.file}; found ${appBundles.length}.`);
    }

    const currentBundlePath = path.join(extractDir, appBundles[0].name);
    const legacyBundlePath = path.join(extractDir, LEGACY_APP_BUNDLE_NAME);
    if (currentBundlePath !== legacyBundlePath) {
      await fs.promises.rename(currentBundlePath, legacyBundlePath);
    }

    await execFileAsync('/usr/bin/ditto', [
      '-c',
      '-k',
      '--sequesterRsrc',
      '--keepParent',
      legacyBundlePath,
      replacementZip,
    ]);
    await fs.promises.rename(replacementZip, event.file);

    // electron-builder calculated the original ZIP's blockmap before this hook.
    // Clearing it makes the generated update metadata hash the rewritten ZIP
    // and fall back to a full, checksum-verified download.
    event.updateInfo = null;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
};
