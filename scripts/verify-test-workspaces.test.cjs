const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  EXPECTED_TEST_WORKSPACES,
  validateTestWorkspacePolicy,
} = require('./verify-test-workspaces.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function policyFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-test-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  writeJson(path.join(root, 'package.json'), {
    scripts: {
      test: 'pnpm run verify:test-workspaces && pnpm -r --if-present test',
    },
  });
  for (const relativeRoot of EXPECTED_TEST_WORKSPACES) {
    writeJson(path.join(root, relativeRoot, 'package.json'), {
      name: relativeRoot,
      scripts: { test: 'node --test' },
    });
  }
  writeJson(path.join(root, 'packages/lan-protocol/package.json'), {
    name: '@loom-media-server/lan-protocol',
    scripts: { typecheck: 'tsc --noEmit' },
  });
  return root;
}

test('accepts the complete expected test-workspace contract', (t) => {
  assert.deepEqual(validateTestWorkspacePolicy(policyFixture(t)), []);
});

test('rejects a named workspace whose test script is removed', (t) => {
  const root = policyFixture(t);
  writeJson(path.join(root, 'packages/runtime-paths/package.json'), {
    name: '@loom-media-server/runtime-paths',
  });

  assert.deepEqual(validateTestWorkspacePolicy(root), [
    'packages/runtime-paths (@loom-media-server/runtime-paths) is missing a test script',
  ]);
});

test('rejects root wiring that can silently skip the policy', (t) => {
  const root = policyFixture(t);
  writeJson(path.join(root, 'package.json'), {
    scripts: { test: 'pnpm -r --if-present test' },
  });

  assert.deepEqual(validateTestWorkspacePolicy(root), [
    'root test script must run verify:test-workspaces',
  ]);
});

test('rejects an expected package removed from the workspace patterns', (t) => {
  const root = policyFixture(t);
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - apps/*',
    '  - packages/*',
    '  - "!packages/runtime-paths"',
    '',
  ].join('\n'));

  assert.deepEqual(validateTestWorkspacePolicy(root), [
    'packages/runtime-paths is not included by pnpm-workspace.yaml',
  ]);
});

test('requires classification for new workspace packages', (t) => {
  const root = policyFixture(t);
  writeJson(path.join(root, 'apps/new-client/package.json'), { name: 'new-client' });
  assert.deepEqual(validateTestWorkspacePolicy(root), [
    'apps/new-client must be classified as a test workspace or an explicit exclusion',
  ]);
});

test('ignores directories without manifests and excluded packages regardless of pattern order', (t) => {
  const root = policyFixture(t);
  fs.mkdirSync(path.join(root, 'apps/assets'));
  writeJson(path.join(root, 'apps/excluded/package.json'), { name: 'excluded' });
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "!apps/excluded"\n  - apps/*\n  - packages/*\n  - .\n');
  assert.deepEqual(validateTestWorkspacePolicy(root), []);
});

test('discovers literal and nested workspace patterns', (t) => {
  const root = policyFixture(t);
  writeJson(path.join(root, 'tools/checker/package.json'), { name: 'checker' });
  writeJson(path.join(root, 'extensions/group/addon/package.json'), { name: 'addon' });
  fs.appendFileSync(path.join(root, 'pnpm-workspace.yaml'), '  - tools/checker\n  - extensions/**\n');
  assert.deepEqual(validateTestWorkspacePolicy(root).sort(), [
    'extensions/group/addon must be classified as a test workspace or an explicit exclusion',
    'tools/checker must be classified as a test workspace or an explicit exclusion',
  ]);
});

test('requires reclassification when an excluded package gains tests', (t) => {
  const root = policyFixture(t);
  writeJson(path.join(root, 'packages/lan-protocol/package.json'), { scripts: { test: 'node --test' } });
  assert.deepEqual(validateTestWorkspacePolicy(root), [
    'packages/lan-protocol is excluded from test workspaces but has a test script',
  ]);
});
