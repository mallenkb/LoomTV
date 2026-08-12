#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');

const workspaceRoot = path.resolve(__dirname, '..');

function activeLines(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line));
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function validateDockerfile(source, label = 'deploy/docker/Dockerfile') {
  const failures = [];
  const lines = activeLines(source);
  const active = lines.join('\n');

  const fromLines = lines.filter((line) => /^\s*FROM\s+/i.test(line));
  if (fromLines.length === 0) failures.push(`${label}: expected at least one FROM instruction`);

  for (const line of fromLines) {
    const reference = line.trim().split(/\s+/)[1] || '';
    if (/(?:^|:)latest(?:@|$)/i.test(reference)) {
      failures.push(`${label}: FROM must not use latest (${reference})`);
    }
    if (!/@sha256:[a-f0-9]{64}$/i.test(reference)) {
      failures.push(`${label}: FROM must use a literal immutable sha256 digest (${reference})`);
    } else if (!/^[^@\s]+:[^@\s]+@sha256:/i.test(reference)) {
      failures.push(`${label}: pinned FROM must retain a readable version tag (${reference})`);
    }
  }

  const snapshotTimestamps = [];
  for (const archive of ['debian', 'debian-security']) {
    const match = active.match(new RegExp(`snapshot\\.debian\\.org/archive/${archive}/(\\d{8}T\\d{6}Z)/`));
    if (!match) {
      failures.push(`${label}: apt sources must use the ${archive} Debian snapshot`);
    } else {
      snapshotTimestamps.push(match[1]);
    }
  }
  if (new Set(snapshotTimestamps).size > 1) {
    failures.push(`${label}: Debian and Debian security sources must use the same snapshot timestamp`);
  }
  const aptUris = [...active.matchAll(/["']URIs:\s+([^"'\s]+)["']/g)].map((match) => match[1]);
  if (aptUris.length !== 2 || aptUris.some((uri) => !/^http:\/\/snapshot\.debian\.org\/archive\/debian(?:-security)?\/\d{8}T\d{6}Z\/$/.test(uri))) {
    failures.push(`${label}: apt must use only the two pinned Debian snapshot sources`);
  }
  if (/https?:\/\/(?:deb|security|ftp)\.debian\.org\//i.test(active)) {
    failures.push(`${label}: apt sources must not include a mutable Debian mirror`);
  }
  if (!/rm\s+-f\s+\/etc\/apt\/sources\.list\s+\/etc\/apt\/sources\.list\.d\/\*/.test(active)) {
    failures.push(`${label}: inherited apt sources must be cleared before configuring snapshots`);
  }
  if (!/Acquire::Check-Valid-Until\s+["]false["]/.test(active)) {
    failures.push(`${label}: historical Debian snapshots must disable Check-Valid-Until explicitly`);
  }
  if (!/apt-get\s+install\s+--no-install-recommends\s+--yes\b/.test(active)) {
    failures.push(`${label}: apt installs must remain non-interactive and exclude recommends`);
  }

  const users = lines
    .map((line) => line.match(/^\s*USER\s+(.+?)\s*$/i)?.[1])
    .filter(Boolean);
  const finalUser = users.at(-1) || '';
  const userId = finalUser.split(':', 1)[0];
  const userArg = userId.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
  const userArgDefault = userArg
    ? source.match(new RegExp(`^\\s*ARG\\s+${userArg}=([^\\s]+)\\s*$`, 'mi'))?.[1]
    : undefined;
  if (!finalUser
    || /^(?:root|0)$/.test(userId)
    || (userArg && (!userArgDefault || /^(?:root|0)$/.test(userArgDefault)))) {
    failures.push(`${label}: final runtime USER must be explicitly non-root`);
  }

  return failures;
}

