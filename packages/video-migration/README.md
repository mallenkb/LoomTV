# @loom-media-server/video-migration

This package migrates legacy LoomTV desktop and headless state into the canonical
SQLite store.

## Command

```text
loomtv-migrate plan     --data-dir <dir> [--desktop-database <file>]
loomtv-migrate run      --data-dir <dir> [--desktop-database <file>] --confirm
loomtv-migrate verify   --data-dir <dir>
loomtv-migrate rollback --data-dir <dir> --confirm-server-stopped
```

Stop every LoomTV process that can write the source before `run` or `rollback`.
Run `loomtv-migrate --help` for current options.

## Source modes

- Direct mode reads legacy headless state from the data directory.
- Projected mode reads a desktop `loomtv.sqlite` database in read-only mode.
- Combined mode reads both source sets and imports them through one projection,
  backup, report, migration marker, and canonical commit. The existing headless
  owner remains the owner for imported desktop profiles and devices.

Records shared by both source sets require an explicit merge rule. An unresolved
account, root, catalog, media-source, profile, or device collision stops before
commit. The bridge never chooses one source silently.

## Guarantees

The bridge inventories all available source records, resolves media identity,
builds one canonical projection, creates one verified backup, writes a redacted
report, commits atomically, and reopens the canonical database for independent
readback.

The verified backup includes each source file and SQLite WAL and SHM sidecar that
exists. Desktop artifacts and headless artifacts share the manifest recorded by
the canonical migration marker.

Migration preserves accounts, credentials, roots, movies, series, episodes,
metadata, artwork references, profiles, PINs, restrictions, selections,
progress, lists, track preferences, devices, and identity evidence. Series are
canonical catalog records, so series-scoped lists and track preferences resolve
without opaque placeholders.

An unknown device referenced by a profile or selection becomes a disabled device
without a credential. It cannot authenticate until paired again.

## Identity and restrictions

Legacy path-derived IDs remain as aliases. Reconnection checks content SHA-256,
filesystem identity, then quick hash. Size and modification time do not reconnect
a record. Ambiguous evidence preserves the records and stops automatic linking.

Desktop treats an empty profile folder grant as access to every folder. The
canonical value is `allowedRootIds: null`. A subfolder grant has no safe canonical
root representation, so migration stops instead of widening access.

## Reports and errors

Reports contain counts, decisions, warnings, conflicts, and opaque fingerprints.
They exclude credentials, tokens, PINs, raw paths, URLs, certificate material,
and internal plan state. A malformed legacy JSON value creates a separate
redacted failure report with its table, column, opaque row reference, and error
code. The malformed value itself is never copied.

The public API returns redacted results only. Inventory, projections, credentials,
locators, and the canonical import plan remain internal.

## Rerun and rollback

A completed rerun is a no-op only when the committed marker, source fingerprint,
reconciliation, backup evidence, and report evidence match. A different source
or plan stops with a typed conflict.

Rollback verifies the recorded backup, moves the canonical database and its
sidecars aside, and restores missing legacy artifacts to their original kind of
destination. It never deletes the canonical database and never treats legacy
files as a fallback store for the canonical server.

## Verification

Focused tests cover dry run, combined sources, series and scoped state, profile
restrictions, malformed JSON reporting, backup coverage, idempotence, readback,
and rollback. Real installations, NAS mounts, Windows filesystem identity, and
packaged desktop startup still require platform evidence.
