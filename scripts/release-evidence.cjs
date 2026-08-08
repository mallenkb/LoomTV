#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseReleaseTag } = require('./release-identity.cjs');

const MANIFEST_NAME = 'release-manifest.json';
const PROVENANCE_NAME = 'release-provenance.json';
const CHECKSUMS_NAME = 'SHA256SUMS';
const EVIDENCE_NAMES = new Set([MANIFEST_NAME, PROVENANCE_NAME, CHECKSUMS_NAME]);

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

  if (!assetNames.some((name) => /\.dmg$/i.test(name))) failures.push('macOS DMG is missing.');
  if (!assetNames.some((name) => /\.zip$/i.test(name))) failures.push('macOS ZIP is missing.');
  if (!assetNames.some((name) => /\.exe$/i.test(name))) failures.push('Windows installer is missing.');
  if (!assetNames.some((name) => /\.deb$/i.test(name))) failures.push('Linux DEB package is missing.');
  if (!assetNames.some((name) => /\.rpm$/i.test(name))) failures.push('Linux RPM package is missing.');
  if (!assetNames.some((name) => /\.AppImage$/i.test(name))) failures.push('Linux AppImage is missing.');
  for (const metadataName of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']) {
    if (!names.has(metadataName)) failures.push(`${metadataName} updater metadata is missing.`);
  }

  for (const name of assetNames) {
    if (!/^latest/i.test(name) && !name.includes(`-${version}-`)) {
      failures.push(`Release artifact ${name} does not carry release version ${version}.`);
    }
  }

  for (const entry of assetEntries.filter((candidate) => /^latest/i.test(candidate.name))) {
    if (!entry.filePath || !fs.existsSync(entry.filePath)) {
      failures.push(`${entry.name} is missing from the release asset directory.`);
      continue;
    }
    const source = fs.readFileSync(entry.filePath, 'utf8');
    const versionLine = new RegExp(`^version:\\s*${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi');
    if (!versionLine.test(source)) {
      failures.push(`${entry.name} does not identify updater version ${version}.`);
    }
    const references = updaterReferences(source);
    if (references.length === 0) failures.push(`${entry.name} does not reference an installer asset.`);
    for (const reference of references) {
      if (!names.has(reference)) failures.push(`${entry.name} references missing asset ${reference}.`);
      if (!reference.includes(`-${version}-`)) failures.push(`${entry.name} references stale asset ${reference}.`);
    }
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
    manifestVersion: 1,
    release: {
      tag,
      version,
      commit,
      tagObject,
    },
    assets: entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      kind: artifactKind(entry.name),
      size: fs.statSync(entry.filePath).size,
      sha256: sha256File(entry.filePath),
    })),
    evidence: {
      checksums: CHECKSUMS_NAME,
      provenance: PROVENANCE_NAME,
    },
  };
  const manifestSource = writeJson(path.join(rootPath, MANIFEST_NAME), manifest);
  const provenance = {
    provenanceVersion: 1,
    release: {
      tag,
      version,
      commit,
      tagObject,
      ref: `refs/tags/${tag}`,
    },
    source: {
      repository: process.env.GITHUB_REPOSITORY || 'mallenkb/LoomTV',
      workflow: process.env.GITHUB_WORKFLOW || 'Release',
      runId: process.env.GITHUB_RUN_ID || 'local',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || 'local',
    },
    builder: {
      node: process.version,
      packageManager: 'pnpm@11.20.0',
      runner: process.env.RUNNER_OS || process.platform,
    },
    manifestSha256: sha256Buffer(manifestSource),
  };
  writeJson(path.join(rootPath, PROVENANCE_NAME), provenance);

  const checksumEntries = [...entries, ...[MANIFEST_NAME, PROVENANCE_NAME].map((name) => ({
    filePath: path.join(rootPath, name),
    name,
  }))].sort((left, right) => left.name.localeCompare(right.name));
  const checksums = `${checksumEntries.map((entry) => `${sha256File(entry.filePath)}  ${entry.name}`).join('\n')}\n`;
  fs.writeFileSync(path.join(rootPath, CHECKSUMS_NAME), checksums, 'utf8');
  console.log(`Prepared ${entries.length} release assets plus checksums, manifest, and provenance evidence.`);
}

function resolveNamedFile(fileMap, rootPath, manifestEntry) {
  if (!manifestEntry || typeof manifestEntry.name !== 'string' || typeof manifestEntry.path !== 'string') {
    return undefined;
  }
  const direct = path.resolve(rootPath, manifestEntry.path);
  const relative = path.relative(rootPath, direct);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
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
  const provenancePath = path.join(rootPath, PROVENANCE_NAME);
  const checksumsPath = path.join(rootPath, CHECKSUMS_NAME);
  for (const filePath of [manifestPath, provenancePath, checksumsPath]) {
    if (!fs.existsSync(filePath)) throw new Error(`Missing release evidence file: ${path.basename(filePath)}`);
  }

  let manifest;
  let provenance;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  } catch (error) {
    throw new Error(`Release evidence JSON is invalid: ${String(error)}`);
  }
  if (manifest.manifestVersion !== 1) throw new Error('Unsupported release manifest version.');
  if (manifest.release?.tag !== tag
    || manifest.release?.version !== version
    || manifest.release?.commit !== commit
    || manifest.release?.tagObject !== tagObject) {
    throw new Error('Release manifest identity does not match the protected release ref.');
  }
  if (provenance.provenanceVersion !== 1
    || provenance.release?.tag !== tag
    || provenance.release?.version !== version
    || provenance.release?.commit !== commit
    || provenance.release?.tagObject !== tagObject) {
    throw new Error('Release provenance identity does not match the protected release ref.');
  }
  if (provenance.manifestSha256 !== sha256File(manifestPath)) {
    throw new Error('Release provenance does not cover the exact release manifest.');
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

  const expectedNames = new Set([...manifestEntries.map((entry) => entry.name), MANIFEST_NAME, PROVENANCE_NAME, CHECKSUMS_NAME]);
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
  console.log(`Verified ${manifestEntries.length} release assets, checksums, manifest, and provenance.`);
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
  CHECKSUMS_NAME,
  MANIFEST_NAME,
  PROVENANCE_NAME,
  isReleaseArtifact,
  validateArtifactSet,
};