function validateCompose(source, label = 'deploy/docker/compose.yaml') {
  const failures = [];
  let compose;
  try {
    compose = parse(source);
  } catch {
    return [`${label}: compose file must be valid YAML`];
  }
  const service = compose?.services?.loomtv;
  if (!service || typeof service !== 'object') {
    return [`${label}: expected a loomtv service`];
  }
  const image = typeof service.image === 'string' ? service.image.trim() : '';

  if (!image) {
    failures.push(`${label}: loomtv must declare an image reference`);
  } else {
    if (/(?:^|:)latest(?:@|$)/i.test(image)) {
      failures.push(`${label}: image must not use latest (${image})`);
    }
    if (!/@sha256:[a-f0-9]{64}$/i.test(image) && !/:v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/i.test(image)) {
      failures.push(`${label}: image must use an immutable digest or explicit release version (${image})`);
    }
  }

  const user = unquote(String(service.user ?? ''));
  const userId = user.match(/^(\$\{[^}]+\}|[^:]+)/)?.[1] || '';
  const variableDefault = userId.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]+)\}$/)?.[1];
  if (!user
    || /^(?:root|0)$/.test(userId)
    || (userId.startsWith('${') && (!variableDefault || /^(?:root|0)$/.test(variableDefault)))) {
    failures.push(`${label}: loomtv service must run as an explicitly non-root user`);
  }
  if (!Array.isArray(service.cap_drop) || !service.cap_drop.includes('ALL')) {
    failures.push(`${label}: loomtv service must drop ALL capabilities`);
  }
  if (Object.hasOwn(service, 'cap_add')) {
    failures.push(`${label}: loomtv service must not add Linux capabilities`);
  }
  if (Object.hasOwn(service, 'privileged')) {
    failures.push(`${label}: loomtv service must not run privileged`);
  }
  if (Object.hasOwn(service, 'entrypoint')) {
    failures.push(`${label}: loomtv service must not override the fail-closed image entrypoint`);
  }
  if (!Array.isArray(service.security_opt) || !service.security_opt.includes('no-new-privileges:true')) {
    failures.push(`${label}: loomtv service must enable no-new-privileges`);
  }
  const mediaReadOnly = Array.isArray(service.volumes) && service.volumes.some((volume) => (
    (typeof volume === 'string' && volume.endsWith(':/media:ro'))
    || (volume && typeof volume === 'object' && volume.target === '/media' && volume.read_only === true)
  ));
  if (!mediaReadOnly) {
    failures.push(`${label}: /media must remain a read-only bind mount`);
  }

  return failures;
}

function validateEntrypoint(source, label = 'deploy/docker/entrypoint.sh') {
  const active = activeLines(source).join('\n');
  const rejectsRootIdentity = /if\s+\[\s*"\$\(id -u\)"\s+-eq\s+0\s*\]\s*\|\|\s*\[\s*"\$\(id -g\)"\s+-eq\s+0\s*\]\s*;\s*then[\s\S]*?exit\s+[1-9][0-9]*[\s\S]*?fi/.test(active);
  return rejectsRootIdentity
    ? []
    : [`${label}: entrypoint must refuse a root runtime UID or GID`];
}

function validateWorkspace(root = workspaceRoot) {
  const dockerfilePath = path.join(root, 'deploy', 'docker', 'Dockerfile');
  const composePath = path.join(root, 'deploy', 'docker', 'compose.yaml');
  const entrypointPath = path.join(root, 'deploy', 'docker', 'entrypoint.sh');
  return [
    ...validateDockerfile(fs.readFileSync(dockerfilePath, 'utf8')),
    ...validateCompose(fs.readFileSync(composePath, 'utf8')),
    ...validateEntrypoint(fs.readFileSync(entrypointPath, 'utf8')),
  ];
}

if (require.main === module) {
  const failures = validateWorkspace();
  if (failures.length > 0) {
    console.error('Container policy validation failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('Container inputs and runtime restrictions match the fail-closed policy.');
  }
}

module.exports = { validateCompose, validateDockerfile, validateEntrypoint, validateWorkspace };
