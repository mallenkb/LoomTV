/**
 * Typed, fail-closed errors for the canonical migration bridge.
 *
 * Every error carries a stable `code`. Details are limited to opaque identifiers,
 * counts, and fingerprints: no raw locator, PIN, token, or password material ever
 * reaches an error message, because migration errors are printed by the command
 * and copied into operator bug reports.
 */

export const MIGRATION_ERROR_CODES = Object.freeze([
  'desktop_database_missing',
  'desktop_database_unreadable',
  'desktop_schema_unsupported',
  'desktop_state_malformed',
  'legacy_state_malformed',
  'legacy_state_changed',
  'desktop_owner_profile_missing',
  'owner_credential_required',
  'unknown_profile_kind',
  'legacy_restriction_unrepresentable',
  'ambiguous_media_relink',
  'staging_conflict',
  'backup_verification_failed',
  'report_field_mismatch',
  'report_redaction_violation',
  'failure_report_write_failed',
  'canonical_cutover_conflict',
  'canonical_marker_unreadable',
  'canonical_readback_mismatch',
  'rollback_evidence_missing',
  'rollback_not_confirmed',
]);

const CODE_SET = new Set(MIGRATION_ERROR_CODES);

export class MigrationBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MigrationBridgeError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function migrationError(code, message, details = {}) {
  if (!CODE_SET.has(code)) throw new Error(`Unknown migration error code ${code}.`);
  return new MigrationBridgeError(code, message, details);
}

export function isMigrationBridgeError(value) {
  return value instanceof MigrationBridgeError;
}

/**
 * the canonical server's frozen migration API throws its own coded errors. Re-throw them unchanged
 * so the fail-closed contract stays the canonical server's, and only annotate where the bridge
 * knows which record produced it.
 */
export function annotateFrozenError(error, details = {}) {
  if (error && typeof error === 'object' && typeof error.code === 'string') Object.assign(error, details);
  return error;
}
