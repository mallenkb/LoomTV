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
  const hadExistingConfig = fs.existsSync(target);
  const actual = hadExistingConfig ? fs.readFileSync(target, 'utf8') : undefined;

  // Electron Builder may emit platform-specific formatting or defaults before
  // this hook runs. The release identity is owned by LoomTV, so normalize the
  // generated file instead of failing the entire package on harmless differences.
  if (actual !== UPDATE_CONFIG) {
    fs.writeFileSync(target, UPDATE_CONFIG, 'utf8');
    console.log(
      `[updates] ${hadExistingConfig ? 'Normalized' : 'Wrote'} packaged update configuration to ${target}`,
    );
  }
};
