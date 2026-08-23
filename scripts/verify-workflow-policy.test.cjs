const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  desktopPackagingViolations,
  findPolicyViolations,
  releaseWorkflowViolations,
  verifyWorkflowDirectory,
  workspacePackageIndex,
  workspaceSelectorViolations,
} = require('./verify-workflow-policy.cjs');

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

function workflow({ permissions = 'contents: read', secret = false, event = 'pull_request' } = {}) {
  return `
name: Fixture
on:
  ${event}:
permissions:
  ${permissions}
jobs:
  verify:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          persist-credentials: false
      - run: corepack pnpm install --frozen-lockfile${secret ? `\n        env:\n          VALUE: \${{ secrets.PROTECTED_VALUE }}` : ''}
`;
}

test('accepts an explicitly read-only pull-request workflow', () => {
  assert.deepEqual(findPolicyViolations('fixture.yml', workflow()), []);
});

test('rejects write permissions in a pull-request workflow', () => {
  const violations = findPolicyViolations('fixture.yml', workflow({ permissions: 'contents: write' }));
  assert.ok(violations.some((message) => message.includes('grants write')));
});

test('requires explicit workflow permissions', () => {
  const source = workflow().replace('permissions:\n  contents: read\n', '');
  const violations = findPolicyViolations('fixture.yml', source);
  assert.ok(violations.some((message) => message.includes('explicit permissions')));
});

test('rejects protected secret references in a pull-request workflow', () => {
  const violations = findPolicyViolations('fixture.yml', workflow({ secret: true }));
  assert.ok(violations.some((message) => message.includes('secrets context')));
});

test('rejects indirect and whitespace-delimited secret-context references', () => {
  for (const expression of ['${{ toJSON(secrets) }}', "${{ secrets ['PROTECTED_VALUE'] }}"]) {
    const source = workflow().replace(
      'corepack pnpm install --frozen-lockfile',
      `corepack pnpm install --frozen-lockfile\n        env:\n          VALUE: ${expression}`,
    );
    const violations = findPolicyViolations('fixture.yml', source);
    assert.ok(violations.some((message) => message.includes('secrets context')));
  }
});

test('allows write permissions in a release-only workflow', () => {
  assert.deepEqual(findPolicyViolations('release-fixture.yml', workflow({ permissions: 'contents: write', secret: true, event: 'workflow_dispatch' })), []);
});

test('requires frozen dependency installs in release-only workflows', () => {
  const source = workflow({ event: 'workflow_dispatch' }).replace(' --frozen-lockfile', '');
  const violations = findPolicyViolations('release.yml', source);
  assert.ok(violations.some((message) => message.includes('dependency install must use --frozen-lockfile')));
});

test('rejects pull_request_target even when its token is read-only', () => {
  const violations = findPolicyViolations('fixture.yml', workflow({ event: 'pull_request_target' }));
  assert.ok(violations.some((message) => message.includes('pull_request_target is prohibited')));
});

test('rejects publishing commands in pull-request jobs', () => {
  const source = workflow().replace(
    'corepack pnpm install --frozen-lockfile',
    'corepack pnpm install --frozen-lockfile\n      - run: gh release create v1.2.3',
  );
  const violations = findPolicyViolations('fixture.yml', source);
  assert.ok(violations.some((message) => message.includes('publishing command')));
});

test('rejects publishing hidden behind a package script in pull-request jobs', () => {
  for (const command of [
    'corepack pnpm --filter loom-media-server-desktop run release',
    'npm run publish',
    'yarn run release:all-platforms',
  ]) {
    const source = workflow().replace(
      'corepack pnpm install --frozen-lockfile',
      `corepack pnpm install --frozen-lockfile\n      - run: ${command}`,
    );
    const violations = findPolicyViolations('fixture.yml', source);
    assert.ok(
      violations.some((message) => message.includes('publishing command')),
      `expected ${command} to be rejected`,
    );
  }
});

test('rejects inherited secrets on reusable pull-request jobs', () => {
  const source = `
name: Reusable fixture
on:
  pull_request:
permissions:
  contents: read
jobs:
  verify:
    uses: example/workflows/.github/workflows/validate.yml@${CHECKOUT_SHA}
    secrets: inherit
`;
  const violations = findPolicyViolations('fixture.yml', source);
  assert.ok(violations.some((message) => message.includes('jobs.verify.secrets')));
  assert.ok(violations.some((message) => message.includes('secrets context')));
});

test('requires reusable workflows to use a full commit SHA', () => {
  const source = `
name: Reusable fixture
on:
  pull_request:
permissions:
  contents: read
jobs:
  verify:
    uses: example/workflows/.github/workflows/validate.yml@main
`;
  const violations = findPolicyViolations('fixture.yml', source);
  assert.ok(violations.some((message) => message.includes('jobs.verify.uses is not pinned')));
});

test('applies the untrusted-input boundary to workflow_run', () => {
  const source = workflow({
    event: 'workflow_run',
    permissions: 'contents: write',
    secret: true,
  }).replace(
    'corepack pnpm install --frozen-lockfile',
    'corepack pnpm install --frozen-lockfile\n      - run: gh release create v1.2.3',
  );
  const violations = findPolicyViolations('fixture.yml', source);
  assert.ok(violations.some((message) => message.includes('grants write')));
  assert.ok(violations.some((message) => message.includes('secrets context')));
  assert.ok(violations.some((message) => message.includes('publishing command')));
});

