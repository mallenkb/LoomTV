export const VIDEO_CONTRACT_VERSION = 1;
export const CANONICAL_API_VERSION = '1';
export const CANONICAL_API_PREFIX = '/api/v1';
export const CANONICAL_API_VERSION_HEADER = 'X-LoomTV-API-Version';

export const ACCOUNT_ROLES = Object.freeze(['owner', 'admin', 'user', 'viewer']);
export const PROFILE_KINDS = Object.freeze(['adult', 'child', 'guest']);
export const PLAYBACK_PLAN_MODES = Object.freeze(['direct', 'remux', 'transcode']);
export const PLAYBACK_TRANSPORTS = Object.freeze(['http', 'hls']);
export const MEDIA_SOURCE_STATES = Object.freeze(['online', 'offline', 'unreadable', 'missing']);
export const IDENTITY_EVIDENCE_KINDS = Object.freeze([
  'content-sha256',
  'filesystem-id',
  'quick-hash',
  'legacy-path-hash',
]);

export const IDENTITY_EVIDENCE_STRENGTH = Object.freeze({
  'legacy-path-hash': 1,
  'quick-hash': 2,
  'filesystem-id': 3,
  'content-sha256': 4,
});

export const ACCOUNT_PERMISSIONS = Object.freeze([
  'admin.read',
  'library.read',
  'library.manage',
  'stream',
  'transcode',
  'downloads',
  'remote.access',
  'remote.manage',
  'audit.read',
  'sessions.read',
  'logs.read',
  'backup.read',
  'backup.create',
  'users.read',
  'users.manage',
  'devices.manage',
  'sharing.manage',
  'account.password',
  'media.delete',
]);

export function canonicalProfileKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (PROFILE_KINDS.includes(normalized)) return normalized;
  throw Object.assign(new TypeError('Unknown canonical profile kind.'), { code: 'unknown_profile_kind' });
}

export function identityEvidenceStrength(kind) {
  const normalized = String(kind || '').trim().toLowerCase();
  const strength = IDENTITY_EVIDENCE_STRENGTH[normalized];
  if (!strength) throw Object.assign(new TypeError('Unknown media identity evidence kind.'), { code: 'unknown_identity_evidence_kind' });
  return strength;
}

export const API_ERROR_CODES = Object.freeze([
  'invalid_request',
  'invalid_json',
  'body_too_large',
  'auth_required',
  'session_expired',
  'permission_denied',
  'secure_transport_required',
  'remote_access_disabled',
  'not_found',
  'account_not_found',
  'profile_not_found',
  'profile_required',
  'profile_locked',
  'stale_profile_selection',
  'media_not_found',
  'source_unavailable',
  'playback_not_supported',
  'playback_capacity_exceeded',
  'playback_session_invalid',
  'transcoder_unavailable',
  'transcode_failed',
  'download_not_allowed',
  'download_quota_exceeded',
  'invalid_backup',
  'device_revoked',
  'invitation_expired',
  'rate_limited',
  'conflict',
  'request_failed',
  'bootstrap_secret_invalid',
  'invalid_credentials',
  'owner_exists',
]);

function freezeRecords(records) {
  return Object.freeze(records.map((record) => Object.freeze(record)));
}

