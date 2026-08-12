import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = JSON.parse(read('apps/mobile/app.json')).expo;
const manifest = read('apps/mobile/android/app/src/main/AndroidManifest.xml');
const gradle = read('apps/mobile/android/app/build.gradle');
const forbidden = ['android.permission.READ_EXTERNAL_STORAGE','android.permission.WRITE_EXTERNAL_STORAGE','android.permission.SYSTEM_ALERT_WINDOW','android.permission.WRITE_SETTINGS'];
const failures = [];
if (app.android?.allowBackup !== false) failures.push('Expo Android backups must be disabled.');
for (const permission of forbidden) {
  if (!app.android?.blockedPermissions?.includes(permission)) failures.push(`Blocked permission missing: ${permission}`);
  if (manifest.includes(`android:name="${permission}"`)) failures.push(`Forbidden merged permission: ${permission}`);
}
if (!manifest.includes('android:allowBackup="false"')) failures.push('Native Android backup must be disabled.');
if (!manifest.includes('android:dataExtractionRules="@xml/data_extraction_rules"')) failures.push('Android data extraction rules are missing.');
const buildTypesStart = gradle.indexOf('buildTypes {');
const releaseStart = gradle.indexOf('release {', buildTypesStart);
let releaseEnd = -1;
let releaseDepth = 0;
if (buildTypesStart >= 0 && releaseStart >= 0) {
  for (let index = gradle.indexOf('{', releaseStart); index < gradle.length; index += 1) {
    if (gradle[index] === '{') releaseDepth += 1;
    if (gradle[index] === '}') releaseDepth -= 1;
    if (releaseDepth === 0) { releaseEnd = index + 1; break; }
  }
}
if (releaseStart < 0 || releaseEnd < 0) failures.push('Release build type is missing or malformed.');
const releaseBlock = releaseStart >= 0 && releaseEnd >= 0 ? gradle.slice(releaseStart, releaseEnd) : '';
if (/signingConfig\s+signingConfigs\.debug/.test(releaseBlock)) failures.push('Release build uses the debug signing key.');
if (failures.length) { console.error(failures.map((failure) => `- ${failure}`).join('\n')); process.exit(1); }
console.log('Mobile release boundaries are enforced.');
