#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const mobileRoot = path.join(workspaceRoot, 'apps', 'mobile');
const generatedAndroidRoot = path.join(mobileRoot, 'android');
const requireGenerated = process.argv.includes('--require-generated');
const policy = require(path.join(mobileRoot, 'android-build-policy.cjs'));
const appConfig = readJson(path.join(mobileRoot, 'app.json')).expo;
const mobilePackage = readJson(path.join(mobileRoot, 'package.json'));
const failures = [];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(message) {
  failures.push(message);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function pluginConfig(name) {
  const entry = appConfig.plugins?.find((candidate) =>
    (Array.isArray(candidate) ? candidate[0] : candidate) === name,
  );
  return Array.isArray(entry) ? entry[1] : entry;
}

function propertyValues(source, key) {
  return [...source.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map((match) => match[1]);
}

function expectSingleProperty(source, key, expected, fileLabel) {
  const values = propertyValues(source, key);
  if (values.length !== 1) {
    fail(`${fileLabel}: expected exactly one ${key} property, found ${values.length}`);
    return;
  }
  expectEqual(values[0], expected, `${fileLabel} ${key}`);
}

function expectGradleString(source, key, expected, fileLabel) {
  const matches = [...source.matchAll(new RegExp(`\\b${key}\\s+["']([^"']+)["']`, 'g'))];
  if (matches.length !== 1) {
    fail(`${fileLabel}: expected exactly one ${key} declaration, found ${matches.length}`);
    return;
  }
  expectEqual(matches[0][1], expected, `${fileLabel} ${key}`);
}

function expectGradleNumber(source, key, expected, fileLabel) {
  const matches = [...source.matchAll(new RegExp(`\\b${key}\\s+(\\d+)`, 'g'))];
  if (matches.length !== 1) {
    fail(`${fileLabel}: expected exactly one ${key} declaration, found ${matches.length}`);
    return;
  }
  expectEqual(Number(matches[0][1]), expected, `${fileLabel} ${key}`);
}

function readGenerated(relativePath) {
  const filePath = path.join(generatedAndroidRoot, relativePath);
  if (!fs.existsSync(filePath)) {
    fail(`generated Android output is missing ${relativePath}`);
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

function validateTrackedConfiguration() {
  expectEqual(appConfig.android?.package, policy.applicationId, 'app.json Android package');
  expectEqual(appConfig.version, policy.version, 'app.json version');
  expectEqual(mobilePackage.version, policy.version, 'mobile package.json version');
  expectEqual(appConfig.android?.versionCode, policy.versionCode, 'app.json Android versionCode');
  expectEqual(appConfig.android?.usesCleartextTraffic, false, 'app.json Android cleartext policy');

  const buildProperties = pluginConfig('expo-build-properties');
  expectEqual(
    buildProperties?.android?.usesCleartextTraffic,
    false,
    'expo-build-properties Android cleartext policy',
  );

  for (const plugin of [
    './plugins/withLoomTvLoopbackTransport.cjs',
    './plugins/with-gradle-distribution-checksum.cjs',
  ]) {
    if (!pluginConfig(plugin)) fail(`app.json is missing required config plugin ${plugin}`);
  }
}

function validateGeneratedConfiguration() {
  const buildGradle = readGenerated(path.join('app', 'build.gradle'));
  expectGradleString(buildGradle, 'namespace', policy.applicationId, 'android/app/build.gradle');
  expectGradleString(buildGradle, 'applicationId', policy.applicationId, 'android/app/build.gradle');
  expectGradleString(buildGradle, 'versionName', policy.version, 'android/app/build.gradle');
  expectGradleNumber(buildGradle, 'versionCode', policy.versionCode, 'android/app/build.gradle');

  const manifest = readGenerated(path.join('app', 'src', 'main', 'AndroidManifest.xml'));
  const application = manifest.match(/<application\b([^>]*)>/)?.[1] || '';
  if (!application) {
    fail('AndroidManifest.xml is missing its application element');
  } else {
    if (!/android:usesCleartextTraffic=["']false["']/.test(application)) {
      fail('AndroidManifest.xml must set android:usesCleartextTraffic="false"');
    }
    const resourcePattern = policy.networkSecurityConfigResource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`android:networkSecurityConfig=["']${resourcePattern}["']`).test(application)) {
      fail(`AndroidManifest.xml must use ${policy.networkSecurityConfigResource}`);
    }
  }

  const manifestPackage = manifest.match(/<manifest\b[^>]*\bpackage=["']([^"']+)["']/)?.[1];
  if (manifestPackage) {
    expectEqual(manifestPackage, policy.applicationId, 'AndroidManifest.xml package');
  }

  const networkConfig = readGenerated(
    path.join('app', 'src', 'main', 'res', 'xml', 'loomtv_network_security_config.xml'),
  );
  expectEqual(
    networkConfig.replace(/\r\n/g, '\n').trim(),
    policy.networkSecurityConfig.trim(),
    'generated Android network security policy',
  );

  const wrapper = readGenerated(path.join('gradle', 'wrapper', 'gradle-wrapper.properties'));
  expectSingleProperty(
    wrapper,
    'distributionUrl',
    policy.gradleDistributionUrl,
    'gradle-wrapper.properties',
  );
  expectSingleProperty(
    wrapper,
    'distributionSha256Sum',
    policy.gradleDistributionSha256,
    'gradle-wrapper.properties',
  );
}

validateTrackedConfiguration();

if (fs.existsSync(generatedAndroidRoot)) {
  validateGeneratedConfiguration();
} else if (requireGenerated) {
  fail('generated Android output is required; run Expo prebuild before validation');
}

if (failures.length > 0) {
  console.error('Mobile Android build contract validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const scope = fs.existsSync(generatedAndroidRoot) ? 'tracked and generated' : 'tracked';
  console.log(`Mobile Android ${scope} configuration matches the fail-closed build policy.`);
}