export const CANONICAL_ROUTES = freezeRecords([
  { id: 'discovery.read', method: 'GET', path: '/api/v1/discovery', access: 'public', state: 'active' },
  { id: 'health.read', method: 'GET', path: '/api/v1/health', access: 'public', state: 'active' },
  { id: 'openapi.read', method: 'GET', path: '/api/v1/openapi.json', access: 'public', state: 'active' },
  { id: 'auth.onboarding.read', method: 'GET', path: '/api/v1/auth/onboarding', access: 'public', state: 'active' },
  { id: 'auth.owner.create', method: 'POST', path: '/api/v1/auth/owner', access: 'bootstrap', state: 'active' },
  { id: 'auth.session.create', method: 'POST', path: '/api/v1/auth/session', access: 'public', state: 'active' },
  { id: 'auth.session.revoke', method: 'DELETE', path: '/api/v1/auth/session', access: 'account', state: 'active' },
  { id: 'auth.me.read', method: 'GET', path: '/api/v1/auth/me', access: 'account', state: 'active' },
  { id: 'library.list', method: 'GET', path: '/api/v1/library', access: 'profile', permission: 'library.read', state: 'active' },
  { id: 'library.series.list', method: 'GET', path: '/api/v1/library/series', access: 'profile', permission: 'library.read', state: 'active' },
  { id: 'library.item.read', method: 'GET', path: '/api/v1/library/{mediaId}', access: 'profile', permission: 'library.read', state: 'active' },
  { id: 'library.roots.list', method: 'GET', path: '/api/v1/library/roots', access: 'account', permission: 'library.read', state: 'active' },
  { id: 'library.roots.create', method: 'POST', path: '/api/v1/library/roots', access: 'account', permission: 'library.manage', state: 'active' },
  { id: 'library.roots.remove', method: 'DELETE', path: '/api/v1/library/roots/{rootId}', access: 'account', permission: 'library.manage', state: 'active' },
  { id: 'library.scan.read', method: 'GET', path: '/api/v1/library/scan', access: 'account', permission: 'library.read', state: 'active' },
  { id: 'library.scan.start', method: 'POST', path: '/api/v1/library/scan', access: 'account', permission: 'library.manage', state: 'active' },
  { id: 'profiles.list', method: 'GET', path: '/api/v1/profiles', access: 'account', state: 'active' },
  { id: 'profiles.create', method: 'POST', path: '/api/v1/profiles', access: 'account', state: 'active' },
  { id: 'profiles.update', method: 'PATCH', path: '/api/v1/profiles/{profileId}', access: 'account', state: 'active' },
  { id: 'profiles.remove', method: 'DELETE', path: '/api/v1/profiles/{profileId}', access: 'account', state: 'active' },
  { id: 'profiles.select', method: 'POST', path: '/api/v1/profiles/{profileId}/select', access: 'account', state: 'active' },
  { id: 'profiles.selection.read', method: 'GET', path: '/api/v1/profiles/selection', access: 'account', state: 'active' },
  { id: 'profiles.selection.update', method: 'PATCH', path: '/api/v1/profiles/selection', access: 'account', state: 'active' },
  { id: 'profiles.selection.clear', method: 'DELETE', path: '/api/v1/profiles/selection', access: 'account', state: 'active' },
  { id: 'profiles.selection.lock', method: 'POST', path: '/api/v1/profiles/selection/lock', access: 'account', state: 'active' },
  { id: 'profiles.pin.update', method: 'PUT', path: '/api/v1/profiles/{profileId}/pin', access: 'account', state: 'active' },
  { id: 'profiles.preferences.read', method: 'GET', path: '/api/v1/profiles/{profileId}/preferences', access: 'profile', state: 'active' },
  { id: 'profiles.preferences.update', method: 'PATCH', path: '/api/v1/profiles/{profileId}/preferences', access: 'profile', state: 'active' },
  { id: 'profiles.lists.read', method: 'GET', path: '/api/v1/profiles/{profileId}/lists', access: 'profile', state: 'active' },
  { id: 'profiles.lists.update', method: 'PUT', path: '/api/v1/profiles/{profileId}/lists/{kind}/{mediaId}', access: 'profile', state: 'active' },
  { id: 'profiles.lists.remove', method: 'DELETE', path: '/api/v1/profiles/{profileId}/lists/{kind}/{mediaId}', access: 'profile', state: 'active' },
  { id: 'profiles.progress.list', method: 'GET', path: '/api/v1/profiles/{profileId}/progress', access: 'profile', state: 'active' },
  { id: 'profiles.progress.read', method: 'GET', path: '/api/v1/profiles/{profileId}/progress/{mediaId}', access: 'profile', state: 'active' },
  { id: 'profiles.progress.save', method: 'PUT', path: '/api/v1/profiles/{profileId}/progress/{mediaId}', access: 'profile', state: 'active' },
  { id: 'profiles.track-preferences.read', method: 'GET', path: '/api/v1/profiles/{profileId}/track-preferences/{scope}', access: 'profile', state: 'active' },
  { id: 'profiles.track-preferences.save', method: 'PUT', path: '/api/v1/profiles/{profileId}/track-preferences/{scope}', access: 'profile', state: 'active' },
  { id: 'media.links.read', method: 'GET', path: '/api/v1/media/{mediaId}', access: 'profile', permission: 'library.read', state: 'active' },
  { id: 'media.plan.create', method: 'POST', path: '/api/v1/media/{mediaId}/playback-plan', access: 'profile', permission: 'stream', state: 'active' },
  { id: 'media.direct.read', method: 'GET', path: '/api/v1/media/{mediaId}/direct', access: 'capability', permission: 'stream', state: 'active' },
  { id: 'media.direct.renew', method: 'POST', path: '/api/v1/media/{mediaId}/direct/renew', access: 'capability', permission: 'stream', state: 'active' },
  { id: 'media.subtitle.read', method: 'GET', path: '/api/v1/media/{mediaId}/subtitles/{trackId}', access: 'capability', permission: 'stream', state: 'active' },
  { id: 'media.transcode.start', method: 'POST', path: '/api/v1/media/{mediaId}/transcode', access: 'profile', permission: 'transcode', state: 'active' },
  { id: 'media.transcode.renew', method: 'POST', path: '/api/v1/media/{mediaId}/transcode/renew', access: 'capability', permission: 'stream', state: 'active' },
  { id: 'media.playback.renew', method: 'POST', path: '/api/v1/media/{mediaId}/playback-session/renew', access: 'capability', permission: 'stream', state: 'active' },
  { id: 'media.playback.stop', method: 'DELETE', path: '/api/v1/media/{mediaId}/playback-session', access: 'capability', permission: 'stream', state: 'active' },
  { id: 'media.download.read', method: 'GET', path: '/api/v1/media/{mediaId}/download', access: 'capability', permission: 'downloads', state: 'reserved' },
  { id: 'users.list', method: 'GET', path: '/api/v1/users', access: 'account', permission: 'users.read', state: 'active' },
  { id: 'users.create', method: 'POST', path: '/api/v1/users', access: 'account', permission: 'users.manage', state: 'active' },
  { id: 'users.update', method: 'PATCH', path: '/api/v1/users/{userId}', access: 'account', permission: 'users.manage', state: 'active' },
  { id: 'users.remove', method: 'DELETE', path: '/api/v1/users/{userId}', access: 'account', permission: 'users.manage', state: 'active' },
  { id: 'account.password.update', method: 'POST', path: '/api/v1/account/password', access: 'account', state: 'active' },
  { id: 'devices.list', method: 'GET', path: '/api/v1/devices', access: 'account', permission: 'devices.manage', state: 'active' },
  { id: 'devices.revoke', method: 'DELETE', path: '/api/v1/devices/{deviceId}', access: 'account', permission: 'devices.manage', state: 'active' },
  { id: 'pairing.request', method: 'POST', path: '/api/v1/pairing/requests', access: 'public', state: 'active' },
  { id: 'pairing.status', method: 'GET', path: '/api/v1/pairing/requests/{requestId}', access: 'capability', state: 'active' },
  { id: 'pairing.approve', method: 'POST', path: '/api/v1/pairing/requests/{requestId}/approve', access: 'account', permission: 'devices.manage', state: 'active' },
  { id: 'remote.policy.read', method: 'GET', path: '/api/v1/remote-policy', access: 'account', permission: 'admin.read', state: 'active' },
  { id: 'remote.policy.update', method: 'PATCH', path: '/api/v1/remote-policy', access: 'account', permission: 'remote.manage', state: 'active' },
  { id: 'audit.list', method: 'GET', path: '/api/v1/audit-events', access: 'account', permission: 'audit.read', state: 'active' },
  { id: 'downloads.create', method: 'POST', path: '/api/v1/downloads', access: 'profile', permission: 'downloads', state: 'active' },
  { id: 'downloads.list', method: 'GET', path: '/api/v1/downloads', access: 'profile', permission: 'downloads', state: 'active' },
  { id: 'downloads.revoke', method: 'DELETE', path: '/api/v1/downloads/{downloadId}', access: 'profile', permission: 'downloads', state: 'active' },
  { id: 'downloads.content', method: 'GET', path: '/api/v1/downloads/{downloadId}/content', access: 'capability', permission: 'downloads', state: 'active' },
  { id: 'invitations.list', method: 'GET', path: '/api/v1/invitations', access: 'account', permission: 'sharing.manage', state: 'active' },
  { id: 'invitations.create', method: 'POST', path: '/api/v1/invitations', access: 'account', permission: 'sharing.manage', state: 'active' },
  { id: 'invitations.accept', method: 'POST', path: '/api/v1/invitations/{invitationId}/accept', access: 'capability', state: 'active' },
  { id: 'invitations.revoke', method: 'DELETE', path: '/api/v1/invitations/{invitationId}', access: 'account', permission: 'sharing.manage', state: 'active' },
  { id: 'invitations.session.revoke', method: 'DELETE', path: '/api/v1/invitations/session', access: 'capability', state: 'active' },
  { id: 'cast.sessions.create', method: 'POST', path: '/api/v1/cast/sessions', access: 'profile', permission: 'stream', state: 'active' },
  { id: 'cast.sessions.update', method: 'PATCH', path: '/api/v1/cast/sessions/{castSessionId}', access: 'profile', permission: 'stream', state: 'active' },
  { id: 'cast.sessions.stop', method: 'DELETE', path: '/api/v1/cast/sessions/{castSessionId}', access: 'profile', permission: 'stream', state: 'active' },
  { id: 'sessions.list', method: 'GET', path: '/api/v1/sessions', access: 'account', permission: 'sessions.read', state: 'active' },
  { id: 'logs.list', method: 'GET', path: '/api/v1/logs', access: 'account', permission: 'logs.read', state: 'active' },
  { id: 'diagnostics.read', method: 'GET', path: '/api/v1/diagnostics', access: 'account', permission: 'admin.read', state: 'active' },
  { id: 'backups.read', method: 'GET', path: '/api/v1/backups', access: 'account', permission: 'backup.read', state: 'active' },
  { id: 'backups.create', method: 'POST', path: '/api/v1/backups', access: 'account', permission: 'backup.create', state: 'active' },
  { id: 'backups.restore', method: 'POST', path: '/api/v1/backups/restore', access: 'owner', state: 'active' },
]);

export const LEGACY_ROUTE_ADAPTERS = freezeRecords([
  { source: '/api/v2/library', destination: '/api/v1/library', removal: 'after the current and prior client generations no longer call it' },
  { source: '/api/v2/library/index', destination: '/api/v1/library', removal: 'after catalogVersion 1 clients leave the compatibility window' },
  { source: '/api/v2/library/items/{mediaId}', destination: '/api/v1/library/{mediaId}', removal: 'after catalogVersion 1 clients leave the compatibility window' },
  { source: '/api/v2/profiles*', destination: '/api/v1/profiles*', removal: 'after profile API v1 clients leave the compatibility window' },
  { source: '/api/v2/client-config', destination: '/api/v1/discovery plus active profile preferences', removal: 'after profile API v1 clients leave the compatibility window' },
  { source: '/api/v2/profiles/active', destination: '/api/v1 active ProfileSelection', removal: 'after profile API v1 clients leave the compatibility window' },
  { source: '/api/v2/profiles/lock', destination: '/api/v1 ProfileSelection unlock revocation', removal: 'after profile API v1 clients leave the compatibility window' },
  { source: '/api/v2/profiles/auto-sign-in', destination: '/api/v1 ProfileSelection', removal: 'after profile API v1 clients leave the compatibility window' },
  { source: '/api/v2/profile-preferences', destination: '/api/v1/profiles/{profileId}/preferences', removal: 'after profile API v1 clients leave the compatibility window' },
  { source: '/api/v2/profile-lists', destination: '/api/v1/profiles/{profileId}/lists', removal: 'after profile API v1 clients leave the compatibility window' },
  { source: '/api/v2/progress', destination: '/api/v1/profiles/{profileId}/progress/{mediaId}', removal: 'after path-keyed progress has migrated and prior clients leave the compatibility window' },
  { source: '/api/v2/playback-track-preferences', destination: '/api/v1/profiles/{profileId}/track-preferences/{scope}', removal: 'after prior clients leave the compatibility window' },
  { source: '/api/v2/playback-plan', destination: '/api/v1/media/{mediaId}/playback-plan', removal: 'after prior clients leave the compatibility window' },
  { source: '/api/v2/start-hls', destination: '/api/v1/media/{mediaId}/transcode', removal: 'after prior clients leave the compatibility window' },
  { source: '/api/v2/artwork/official-candidates', destination: 'typed 410 legacy_route_retired', removal: 'provider metadata requires a future canonical contract' },
  { source: '/api/v2/artwork/apply-official', destination: 'typed 410 legacy_route_retired', removal: 'provider metadata requires a future canonical contract' },
  { source: '/api/v2/playback/segments', destination: 'typed 410 legacy_route_retired', removal: 'segment metadata requires a future canonical contract' },
  { source: '/api/v2/pair*', destination: '/api/v1/pairing/requests*', removal: 'after approved-device credentials replace LAN tokens' },
  { source: '/api/v2/auth/refresh', destination: '/api/v1/auth/session', removal: 'after approved-device credentials replace LAN refresh tokens' },
  { source: '/api/v2/unpair', destination: '/api/v1/devices/{deviceId}', removal: 'after prior clients leave the compatibility window' },
  { source: '/stream', destination: '/api/v1/media/{mediaId}/direct', removal: 'after every prior client uses canonical direct capabilities' },
  { source: '/hls/{sessionId}/*', destination: '/api/v1/media/{mediaId}/transcode', removal: 'after every prior client uses canonical HLS URLs' },
  { source: '/api/admin*', destination: '/api/v1 admin routes', removal: 'after the bundled admin client uses only /api/v1' },
  { source: '/api/media*', destination: '/api/v1/media* delivery handlers', removal: 'after all issued legacy playback capabilities expire' },
]);