test('rejects an untrusted workflow environment even without a secret expression', () => {
  const source = workflow().replace(
    '  verify:\n    permissions:',
    '  verify:\n    environment: production-release\n    permissions:',
  );
  const violations = findPolicyViolations('fixture.yml', source);
  assert.ok(violations.some((message) => message.includes('environment is prohibited')));
});

test('rejects an untrusted workflow that keeps checkout credentials', () => {
  const source = workflow().replace('          persist-credentials: false\n', '');
  const violations = findPolicyViolations('fixture.yml', source);
  assert.ok(violations.some((message) => message.includes('persist-credentials: false')));
});

test('rejects repository mutation through gh api in an untrusted workflow', () => {
  const source = workflow().replace(
    'corepack pnpm install --frozen-lockfile',
    'corepack pnpm install --frozen-lockfile\n      - run: gh api --method POST repos/example/example/releases',
  );
  const violations = findPolicyViolations('fixture.yml', source);
  assert.ok(violations.some((message) => message.includes('publishing command')));
});

test('rejects a release action in an untrusted workflow', () => {
  const source = workflow().replace(
    'corepack pnpm install --frozen-lockfile',
    `corepack pnpm install --frozen-lockfile\n      - uses: actions/create-release@${CHECKOUT_SHA}`,
  );
  const violations = findPolicyViolations('fixture.yml', source);
  assert.ok(violations.some((message) => message.includes('publishing command')));
});

test('accepts explicit deny-all permissions for untrusted triggers', () => {
  const source = workflow({ permissions: '{}' }).replace(
    '    permissions:\n      contents: read\n',
    '',
  );
  assert.deepEqual(findPolicyViolations('fixture.yml', source), []);
});

test('handles an empty job body without throwing', () => {
  const source = `
name: Empty job fixture
on:
  pull_request:
permissions: {}
jobs:
  verify:
`;
  assert.deepEqual(findPolicyViolations('fixture.yml', source), []);
});

test('requires the desktop validation script to disable publishing', () => {
  assert.deepEqual(desktopPackagingViolations({
    scripts: { dist: 'electron-builder --publish=never' },
  }), []);
  assert.ok(desktopPackagingViolations({
    scripts: { dist: `electron-builder --publish=${'always'}` },
  }).some((message) => message.includes('--publish=never')));
});

test('rejects direct release entrypoints in the desktop package', () => {
  const violations = desktopPackagingViolations({
    scripts: {
      dist: 'electron-builder --publish=never',
      release: 'electron-builder --publish=never',
    },
  });
  assert.ok(violations.some((message) => message.includes('scripts.release')));
});

test('accepts the checked-in release-specific workflow contract', () => {
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'release.yml');
  const source = fs.readFileSync(workflowPath, 'utf8');
  assert.deepEqual(releaseWorkflowViolations(YAML.parse(source), source), []);
});

const workspacePackagesFixture = new Map([
  ['@loom-media-server/mobile', { directory: 'apps/mobile', scripts: { test: 'node --test', typecheck: 'tsc' } }],
  ['loom-media-server-desktop', { directory: 'apps/desktop', scripts: { dist: 'electron-builder --publish=never' } }],
]);

test('rejects a workspace filter that names no current package', () => {
  const violations = workspaceSelectorViolations(
    'fixture.yml',
    '      - run: pnpm --filter @loomtv/mobile test\n',
    workspacePackagesFixture,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /fixture\.yml:1: --filter @loomtv\/mobile does not resolve to a workspace package/);
});

test('accepts a workspace filter that names a current package and script', () => {
  assert.deepEqual(workspaceSelectorViolations(
    'fixture.yml',
    '      - run: pnpm --filter @loom-media-server/mobile test\n'
    + '      - run: corepack pnpm --filter loom-media-server-desktop run dist\n',
    workspacePackagesFixture,
  ), []);
});

test('rejects a workspace filter that runs a script the package does not declare', () => {
  const violations = workspaceSelectorViolations(
    'fixture.yml',
    '      - run: pnpm --filter @loom-media-server/mobile run verify:tv-release\n',
    workspacePackagesFixture,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /runs "verify:tv-release", which is not a script in that package/);
});

test('ignores pnpm built-in commands and quoted selectors after a filter', () => {
  assert.deepEqual(workspaceSelectorViolations(
    'fixture.yml',
    "      - run: pnpm --filter '@loom-media-server/mobile' exec expo prebuild --clean --no-install\n"
    + '      - run: pnpm --filter=@loom-media-server/mobile install --frozen-lockfile\n',
    workspacePackagesFixture,
  ), []);
});

test('rejects a run-time computed workspace filter', () => {
  const violations = workspaceSelectorViolations(
    'fixture.yml',
    '      - run: pnpm --filter "$PACKAGE" test\n',
    workspacePackagesFixture,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /computed at run time/);
});

test('rejects a workflow that runs a repository script which does not exist', () => {
  const violations = workspaceSelectorViolations(
    'fixture.yml',
    '      - run: node scripts/verify-television-release.cjs\n',
    workspacePackagesFixture,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /node scripts\/verify-television-release\.cjs does not exist/);
});

test('indexes every current workspace package from pnpm-workspace.yaml', () => {
  const packages = workspacePackageIndex();
  for (const name of [
    '@loom-media-server/mobile',
    '@loom-media-server/video-contracts',
    '@loom-media-server/video-migration',
    'loom-media-server-desktop',
    'loom-media-server-headless',
  ]) {
    assert.ok(packages.has(name), `${name} must be indexed as a workspace package`);
  }
});

test('every checked-in workflow selector resolves against the current manifests', () => {
  assert.ok(verifyWorkflowDirectory().length > 0);
});
