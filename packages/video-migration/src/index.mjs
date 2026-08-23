/**
 * LoomTV canonical migration bridge.
 *
 * Consumes the canonical server's frozen migration API from `loom-media-server-headless/migration` and
 * nothing else from the server package. Every mapping, projection, report, and rollback
 * behaviour lives in this package.
 *
 * The public surface is deliberately narrow. `prepareCanonicalMigration`,
 * `readDesktopInventory`, `projectDesktopState`, `resolveMediaIdentity`, and
 * `createOwnerAccount` all return objects that hold password and PIN hashes, device
 * secret digests, raw library locators, or the canonical server's `plan.state`. They stay internal to the
 * package so no caller can reach that material by accident, and so an accidental
 * `JSON.stringify` of a returned value can never produce a leak. The four entry points
 * below return redacted results only: counts, opaque identifiers, fingerprints, and
 * typed decisions, warnings, and conflicts.
 */

export { MIGRATION_ERROR_CODES, MigrationBridgeError, isMigrationBridgeError, migrationError } from './errors.mjs';
export { assertRedacted, assertReportFields, locatorFingerprint, opaqueFingerprint } from './redaction.mjs';
export { QUICK_HASH_WINDOW_BYTES, RELINK_EVIDENCE_ORDER, strongestEvidenceKind } from './evidence.mjs';
export { DESKTOP_DATABASE_FILENAME } from './desktopInventory.mjs';
export { migrationReportFileName } from './reportStore.mjs';
export { CANONICAL_STATE_FILENAME, canonicalStatePath } from './canonicalMarker.mjs';
export { rollbackCanonicalMigration, rollbackInstructions } from './rollback.mjs';
export {
  inspectCanonicalMigration,
  planCanonicalMigration,
  runCanonicalMigration,
} from './migrationBridge.mjs';
