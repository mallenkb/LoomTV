const fs = require('node:fs');
const path = require('node:path');

const RELEASE_TAG_PATTERN = /^v([0-9]+\.[0-9]+\.[0-9]+(?:[+-][0-9A-Za-z.-]+)?)$/;
const UPDATE_CONFIG = [
  'provider: github',
  'owner: mallenkb',
  'repo: LoomTV',
  'releaseType: release',
  '',
].join('\n');

function parseReleaseTag(releaseTag) {
  if (typeof releaseTag !== 'string') {
    throw new Error('Release tag must be a string.');
  }
  const match = releaseTag.match(RELEASE_TAG_PATTERN);
  if (!match) {
    throw new Error(`Release tag must match vMAJOR.MINOR.PATCH[-prerelease][+build]: ${releaseTag}`);
  }
  return { tag: releaseTag, version: match[1] };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function releaseNotesPath(workspaceRoot, version) {
  return path.join(workspaceRoot, 'docs', 'releases', `v${version}.md`);
}

function updateConfigFields() {
  return {
    provider: 'github',
    owner: 'mallenkb',
    repo: 'LoomTV',
    releaseType: 'release',
  };
}

function verifyReleaseIdentity(workspaceRoot, releaseTag) {
  const { tag, version } = parseReleaseTag(releaseTag);
  const desktopPackagePath = path.join(workspaceRoot, 'apps', 'desktop', 'package.json');
  const desktopPackage = readJson(desktopPackagePath);
  const failures = [];

  if (desktopPackage.version !== version) {
    failures.push(`apps/desktop/package.json version must be ${version}; received ${desktopPackage.version}.`);
  }
  if (desktopPackage.productName !== 'LoomTV') {
    failures.push(`apps/desktop/package.json productName must be LoomTV; received ${desktopPackage.productName}.`);
  }
  if (desktopPackage.build?.artifactName !== '${productName}-${version}-${os}-${arch}.${ext}') {
    failures.push('apps/desktop/package.json build.artifactName must use the package version and platform tokens.');
  }

  const publishEntries = desktopPackage.build?.publish;
  const publish = Array.isArray(publishEntries) && publishEntries.length === 1
    ? publishEntries[0]
    : undefined;
  const expectedUpdater = updateConfigFields();
  for (const [field, expected] of Object.entries(expectedUpdater)) {
    if (publish?.[field] !== expected) {
      failures.push(`apps/desktop/package.json build.publish.${field} must be ${expected}.`);
    }
  }

  const notesPath = releaseNotesPath(workspaceRoot, version);
  let notesStat;
  try {
    notesStat = fs.lstatSync(notesPath);
  } catch {
    notesStat = undefined;
  }
  if (!notesStat?.isFile() || notesStat.isSymbolicLink()) {
    failures.push(`Release notes are required at docs/releases/v${version}.md.`);
  } else if (!fs.readFileSync(notesPath, 'utf8').trim()) {
    failures.push(`Release notes must not be empty: docs/releases/v${version}.md.`);
  }

  return {
    tag,
    version,
    notesPath,
    failures,
  };
}

module.exports = {
  RELEASE_TAG_PATTERN,
  UPDATE_CONFIG,
  parseReleaseTag,
  releaseNotesPath,
  updateConfigFields,
  verifyReleaseIdentity,
};
