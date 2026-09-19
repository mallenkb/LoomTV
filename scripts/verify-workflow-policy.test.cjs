const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { spawnSync } = require('node:child_process');
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

test('release preparation requires the latest trusted push validation for the exact release commit', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const jobs = YAML.parse(source).jobs;
  const steps = jobs.prepare.steps;
  const gateIndex = steps.findIndex((step) => step.name === 'Require successful validation of release commit');
  const gate = steps[gateIndex];
  assert.ok(gateIndex > steps.findIndex((step) => step.id === 'release-target'));
  assert.equal(jobs.prepare.permissions.actions, 'read');
  assert.equal(jobs.make.needs, 'prepare');
  assert.ok(jobs['publish-release'].needs.includes('prepare'));
  assert.equal(gate.env.RELEASE_SHA, '${{ steps.release-target.outputs.release_sha }}');
  assert.equal(gate.env.GH_TOKEN, '${{ github.token }}');
  assert.match(gate.run, /--workflow validate\.yml/);
  assert.match(gate.run, /--commit "\$RELEASE_SHA"/);
  assert.match(gate.run, /--event push/);
  assert.match(gate.run, /--branch main/);
  assert.match(gate.run, /--limit 1/);
  assert.doesNotMatch(gate.run, /--status/);

  const success = {
    status: 'completed', conclusion: 'success', event: 'push',
    headBranch: 'main', headSha: 'a'.repeat(40),
  };
  const cases = [
    [JSON.stringify([success]), 0, true],
    ...['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', null].map((conclusion) => (
      [JSON.stringify([{ ...success, conclusion }]), 0, false]
    )),
    ...['queued', 'pending', 'in_progress', 'waiting', 'requested'].map((status) => (
      [JSON.stringify([{ ...success, status }]), 0, false]
    )),
    [JSON.stringify([{ ...success, event: 'pull_request' }]), 0, false],
    [JSON.stringify([{ ...success, headBranch: 'untrusted' }]), 0, false],
    [JSON.stringify([{ ...success, headSha: 'b'.repeat(40) }]), 0, false],
    [JSON.stringify([success]), 1, false],
    ['[]', 0, false], ['{}', 0, false], ['invalid', 0, false], ['', 0, false],
  ];
  for (const [result, code, allowed] of cases) {
    const script = 'gh() { printf "%s\\n" "$MOCK_RESULT"; return "$MOCK_CODE"; }\nsleep() { :; }\n' + gate.run;
    const run = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'example/repo',
        RELEASE_SHA: success.headSha,
        MOCK_RESULT: result,
        MOCK_CODE: String(code),
      },
      encoding: 'utf8',
    });
    assert.ifError(run.error);
    assert.equal(run.status === 0, allowed, `${result}/${code}: ${run.stderr}`);
  }
});

test('release validation rejects a newer pending run despite an older successful run', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const gate = YAML.parse(source).jobs.prepare.steps.find((step) => step.name === 'Require successful validation of release commit');
  const success = {
    status: 'completed', conclusion: 'success', event: 'push',
    headBranch: 'main', headSha: 'a'.repeat(40),
  };
  const mock = `gh() {
    [[ "$*" == "run list --repo example/repo --workflow validate.yml --commit $RELEASE_SHA --event push --branch main --limit 1 --json status,conclusion,event,headBranch,headSha" ]] || return 2
    jq '.[0:1]' <<< "$MOCK_RUNS"
  }
  sleep() { :; }
`;
  for (const status of ['queued', 'pending', 'in_progress', 'waiting', 'requested', 'completed']) {
    const runs = [{ ...success, status, conclusion: status === 'completed' ? 'success' : null }, success];
    const run = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', mock + gate.run], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'example/repo',
        RELEASE_SHA: success.headSha,
        MOCK_RUNS: JSON.stringify(runs),
      },
      encoding: 'utf8',
    });
    assert.ifError(run.error);
    assert.equal(run.status, status === 'completed' ? 0 : 1, `${status}: ${run.stderr}`);
    if (status !== 'completed') {
      assert.match(run.stderr, /Latest Validate push run on main|Timed out waiting/);
    }
  }
});

