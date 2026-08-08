#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ATTESTATION_PREDICATE, MANIFEST_NAME } = require('./release-evidence.cjs');
const { parseReleaseTag } = require('./release-identity.cjs');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function required(values, name) {
  if (typeof values[name] !== 'string' || !values[name].trim()) {
    throw new Error(`Missing required argument --${name}.`);
  }
  return values[name];
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifySubject(filePath, repository, tag, sourceDigest) {
  const result = spawnSync('gh', [
    'attestation',
    'verify',
    filePath,
    '--repo',
    repository,
    '--signer-workflow',
    `${repository}/.github/workflows/release.yml`,
    '--source-ref',
    `refs/tags/${tag}`,
    '--source-digest',
    sourceDigest,
    '--predicate-type',
    ATTESTATION_PREDICATE,
    '--deny-self-hosted-runners',
    '--format',
    'json',
  ], { encoding: 'utf8' });

  if (result.error) throw new Error(`Could not execute gh attestation verify: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`GitHub/SLSA attestation verification failed for ${path.basename(filePath)}:\n${(result.stderr || result.stdout).trim()}`);
  }

  let records;
  try {
    records = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh attestation verify returned invalid JSON for ${path.basename(filePath)}: ${String(error)}`);
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`No verified GitHub/SLSA attestation was returned for ${path.basename(filePath)}.`);
  }

  const expectedDigest = sha256File(filePath);
  const hasExactSubject = records.some((record) => {
    const statement = record?.verificationResult?.statement;
    if (statement?.predicateType !== ATTESTATION_PREDICATE) return false;
    return Array.isArray(statement.subject)
      && statement.subject.some((subject) => subject?.digest?.sha256 === expectedDigest);
  });
  if (!hasExactSubject) {
    throw new Error(`Verified attestation subjects did not contain the exact SHA-256 for ${path.basename(filePath)}.`);
  }
}

function main(values) {
  const assetsRoot = path.resolve(required(values, 'assets'));
  const repository = required(values, 'repository');
  const { tag, version } = parseReleaseTag(required(values, 'tag'));
  const sourceDigest = required(values, 'sha');
  if (!/^[0-9a-f]{40}$/i.test(sourceDigest)) {
    throw new Error(`Release source digest must be a full SHA: ${sourceDigest}`);
  }

  const manifestPath = path.join(assetsRoot, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing release manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.release?.tag !== tag || manifest.release?.version !== version || manifest.release?.commit !== sourceDigest) {
    throw new Error('Release manifest identity does not match the attestation verification inputs.');
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error('Release manifest contains no attestation subjects.');
  }

  for (const entry of manifest.assets) {
    if (typeof entry.path !== 'string' || path.basename(entry.path) !== entry.name) {
      throw new Error(`Release manifest path is invalid for ${entry.name}.`);
    }
    const filePath = path.resolve(assetsRoot, entry.path);
    const relative = path.relative(assetsRoot, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath)) {
      throw new Error(`Release attestation subject is missing: ${entry.name}.`);
    }
    verifySubject(filePath, repository, tag, sourceDigest);
    console.log(`Verified GitHub/SLSA subject ${entry.name}.`);
  }
}

if (require.main === module) {
  try {
    main(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArguments };
