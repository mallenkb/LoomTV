#!/usr/bin/env node

const path = require('node:path');
const { verifyReleaseIdentity } = require('./release-identity.cjs');

const workspaceRoot = path.resolve(__dirname, '..');
const releaseTag = process.argv[2];

try {
  const result = verifyReleaseIdentity(workspaceRoot, releaseTag);
  if (result.failures.length > 0) {
    throw new Error(`Release identity validation failed:\n- ${result.failures.join('\n- ')}`);
  }
  console.log(`Release identity is consistent for ${result.tag} (${result.version}).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
