#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseReleaseTag } = require('./release-identity.cjs');

const MANIFEST_NAME = 'release-manifest.json';
const CHECKSUMS_NAME = 'SHA256SUMS';
const ATTESTATION_PREDICATE = 'https://slsa.dev/provenance/v1';
const EVIDENCE_NAMES = new Set([MANIFEST_NAME, CHECKSUMS_NAME]);

// This is the production release contract.  Keep this list in lockstep with
// apps/desktop/package.json so a new platform or architecture cannot silently
// enter the updater feed without changing the manifest contract.
const TARGET_MATRIX = Object.freeze([
  Object.freeze({
    id: 'mac-arm64',
    platform: 'macOS',
    arch: 'arm64',
    stem: 'mac-arm64',
    installerExtensions: Object.freeze(['dmg', 'zip']),
    updaterMetadata: 'latest-mac.yml',
    updaterExtensions: Object.freeze(['zip']),
  }),
  Object.freeze({
    id: 'mac-x64',
    platform: 'macOS',
    arch: 'x64',
    stem: 'mac-x64',
    installerExtensions: Object.freeze(['dmg', 'zip']),
    updaterMetadata: 'latest-mac.yml',
    updaterExtensions: Object.freeze(['zip']),
  }),
  Object.freeze({
    id: 'win-x64',
    platform: 'Windows',
    arch: 'x64',
    stem: 'win-x64',
    installerExtensions: Object.freeze(['exe']),
    updaterMetadata: 'latest.yml',
    updaterExtensions: Object.freeze(['exe']),
  }),
  Object.freeze({
    id: 'linux-x64',
    platform: 'Linux',
    arch: 'x64',
    stem: 'linux-x64',
    installerExtensions: Object.freeze(['deb', 'rpm', 'AppImage']),
    updaterMetadata: 'latest-linux.yml',
    updaterExtensions: Object.freeze(['AppImage']),
  }),
]);

