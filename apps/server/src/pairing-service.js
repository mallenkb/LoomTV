import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { AUTH_PERMISSIONS, hasPermission, isLocalNetworkAddress, isOwnerPrincipal } from './auth-policy.js';

const REQUEST_TTL_MS = 5 * 60 * 1000;
const CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_ADDRESS = 8;
const MAX_STATUS_FAILURES_PER_ADDRESS = 32;
const REMOTE_DEVICE_PERMISSIONS = Object.freeze([
  'library.read', 'stream', 'transcode', 'downloads', 'remote.access',
]);
const DEFAULT_DEVICE_PERMISSIONS = Object.freeze(['library.read', 'stream', 'transcode', 'downloads']);

function pairingError(status, code, message, details = {}) {
  return Object.assign(new Error(message), { status, code, ...details });
}

function hashSecret(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

function safeEqual(left, right) {
  const actual = Buffer.from(String(left || ''), 'utf8');
  const expected = Buffer.from(String(right || ''), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function envelopeKey(requestSecret) {
  return createHash('sha256').update('loomtv-pairing-envelope-v1\0').update(requestSecret).digest();
}

function encryptCredentialSecret(requestSecret, credentialSecret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', envelopeKey(requestSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(credentialSecret, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptCredentialSecret(requestSecret, encrypted) {
  const decipher = createDecipheriv('aes-256-gcm', envelopeKey(requestSecret), Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function normalizeFingerprint(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).replaceAll(':', '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw pairingError(400, 'invalid_request', 'The certificate fingerprint is invalid.');
  return normalized;
}

function normalizePermissions(value, fallback = DEFAULT_DEVICE_PERMISSIONS) {
  const source = Array.isArray(value) ? value : fallback;
  const permissions = [...new Set(source.filter((entry) => typeof entry === 'string' && REMOTE_DEVICE_PERMISSIONS.includes(entry)))];
  if (Array.isArray(value) && permissions.length !== value.length) {
    throw pairingError(400, 'invalid_request', 'The requested device permissions are invalid.');
  }
  return permissions;
}

function publicDevice(device) {
  return {
    id: device.id,
    accountId: device.accountId,
    name: device.name,
    kind: device.kind,
    permissions: [...(device.permissions || [])],
    disabled: device.disabled === true,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }),
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt, revokedReason: device.revokedReason }),
    ...(device.certificateFingerprint ? { certificateFingerprint: device.certificateFingerprint } : {}),
  };
}

export function createPairingService({ store, getAccount, getCertificateFingerprint = () => undefined, clock = Date.now }) {
  if (!store) throw new Error('Pairing service requires canonical state.');
  const requestBuckets = new Map();
  const statusFailureBuckets = new Map();

  function addressKey(address) {
    return hashSecret(`pairing-address\0${String(address || 'unknown')}`);
  }

  function consumeRate(bucketMap, address, limit) {
    const now = clock();
    const key = addressKey(address);
    const current = bucketMap.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + RATE_WINDOW_MS } : current;
    bucket.count += 1;
    bucketMap.set(key, bucket);
    if (bucket.count > limit) throw pairingError(429, 'rate_limited', 'Too many pairing attempts. Try again later.', {
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    });
  }

  function certificateForRequest(value) {
    const supplied = normalizeFingerprint(value);
    const advertised = normalizeFingerprint(getCertificateFingerprint?.());
    if (supplied && advertised && !safeEqual(supplied, advertised)) {
      throw pairingError(409, 'certificate_fingerprint_mismatch', 'The server certificate changed before pairing.');
    }
    return supplied || advertised;
  }

  return {
    async request(input = {}) {
      consumeRate(requestBuckets, input.address, MAX_REQUESTS_PER_ADDRESS);
      const now = clock();
      const requestSecret = randomBytes(32).toString('base64url');
      const credentialSecret = randomBytes(32).toString('base64url');
      const encrypted = encryptCredentialSecret(requestSecret, credentialSecret);
      const name = String(input.name || input.deviceName || 'LoomTV device').trim().slice(0, 80) || 'LoomTV device';
      const kind = String(input.kind || input.platform || 'unknown').trim().toLowerCase().slice(0, 32) || 'unknown';
      const permissions = normalizePermissions(input.permissions);
      if (!isLocalNetworkAddress(input.address) && !permissions.includes('remote.access')) {
        throw pairingError(403, 'remote_access_disabled', 'Remote pairing must explicitly request remote access for approval.');
      }
      const request = {
        id: randomUUID(), deviceId: randomUUID(), credentialId: randomUUID(),
        requestSecretHash: hashSecret(requestSecret), credentialSecretHash: hashSecret(credentialSecret),
        credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag,
        name, kind, permissions, certificateFingerprint: certificateForRequest(input.certificateFingerprint),
        createdAt: now, expiresAt: now + REQUEST_TTL_MS,
      };
      store.createPairingRequest(request);
      return { requestId: request.id, requestSecret, status: 'pending', expiresAt: request.expiresAt };
    },

    async status(requestId, requestSecret, address = '') {
      if (!requestId || !requestSecret) throw pairingError(404, 'not_found', 'Pairing request was not found.');
      const record = store.readPairingRequest(String(requestId));
      if (!record || !safeEqual(record.requestSecretHash, hashSecret(requestSecret))) {
        consumeRate(statusFailureBuckets, address, MAX_STATUS_FAILURES_PER_ADDRESS);
        throw pairingError(404, 'not_found', 'Pairing request was not found.');
      }
      if (record.state === 'pending') {
        if (record.expiresAt <= clock()) {
          store.consumePairingRequest(record.id, record.requestSecretHash, clock());
          return { status: 'expired', expiresAt: record.expiresAt };
        }
        return { status: 'pending', expiresAt: record.expiresAt };
      }
      if (record.state !== 'approved' && record.state !== 'denied') {
        throw pairingError(404, 'not_found', 'Pairing request was not found.');
      }
      let credentialSecret;
      if (record.state === 'approved') {
        try {
          credentialSecret = decryptCredentialSecret(requestSecret, {
            ciphertext: record.credentialCiphertext, iv: record.credentialIv, tag: record.credentialTag,
          });
        } catch {
          throw pairingError(409, 'pairing_credential_unavailable', 'The approved device credential could not be recovered. Pair again.');
        }
        if (!safeEqual(hashSecret(credentialSecret), record.credentialSecretHash)) {
          throw pairingError(409, 'pairing_credential_unavailable', 'The approved device credential could not be recovered. Pair again.');
        }
      }
      const result = store.consumePairingRequest(record.id, record.requestSecretHash, clock());
      if (!result) throw pairingError(404, 'not_found', 'Pairing request was not found.');
      if (result.state === 'denied') return { status: 'denied' };
      if (result.state !== 'approved') return result;
      const issuedCredential = store.readDeviceCredential(result.credentialId);
      return {
        status: 'approved', deviceId: result.deviceId, accountId: result.accountId,
        credential: { id: result.credentialId, secret: credentialSecret, scheme: 'LoomDevice' },
        credentialExpiresAt: issuedCredential?.expiresAt,
        permissions: result.permissions,
        ...(result.certificateFingerprint ? { certificateFingerprint: result.certificateFingerprint } : {}),
      };
    },

    async approve(requestId, input, approver) {
      const record = store.readPairingRequest(String(requestId || ''));
      if (!record) throw pairingError(404, 'not_found', 'Pairing request was not found.');
      const accountId = String(input?.accountId || approver?.id || '').trim();
      const account = await getAccount?.(accountId);
      if (!account) throw pairingError(404, 'account_not_found', 'The target account is unavailable or disabled.');
      const requested = normalizePermissions(record.requestedPermissions);
      const permissions = normalizePermissions(input?.permissions, requested);
      if (permissions.some((permission) => !requested.includes(permission))) {
        throw pairingError(400, 'invalid_request', 'Approval cannot add permissions the device did not request.');
      }
      if (!isOwnerPrincipal(account) && permissions.some((permission) => !hasPermission(account, permission))) {
        throw pairingError(403, 'permission_denied', 'The target account does not have every approved device permission.');
      }
      if (input?.approved === false) {
        store.denyPairingRequest(record.id, clock());
        return { requestId: record.id, status: 'denied' };
      }
      const approved = store.approvePairingRequest({
        requestId: record.id, accountId, permissions, approvedAt: clock(),
        credentialExpiresAt: clock() + CREDENTIAL_TTL_MS,
      });
      return { requestId: record.id, status: 'approved', device: publicDevice({
        id: approved.deviceId, accountId: approved.accountId, name: record.name, kind: record.kind,
        permissions: approved.permissions, certificateFingerprint: approved.certificateFingerprint,
        disabled: false, createdAt: approved.createdAt, updatedAt: approved.createdAt,
      }) };
    },

    async deny(requestId) {
      store.denyPairingRequest(String(requestId || ''), clock());
      return { requestId: String(requestId || ''), status: 'denied' };
    },

    async authenticate(authorization) {
      const match = /^LoomDevice\s+([A-Za-z0-9._-]{1,128})\.([A-Za-z0-9_-]{32,256})$/.exec(String(authorization || '').trim());
      if (!match) return null;
      const credential = store.readDeviceCredential(match[1]);
      if (!credential || credential.disabled || credential.revokedAt || credential.expiresAt <= clock()
        || credential.algorithm !== 'sha256' || !safeEqual(credential.secretHash, hashSecret(match[2]))) return null;
      store.touchDevice(credential.deviceId, clock());
      return credential;
    },

    async resolveBoundDevice(accountId, deviceId) {
      if (!accountId || !deviceId) return null;
      return store.resolveBoundDevice(accountId, deviceId);
    },

    async resolveSessionDevice(accountId, deviceId) {
      if (!accountId || !deviceId) return null;
      const credential = store.readDeviceCredentialForDevice(deviceId);
      if (!credential || credential.accountId !== accountId || credential.expiresAt <= clock()
        || credential.disabled || credential.revokedAt) return null;
      return {
        id: credential.id, deviceId: credential.deviceId, accountId: credential.accountId,
        permissions: [...credential.permissions], expiresAt: credential.expiresAt,
      };
    },

    issueLegacyStreamCapability({
      deviceId, mediaId, profileId, selectionRevision, sourceId, fileVersion,
      authenticationSessionId = '', ttlMs = 15 * 60 * 1000,
    }) {
      const credential = store.readDeviceCredentialForDevice(deviceId);
      if (!credential || credential.disabled || credential.revokedAt || credential.expiresAt <= clock()) {
        throw pairingError(401, 'device_revoked', 'The device credential is unavailable or revoked.');
      }
      if (!sourceId || !/^[A-Za-z0-9_-]{43}$/.test(String(fileVersion || ''))) {
        throw pairingError(409, 'source_unavailable', 'The media source identity is unavailable.');
      }
      const expiresAt = Math.min(credential.expiresAt, clock() + Math.max(1_000, Math.min(15 * 60 * 1000, ttlMs)));
      const payload = [deviceId, mediaId, profileId, String(selectionRevision), sourceId, fileVersion,
        authenticationSessionId, String(expiresAt)].join('\0');
      const signature = createHmac('sha256', credential.secretHash).update(payload).digest('base64url');
      return { deviceId, mediaId, profileId, selectionRevision, sourceId, fileVersion,
        ...(authenticationSessionId ? { authenticationSessionId } : {}), expiresAt, signature };
    },

    authorizeLegacyStreamCapability(input) {
      const expiresAt = Number(input?.expiresAt);
      const selectionRevision = Number(input?.selectionRevision);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= clock() || expiresAt > clock() + 15 * 60 * 1000 + 5_000
        || !Number.isSafeInteger(selectionRevision) || selectionRevision < 0
        || !input?.sourceId || !/^[A-Za-z0-9_-]{43}$/.test(String(input?.fileVersion || ''))) return null;
      const credential = store.readDeviceCredentialForDevice(String(input.deviceId || ''));
      if (!credential || credential.disabled || credential.revokedAt || credential.expiresAt <= clock()) return null;
      const payload = [input.deviceId, input.mediaId, input.profileId, String(selectionRevision), input.sourceId, input.fileVersion,
        input.authenticationSessionId || '', String(expiresAt)].join('\0');
      const expected = createHmac('sha256', credential.secretHash).update(payload).digest('base64url');
      return safeEqual(expected, input.signature) ? credential : null;
    },

    async list(principal) {
      if (!hasPermission(principal, 'devices.manage')) throw pairingError(403, 'permission_denied', 'Device management permission is required.');
      return store.listDevices().map(publicDevice);
    },

    async revoke(deviceId, principal, reason = 'device_revoked') {
      if (!hasPermission(principal, 'devices.manage')) throw pairingError(403, 'permission_denied', 'Device management permission is required.');
      const device = store.listDevices().find((entry) => entry.id === deviceId);
      if (!device) throw pairingError(404, 'not_found', 'Device was not found.');
      const revoked = store.revokeDevice(deviceId, reason, clock());
      return { ...revoked, device: publicDevice(store.listDevices().find((entry) => entry.id === deviceId)) };
    },

    async revokeSelf(deviceId, principal, reason = 'device_revoked') {
      const device = store.listDevices().find((entry) => entry.id === deviceId);
      if (!device || device.accountId !== principal?.id || principal?.deviceId !== deviceId) {
        throw pairingError(403, 'permission_denied', 'The authenticated device cannot revoke that credential.');
      }
      const revoked = store.revokeDevice(deviceId, reason, clock());
      return { ...revoked, device: publicDevice(store.listDevices().find((entry) => entry.id === deviceId)) };
    },

    credentialHeader(credential) {
      if (!credential?.id || !credential?.secret) throw pairingError(400, 'invalid_request', 'Device credential is incomplete.');
      return `LoomDevice ${credential.id}.${credential.secret}`;
    },

    supportedPermissions: [...REMOTE_DEVICE_PERMISSIONS],
    allAccountPermissions: [...AUTH_PERMISSIONS],
  };
}
