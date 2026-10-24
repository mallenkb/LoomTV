#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function digest(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('A backup artifact must be a regular file.');
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let size;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function syncFile(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readEvidence(file, expectedHash) {
  if (fs.statSync(file).size > 1024 * 1024 || digest(file) !== expectedHash) {
    throw new Error('Consolidation backup evidence is missing or changed.');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function verifyDatabase(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    if (
      database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
      database.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('A rollback database failed verification.');
  } finally {
    database.close();
  }
}

function rollback(args) {
  const directoryIndex = args.indexOf('--data-dir');
  if (
    !args.includes('--confirm-stopped') ||
    directoryIndex < 0 ||
    !args[directoryIndex + 1] ||
    args[directoryIndex + 1].startsWith('--')
  ) {
    throw new Error('Stop every Loom process, then use --data-dir <directory> --confirm-stopped.');
  }
  const dataDir = path.resolve(args[directoryIndex + 1]);
  const canonical = path.join(dataDir, 'loomtv-canonical.sqlite');
  const database = new DatabaseSync(canonical, { readOnly: true });
  let record;
  try {
    record = database.prepare('SELECT * FROM native_storage_migrations ORDER BY created_at DESC LIMIT 1').get();
  } finally {
    database.close();
  }
  if (
    !record ||
    typeof record.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(record.id) ||
    ![0, 1].includes(record.previous_canonical)
  )
    throw new Error('The consolidation migration ledger is invalid.');
  const backupDir = path.join(dataDir, 'video-consolidation-backups', record.id);
  if (
    record.manifest_path !== path.join(backupDir, 'manifest.json') ||
    record.report_path !== path.join(backupDir, 'report.json') ||
    fs.realpathSync(backupDir) !== path.join(fs.realpathSync(dataDir), 'video-consolidation-backups', record.id)
  ) {
    throw new Error('The consolidation backup paths do not match this data directory.');
  }
  const manifest = readEvidence(record.manifest_path, record.manifest_sha256);
  const report = readEvidence(record.report_path, record.report_sha256);
  if (
    manifest.format !== 'loomtv-native-video-backup-v1' ||
    manifest.migrationId !== record.id ||
    !Array.isArray(manifest.artifacts) ||
    report.version !== 1 ||
    report.migrationId !== record.id ||
    report.canonicalBackup !== Boolean(record.previous_canonical)
  ) {
    throw new Error('The consolidation backup manifest or report is invalid.');
  }
  const artifactNames = {
    'canonical-pre-consolidation': 'loomtv-canonical.sqlite',
    'desktop-sqlite': 'loomtv.sqlite',
    'desktop-library-json': 'library.json',
  };
  const kinds = new Set();
  for (const artifact of manifest.artifacts) {
    if (
      !artifact ||
      !Object.hasOwn(artifactNames, artifact.kind) ||
      artifactNames[artifact.kind] !== artifact.fileName ||
      kinds.has(artifact.kind) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes < 0 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    ) {
      throw new Error('The backup contains an invalid or duplicate artifact.');
    }
    kinds.add(artifact.kind);
    const source = path.join(backupDir, artifact.fileName);
    if (digest(source) !== artifact.sha256 || fs.statSync(source).size !== artifact.sizeBytes)
      throw new Error('A consolidation backup failed verification.');
  }
  const previous = manifest.artifacts.find((artifact) => artifact.kind === 'canonical-pre-consolidation');
  const desktop = manifest.artifacts.find((artifact) => artifact.kind === 'desktop-sqlite');
  const json = manifest.artifacts.find((artifact) => artifact.kind === 'desktop-library-json');
  if (Boolean(previous) !== Boolean(record.previous_canonical) || report.legacyPreserved !== Boolean(desktop)) {
    throw new Error('The backup inventory does not match the migration ledger.');
  }
  const suffix = `.before-rollback-${randomUUID()}`;
  const moves = [];
  const restoredInputs = [];
  const staging = `${canonical}.restore-${randomUUID()}`;
  let published = false;
  try {
    if (previous) {
      fs.copyFileSync(path.join(backupDir, previous.fileName), staging, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(staging, 0o600);
      verifyDatabase(staging);
      syncFile(staging);
    }
    if (desktop) verifyDatabase(path.join(backupDir, desktop.fileName));
    for (const ending of ['', '-wal', '-shm']) {
      const source = `${canonical}${ending}`;
      if (!fs.existsSync(source)) continue;
      syncFile(source);
      const destination = `${canonical}${suffix}${ending}`;
      fs.renameSync(source, destination);
      moves.push([source, destination]);
    }
    syncDirectory(dataDir);
    for (const artifact of [desktop, json].filter(Boolean)) {
      const destination = path.join(dataDir, artifact.fileName);
      if (fs.existsSync(destination)) continue;
      fs.copyFileSync(path.join(backupDir, artifact.fileName), destination, fs.constants.COPYFILE_EXCL);
      restoredInputs.push(destination);
      fs.chmodSync(destination, 0o600);
      syncFile(destination);
    }
    if (previous) {
      // Refuse to replace a database another process created during rollback.
      fs.linkSync(staging, canonical);
      published = true;
      fs.unlinkSync(staging);
    }
    syncDirectory(dataDir);
  } catch (error) {
    if (published) fs.unlinkSync(canonical);
    // Never attach archived WAL files to an unexpected concurrently created DB.
    if (moves.some(([source]) => fs.existsSync(source))) {
      throw new Error(
        `Rollback stopped because database files reappeared. The current database is archived with suffix ${suffix}.`,
        { cause: error },
      );
    }
    for (const [source, destination] of moves.reverse()) fs.renameSync(destination, source);
    for (const file of restoredInputs) fs.unlinkSync(file);
    syncDirectory(dataDir);
    throw error;
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
  process.stdout.write(
    `Consolidation rolled back. The current canonical database was archived with suffix ${suffix}. Start the previous application version.\n`,
  );
}

if (require.main === module) {
  try {
    rollback(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
module.exports = { rollback };
