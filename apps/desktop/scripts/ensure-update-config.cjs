const fs = require('node:fs');
const path = require('node:path');
const { UPDATE_CONFIG } = require('../../../scripts/release-identity.cjs');

function resourcesPath(appOutDir, platform) {
  if (platform === 'darwin') {
    const appBundle = fs.readdirSync(appOutDir, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
    if (!appBundle) throw new Error(`No macOS app bundle found under ${appOutDir}.`);
    return path.join(appOutDir, appBundle.name, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

exports.default = async function ensureUpdateConfig(context) {
  const target = path.join(resourcesPath(context.appOutDir, context.electronPlatformName), 'app-update.yml');
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, UPDATE_CONFIG, 'utf8');
    console.log(`[updates] Wrote packaged update configuration to ${target}`);
    return;
  }

  const actual = fs.readFileSync(target, 'utf8');
  if (actual !== UPDATE_CONFIG) {
    throw new Error(
      `Packaged updater configuration is not the canonical LoomTV GitHub release identity: ${target}`,
    );
  }
};
