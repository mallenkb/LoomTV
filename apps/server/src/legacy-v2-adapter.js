import { createHash } from 'node:crypto';
import { MEDIA_CORE_CONTRACT_VERSION, normalizeClientPlaybackCapabilities } from '@loom-media-server/media-core';
import { hasPermission, isLocalNetworkAddress } from './auth-policy.js';

const MAX_BODY_BYTES = 64 * 1024;

function response(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', ...headers });
  res.end(body);
  return true;
}

function requestOrigin(req) {
  const host = String(req.headers.host || '').trim();
  if (!host || host.includes('@') || /[/?#\\]/.test(host)) {
    throw Object.assign(new Error('The request host is invalid.'), { status: 400, code: 'invalid_request' });
  }
  const parsed = new URL(`https://${host}`);
  return parsed.origin;
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { status: 413, code: 'body_too_large' });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body is invalid.'), { status: 400, code: 'invalid_json' }); }
}

function legacyScopes(permissions = []) {
  return [
    ...(permissions.includes('library.read') ? ['catalog:read'] : []),
    ...(permissions.includes('stream') ? ['media:stream'] : []),
    ...(permissions.includes('library.read') ? ['playback:write'] : []),
    'device:self',
  ];
}

function legacyMediaItem(item) {
  const type = item.animeLikely ? 'anime' : item.kind === 'episode' || item.type === 'tv' ? 'tv' : 'movie';
  return {
    id: item.id, type, title: String(item.title || 'Untitled'), year: Number(item.year) || 0,
    poster: '', backdrop: '', summary: String(item.summary || ''), rating: Number(item.rating) || 0,
    genres: Array.isArray(item.genres) ? item.genres.filter((entry) => typeof entry === 'string').slice(0, 64) : [],
    cast: [], filePath: item.legacyStreamUrl || '',
    ...(item.providerIds && typeof item.providerIds === 'object' ? { providerIds: { ...item.providerIds } } : {}),
  };
}

function legacyCard(item) {
  const projected = legacyMediaItem(item);
  return { ...projected, playbackReferences: [{ progressKey: item.id }] };
}

function legacyProfile(profile, sortOrder = 0) {
  const type = profile.type === 'kid' || profile.kind === 'child' ? 'kid'
    : profile.type === 'guest' || profile.kind === 'guest' ? 'guest' : 'standard';
  return { id: profile.id, name: profile.name, avatarKey: profile.avatarKey || 'glyph-01',
    colorKey: profile.colorKey || 'ember', type, hasPin: profile.hasPin === true,
    isGuest: type === 'guest', sortOrder: Number(profile.sortOrder) || sortOrder,
    ...(profile.lastUsedAt === undefined ? {} : { lastUsedAt: profile.lastUsedAt }) };
}

function legacyActive(active) {
  return { profileId: active.profileId || null, selectionRequired: !active.profileId,
    selectionRevision: Number(active.selectionRevision) || 0, automaticSignIn: active.automaticSignIn === true };
}

function collection(items, projection = legacyMediaItem) {
  return {
    movies: items.filter((item) => !item.animeLikely && item.kind !== 'episode').map(projection),
    tvShows: items.filter((item) => !item.animeLikely && item.kind === 'episode').map(projection),
    animeShows: items.filter((item) => item.animeLikely).map(projection),
    others: [],
  };
}

function revisionFor(items) {
  return items.reduce((latest, item) => Math.max(latest, Number(item.updatedAt || item.indexedAt) || 0), 0);
}

function legacyPreferences(preferences) {
  return {
    ...(preferences.themeMode ? { appThemeMode: preferences.themeMode } : {}),
    ...(preferences.themeColor ? { appThemeColor: preferences.themeColor } : {}),
    ...(preferences.skipBackSeconds !== undefined ? { playbackSkipBackSeconds: preferences.skipBackSeconds } : {}),
    ...(preferences.skipForwardSeconds !== undefined ? { playbackSkipForwardSeconds: preferences.skipForwardSeconds } : {}),
    ...(preferences.autoplayNextEnabled !== undefined ? { autoplayNextEnabled: preferences.autoplayNextEnabled } : {}),
  };
}

