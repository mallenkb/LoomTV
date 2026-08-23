#!/usr/bin/env node
/**
 * loomtv-migrate: the canonical migration command.
 *
 *   loomtv-migrate plan     --data-dir <dir> [--desktop-database <file>]
 *   loomtv-migrate run      --data-dir <dir> [--desktop-database <file>] --confirm
 *   loomtv-migrate verify   --data-dir <dir>
 *   loomtv-migrate rollback --data-dir <dir> --confirm-server-stopped
 *
 * The command prints counts, opaque record IDs, and fingerprints. It never prints a
 * library path, a PIN, a token, or a password, because operators paste this output into
 * bug reports.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  inspectCanonicalMigration,
  isMigrationBridgeError,
  planCanonicalMigration,
  rollbackCanonicalMigration,
  runCanonicalMigration,
} from '../src/index.mjs';

const USAGE = `loomtv-migrate <command> [options]

Commands
  plan       Dry run. Inventories the source, builds the import plan, writes a redacted
             report, and does not create canonical state.
  run        Verified backup, report, and commit. Requires --confirm.
  verify     Report what the data directory currently holds.
  rollback   Move a committed canonical database aside after verifying its backup.

Common options
  --data-dir <dir>            Canonical data directory. Required.
  --desktop-database <file>   Legacy desktop loomtv.sqlite. Omit for a headless source.
  --desktop-settings <file>   Optional desktop settings.json to include in the backup.
  --work-dir <dir>            Root for backups, reports, and bundles.
                              Default: <data-dir>/loomtv-migration
  --backup-dir <dir>          Override the backup directory.
  --report-dir <dir>          Override the report directory.
  --bundle-dir <dir>          Override the migration bundle directory.
  --json                      Emit machine-readable output.

Desktop source options
  --owner-name <name>         Owner account display name. Defaults to the owner profile.
  --owner-password-file <f>   File holding the owner password. Read once, never logged.
                              LOOMTV_OWNER_PASSWORD is used when no file is given.
                              A desktop rerun must supply the same credential.
  --owner-account-id <id>     Reuse a specific opaque owner account ID.
  --sessions <policy>         preserve (default) or revoke.
  --relink-candidates <file>  Newline-delimited absolute paths to consider when a file
                              has moved. Without candidates a moved file stays offline.
  --prior-evidence <file>     JSON array of {legacyMediaId, kind, value} captured before
                              the move. Required to reconnect a moved file at all.
  --no-content-hash           Skip content SHA-256. Reconnection then falls back to
                              filesystem-id and reported quick-hash evidence.
  --no-quick-hash             Skip quick-hash entirely.

run options
  --confirm                   Required. Acknowledges that this writes canonical state.

rollback options
  --migration-id <id>         Refuse to roll back a different migration.
  --confirm-server-stopped    Required.
  --restore-sources           Restore legacy sources that are missing from the backup.
  --force                     Proceed when the recorded backup no longer verifies.
`;

const FLAGS = new Set([
  '--json', '--confirm', '--confirm-server-stopped', '--restore-sources', '--force',
  '--no-content-hash', '--no-quick-hash', '--help', '-h',
]);
const VALUE_OPTIONS = new Set([
  '--data-dir', '--desktop-database', '--desktop-settings', '--work-dir', '--backup-dir',
  '--report-dir', '--bundle-dir', '--owner-name', '--owner-password-file',
  '--owner-account-id', '--sessions', '--relink-candidates', '--prior-evidence',
  '--migration-id',
]);

function parseArguments(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') && !token.startsWith('-')) {
      options._.push(token);
      continue;
    }
    if (FLAGS.has(token)) {
      options[token.replace(/^--?/, '')] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(token)) throw new Error(`Unknown option ${token}.`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Option ${token} needs a value.`);
    }
    options[token.replace(/^--/, '')] = next;
    index += 1;
  }
  return options;
}

async function readPassword(options) {
  if (options['owner-password-file']) {
    const contents = await fs.readFile(path.resolve(options['owner-password-file']), 'utf8');
    return contents.replace(/\r?\n$/, '');
  }
  return process.env.LOOMTV_OWNER_PASSWORD || undefined;
}

async function readLines(target) {
  const contents = await fs.readFile(path.resolve(target), 'utf8');
  return contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function readPriorEvidence(target) {
  const parsed = JSON.parse(await fs.readFile(path.resolve(target), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('The prior evidence file must hold a JSON array.');
  return parsed;
}

async function buildOptions(options) {
  if (!options['data-dir']) throw new Error('--data-dir is required.');
  return {
    dataDir: options['data-dir'],
    desktopDatabase: options['desktop-database'],
    desktopSettingsPath: options['desktop-settings'],
    workDir: options['work-dir'],
    backupDir: options['backup-dir'],
    reportDir: options['report-dir'],
    bundleDir: options['bundle-dir'],
    owner: {
      name: options['owner-name'],
      password: await readPassword(options),
      accountId: options['owner-account-id'],
    },
    sessionPolicy: options.sessions === 'revoke' ? 'revoke' : 'preserve',
    relinkCandidates: options['relink-candidates'] ? await readLines(options['relink-candidates']) : [],
    priorEvidence: options['prior-evidence'] ? await readPriorEvidence(options['prior-evidence']) : [],
    allowContentHash: !options['no-content-hash'],
    allowQuickHash: !options['no-quick-hash'],
  };
}

function line(label, value) {
  return `  ${label.padEnd(26)}${value}`;
}

function describeIssues(title, entries) {
  if (!entries?.length) return [];
  const rows = [`${title}:`];
  for (const entry of entries) {
    const count = entry.count === undefined ? '' : ` x${entry.count}`;
    rows.push(`  - ${entry.code}${count}${entry.resolution ? ` [${entry.resolution}]` : ''}`);
    if (entry.detail) rows.push(`      ${entry.detail}`);
  }
  return rows;
}

function printResult(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const rows = [];
  rows.push(result.dryRun ? 'Dry run complete. No canonical state was written.' : 'Migration committed.');
  rows.push(line('Migration ID', result.migrationId));
  rows.push(line('Source mode', result.sourceMode));
  rows.push(line('Source fingerprint', result.sourceFingerprint));
  if (result.recovered) rows.push(line('Rerun', 'already committed, no changes made'));
  if (result.reportPath) rows.push(line('Report', result.reportPath));
  if (result.summary) {
    const { summary } = result;
    rows.push(line('Roots', summary.roots));
    rows.push(line('Catalog items', summary.catalogItems));
    rows.push(line('Profiles', summary.profiles));
    rows.push(line('Devices', summary.devices));
    rows.push(line('Progress rows', summary.progress));
    rows.push(line('List entries', summary.listEntries));
    rows.push(line('Track preferences', summary.trackPreferences));
    rows.push(line('Media intact', summary.identity.intact));
    rows.push(line('Media reconnected', summary.identity.relinked));
    rows.push(line('Media still missing', summary.identity.missing));
    rows.push(line('Media ambiguous', summary.identity.ambiguous));
  }
  if (result.evidenceAvailable) {
    rows.push(line('Backup verified', String(result.evidenceAvailable.backup)));
    rows.push(line('Report verified', String(result.evidenceAvailable.report)));
  }
  if (result.report) {
    rows.push(...describeIssues('Conflicts', result.report.conflicts));
    rows.push(...describeIssues('Warnings', result.report.warnings));
  }
  if (result.rollback) {
    rows.push('Rollback:');
    for (const step of result.rollback) rows.push(`  - ${step}`);
  }
  process.stdout.write(`${rows.join('\n')}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseArguments(argv);
  const command = options._[0];

  if (!command || options.help || options.h) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === 'plan') {
    printResult(await planCanonicalMigration(await buildOptions(options)), options.json === true);
    return 0;
  }

  if (command === 'run') {
    if (!options.confirm) {
      process.stderr.write('run writes canonical state. Re-run with --confirm once a dry run looks correct.\n');
      return 2;
    }
    printResult(await runCanonicalMigration(await buildOptions(options)), options.json === true);
    return 0;
  }

  if (command === 'verify') {
    if (!options['data-dir']) throw new Error('--data-dir is required.');
    const state = await inspectCanonicalMigration({ dataDir: options['data-dir'] });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
      return 0;
    }
    const rows = [state.committed ? 'Canonical state is committed.' : 'No canonical state is committed.'];
    rows.push(line('Legacy sources present', String(state.legacySourcesPresent)));
    if (state.marker) {
      rows.push(line('Migration ID', state.marker.migrationId));
      rows.push(line('Source fingerprint', state.marker.sourceFingerprint));
      rows.push(line('Committed at', new Date(state.marker.committedAt || 0).toISOString()));
      rows.push(line('Backup evidence', String(state.evidenceAvailable.backup)));
      rows.push(line('Report evidence', String(state.evidenceAvailable.report)));
    }
    process.stdout.write(`${rows.join('\n')}\n`);
    return 0;
  }

  if (command === 'rollback') {
    if (!options['data-dir']) throw new Error('--data-dir is required.');
    const result = await rollbackCanonicalMigration({
      dataDir: options['data-dir'],
      migrationId: options['migration-id'],
      confirmServerStopped: options['confirm-server-stopped'] === true,
      restoreSources: options['restore-sources'] === true,
      desktopDatabase: options['desktop-database'],
      desktopSettingsPath: options['desktop-settings'],
      force: options.force === true,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    const rows = [result.rolledBack ? 'Canonical state moved aside.' : 'Nothing to roll back.'];
    if (result.migrationId) rows.push(line('Migration ID', result.migrationId));
    if (result.movedAside?.length) rows.push(line('Moved aside', result.movedAside.join(', ')));
    if (result.restoredSources?.length) {
      rows.push(line('Restored sources', result.restoredSources.map((entry) => `${entry.kind} -> ${entry.origin}`).join(', ')));
    }
    if (result.skippedSources?.length) {
      rows.push(line('Left in place', result.skippedSources.map((entry) => entry.kind).join(', ')));
    }
    rows.push('Next steps:');
    for (const step of result.instructions) rows.push(`  - ${step}`);
    process.stdout.write(`${rows.join('\n')}\n`);
    return 0;
  }

  process.stderr.write(`Unknown command ${command}.\n\n${USAGE}`);
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (isMigrationBridgeError(error) || (error && typeof error.code === 'string')) {
      // Own enumerable properties only: `message` and `stack` are non-enumerable on Error,
      // so the details block carries the coded context and nothing else.
      const printable = Object.fromEntries(
        Object.entries(error).filter(([key]) => !['code', 'name', 'cause'].includes(key)),
      );
      process.stderr.write(`${error.code}: ${error.message}\n`);
      if (Object.keys(printable).length) process.stderr.write(`${JSON.stringify(printable, null, 2)}\n`);
    } else {
      process.stderr.write(`${error?.message || error}\n`);
    }
    process.exitCode = 1;
  },
);