function parseArguments(argv) {
  const values = { verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--verify') {
      values.verify = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function requiredArgument(values, name) {
  if (typeof values[name] !== 'string' || !values[name].trim()) {
    throw new Error(`Missing required argument --${name}.`);
  }
  return values[name];
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function collectFiles(rootPath) {
  const files = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Release evidence must not contain symbolic links: ${candidate}`);
      }
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
      else throw new Error(`Release evidence contains an unsupported file type: ${candidate}`);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function relativePath(rootPath, filePath) {
  const relative = path.relative(rootPath, filePath).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || relative.includes('/../') || path.isAbsolute(relative)) {
    throw new Error(`Release evidence file escapes its root: ${filePath}`);
  }
  return relative;
}

function isReleaseArtifact(name) {
  return /^LoomTV-[^/]+\.(?:dmg|zip|exe|deb|rpm|AppImage|blockmap)$/i.test(name)
    || /^latest[^/]*\.(?:yml|yaml)$/i.test(name);
}

function artifactKind(name) {
  if (/\.dmg$/i.test(name)) return 'macOS-dmg';
  if (/\.zip$/i.test(name)) return 'macOS-zip';
  if (/\.exe$/i.test(name)) return 'windows-installer';
  if (/\.deb$/i.test(name)) return 'linux-deb';
  if (/\.rpm$/i.test(name)) return 'linux-rpm';
  if (/\.AppImage$/i.test(name)) return 'linux-appimage';
  if (/\.blockmap$/i.test(name)) return 'updater-blockmap';
  return 'updater-metadata';
}

function expectedTargetMatrix(version) {
  return TARGET_MATRIX.map((target) => ({
    id: target.id,
    platform: target.platform,
    arch: target.arch,
    artifacts: target.installerExtensions.map((extension) => `LoomTV-${version}-${target.stem}.${extension}`),
    updaterMetadata: target.updaterMetadata,
  }));
}

function expectedUpdaterCoverage(version) {
  return [...new Set(TARGET_MATRIX.map((target) => target.updaterMetadata))].map((metadata) => {
    const targets = TARGET_MATRIX.filter((target) => target.updaterMetadata === metadata);
    return {
      metadata,
      targetIds: targets.map((target) => target.id),
      requiredAssets: [...new Set(targets.flatMap((target) => target.updaterExtensions
        .map((extension) => `LoomTV-${version}-${target.stem}.${extension}`)))],
    };
  });
}

function metadataTarget(metadataName) {
  const targets = TARGET_MATRIX.filter((target) => target.updaterMetadata === metadataName);
  if (targets.length === 0) return undefined;
  return {
    metadata: metadataName,
    targetIds: targets.map((target) => target.id),
  };
}

function artifactDescriptor(name, version) {
  for (const target of TARGET_MATRIX) {
    for (const extension of target.installerExtensions) {
      const artifactName = `LoomTV-${version}-${target.stem}.${extension}`;
      if (name === artifactName) {
        return {
          targetId: target.id,
          platform: target.platform,
          arch: target.arch,
          extension,
          blockmap: false,
        };
      }
      if (name === `${artifactName}.blockmap`) {
        return {
          targetId: target.id,
          platform: target.platform,
          arch: target.arch,
          extension,
          blockmap: true,
        };
      }
    }
  }
  return undefined;
}

function assetMap(files, rootPath) {
  const map = new Map();
  for (const filePath of files) {
    const name = path.basename(filePath);
    if (map.has(name)) {
      throw new Error(`Release assets must have unique names; found more than one ${name}.`);
    }
    map.set(name, {
      filePath,
      name,
      path: relativePath(rootPath, filePath),
    });
  }
  return map;
}

function updaterReferences(source) {
  return [...source.matchAll(/^\s*(?:url|path):\s*["']?([^"'\s]+)["']?\s*$/gim)]
    .map((match) => match[1]);
}

function validateArtifactSet(assetEntries, version) {
  const failures = [];
  const names = new Set(assetEntries.map((entry) => entry.name));
  const assetNames = assetEntries
    .filter((entry) => isReleaseArtifact(entry.name))
    .map((entry) => entry.name);
  const expectedMatrix = expectedTargetMatrix(version);
  const requiredArtifacts = expectedMatrix.flatMap((target) => target.artifacts);

  for (const name of requiredArtifacts) {
    if (!names.has(name)) failures.push(`Required ${name} release target is missing.`);
  }

  for (const name of assetNames) {
    if (/^latest/i.test(name)) {
      if (!expectedUpdaterCoverage(version).some((coverage) => coverage.metadata === name)) {
        failures.push(`Unsupported updater metadata is present: ${name}.`);
      }
      continue;
    }
    if (!artifactDescriptor(name, version)) {
      failures.push(`Unsupported or stale release artifact name: ${name}.`);
    }
  }

  for (const coverage of expectedUpdaterCoverage(version)) {
    const entry = assetEntries.find((candidate) => candidate.name === coverage.metadata);
    if (!entry?.filePath || !fs.existsSync(entry.filePath)) {
      failures.push(`${coverage.metadata} updater metadata is missing.`);
      continue;
    }
    const source = fs.readFileSync(entry.filePath, 'utf8');
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const versionLine = new RegExp(`^version:\\s*${escapedVersion}\\s*$`, 'mi');
    if (!versionLine.test(source)) {
      failures.push(`${entry.name} does not identify updater version ${version}.`);
    }
    const references = updaterReferences(source);
    if (references.length === 0) failures.push(`${entry.name} does not reference an installer asset.`);
    const allowedReferences = new Set([
      ...coverage.requiredAssets,
      ...coverage.requiredAssets.map((name) => `${name}.blockmap`),
    ]);
    for (const reference of references) {
      if (!names.has(reference)) failures.push(`${entry.name} references missing asset ${reference}.`);
      if (!allowedReferences.has(reference)) {
        failures.push(`${entry.name} references asset outside its exact target coverage: ${reference}.`);
      }
      if (!artifactDescriptor(reference, version)) {
        failures.push(`${entry.name} references stale or unsupported asset ${reference}.`);
      }
    }
    for (const requiredAsset of coverage.requiredAssets) {
      if (!references.includes(requiredAsset)) {
        failures.push(`${entry.name} does not cover required updater asset ${requiredAsset}.`);
      }
    }
  }

  return failures;
}

function validateManifestPolicy(manifest, version) {
  const failures = [];
  if (JSON.stringify(manifest.targetMatrix) !== JSON.stringify(expectedTargetMatrix(version))) {
    failures.push('Release manifest targetMatrix does not equal the exact production platform/architecture matrix.');
  }
  if (JSON.stringify(manifest.updaterCoverage) !== JSON.stringify(expectedUpdaterCoverage(version))) {
    failures.push('Release manifest updaterCoverage does not equal the exact updater target coverage.');
  }
  const expectedEvidence = {
    checksums: CHECKSUMS_NAME,
    attestations: {
      provider: 'GitHub artifact attestations',
      predicateType: ATTESTATION_PREDICATE,
    },
  };
  if (JSON.stringify(manifest.evidence) !== JSON.stringify(expectedEvidence)) {
    failures.push('Release manifest evidence must point to checksums and GitHub/SLSA attestations.');
  }
  return failures;
}

function releaseAssets(rootPath) {
  if (!fs.existsSync(rootPath)) throw new Error(`Release asset directory does not exist: ${rootPath}`);
  const files = collectFiles(rootPath);
  const map = assetMap(files, rootPath);
  const unknown = [...map.values()].filter((entry) => !isReleaseArtifact(entry.name) && !EVIDENCE_NAMES.has(entry.name));
  if (unknown.length > 0) {
    throw new Error(`Release asset directory contains unexpected files: ${unknown.map((entry) => entry.name).join(', ')}`);
  }
  const entries = [...map.values()].filter((entry) => isReleaseArtifact(entry.name));
  if (entries.length === 0) throw new Error('No release artifacts were downloaded.');
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function writeJson(filePath, value) {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, source, 'utf8');
  return source;
}

function createEvidence(values) {
  const rootPath = path.resolve(requiredArgument(values, 'assets'));
  const { tag, version } = parseReleaseTag(requiredArgument(values, 'tag'));
  const commit = requiredArgument(values, 'sha');
  const tagObject = requiredArgument(values, 'tag-oid');
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Release commit must be a full SHA: ${commit}`);
  if (!/^[0-9a-f]{40}$/i.test(tagObject)) throw new Error(`Release tag object must be a full SHA: ${tagObject}`);

  const entries = releaseAssets(rootPath);
  const failures = validateArtifactSet(entries, version);
  if (failures.length > 0) throw new Error(`Release artifact validation failed:\n- ${failures.join('\n- ')}`);

  const manifest = {
    manifestVersion: 2,
    release: {
      tag,
      version,
      commit,
      tagObject,
    },
    targetMatrix: expectedTargetMatrix(version),
    updaterCoverage: expectedUpdaterCoverage(version),
    assets: entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      kind: artifactKind(entry.name),
      target: artifactDescriptor(entry.name, version) || metadataTarget(entry.name),
      size: fs.statSync(entry.filePath).size,
      sha256: sha256File(entry.filePath),
    })),
    evidence: {
      checksums: CHECKSUMS_NAME,
      attestations: {
        provider: 'GitHub artifact attestations',
        predicateType: ATTESTATION_PREDICATE,
      },
    },
  };
  writeJson(path.join(rootPath, MANIFEST_NAME), manifest);

  const checksumEntries = [...entries, {
    filePath: path.join(rootPath, MANIFEST_NAME),
    name: MANIFEST_NAME,
  }].sort((left, right) => left.name.localeCompare(right.name));
  const checksums = `${checksumEntries.map((entry) => `${sha256File(entry.filePath)}  ${entry.name}`).join('\n')}\n`;
  fs.writeFileSync(path.join(rootPath, CHECKSUMS_NAME), checksums, 'utf8');
  console.log(`Prepared ${entries.length} release assets plus checksums, manifest, and GitHub/SLSA attestation requirements.`);
}

