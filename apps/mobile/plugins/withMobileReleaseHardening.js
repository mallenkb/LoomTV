const fs = require('node:fs/promises');
const path = require('node:path');
const { withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('@expo/config-plugins');

const FORBIDDEN_PERMISSIONS = new Set([
  'android.permission.READ_EXTERNAL_STORAGE',
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
