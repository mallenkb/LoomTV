#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateCompose,
  validateDockerfile,
  validateEntrypoint,
  validateWorkspace,
} = require('./verify-container-policy.cjs');

const workspaceRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixtures', 'container-policy-negative.json');
const sources = {
  compose: fs.readFileSync(path.join(workspaceRoot, 'deploy', 'docker', 'compose.yaml'), 'utf8'),
  dockerfile: fs.readFileSync(path.join(workspaceRoot, 'deploy', 'docker', 'Dockerfile'), 'utf8'),
  entrypoint: fs.readFileSync(path.join(workspaceRoot, 'deploy', 'docker', 'entrypoint.sh'), 'utf8'),
};
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

assert.deepEqual(validateWorkspace(workspaceRoot), [], 'tracked container policy must pass');

for (const fixture of fixtures) {
  const source = sources[fixture.target];
  assert.equal(typeof source, 'string', `${fixture.name}: unknown target ${fixture.target}`);
  assert.ok(source.includes(fixture.find), `${fixture.name}: fixture input no longer matches tracked source`);
  const mutated = source.replace(fixture.find, fixture.replace);
  const failures = fixture.target === 'compose'
    ? validateCompose(mutated, fixture.name)
    : fixture.target === 'dockerfile'
      ? validateDockerfile(mutated, fixture.name)
      : validateEntrypoint(mutated, fixture.name);
  assert.ok(
    failures.some((failure) => failure.includes(fixture.expected)),
    `${fixture.name}: expected a failure containing ${JSON.stringify(fixture.expected)}, received ${JSON.stringify(failures)}`,
  );
}

const decoyService = sources.compose
  .replace('    user: "${PUID:-1000}:${PGID:-1000}"', '    user: root')
  .concat('\n  decoy:\n    image: decoy:1.2.3\n    user: "1000:1000"\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n    volumes: ["./media:/media:ro"]\n');
assert.ok(
  validateCompose(decoyService, 'service scoping').some((failure) => failure.includes('explicitly non-root user')),
  'a hardened sibling service must not mask an unsafe loomtv service',
);

for (const [find, replacement, expected] of [
  ['REQUIRE_SECURE_TRANSPORT: "true"', 'REQUIRE_SECURE_TRANSPORT: "false"', 'require secure transport'],
  ['${TRUSTED_PROXIES:?Set TRUSTED_PROXIES to the exact TLS proxy peer IP or CIDR seen by the container}', '0.0.0.0/0', 'explicit trusted proxy allowlist'],
  ['127.0.0.1:${LOOMTV_PORT:-3847}:3847', '${LOOMTV_PORT:-3847}:3847', 'only on host loopback'],
]) {
  assert.ok(sources.compose.includes(find));
  assert.ok(validateCompose(sources.compose.replace(find, replacement)).some((failure) => failure.includes(expected)));
}

for (const directory of ['video-contracts', 'media-core', 'runtime-paths', 'transcode-capabilities']) {
  for (const entry of ['package.json', 'src']) {
    assert.ok(sources.dockerfile.includes(`COPY packages/${directory}/${entry} packages/${directory}/${entry}`));
  }
}

const workflow = require('yaml').parse(fs.readFileSync(path.join(workspaceRoot, '.github/workflows/validate.yml'), 'utf8'));
const containerSteps = workflow.jobs.container.steps;
assert.ok(containerSteps.some((step) => step.run?.includes('docker build --file deploy/docker/Dockerfile')));
const smoke = containerSteps.find((step) => step.run?.includes('docker run'))?.run;
assert.ok(smoke?.includes('--env HOST=127.0.0.1'));
assert.ok(smoke?.includes('.State.Health.Status'));
assert.ok(smoke?.includes('docker rm --force loomtv-ci'));
assert.ok(smoke?.trim().endsWith('exit 1'));

console.log(`Container policy rejected ${fixtures.length} focused negative fixtures.`);