function canonicalPreferences(input) {
  return {
    ...(input.appThemeMode !== undefined ? { themeMode: input.appThemeMode } : {}),
    ...(input.appThemeColor !== undefined ? { themeColor: input.appThemeColor } : {}),
    ...(input.playbackSkipBackSeconds !== undefined ? { skipBackSeconds: input.playbackSkipBackSeconds } : {}),
    ...(input.playbackSkipForwardSeconds !== undefined ? { skipForwardSeconds: input.playbackSkipForwardSeconds } : {}),
    ...(input.autoplayNextEnabled !== undefined ? { autoplayNextEnabled: input.autoplayNextEnabled === true } : {}),
  };
}

const HIDDEN_LIBRARY_ITEM_ERRORS = new Set([
  'permission_denied', 'profile_forbidden',
]);

const UNAVAILABLE_LIBRARY_ITEM_ERRORS = new Set([
  'source_unavailable', 'media_root_unavailable',
  'media_path_unavailable', 'media_path_escape', 'media_path_not_a_file',
  'media_path_substituted',
]);

function legacyOptionUnsupported(message) {
  return Object.assign(new Error(message), { status: 422, code: 'legacy_option_unsupported' });
}

function legacyTrackId(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < -1 || value > 65_535) {
    throw Object.assign(new Error(`${field} must be -1 or a non-negative stream index.`), { status: 400, code: 'invalid_request' });
  }
  return value === -1 ? null : `stream:${value}`;
}

