import { IDENTITY_EVIDENCE_STRENGTH } from './index.mjs';

export const CANONICAL_BACKUP_ENVELOPE_FORMAT = 'loomtv-canonical-backup';
export const CANONICAL_BACKUP_ENVELOPE_VERSION = 2;
export const CANONICAL_STATE_SNAPSHOT_FORMAT = 'loomtv-canonical-state-v1';
export const CANONICAL_STATE_SNAPSHOT_VERSION = 1;
export const CANONICAL_BACKUP_DURABLE_TABLES = Object.freeze([
  'accounts', 'owner_account', 'account_credentials',
  'devices', 'device_credentials',
  'library_roots', 'catalog_items', 'media_sources', 'media_identity_aliases', 'media_identity_evidence',
  'profiles', 'profile_credentials', 'profile_assignments', 'profile_selections', 'watch_progress', 'watch_history',
  'profile_preferences', 'profile_restrictions', 'profile_list_entries', 'track_preferences',
  'scan_state', 'backup_state', 'operational_logs',
  'migration_markers', 'remote_policy', 'invitations', 'audit_events',
]);
export const CANONICAL_BACKUP_TRANSIENT_TABLES = Object.freeze([
  'account_sessions', 'login_attempts', 'pairing_requests', 'invitation_sessions', 'offline_download_leases',
]);

export const LEGACY_PROFILE_KIND_MAP = Object.freeze({
  owner: 'adult',
  standard: 'adult',
  kid: 'child',
  guest: 'guest',
});

export function migrateLegacyProfileKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const kind = LEGACY_PROFILE_KIND_MAP[normalized];
  if (!kind) {
    throw Object.assign(new TypeError('Unknown legacy profile kind.'), {
      code: 'unknown_profile_kind',
      value: normalized,
    });
  }
  return kind;
}

export function compareIdentityEvidence(leftKind, rightKind) {
  const left = IDENTITY_EVIDENCE_STRENGTH[String(leftKind || '').trim().toLowerCase()];
  const right = IDENTITY_EVIDENCE_STRENGTH[String(rightKind || '').trim().toLowerCase()];
  if (!left || !right) {
    throw Object.assign(new TypeError('Unknown media identity evidence kind.'), {
      code: 'unknown_identity_evidence_kind',
    });
  }
  return left - right;
}
