#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function firstRuntimeRoot(candidates, executablePath) {
  return candidates.find((candidate) => (
    typeof candidate === 'string'
    && candidate.length > 0
    && fs.existsSync(path.join(candidate, executablePath))
  ));
}

const javaHome = firstRuntimeRoot([
  process.env.JAVA_HOME,
  '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  '/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home',
  '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
  '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
  '/opt/android-studio/jbr',
  '/usr/lib/jvm/java-17-openjdk-amd64',
], path.join('bin', process.platform === 'win32' ? 'java.exe' : 'java'));

const androidSdk = firstRuntimeRoot([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  path.join(os.homedir(), 'Library', 'Android', 'sdk'),
  path.join(os.homedir(), 'Android', 'Sdk'),
], path.join('platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));

if (!javaHome) {
  console.error('[android] Java was not found. Install Android Studio or set JAVA_HOME to a supported JDK.');
  process.exit(1);
}

if (!androidSdk) {
  console.error('[android] The Android SDK was not found. Install it with Android Studio or set ANDROID_HOME.');
  process.exit(1);
}

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidSdk,
  ANDROID_SDK_ROOT: androidSdk,
  PATH: [
    path.join(javaHome, 'bin'),
    path.join(androidSdk, 'platform-tools'),
    process.env.PATH || '',
  ].filter(Boolean).join(path.delimiter),
};

console.log(`[android] Java: ${javaHome}`);
console.log(`[android] SDK: ${androidSdk}`);

const expoCli = require.resolve('expo/bin/cli');
const result = spawnSync(process.execPath, [expoCli, 'run:android', ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '..'),
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[android] Expo failed to start: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
