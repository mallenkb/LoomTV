const fs = require('node:fs');
const path = require('node:path');
const {
  withAndroidManifest,
  withDangerousMod,
  withInfoPlist,
} = require('@expo/config-plugins');
const ANDROID_BUILD_POLICY = require('../android-build-policy.cjs');

module.exports = function withLoomTvLoopbackTransport(config) {
  if (config.android?.package !== ANDROID_BUILD_POLICY.applicationId) {
    throw new Error(`Android package must be ${ANDROID_BUILD_POLICY.applicationId}.`);
  }
  if (config.version !== ANDROID_BUILD_POLICY.version) {
    throw new Error(`Android version must be ${ANDROID_BUILD_POLICY.version}.`);
  }
  if (config.android?.versionCode !== ANDROID_BUILD_POLICY.versionCode) {
    throw new Error(`Android versionCode must be ${ANDROID_BUILD_POLICY.versionCode}.`);
  }
  if (config.android?.usesCleartextTraffic !== false) {
    throw new Error('Android cleartext traffic must remain disabled.');
  }

  config = withAndroidManifest(config, (androidConfig) => {
    const application = androidConfig.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android application manifest is unavailable.');
    application.$['android:usesCleartextTraffic'] = 'false';
    application.$['android:networkSecurityConfig'] = ANDROID_BUILD_POLICY.networkSecurityConfigResource;
    return androidConfig;
  });

  config = withDangerousMod(config, ['android', (androidConfig) => {
    const target = path.join(
      androidConfig.modRequest.platformProjectRoot,
      'app',
      'src',
      'main',
      'res',
      'xml',
      'loomtv_network_security_config.xml',
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ANDROID_BUILD_POLICY.networkSecurityConfig, 'utf8');
    return androidConfig;
  }]);

  return withInfoPlist(config, (iosConfig) => {
    iosConfig.modResults.NSAppTransportSecurity = {
      ...(iosConfig.modResults.NSAppTransportSecurity || {}),
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
    };
    return iosConfig;
  });
};