export function createLegacyV2CompatibilityHandler({ authorizeLegacyPairing, getCertificateFingerprint, clientAddress } = {}) {
  return async function legacyV2(req, res, context) {
    const url = new URL(req.url || '/', `https://${req.headers.host || 'loomtv.local'}`);
    if (!url.pathname.startsWith('/api/v2/') && url.pathname !== '/stream' && !url.pathname.startsWith('/hls/')) return false;
    const { adminService, clientState, mediaService, pairingService } = context;
    try {
      if (url.pathname.startsWith('/hls/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const match = url.pathname.match(/^\/hls\/([^/]+)\/(index\.m3u8|segment-\d+\.ts)$/);
        if (!match) return response(res, 404, { error: 'not_found' });
        await mediaService.handle(req, res, new URL(`/api/media/transcode/${encodeURIComponent(decodeURIComponent(match[1]))}/${match[2]}?${url.searchParams}`, 'https://loomtv.local'));
        return true;
      }
      if (url.pathname === '/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
        const credential = pairingService.authorizeLegacyStreamCapability({
          deviceId: url.searchParams.get('deviceId'), mediaId: url.searchParams.get('mediaId'),
          profileId: url.searchParams.get('profileId'), selectionRevision: url.searchParams.get('selectionRevision'),
          sourceId: url.searchParams.get('sourceId'), fileVersion: url.searchParams.get('fileVersion'),
          authenticationSessionId: url.searchParams.get('authenticationSessionId'),
          expiresAt: url.searchParams.get('expiresAt'), signature: url.searchParams.get('signature'),
        });
        if (!credential) return response(res, 401, { error: 'stream_token_invalid' });
        const account = await adminService.getPrincipalById(credential.accountId);
        const streamPrincipal = account ? { ...account, authentication: 'legacy-stream-capability',
          deviceId: credential.deviceId, devicePermissions: [...credential.permissions] } : null;
        if (!streamPrincipal || !hasPermission(streamPrincipal, 'stream')) return response(res, 403, { error: 'permission_denied' });
        const address = typeof clientAddress === 'function' ? clientAddress(req) : req.socket?.remoteAddress;
        if (!isLocalNetworkAddress(address) && !hasPermission(streamPrincipal, 'remote.access')) {
          return response(res, 403, { error: 'remote_access_disabled' });
        }
        const authenticationSessionId = url.searchParams.get('authenticationSessionId');
        if (authenticationSessionId
          && !await adminService.isSessionActive(authenticationSessionId, streamPrincipal.id, credential.deviceId)) {
          return response(res, 401, { error: 'stream_token_invalid' });
        }
        const mediaId = url.searchParams.get('mediaId');
        const item = await adminService.getLibraryItem(mediaId, streamPrincipal);
        if (!item) return response(res, 404, { error: 'media_not_found' });
        const contextForStream = await clientState.requireActivePlaybackProfile(streamPrincipal.id, credential.deviceId, item);
        if (contextForStream.profileId !== url.searchParams.get('profileId')
          || contextForStream.selectionRevision !== Number(url.searchParams.get('selectionRevision'))) {
          return response(res, 409, { error: 'stale_profile_selection' });
        }
        await mediaService.serveDirectCapability(req, res, {
          itemId: mediaId, principal: streamPrincipal, profileContext: contextForStream,
          sourceId: url.searchParams.get('sourceId'), fileVersion: url.searchParams.get('fileVersion'),
        });
        return true;
      }
      if (url.pathname === '/api/v2/pair' && req.method === 'POST') {
        const input = await body(req);
        if (!getCertificateFingerprint?.()) return response(res, 409, {
          error: 'certificate_fingerprint_unavailable',
          message: 'Legacy pairing requires a configured certificate fingerprint.',
        });
        if (input.approvalRequested !== true && typeof authorizeLegacyPairing !== 'function') return response(res, 410, {
          error: 'pin_pairing_retired', message: 'Request approval from the LoomTV host to pair this device.',
        });
        const address = typeof clientAddress === 'function' ? clientAddress(req) : req.socket?.remoteAddress;
        const requested = await pairingService.request({
          name: input.deviceName, kind: input.kind || input.platform || 'legacy',
          certificateFingerprint: input.certificateFingerprint, address,
        });
        if (input.approvalRequested === true) return response(res, 202, requested);
        const authorized = await authorizeLegacyPairing({
          code: String(input.code || ''), deviceName: String(input.deviceName || ''),
          address: address || '', requestId: requested.requestId,
        });
        if (!authorized) {
          await pairingService.deny(requested.requestId).catch(() => undefined);
          return response(res, 401, { error: 'The sharing code was not accepted.' });
        }
        const approval = authorized === true ? {} : authorized;
        const owner = await adminService.getOwnerPrincipal();
        if (!owner) return response(res, 409, { error: 'owner_required' });
        await pairingService.approve(requested.requestId, {
          approved: true, accountId: approval.accountId || owner.id, permissions: approval.permissions,
        }, owner);
        const result = await pairingService.status(requested.requestId, requested.requestSecret, address);
        const credentialToken = `${result.credential.id}.${result.credential.secret}`;
        const credential = await pairingService.authenticate(`LoomDevice ${credentialToken}`);
        const session = await adminService.issueDeviceSession(credential);
        const emptyLibrary = { movies: [], tvShows: [], animeShows: [], others: [] };
        return response(res, 200, { ok: true, deviceId: result.deviceId, accessToken: session.adminToken,
          accessTokenExpiresAt: session.expiresAt, refreshToken: credentialToken,
          refreshTokenExpiresAt: result.credentialExpiresAt, scopes: legacyScopes(result.permissions),
          certFingerprint: result.certificateFingerprint, library: emptyLibrary,
          libraryEtag: createHash('sha256').update(JSON.stringify(emptyLibrary)).digest('hex') });
      }
      if (url.pathname === '/api/v2/pair/status' && req.method === 'POST') {
        const input = await body(req);
        const address = typeof clientAddress === 'function' ? clientAddress(req) : req.socket?.remoteAddress;
        const result = await pairingService.status(input.requestId, input.requestSecret, address);
        if (result.status === 'pending') return response(res, 202, result);
        if (result.status === 'denied') return response(res, 403, { ...result, error: 'The host denied this connection.' });
        if (result.status === 'expired') return response(res, 410, { ...result, error: 'Pairing approval expired.' });
        if (result.status !== 'approved') return response(res, 409, { status: result.status, error: 'Pairing approval is unavailable.' });
        const credentialToken = `${result.credential.id}.${result.credential.secret}`;
        const credential = await pairingService.authenticate(`LoomDevice ${credentialToken}`);
        if (!credential) throw Object.assign(new Error('The approved device credential is unavailable.'), { status: 401, code: 'device_revoked' });
        const session = await adminService.issueDeviceSession(credential);
        const emptyLibrary = { movies: [], tvShows: [], animeShows: [], others: [] };
        return response(res, 200, {
          ok: true, deviceId: result.deviceId, accessToken: session.adminToken,
          accessTokenExpiresAt: session.expiresAt, refreshToken: credentialToken,
          refreshTokenExpiresAt: result.credentialExpiresAt, scopes: legacyScopes(result.permissions),
          certFingerprint: result.certificateFingerprint,
          library: emptyLibrary,
          libraryEtag: createHash('sha256').update(JSON.stringify(emptyLibrary)).digest('hex'),
        });
      }
      if (url.pathname === '/api/v2/auth/refresh' && req.method === 'POST') {
        const input = await body(req);
        const credential = await pairingService.authenticate(`LoomDevice ${String(input.refreshToken || '')}`);
        if (!credential) throw Object.assign(new Error('Refresh credential is invalid or revoked.'), { status: 401, code: 'device_revoked' });
        const session = await adminService.issueDeviceSession(credential);
        return response(res, 200, { accessToken: session.adminToken, accessTokenExpiresAt: session.expiresAt,
          refreshToken: input.refreshToken, refreshTokenExpiresAt: credential.expiresAt, scopes: legacyScopes(credential.permissions) });
      }

      const principal = await adminService.authenticateRequest(req);
      if (!principal) return response(res, 401, { error: 'auth_required' });
      const deviceId = principal.deviceId || `account:${principal.id}`;
      const canSeeAll = hasPermission(principal, 'users.manage');

      if (url.pathname === '/api/v2/unpair' && req.method === 'POST') {
        await body(req);
        const result = await pairingService.revokeSelf(deviceId, principal);
        await adminService.revokeDeviceSessions?.(deviceId);
        await clientState.revokeDeviceAccess?.(deviceId);
        await mediaService.revokeDevice?.(deviceId);
        return response(res, 200, { ok: true, device: result.device });
      }
      if (!hasPermission(principal, 'library.read')) return response(res, 403, { error: 'permission_denied' });

      const active = await clientState.getActiveProfileState(principal.id, deviceId);
      const requireActive = () => {
        if (!active.profileId) throw Object.assign(new Error('Select a profile first.'), { status: 409, code: 'profile_required' });
        if (active.locked) throw Object.assign(new Error('The active profile is locked.'), { status: 403, code: 'profile_locked' });
        return active.profileId;
      };
      const visibleItems = async () => {
        requireActive();
        const items = await adminService.listLibraryItems(principal);
        const visible = [];
        const origin = requestOrigin(req);
        for (const item of items) {
          try {
            const profileContext = await clientState.requireActivePlaybackProfile(principal.id, deviceId, item);
            const binding = await mediaService.describeDirectCapability(item.id, principal, profileContext);
            const capability = pairingService.issueLegacyStreamCapability({
              deviceId, mediaId: item.id, profileId: profileContext.profileId,
              selectionRevision: profileContext.selectionRevision,
              authenticationSessionId: principal.sessionId, ...binding,
            });
            const query = new URLSearchParams(Object.fromEntries(Object.entries(capability).map(([key, value]) => [key, String(value)])));
            query.set('resourceId', item.id);
            visible.push({ ...item, legacyStreamUrl: `${origin}/stream?${query}` });
          } catch (error) {
            if (HIDDEN_LIBRARY_ITEM_ERRORS.has(error?.code)) continue;
            if (UNAVAILABLE_LIBRARY_ITEM_ERRORS.has(error?.code)) {
              // The v2 media schema has no availability field. Keep the record
              // decoder-valid with an empty, non-playable filePath so an
              // offline source does not look like a catalog deletion.
              visible.push({ ...item, legacyStreamUrl: '' });
              continue;
            }
            throw error;
          }
        }
        return visible;
      };

      if (url.pathname === '/api/v2/client-config' && req.method === 'GET') {
        const preferences = active.profileId ? await clientState.getProfilePreferences(active.profileId, principal.id, canSeeAll) : {};
        return response(res, 200, { profileApiVersion: 1, mediaCoreContractVersion: MEDIA_CORE_CONTRACT_VERSION,
          capabilities: { profiles: true, profileCreation: true, profilePins: true, kidsRestrictions: true,
            profilePreferences: true, profileLists: true, playbackPlan: true }, ...legacyPreferences(preferences) });
      }
      if (url.pathname === '/api/v2/profiles' && req.method === 'GET') {
        return response(res, 200, { profiles: (await clientState.listProfiles(principal.id, canSeeAll)).map(legacyProfile) });
      }
      if (url.pathname === '/api/v2/profiles' && req.method === 'POST') {
        const input = await body(req);
        const profile = await clientState.createProfile(input, principal.id);
        return response(res, 201, { profile: legacyProfile(profile),
          profiles: (await clientState.listProfiles(principal.id, canSeeAll)).map(legacyProfile) });
      }
      if (url.pathname === '/api/v2/profiles/active' && req.method === 'GET') return response(res, 200, legacyActive(active));
      if (url.pathname === '/api/v2/profiles/select' && req.method === 'POST') {
        const input = await body(req);
        const profile = await clientState.selectProfile(input.profileId, principal.id, false, deviceId, input.pin, req.socket?.remoteAddress);
        return response(res, 200, { profile: legacyProfile(profile), active: legacyActive(await clientState.getActiveProfileState(principal.id, deviceId)) });
      }
      if (url.pathname === '/api/v2/profiles/lock' && req.method === 'POST') {
        await body(req);
        return response(res, 200, legacyActive(await clientState.lockActiveProfile(principal.id, deviceId)));
      }
      if (url.pathname === '/api/v2/profiles/auto-sign-in' && req.method === 'POST') {
        const input = await body(req);
        return response(res, 200, legacyActive(await clientState.setAutomaticSignIn(principal.id, deviceId, input.enabled)));
      }
      if (url.pathname === '/api/v2/profile-preferences') {
        const profileId = requireActive();
        if (req.method === 'GET') return response(res, 200, legacyPreferences(await clientState.getProfilePreferences(profileId, principal.id, canSeeAll)));
        if (req.method === 'PATCH') {
          const input = await body(req);
          await clientState.assertSelectionRevision(principal.id, deviceId, input.selectionRevision);
          return response(res, 200, legacyPreferences(await clientState.saveProfilePreferences(profileId, canonicalPreferences(input), principal.id, canSeeAll)));
        }
      }
      if (url.pathname === '/api/v2/profile-lists') {
        const profileId = requireActive();
        if (req.method === 'GET') return response(res, 200, await clientState.getProfileLists(profileId, url.searchParams.get('kind') || undefined, principal.id, canSeeAll));
        if (req.method === 'PUT' || req.method === 'DELETE') {
          const input = await body(req);
          await clientState.assertSelectionRevision(principal.id, deviceId, input.selectionRevision);
          if (req.method === 'PUT' && !await adminService.getLibraryItem(input.mediaId, principal)) return response(res, 404, { error: 'media_not_found' });
          return response(res, 200, await clientState.setProfileListEntry(profileId, input.mediaId, input.kind, req.method === 'PUT', principal.id, canSeeAll));
        }
      }
      if (url.pathname === '/api/v2/progress' && req.method === 'GET') {
        return response(res, 200, await clientState.listProgress(requireActive(), principal.id, canSeeAll));
      }
      if (url.pathname === '/api/v2/progress' && req.method === 'POST') {
        const input = await body(req);
        await clientState.assertSelectionRevision(principal.id, deviceId, input.selectionRevision);
        const profileId = requireActive();
        const item = await adminService.getLibraryItem(input.mediaId, principal);
        if (!item) return response(res, 404, { error: 'media_not_found' });
        await clientState.requireActivePlaybackProfile(principal.id, deviceId, item);
        return response(res, 200, await clientState.saveProgress(profileId, input.mediaId, input, principal.id, canSeeAll));
      }
      if (url.pathname === '/api/v2/playback-track-preferences') {
        const profileId = requireActive();
        if (req.method === 'GET') return response(res, 200, await clientState.getTrackPreferences(profileId, url.searchParams.get('scope') || '', principal.id, canSeeAll));
        if (req.method === 'POST') {
          const input = await body(req);
          await clientState.assertSelectionRevision(principal.id, deviceId, input.selectionRevision);
          return response(res, 200, await clientState.saveTrackPreferences(profileId, input.scope, input.preferences, principal.id, canSeeAll));
        }
      }
      if (url.pathname === '/api/v2/library' && req.method === 'GET') return response(res, 200, collection(await visibleItems()));
      if (url.pathname === '/api/v2/library/index' && req.method === 'GET') {
        const items = await visibleItems();
        return response(res, 200, { catalogVersion: 1, revision: revisionFor(items), ...collection(items, legacyCard) });
      }
      if (url.pathname.startsWith('/api/v2/library/items/') && req.method === 'GET') {
        const mediaId = decodeURIComponent(url.pathname.slice('/api/v2/library/items/'.length));
        const item = (await visibleItems()).find((entry) => entry.id === mediaId);
        return item ? response(res, 200, { catalogVersion: 1, revision: revisionFor([item]), item: legacyMediaItem(item) })
          : response(res, 404, { error: 'media_not_found' });
      }
      if (url.pathname === '/api/v2/playback-plan' && req.method === 'POST') {
        const input = await body(req);
        await clientState.assertSelectionRevision(principal.id, deviceId, input.selectionRevision);
        const profileContext = {
          ...(await clientState.requireActivePlaybackProfile(principal.id, deviceId)),
          remoteAccess: hasPermission(principal, 'remote.access'),
          ...(principal.sessionId ? { authenticationSessionId: principal.sessionId } : {}),
        };
        const capabilities = normalizeClientPlaybackCapabilities(input.capabilities || {});
        const result = await mediaService.planPlayback(input.mediaId, { sourceId: input.sourceId, capabilities,
          videoTrackId: input.videoTrackId, audioTrackId: input.audioTrackId, subtitleTrackId: input.subtitleTrackId }, principal, profileContext);
        const legacyPlan = { mode: result.plan.mode, reason: result.plan.reasonCode,
          sourceAction: result.plan.mode === 'direct' ? 'direct' : 'transcode',
          ...(result.plan.outputVideoCodec ? { codec: result.plan.outputVideoCodec } : {}) };
        return response(res, 200, { ok: true, data: { mediaCoreContractVersion: MEDIA_CORE_CONTRACT_VERSION,
          capabilities, plan: legacyPlan } });
      }
      if (url.pathname === '/api/v2/start-hls' && req.method === 'POST') {
        const input = await body(req);
        const options = input.options && typeof input.options === 'object' ? input.options : {};
        if (options.targetVideoCodec && options.targetVideoCodec !== 'h264') {
          throw legacyOptionUnsupported('Canonical MPEG-TS HLS supports H.264 video only.');
        }
        if (options.preset && options.preset !== 'auto') {
          throw legacyOptionUnsupported('A fixed legacy transcoder backend cannot be guaranteed by the canonical planner.');
        }
        if (options.subtitleFilePath) {
          throw legacyOptionUnsupported('Legacy external subtitle files are not accepted by the canonical server.');
        }
        if (options.subtitleStyle !== undefined) {
          const style = options.subtitleStyle;
          const unsupportedKeys = !style || typeof style !== 'object' || Array.isArray(style)
            ? ['subtitleStyle'] : Object.keys(style).filter((key) => key !== 'fontSize');
          if (unsupportedKeys.length || (style.fontSize !== undefined
            && (!Number.isFinite(style.fontSize) || style.fontSize <= 0 || style.fontSize > 128))) {
            throw legacyOptionUnsupported('Only a bounded embedded-subtitle font size is supported.');
          }
        }
        if (options.subtitleCodec !== undefined
          && (typeof options.subtitleCodec !== 'string' || options.subtitleCodec.length > 64 || options.subtitleCodec.includes('\0'))) {
          throw Object.assign(new Error('subtitleCodec must be a bounded codec hint.'), { status: 400, code: 'invalid_request' });
        }
        if (options.subtitleStreamOrdinal !== undefined && options.subtitleTrackIndex === undefined) {
          throw legacyOptionUnsupported('A subtitle ordinal requires its canonical stream index.');
        }
        const audioTrackId = legacyTrackId(options.audioTrackIndex, 'audioTrackIndex');
        const subtitleTrackId = legacyTrackId(options.subtitleTrackIndex, 'subtitleTrackIndex');
        await clientState.assertSelectionRevision(principal.id, deviceId, input.selectionRevision);
        if (!hasPermission(principal, 'transcode')) return response(res, 403, { ok: false, code: 'permission_denied', error: 'Transcoding is not allowed.' });
        const profileContext = await clientState.requireActivePlaybackProfile(principal.id, deviceId);
        const capabilities = normalizeClientPlaybackCapabilities({
          ...(input.capabilities || {}),
          containers: ['mpegts'], videoCodecs: ['h264'], audioCodecs: ['aac'],
          streamingProtocols: ['hls'],
          ...(options.maxWidth !== undefined ? { maxWidth: options.maxWidth } : {}),
          ...(options.maxHeight !== undefined ? { maxHeight: options.maxHeight } : {}),
          ...(options.videoBitrateKbps !== undefined ? { maxVideoBitrateKbps: options.videoBitrateKbps } : {}),
          ...(options.toneMap === true ? { supportsHdr: false, hdrFormats: [] } : {}),
        });
        const planned = await mediaService.planPlayback(input.mediaId, {
          sourceId: input.sourceId,
          capabilities,
          audioTrackId, subtitleTrackId,
        }, principal, profileContext);
        if (options.subtitleStreamOrdinal !== undefined
          && (!Number.isSafeInteger(options.subtitleStreamOrdinal) || options.subtitleStreamOrdinal < 0
            || planned.plan.selectedSubtitleTrackOrdinal !== options.subtitleStreamOrdinal)) {
          throw legacyOptionUnsupported('The subtitle stream ordinal does not match the selected canonical subtitle stream.');
        }
        if (options.audioBitrateKbps !== undefined
          && (!Number.isFinite(options.audioBitrateKbps) || Number(options.audioBitrateKbps) < 0)) {
          throw Object.assign(new Error('audioBitrateKbps must be a non-negative number.'), { status: 400, code: 'invalid_request' });
        }
        const boundedAudioBitrate = !options.audioBitrateKbps
          ? planned.plan.audioBitrateKbps
          : Math.max(32, Math.min(1_024, Math.round(Number(options.audioBitrateKbps))));
        const executionPlan = {
          ...planned.plan, audioBitrateKbps: boundedAudioBitrate,
          ...(options.subtitleStyle?.fontSize !== undefined
            ? { subtitleFontSize: Math.max(1, Math.min(128, Math.round(options.subtitleStyle.fontSize))) } : {}),
        };
        const plan = mediaService.issueTranscodePlan(input.mediaId, principal.id, executionPlan, planned.probe,
          { startSeconds: options.startSeconds }, { ...profileContext, sourceId: planned.plan.sourceId, fileId: planned.sourceIdentity.fileId }, planned.sourceIdentity);
        const session = await mediaService.startTranscodePlan(input.mediaId, plan.token, principal);
        const playlistUrl = new URL(session.playlistUrl.replace('/api/media/transcode/', '/hls/'), requestOrigin(req)).href;
        const legacyPreset = ['software', 'videotoolbox', 'nvenc', 'qsv', 'vaapi', 'amf', 'rkmpp'].includes(session.backend)
          ? session.backend : undefined;
        const legacyCodec = ['h264', 'hevc', 'av1'].includes(session.codec) ? session.codec : undefined;
        return response(res, 202, { ok: true, data: {
          sessionId: session.sessionId, filePath: String(input.mediaId), playlistUrl,
          outputDir: session.sessionId, seekable: true,
          startSeconds: Math.max(0, Math.min(86_400, Number(options.startSeconds) || 0)),
          ...(legacyPreset ? { preset: legacyPreset } : {}), ...(legacyCodec ? { codec: legacyCodec } : {}),
        } });
      }
      if (['/api/v2/artwork/official-candidates', '/api/v2/artwork/apply-official', '/api/v2/playback/segments'].includes(url.pathname)) {
        return response(res, 410, { error: 'legacy_route_retired', replacement: 'No canonical provider-metadata or segment contract is available.' });
      }
      return response(res, 404, { error: 'not_found' });
    } catch (error) {
      return response(res, Number.isInteger(error?.status) ? error.status : 500, {
        error: error?.code || 'request_failed',
        message: Number(error?.status) >= 500 ? 'The compatibility request could not be completed.' : error?.message,
        ...(error?.retryAfter ? { retryAfter: error.retryAfter } : {}),
      }, error?.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
    }
  };
}
