#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const mobileRoot = path.join(workspaceRoot, 'apps', 'mobile');
const appConfig = readJson(path.join(mobileRoot, 'app.json')).expo;
const easConfig = readJson(path.join(mobileRoot, 'eas.json'));
const mobilePackage = readJson(path.join(mobileRoot, 'package.json'));
const failures = [];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function pluginName(entry) {
  return Array.isArray(entry) ? entry[0] : entry;
}

function assetExists(relativePath, label) {
  expect(
    typeof relativePath === 'string' && fs.existsSync(path.resolve(mobileRoot, relativePath)),
    `${label} must point to a tracked asset`,
  );
}

expect(appConfig.version === mobilePackage.version, 'app.json and mobile package versions must match');
expect(Boolean(appConfig.ios?.bundleIdentifier), 'iOS bundleIdentifier is required');
expect(appConfig.ios?.supportsTablet === true, 'iOS tablet support must stay enabled');
expect(appConfig.ios?.config?.usesNonExemptEncryption === false, 'iOS export-compliance declaration must be explicit');
expect(
  appConfig.ios?.infoPlist?.NSBonjourServices?.includes('_loomtv._tcp'),
  'iOS Bonjour service declaration is required for LAN discovery',
);
expect(
  Boolean(appConfig.ios?.infoPlist?.NSLocalNetworkUsageDescription),
  'iOS local-network usage description is required',
);
expect(Boolean(appConfig.android?.package), 'Android package is required');
expect(Number.isSafeInteger(appConfig.android?.versionCode) && appConfig.android.versionCode > 0, 'Android versionCode must be positive');
expect(appConfig.android?.usesCleartextTraffic === false, 'Android remote cleartext traffic must remain disabled');
for (const permission of [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.ACCESS_WIFI_STATE',
  'android.permission.CHANGE_WIFI_MULTICAST_STATE',
]) {
  expect(appConfig.android?.permissions?.includes(permission), `Android permission ${permission} is required`);
}

const plugins = (appConfig.plugins || []).map(pluginName);
expect(plugins.includes('./plugins/withLoomTvLoopbackTransport.cjs'), 'secure LAN transport config plugin is required');
expect(plugins.includes('./plugins/with-gradle-distribution-checksum.cjs'), 'Gradle checksum config plugin is required');
expect(Boolean(mobilePackage.dependencies?.['expo-sqlite']), 'expo-sqlite is required for offline library metadata');

expect(easConfig.cli?.appVersionSource === 'remote', 'EAS must own native build-number increments');
expect(easConfig.cli?.requireCommit === true, 'EAS releases must be built from a committed revision');
expect(easConfig.build?.preview?.distribution === 'internal', 'preview builds must use internal distribution');
expect(easConfig.build?.preview?.android?.buildType === 'apk', 'Android preview builds must produce an installable APK');
expect(easConfig.build?.['preview-simulator']?.ios?.simulator === true, 'an iOS Simulator profile is required');
expect(easConfig.build?.production?.autoIncrement === true, 'production builds must auto-increment native versions');
expect(Boolean(easConfig.submit?.production), 'production submission profile is required');

for (const scriptName of [
  'build:preview:android',
  'build:preview:ios',
  'build:simulator:ios',
  'build:production',
  'submit:production',
]) {
  expect(Boolean(mobilePackage.scripts?.[scriptName]), `mobile script ${scriptName} is required`);
}

assetExists(appConfig.icon, 'App icon');
assetExists(appConfig.android?.adaptiveIcon?.foregroundImage, 'Android foreground icon');
assetExists(appConfig.android?.adaptiveIcon?.backgroundImage, 'Android background icon');
assetExists(appConfig.android?.adaptiveIcon?.monochromeImage, 'Android monochrome icon');
expect(fs.existsSync(path.join(mobileRoot, 'RELEASE_CHECKLIST.md')), 'mobile release checklist is required');

if (failures.length > 0) {
  console.error('Mobile release configuration validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Mobile iOS/Android release configuration is complete.');
}
