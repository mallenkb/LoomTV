#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const {
  artifactDescriptor,
  metadataTarget,
} = require('./release-evidence.cjs');
const { parseReleaseTag } = require('./release-identity.cjs');

function collectFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Attestation input contains a symbolic link: ${candidate}`);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
      else throw new Error(`Attestation input contains an unsupported entry: ${candidate}`);
    }
  }
  return files;
}

function verifyAttestationInput(root, platform, tag) {
  const { version } = parseReleaseTag(tag);
  if (!['Linux', 'macOS', 'Windows'].includes(platform)) {
    throw new Error(`Unsupported trusted attestation platform: ${platform}`);
  }
  const files = collectFiles(root);
  if (files.length === 0) throw new Error(`No ${platform} artifacts were downloaded for attestation.`);
  for (const file of files) {
    const name = path.basename(file);
    const target = artifactDescriptor(name, version) || metadataTarget(name);
    if (!target) throw new Error(`Unsupported artifact in ${platform} attestation input: ${name}`);
    if (target.platform !== platform) {
      throw new Error(`${platform} attestation input contains ${target.platform} artifact ${name}.`);
    }
  }
  console.log(`Verified ${files.length} ${platform} attestation subject(s).`);
}

if (require.main === module) {
  try {
    const [root, platform, tag] = process.argv.slice(2);
    if (!root || !platform || !tag) {
      throw new Error('Usage: verify-attestation-input.cjs <directory> <Linux|macOS|Windows> <vMAJOR.MINOR.PATCH>');
    }
    verifyAttestationInput(path.resolve(root), platform, tag);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyAttestationInput };
