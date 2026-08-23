import { API_ERROR_CODES } from '@loom-media-server/video-contracts';

const PUBLIC_ERROR_CODES = new Set(API_ERROR_CODES);

export function canonicalPublicError(error) {
  const internalCode = typeof error?.code === 'string' ? error.code : '';
  let status = Number.isInteger(error?.status) ? error.status : 500;
  let code = internalCode;

  if (['media_source_unavailable', 'media_source_unreadable', 'source_unavailable', 'media_path_substituted', 'stream_source_revoked'].includes(internalCode)) code = 'source_unavailable';
  else if (internalCode === 'media_probe_unavailable') code = 'transcoder_unavailable';
  else if (['media_probe_failed', 'media_probe_invalid', 'media_probe_incomplete', 'playback_track_not_found', 'subtitle_mode_unsupported', 'playback_transport_unsupported', 'playback_codec_unsupported', 'direct_stream_not_supported'].includes(internalCode)) code = 'playback_not_supported';
  else if (['transcode_principal_limit', 'transcode_global_limit', 'transcode_cache_unavailable', 'transcode_cache_free_space_unknown', 'transcode_cache_quota', 'transcode_cache_free_space', 'playback_capacity_exceeded'].includes(internalCode)) code = 'playback_capacity_exceeded';
  else if (internalCode === 'profile_forbidden') code = 'permission_denied';
  else if (['stream_token_invalid', 'stream_token_revoked'].includes(internalCode)) code = 'playback_session_invalid';
  else if (internalCode === 'admin_auth_required') code = 'auth_required';
  else if (internalCode === 'pairing_capacity_exceeded') {
    status = 429;
    code = 'rate_limited';
  } else if (internalCode === 'pairing_request_not_found') {
    status = 404;
    code = 'not_found';
  } else if (internalCode === 'pairing_request_expired') {
    status = 410;
    code = 'session_expired';
  } else if (['pairing_request_decided', 'pairing_request_not_pending', 'pairing_credential_unavailable', 'certificate_fingerprint_mismatch'].includes(internalCode)) {
    status = 409;
    code = 'conflict';
  } else if (internalCode === 'invitation_not_found') {
    status = 404;
    code = 'not_found';
  } else if (internalCode === 'invitation_expired') {
    status = 410;
    code = 'invitation_expired';
  } else if (internalCode === 'invitation_unavailable') {
    status = 409;
    code = 'conflict';
  } else if (internalCode === 'invitation_capacity_exceeded') {
    status = 429;
    code = 'rate_limited';
  } else if (internalCode === 'download_quota_exceeded') {
    status = 409;
    code = 'download_quota_exceeded';
  }

  if (!PUBLIC_ERROR_CODES.has(code)) {
    if (status >= 500) code = 'request_failed';
    else if (status === 401) code = 'auth_required';
    else if (status === 403) code = 'permission_denied';
    else if (status === 404) code = 'not_found';
    else if (status === 409) code = 'conflict';
    else if (status === 410) code = 'invitation_expired';
    else if (status === 429) code = 'rate_limited';
    else code = 'invalid_request';
  }
  return { status, code };
}
