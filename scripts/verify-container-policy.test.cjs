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

console.log(`Container policy rejected ${fixtures.length} focused negative fixtures.`);
