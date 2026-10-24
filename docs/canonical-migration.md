# Canonical migration

This guide moves a legacy LoomTV desktop or headless installation into the one
canonical SQLite store. The implementation is
`@loom-media-server/video-migration` and the canonical import API is
`loom-media-server-headless/migration`.

## Native desktop consolidation

Native desktop startup now uses the canonical store directly. It consolidates an older `loomtv.sqlite` into `loomtv-canonical.sqlite`; if the SQLite catalog is empty, it can import the validated legacy `library.json` instead. Subsequent launches use the canonical file only. The old files are retained as migration inputs and recovery copies, not writable video stores.

Close other LoomTV processes before the first launch. Consolidation verifies the source, creates durable read-only backups, checks for concurrent writes, imports inside an immediate transaction, and verifies the result before publication. A new database is published without overwriting a file another process created. An existing canonical database is backed up before the transaction. Unresolved identity, credential, or profile conflicts stop the operation.

Backups live under `<data-dir>/video-consolidation-backups/<migration-id>/`. The directory contains the applicable source databases or JSON, `manifest.json`, and a redacted `report.json`. The `native_storage_migrations` ledger pins the manifest and report digests. Keep that directory with the installation's backups.

Existing canonical media IDs and matched source identities remain authoritative. Verified legacy aliases preserve progress, lists, and track references through rescans. Native file metadata stays separate from canonical probe records. Existing canonical profile grants remain unchanged; newly imported roots and profiles do not widen previously unrestricted nonowner access across the two installations. Subfolder grants are enforced alongside canonical root grants.

A desktop-only installation creates an owner account with no exposed login credential. The existing owner setup screen sets its password through an in-process channel. A combined installation keeps its existing server owner password.

To roll back this native consolidation, stop every process using the data directory and run from the repository root:

```sh
pnpm video:rollback --data-dir <dir> --confirm-stopped
```

The equivalent command is `node scripts/rollback-native-video.cjs --data-dir <dir> --confirm-stopped`. It verifies the ledger, exact artifact paths, digests, sizes, and report inventory before restoring. It archives the consolidated database and sidecars, restores the prior canonical database when one existed, and restores legacy inputs from the verified copies. Use the previous application build after rollback; the new build will otherwise consolidate again.

Desktop SQLite backups contain the full store. Canonical JSON snapshots include registered native extension records and BLOBs, and require a matching installed extension schema when restored. Restore rejects missing or incompatible native records before clearing tables. Native JSON export and restore clear paired LAN devices and disable sharing, so restored clients must pair again. Provider secrets retain their OS-encrypted envelope. Store backups privately because they contain credentials and settings.

On 2026-10-24, all 10 native consolidation tests and 21 migration-package tests passed against disposable fixtures. Coverage includes first-launch publication, repeated startup, JSON import, rollback with and without a prior canonical store, modified-backup rejection, permissions, and metadata preservation. No user database was migrated. Packaged-app migration, process termination at publication boundaries, and visual checks remain unverified.

## Explicit migration CLI

The commands below describe the existing migration package. Its reports and rollback directory differ from native desktop consolidation. Use it first when importing legacy headless files; native startup stops if those files still need an explicit import.

## Before you start

1. Stop every desktop or headless LoomTV process that can write the source.
2. Make an independent copy of the data directory and desktop database.
3. Run `plan` and read the report before `run`.

A live source is unsupported because its SQLite WAL can change after inventory
but before backup.

## Commands

```text
loomtv-migrate plan     --data-dir <dir> [--desktop-database <file>]
loomtv-migrate run      --data-dir <dir> [--desktop-database <file>] --confirm
loomtv-migrate verify   --data-dir <dir>
loomtv-migrate rollback --data-dir <dir> --confirm-server-stopped
```

`plan` inventories every available source, resolves identity, builds the
canonical projection, and writes a redacted report. It does not create the
canonical database.

`run` creates the verified backup and report, commits one canonical database,
and independently reads back its marker and table counts. It requires
`--confirm`.

`verify` checks the committed marker and its recorded backup and report.

`rollback` verifies the backup and moves the canonical database aside. Add
`--restore-sources` and the original `--desktop-database` or
`--desktop-settings` destination when a legacy artifact needs restoration.

Working files default to `<data-dir>/loomtv-migration`. That directory contains
`backups`, `reports`, and `bundles`.

## Source combinations

The bridge supports three inputs:

- legacy headless files in the data directory;
- a desktop `loomtv.sqlite` supplied with `--desktop-database`;
- both at once.

Combined migration uses one projection and one verified backup. The existing
headless owner remains authoritative, and desktop profiles and devices bind to
that owner. Overlapping records need an explicit merge rule. An unresolved
collision stops before commit.

A desktop-only migration needs a new owner password because the desktop profile
model has no account password. Supply it through `--owner-password-file` or
`LOOMTV_OWNER_PASSWORD`. A combined migration reuses the existing headless owner
credential.

## Migrated state

| Source state | Canonical destination |
| --- | --- |
| Owner, users, and credentials | `accounts`, `account_credentials` |
| Library folders | `library_roots` |
| Movies, series, and episodes | `catalog_items`, `media_sources` |
| Metadata and artwork references | catalog extension data and migration bundle |
| Path IDs and file evidence | identity aliases and evidence |
| Profiles and PINs | `profiles`, `profile_credentials` |
| Assignments and selections | profile assignment and selection tables |
| Restrictions and folder grants | `profile_restrictions` |
| Progress and history | watch state tables |
| Lists and track preferences | profile list and track tables |
| Paired devices | devices and device credentials |

Series are first-class catalog records. Episode records carry their series ID,
season number, and episode number. Series-scoped lists and track preferences
resolve to that record.

Selections or guest profiles that name a missing device create a disabled
placeholder without a credential. The record preserves relationships but cannot
authenticate.

## Access and identity decisions

In the explicit migration CLI, an empty desktop folder grant maps to canonical
`allowedRootIds: null`. That CLI stops on subfolder grants it cannot represent
as root IDs. Native desktop consolidation instead retains those grants in
`profile_path_grants` and intersects them with canonical root restrictions.

Media reconnection uses content SHA-256, filesystem identity, then quick hash.
It does not use size or modification time alone. Ambiguous evidence reconnects
nothing and appears in the report.

## Reports

Success reports live under `<work-dir>/reports` in the canonical migration
report format. They include source and target counts, reconciliation, decisions,
conflicts, warnings, backup evidence, rollback instructions, and redaction
assertions.

Malformed JSON produces a redacted failure report before the command returns its
typed error. Failure reports name the table, column, opaque row reference, and
error code. Neither report format includes a raw path, malformed value, password,
PIN, token, credential digest, certificate, or internal plan state.

## Rerun and rollback

A completed rerun changes nothing when the source fingerprint, migration marker,
reconciliation, backup, and report still match. A changed source is a different
migration and stops against an existing canonical commit.

Rollback performs these actions:

1. confirm every server using the data directory is stopped;
2. verify the backup recorded by the migration marker;
3. move `loomtv-canonical.sqlite` and its WAL and SHM sidecars aside;
4. restore a missing legacy artifact only when requested and when its real
   destination is supplied;
5. start the previous product against its restored source state.

The canonical server does not fall back to legacy state. Rollback returns to the
previous product version and keeps the canonical database recoverable.

## Evidence status

Focused automated tests cover synthetic desktop, headless, and combined sources,
restriction failures, malformed JSON, series state, backup contents, commit,
readback, rerun, and rollback. A real desktop installation, NAS mount, Windows
filesystem identity, packaged desktop cutover, and large-library timing still
need runtime or platform evidence.
