#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');

const EXPECTED_TEST_WORKSPACES = Object.freeze([
  'apps/desktop',
  'apps/mobile',
  'apps/server',
  'apps/tv',
  'apps/desktop-tauri',
  'packages/media-core',
  'packages/plugin-protocol',
  'packages/runtime-paths',
  'packages/transcode-capabilities',
  'packages/video-contracts',
  'packages/video-migration',
]);

// The repository root orchestrates workspace tests. lan-protocol is intentionally
// typecheck-only until it has a test script of its own.
const TEST_WORKSPACE_EXCLUSIONS = Object.freeze({
  '.': 'root orchestration package',
  'packages/lan-protocol': 'typecheck-only package with no test script',
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readWorkspacePatterns(workspaceRoot) {
  const workspaceManifest = parse(fs.readFileSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8'));
  return Array.isArray(workspaceManifest?.packages) ? workspaceManifest.packages : [];
}

function workspaceIncludes(relativeRoot, patterns) {
  const validPatterns = patterns.filter((pattern) => typeof pattern === 'string' && pattern);
  return validPatterns.some((pattern) => !pattern.startsWith('!') && path.posix.matchesGlob(relativeRoot, pattern))
    && !validPatterns.some((pattern) => pattern.startsWith('!') && path.posix.matchesGlob(relativeRoot, pattern.slice(1)));
}

function discoverWorkspaceRoots(workspaceRoot, patterns) {
  const roots = new Set();
  for (const rawPattern of patterns) {
    if (typeof rawPattern !== 'string' || !rawPattern) continue;
    if (rawPattern.startsWith('!')) continue;
    for (const match of fs.globSync(rawPattern, { cwd: workspaceRoot, exclude: ['**/node_modules/**'] })) {
      const relativeRoot = match.split(path.sep).join('/') || '.';
      if (workspaceIncludes(relativeRoot, patterns)
        && fs.existsSync(path.join(workspaceRoot, relativeRoot, 'package.json'))) roots.add(relativeRoot);
    }
  }
  return [...roots];
}

function validateTestWorkspacePolicy(workspaceRoot) {
  const failures = [];
  const rootManifest = readJson(path.join(workspaceRoot, 'package.json'));
  const workspacePatterns = readWorkspacePatterns(workspaceRoot);
  const rootTest = rootManifest.scripts?.test || '';
  const discoveredWorkspaceRoots = discoverWorkspaceRoots(workspaceRoot, workspacePatterns);
  const expectedWorkspaces = new Set(EXPECTED_TEST_WORKSPACES);
  const excludedWorkspaces = new Set(Object.keys(TEST_WORKSPACE_EXCLUSIONS));

  if (!rootTest.includes('verify:test-workspaces')) {
    failures.push('root test script must run verify:test-workspaces');
  }
  if (!/pnpm\s+-r\s+--if-present\s+test(?:\s|$)/.test(rootTest)) {
    failures.push('root test script must execute recursive workspace tests');
  }

  for (const relativeRoot of discoveredWorkspaceRoots) {
    if (!expectedWorkspaces.has(relativeRoot) && !excludedWorkspaces.has(relativeRoot)) {
      failures.push(`${relativeRoot} must be classified as a test workspace or an explicit exclusion`);
    }
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

  for (const relativeRoot of excludedWorkspaces) {
    if (relativeRoot === '.') continue;
    const manifestPath = path.join(workspaceRoot, relativeRoot, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      failures.push(`${relativeRoot} is an explicit test-workspace exclusion but is missing package.json`);
      continue;
    }
    const manifest = readJson(manifestPath);
    if (typeof manifest.scripts?.test === 'string' && manifest.scripts.test.trim()) {
      failures.push(`${relativeRoot} is excluded from test workspaces but has a test script`);
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
  console.log(`Test-workspace policy covers ${EXPECTED_TEST_WORKSPACES.length} workspaces and ${Object.keys(TEST_WORKSPACE_EXCLUSIONS).length} explicit exclusions.`);
  return 0;
}

if (require.main === module) process.exitCode = runCli();

module.exports = {
  EXPECTED_TEST_WORKSPACES,
  TEST_WORKSPACE_EXCLUSIONS,
  runCli,
  validateTestWorkspacePolicy,
};