function resolveNamedFile(fileMap, rootPath, manifestEntry) {
  if (!manifestEntry || typeof manifestEntry.name !== 'string' || typeof manifestEntry.path !== 'string') {
    return undefined;
  }
  const direct = path.resolve(rootPath, manifestEntry.path);
  const relative = path.relative(rootPath, direct);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.basename(direct) !== manifestEntry.name) {
    return undefined;
  }
  if (fs.existsSync(direct)) return direct;
  return fileMap.get(manifestEntry.name)?.filePath;
}

function verifyEvidence(values) {
  const rootPath = path.resolve(requiredArgument(values, 'assets'));
  const { tag, version } = parseReleaseTag(requiredArgument(values, 'tag'));
  const commit = requiredArgument(values, 'sha');
  const tagObject = requiredArgument(values, 'tag-oid');
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Release commit must be a full SHA: ${commit}`);
  if (!/^[0-9a-f]{40}$/i.test(tagObject)) throw new Error(`Release tag object must be a full SHA: ${tagObject}`);
  const files = collectFiles(rootPath);
  const map = assetMap(files, rootPath);
  const manifestPath = path.join(rootPath, MANIFEST_NAME);
  const checksumsPath = path.join(rootPath, CHECKSUMS_NAME);
  for (const filePath of [manifestPath, checksumsPath]) {
    if (!fs.existsSync(filePath)) throw new Error(`Missing release evidence file: ${path.basename(filePath)}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Release manifest JSON is invalid: ${String(error)}`);
  }
  if (manifest.manifestVersion !== 2) throw new Error('Unsupported release manifest version.');
  if (manifest.release?.tag !== tag
    || manifest.release?.version !== version
    || manifest.release?.commit !== commit
    || manifest.release?.tagObject !== tagObject) {
    throw new Error('Release manifest identity does not match the protected release ref.');
  }
  const manifestPolicyFailures = validateManifestPolicy(manifest, version);
  if (manifestPolicyFailures.length > 0) {
    throw new Error(`Release manifest policy validation failed:\n- ${manifestPolicyFailures.join('\n- ')}`);
  }

  const manifestEntries = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (manifestEntries.length === 0) throw new Error('Release manifest contains no assets.');
  const manifestFailures = validateArtifactSet(manifestEntries.map((entry) => ({
    ...entry,
    filePath: resolveNamedFile(map, rootPath, entry),
  })), version);
  if (manifestFailures.length > 0) {
    throw new Error(`Release manifest validation failed:\n- ${manifestFailures.join('\n- ')}`);
  }

  for (const entry of manifestEntries) {
    const expectedTarget = artifactDescriptor(entry.name, version) || metadataTarget(entry.name);
    if (JSON.stringify(entry.target) !== JSON.stringify(expectedTarget)) {
      throw new Error(`Release manifest target identity mismatch for ${entry.name}.`);
    }
  }

  const expectedNames = new Set([...manifestEntries.map((entry) => entry.name), MANIFEST_NAME, CHECKSUMS_NAME]);
  const actualNames = new Set(map.keys());
  for (const name of expectedNames) if (!actualNames.has(name)) throw new Error(`Release evidence is missing ${name}.`);
  for (const name of actualNames) if (!expectedNames.has(name)) throw new Error(`Release evidence contains unexpected file ${name}.`);

  for (const entry of manifestEntries) {
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error(`Invalid SHA-256 in release manifest for ${entry.name}.`);
    }
    const filePath = resolveNamedFile(map, rootPath, entry);
    if (!filePath) throw new Error(`Release manifest references missing asset ${entry.name}.`);
    const stat = fs.statSync(filePath);
    if (stat.size !== entry.size || sha256File(filePath).toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new Error(`Release manifest checksum or size mismatch for ${entry.name}.`);
    }
  }

  const checksumLines = fs.readFileSync(checksumsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/i);
    if (!match || checksums.has(match[2])) throw new Error(`Invalid or duplicate checksum line: ${line}`);
    checksums.set(match[2], match[1].toLowerCase());
  }
  const checksumNames = new Set([...actualNames].filter((name) => name !== CHECKSUMS_NAME));
  if (checksums.size !== checksumNames.size || [...checksumNames].some((name) => !checksums.has(name))) {
    throw new Error('SHA256SUMS does not cover exactly every release asset and evidence file.');
  }
  for (const [name, expected] of checksums) {
    if (sha256File(map.get(name).filePath).toLowerCase() !== expected) {
      throw new Error(`SHA256SUMS mismatch for ${name}.`);
    }
  }
  console.log(`Verified ${manifestEntries.length} release assets, checksums, exact target matrix, and GitHub/SLSA subjects.`);
}

if (require.main === module) {
  try {
    const values = parseArguments(process.argv.slice(2));
    if (values.verify) verifyEvidence(values);
    else createEvidence(values);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  ATTESTATION_PREDICATE,
  CHECKSUMS_NAME,
  createEvidence,
  EVIDENCE_NAMES,
  MANIFEST_NAME,
  TARGET_MATRIX,
  artifactDescriptor,
  expectedTargetMatrix,
  expectedUpdaterCoverage,
  isReleaseArtifact,
  validateArtifactSet,
  validateManifestPolicy,
  verifyEvidence,
};
