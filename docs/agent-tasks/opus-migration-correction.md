# Opus correction: clear the migration gate

Read [the remaining implementation contract](./opus-remaining-implementation.md),
[the shared program contract](./video-unification-shared.md),
[the Sol handoff](./sol-core-platform-handoff.md), and
[the Opus ledger](./opus-handoff-ledger.md) completely. This correction covers
only migration, its public package text, its operator guide, and focused tests.
Do not start client, casting, or subtitle work in this run.

## Outcome

Make `packages/video-migration` safe to accept as the only bridge from every
supported legacy installation into canonical persistence. Clear each blocker
below with code and a focused regression test. Update the ledger with the exact
mapping and command evidence.

## Step 1: merge every supported source set

Support a data directory that contains legacy headless state together with a
desktop database. Inventory both read-only, merge them into one canonical
projection, and reconcile overlaps by stable identity and explicit conflict
rules. Do not ask operators to migrate one authority and then import another.
The one verified backup must bind both source sets and the desktop database,
WAL, SHM, and settings artifacts.

Completion criterion: desktop-only, headless-only, and combined-source fixtures
all produce one deterministic projection and one migration marker. A conflict
has one typed, redacted resolution or stops before canonical commit.

## Step 2: preserve series and scoped state

Project every legacy series as a canonical catalog record. Preserve the links
among series, seasons, episodes, metadata, artwork, progress, history, and
identity aliases. Resolve series-scoped list and track-preference entries to the
canonical series ID. An unresolved scope remains an explicit incompatibility and
cannot silently become a media-level or account-wide preference.

When a profile selection names a device that has no legacy device row, create a
disabled placeholder device with no usable credential. Preserve the selection
for reconciliation while preventing the placeholder from authenticating.

Completion criterion: focused fixtures account for every series, season,
episode, series list entry, scoped track preference, selection, and device.
Canonical readback matches those counts and relationships.

## Step 3: make failure evidence safe and usable

Replace every literal NUL byte in source files with an escaped string delimiter
or a structured tuple key. Source files must remain ordinary text and pass the
repository text and parser checks.

Catch malformed legacy JSON at the migration boundary. Write a redacted failure
report before returning the typed error. The report may contain the table,
column, opaque row reference, error code, and counts. It must not contain the
malformed value, raw path, secret, credential digest, or internal plan state.

Completion criterion: a malformed JSON fixture creates a bounded redacted
report and leaves source and canonical state unchanged. A repository scan finds
no literal NUL byte in the package.

## Step 4: remove stale and agent-specific product text

Rewrite `packages/video-migration/README.md`, package metadata, declarations,
comments exposed to package consumers, CLI help, and
`docs/canonical-migration.md` to match the implementation. Remove staging
directory options and instructions if staging no longer exists. Remove every
claim that canonical persistence falls back to legacy state. Remove the names
`Opus` and `Sol` from product code, package metadata, CLI text, and operator
documentation. Describe components by their actual package or service names.

Completion criterion: every documented command and option exists. Search finds
no agent name, removed staging option, or canonical legacy-fallback claim in the
migration package or operator guide.

## Step 5: prove the correction

Add focused tests for combined sources, series preservation, series-scoped list
and track state, disabled placeholder devices, malformed JSON reporting, backup
coverage, idempotent rerun, readback, rollback destinations, public redaction,
and plain-text source files. Run the migration package tests, syntax checks,
type declaration checks available in the package, documentation or CLI option
consistency check, and `git diff --check` on the owned paths.

Completion criterion: all focused checks pass and the ledger records every
command and result. End with `MIGRATION_GATE_READY` only when no known migration
implementation blocker remains. Otherwise end with `BLOCKED` and name an
external blocker. The size of the work is not a blocker.