test('Rust validation installs the repository toolchain and covers both workspaces', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'validate.yml'), 'utf8');
  const rust = YAML.parse(source).jobs.rust;
  assert.equal(rust['runs-on'], 'ubuntu-latest');
  assert.deepEqual(rust.permissions, { contents: 'read' });
  const steps = rust.steps;
  const installIndex = steps.findIndex((step) => step.name === 'Install repository Rust toolchain');
  const install = steps[installIndex].run;
  assert.match(install, /with open\("rust-toolchain\.toml", "rb"\)/);
  assert.match(install, /tomllib\.load\(file\)\["toolchain"\]/);
  assert.match(install, /\["rustup", "toolchain", "install", toolchain\["channel"\], "--profile", toolchain\.get\("profile", "minimal"\)\]/);
  assert.match(install, /command\.extend\(\["--component", component\]\)/);
  assert.match(install, /command\.extend\(\["--target", target\]\)/);
  assert.match(install, /subprocess\.run\(command, check=True\)/);
  const cacheIndex = steps.findIndex((step) => step.uses?.startsWith('Swatinem/rust-cache@'));
  assert.ok(installIndex >= 0 && cacheIndex > installIndex);
  assert.match(steps[cacheIndex].uses, /@[0-9a-f]{40}$/);
  assert.deepEqual(steps[cacheIndex].with.workspaces.trim().split('\n'), [
    '. -> target', 'apps/desktop/native/scanner -> target',
  ]);
  const dependenciesIndex = steps.findIndex((step) => step.name === 'Install Linux Rust dependencies');
  const dependencies = steps[dependenciesIndex].run;
  for (const dependency of ['build-essential', 'pkg-config', 'libssl-dev', 'libdbus-1-dev', 'libgtk-3-dev', 'libxdo-dev', 'libwebkit2gtk-4.1-dev', 'libayatana-appindicator3-dev', 'librsvg2-dev', 'patchelf']) {
    assert.ok(dependencies.split(/\s+/).includes(dependency), dependency);
  }
  const tests = steps.filter((step) => step.run?.startsWith('cargo test'));
  assert.deepEqual(tests.map((step) => [step['working-directory'], step.run]), [
    ['crates/loomtv-core', 'cargo test --locked -p loomtv-core'],
    ['crates/loomtv-playback', 'cargo test --locked -p loomtv-playback'],
    ['apps/desktop-tauri/src-tauri', 'cargo test --locked -p loomtv-desktop-tauri'],
    ['apps/desktop/native/scanner', 'cargo test --locked -p loom-scanner'],
  ]);
  for (const step of tests) {
    assert.ok(steps.indexOf(step) > dependenciesIndex);
    assert.equal(step['continue-on-error'], undefined);
  }
  const auditInstallIndex = steps.findIndex((step) => step.run === 'cargo install cargo-audit --version 0.22.2 --locked');
  const auditIndex = steps.findIndex((step) => step.name === 'Audit both Rust workspaces');
  assert.ok(auditInstallIndex >= 0 && auditIndex > auditInstallIndex);
  const audit = steps[auditIndex];
  assert.equal(audit['continue-on-error'], undefined);
  for (const failedLock of ['', 'Cargo.lock', 'apps/desktop/native/scanner/Cargo.lock']) {
    const mock = `cargo() {
      printf '%s\\n' "$*"
      [[ "$1" == audit && "$2" == --file && "$#" == 3 ]] || return 2
      [[ "$3" != "$FAILED_LOCK" ]]
    }\n`;
    const run = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', mock + audit.run], {
      env: { ...process.env, FAILED_LOCK: failedLock },
      encoding: 'utf8',
    });
    assert.ifError(run.error);
    assert.equal(run.status, failedLock ? 1 : 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split('\n'), [
      'audit --file Cargo.lock', 'audit --file apps/desktop/native/scanner/Cargo.lock',
    ]);
  }
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