export const LEGACY_MODEL_DESTINATIONS = freezeRecords([
  { source: 'desktop LibraryData and headless roots/catalog', destination: 'LibraryRoot, CatalogItem, MediaSource, CatalogSnapshot', decision: 'migrate' },
  { source: 'desktop WireMediaItem and headless catalog item', destination: 'CatalogItem plus one or more MediaSource records', decision: 'migrate' },
  { source: 'desktop path-hash media id and headless path-hash id', destination: 'CatalogItem.id with MediaIdentityAlias entries', decision: 'preserve-and-alias' },
  { source: 'desktop filePath progress keys', destination: 'WatchProgress keyed by profileId and mediaId', decision: 'resolve-and-migrate' },
  { source: 'desktop ProfileRecord including owner profile', destination: 'ViewingProfile; owner profile becomes an adult profile owned by the owner account', decision: 'migrate' },
  { source: 'headless owner and user records', destination: 'Account', decision: 'migrate' },
  { source: 'desktop paired device tokens and headless account device allow-list', destination: 'Device and DeviceCredential', decision: 'migrate-or-repair' },
  { source: 'desktop DeviceProfileSelection and headless selections', destination: 'ProfileSelection', decision: 'migrate' },
  { source: 'desktop profile PIN credentials', destination: 'ViewingProfileCredential', decision: 'migrate-secret' },
  { source: 'desktop profile preferences, restrictions, lists, and track preferences', destination: 'ProfilePreferences, ProfileRestrictions, ProfileListEntry, TrackPreference', decision: 'migrate' },
  { source: 'headless authentication sessions', destination: 'AccountSession', decision: 'migrate-or-revoke' },
  { source: 'desktop TranscodeSession and headless playback-session registry', destination: 'PlaybackSession and PlaybackDelivery', decision: 'adapter-only' },
  { source: 'desktop ProbeResult and headless localMetadata', destination: 'MediaProbe with MediaTrack records', decision: 'migrate' },
  { source: 'desktop TranscodeOptions and LAN playback capabilities', destination: 'PlaybackRequest and ClientCapabilities', decision: 'adapter-only' },
  { source: 'desktop ApiResult, ProfileError, and StreamStartFailure', destination: 'ApiSuccess or ApiFailure with ApiError', decision: 'adapter-only' },
  { source: 'desktop profile export v1', destination: 'migration import source only', decision: 'retire-after-import-window' },
  { source: 'headless-client.json and headless-client.sqlite', destination: 'canonical persistence migration source', decision: 'retire-after-verified-migration' },
  { source: 'headless-admin.json', destination: 'canonical account, root, catalog, session, and operational stores', decision: 'retire-after-verified-migration' },
]);

export function canonicalRoute(routeId) {
  return CANONICAL_ROUTES.find((route) => route.id === routeId) || null;
}
