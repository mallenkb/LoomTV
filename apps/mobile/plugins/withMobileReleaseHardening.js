const fs = require('node:fs/promises');
const path = require('node:path');
const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withPodfile,
  withXcodeProject,
} = require('@expo/config-plugins');

const FORBIDDEN_PERMISSIONS = new Set([
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
  'android.permission.VIBRATE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.WRITE_SETTINGS',
]);

const BACKUP_RULES = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <exclude domain="root" path="." />
    <exclude domain="file" path="." />
    <exclude domain="database" path="." />
    <exclude domain="sharedpref" path="." />
    <exclude domain="external" path="." />
</full-backup-content>
`;

const DATA_EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup disableIfNoEncryptionCapabilities="true">
        <exclude domain="root" path="." />
        <exclude domain="file" path="." />
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="external" path="." />
    </cloud-backup>
    <device-transfer>
        <exclude domain="root" path="." />
        <exclude domain="file" path="." />
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="external" path="." />
    </device-transfer>
</data-extraction-rules>
`;

function withMobileReleaseHardening(config) {
  config = withAndroidManifest(config, (androidConfig) => {
    const manifest = androidConfig.modResults.manifest;
    manifest['uses-permission'] = (manifest['uses-permission'] || []).filter((entry) => !FORBIDDEN_PERMISSIONS.has(entry?.$?.['android:name']));
    for (const permission of FORBIDDEN_PERMISSIONS) {
      manifest['uses-permission'].push({
        $: {
          'android:name': permission,
          'tools:node': 'remove',
        },
      });
    }
    const application = manifest.application?.[0];
    if (!application?.$) throw new Error('Android application manifest entry is missing.');
    application.$['android:allowBackup'] = 'false';
    application.$['android:fullBackupContent'] = '@xml/backup_rules';
    application.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    return androidConfig;
  });

  config = withAppBuildGradle(config, (gradleConfig) => {
    const contents = gradleConfig.modResults.contents;
    const buildTypesStart = contents.indexOf('buildTypes {');
    const releaseStart = contents.indexOf('release {', buildTypesStart);
    if (buildTypesStart < 0 || releaseStart < 0) throw new Error('Android release build type is missing.');
    let depth = 0;
    let releaseEnd = -1;
    for (let index = contents.indexOf('{', releaseStart); index < contents.length; index += 1) {
      if (contents[index] === '{') depth += 1;
      if (contents[index] === '}') depth -= 1;
      if (depth === 0) { releaseEnd = index + 1; break; }
    }
    if (releaseEnd < 0) throw new Error('Android release build type is malformed.');
    const releaseBlock = contents.slice(releaseStart, releaseEnd);
    const hardenedReleaseBlock = releaseBlock.replace(
      /^\s*signingConfig signingConfigs\.debug\s*$/m,
      '            // Production signing is injected by EAS. Local release builds remain unsigned.',
    );
    if (/signingConfig\s+signingConfigs\.debug/.test(hardenedReleaseBlock)) {
      throw new Error('Android release build still references the debug signing key.');
    }
    gradleConfig.modResults.contents = contents.slice(0, releaseStart) + hardenedReleaseBlock + contents.slice(releaseEnd);
    return gradleConfig;
  });

  config = withPodfile(config, (podfileConfig) => {
    const marker = '# LoomTV minimum iOS deployment target';
    if (podfileConfig.modResults.contents.includes(marker)) return podfileConfig;
    const postInstallPattern = /(post_install do \|installer\|\r?\n)/;
    if (!postInstallPattern.test(podfileConfig.modResults.contents)) {
      throw new Error('iOS Podfile post_install hook is missing.');
    }
    const deploymentTargetGuard = `${marker}
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |build_config|
      deployment_target = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f
      if deployment_target.positive? && deployment_target < 15.1
        build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'
      end
    end
    target.shell_script_build_phases.each do |phase|
      next unless phase.name == '[CP-User] Generate app.config for prebuilt Constants.manifest'
      phase.shell_script = 'bash -l -c "\\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\""'
    end
  end
`;
    podfileConfig.modResults.contents = podfileConfig.modResults.contents.replace(
      postInstallPattern,
      `$1  ${deploymentTargetGuard}`,
    );
    return podfileConfig;
  });

  config = withXcodeProject(config, (xcodeConfig) => {
    const phases = xcodeConfig.modResults.hash.project.objects.PBXShellScriptBuildPhase;
    const nodePrint = '"$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'"';
    const unquotedInvocation = `\`${nodePrint}\``;
    const quotedInvocation = `"$(${nodePrint})"`;

    Object.values(phases).forEach((phase) => {
      if (!phase || typeof phase !== 'object') return;
      const phaseName = String(phase.name || '').replace(/^"|"$/g, '');
      if (phaseName !== 'Bundle React Native code and images') return;

      const shellScript = String(phase.shellScript || '');
      const escapedUnquotedInvocation = unquotedInvocation.replaceAll('"', '\\"');
      const escapedQuotedInvocation = quotedInvocation.replaceAll('"', '\\"');
      if (shellScript.includes(unquotedInvocation)) {
        phase.shellScript = shellScript.replace(unquotedInvocation, quotedInvocation);
      } else if (shellScript.includes(escapedUnquotedInvocation)) {
        phase.shellScript = shellScript.replace(escapedUnquotedInvocation, escapedQuotedInvocation);
      } else {
        throw new Error('React Native bundle phase no longer contains the expected script invocation.');
      }
    });

    return xcodeConfig;
  });

  config = withDangerousMod(config, ['android', async (dangerousConfig) => {
    const xmlDir = path.join(dangerousConfig.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    await fs.mkdir(xmlDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(xmlDir, 'backup_rules.xml'), BACKUP_RULES),
      fs.writeFile(path.join(xmlDir, 'data_extraction_rules.xml'), DATA_EXTRACTION_RULES),
    ]);
    return dangerousConfig;
  }]);
  return config;
}

module.exports = withMobileReleaseHardening;
