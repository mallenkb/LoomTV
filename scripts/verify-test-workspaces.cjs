#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');

const EXPECTED_TEST_WORKSPACES = Object.freeze([
  'apps/desktop',
  'apps/mobile',
  'apps/server',
  'packages/media-core',
  'packages/runtime-paths',
  'packages/transcode-capabilities',
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readWorkspacePatterns(workspaceRoot) {
  const workspaceManifest = parse(fs.readFileSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8'));
  return Array.isArray(workspaceManifest?.packages) ? workspaceManifest.packages : [];
}

function workspaceIncludes(relativeRoot, patterns) {
  let included = false;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern) continue;
    const excluded = pattern.startsWith('!');
    const candidate = excluded ? pattern.slice(1) : pattern;
    if (path.posix.matchesGlob(relativeRoot, candidate)) included = !excluded;
  }
  return included;
}

function validateTestWorkspacePolicy(workspaceRoot) {
  const failures = [];
  const rootManifest = readJson(path.join(workspaceRoot, 'package.json'));
  const workspacePatterns = readWorkspacePatterns(workspaceRoot);
  const rootTest = rootManifest.scripts?.test || '';

  if (!rootTest.includes('verify:test-workspaces')) {
    failures.push('root test script must run verify:test-workspaces');
  }
  if (!/pnpm\s+-r\s+--if-present\s+test(?:\s|$)/.test(rootTest)) {
    failures.push('root test script must execute recursive workspace tests');
  }

  for (const relativeRoot of EXPECTED_TEST_WORKSPACES) {
    if (!workspaceIncludes(relativeRoot, workspacePatterns)) {
      failures.push(`${relativeRoot} is not included by pnpm-workspace.yaml`);
    }
    const manifestPath = path.join(workspaceRoot, relativeRoot, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      failures.push(`${relativeRoot} is missing package.json`);
      continue;
    }
    const manifest = readJson(manifestPath);
    if (typeof manifest.scripts?.test !== 'string' || !manifest.scripts.test.trim()) {
      failures.push(`${relativeRoot} (${manifest.name || 'unnamed'}) is missing a test script`);
    }
  }

  return failures;
}

function runCli(workspaceRoot = path.resolve(__dirname, '..')) {
  const failures = validateTestWorkspacePolicy(workspaceRoot);
  if (failures.length > 0) {
    console.error('Test-workspace policy validation failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }
  console.log(`Test-workspace policy covers ${EXPECTED_TEST_WORKSPACES.length} workspaces.`);
  return 0;
}

if (require.main === module) process.exitCode = runCli();

module.exports = {
  EXPECTED_TEST_WORKSPACES,
  runCli,
  validateTestWorkspacePolicy,
};
