const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TRUSTED_ATTESTATION_BUILDERS,
} = require('./release-evidence.cjs');
const {
  attestationArguments,
  verifySubject,
} = require('./verify-release-attestations.cjs');

const REPOSITORY = 'mallenkb/LoomTV';
const TAG = 'v1.2.3';
const SOURCE_DIGEST = 'a'.repeat(40);

test('every platform tuple selects a distinct pinned trusted attestation workflow', () => {
  const builders = Object.values(TRUSTED_ATTESTATION_BUILDERS);
  assert.equal(new Set(builders).size, 3);

  for (const builder of builders) {
    const args = attestationArguments('/tmp/artifact', REPOSITORY, TAG, SOURCE_DIGEST, builder);
    assert.equal(args[args.indexOf('--signer-workflow') + 1], `${REPOSITORY}/${builder}`);
    assert.equal(args[args.indexOf('--signer-digest') + 1], SOURCE_DIGEST);
    assert.equal(args[args.indexOf('--source-digest') + 1], SOURCE_DIGEST);
    assert.equal(args[args.indexOf('--source-ref') + 1], `refs/tags/${TAG}`);
  }
});

test('attestation verification rejects an untrusted workflow before invoking gh', () => {
  assert.throws(
    () => attestationArguments('/tmp/artifact', REPOSITORY, TAG, SOURCE_DIGEST, '.github/workflows/release.yml'),
    /Untrusted release attestation builder/,
  );
});

test('attestation verification requires the exact artifact digest in verified subjects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-attestation-fixture-'));
  const artifact = path.join(root, 'artifact.bin');
  fs.writeFileSync(artifact, 'trusted subject');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  const execute = () => ({
    status: 0,
    stdout: JSON.stringify([{
      verificationResult: {
        statement: {
          predicateType: 'https://slsa.dev/provenance/v1',
          subject: [{ digest: { sha256: digest } }],
        },
      },
    }]),
    stderr: '',
  });

  assert.doesNotThrow(() => verifySubject(
    artifact,
    REPOSITORY,
    TAG,
    SOURCE_DIGEST,
    TRUSTED_ATTESTATION_BUILDERS.Linux,
    execute,
  ));
});
