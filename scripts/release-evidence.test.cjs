const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ATTESTATION_PREDICATE,
  createEvidence,
  expectedTargetMatrix,
  expectedUpdaterCoverage,
  validateArtifactSet,
  validateManifestPolicy,
  verifyEvidence,
} = require('./release-evidence.cjs');

function fixtureAssets(version = '1.2.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-release-evidence-'));
  const names = expectedTargetMatrix(version).flatMap((target) => target.artifacts);
  const updaterFiles = new Map([
    ['latest-mac.yml', expectedUpdaterCoverage(version)[0].requiredAssets],
    ['latest.yml', expectedUpdaterCoverage(version)[1].requiredAssets],
    ['latest-linux.yml', expectedUpdaterCoverage(version)[2].requiredAssets],
  ]);
  for (const name of names) fs.writeFileSync(path.join(root, name), name);
  for (const [metadata, references] of updaterFiles) {
    fs.writeFileSync(path.join(root, metadata), [
      `version: ${version}`,
      'files:',
      ...references.map((reference) => `  - url: ${reference}`),
      `path: ${references[0]}`,
      '',
    ].join('\n'));
  }
  return { root, names: [...names, ...updaterFiles.keys()] };
}

function entriesFor(fixture) {
  return fixture.names.map((name) => ({
    name,
    filePath: path.join(fixture.root, name),
  }));
}

test('release evidence fixture enforces every platform, architecture, and updater subject', () => {
  const fixture = fixtureAssets();
  assert.deepEqual(validateArtifactSet(entriesFor(fixture), '1.2.3'), []);
  assert.deepEqual(validateManifestPolicy({
    targetMatrix: expectedTargetMatrix('1.2.3'),
    updaterCoverage: expectedUpdaterCoverage('1.2.3'),
    evidence: {
      checksums: 'SHA256SUMS',
      attestations: {
        provider: 'GitHub artifact attestations',
        predicateType: ATTESTATION_PREDICATE,
      },
    },
  }, '1.2.3'), []);

  const identity = {
    assets: fixture.root,
    tag: 'v1.2.3',
    sha: 'a'.repeat(40),
    'tag-oid': 'b'.repeat(40),
  };
  createEvidence(identity);
  verifyEvidence(identity);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.root, 'release-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.targetMatrix, expectedTargetMatrix('1.2.3'));
  assert.deepEqual(manifest.updaterCoverage, expectedUpdaterCoverage('1.2.3'));
});

test('release evidence fixture rejects a missing target and cross-platform updater reference', () => {
  const fixture = fixtureAssets();
  const missing = fixture.names.filter((name) => name !== 'LoomTV-1.2.3-mac-x64.zip');
  const missingFailures = validateArtifactSet(missing.map((name) => ({
    name,
    filePath: path.join(fixture.root, name),
  })), '1.2.3');
  assert.ok(missingFailures.some((message) => message.includes('mac-x64.zip')));

  fs.writeFileSync(path.join(fixture.root, 'latest.yml'), [
    'version: 1.2.3',
    'path: LoomTV-1.2.3-mac-arm64.zip',
    '',
  ].join('\n'));
  assert.ok(validateArtifactSet(entriesFor(fixture), '1.2.3').some((message) => message.includes('outside its exact target coverage')));
});
