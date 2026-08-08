/**
 * Normative signing-byte helpers for the pre-phase plugin contracts.
 *
 * The canonicalization is deliberately a small, reviewed JCS/RFC 8785-
 * compatible implementation for I-JSON values: ECMAScript JSON number
 * serialization, lexicographically sorted object keys, UTF-8 output, no
 * undefined/non-finite values, and rejection of lone UTF-16 surrogates.
 * Signature verification remains host-owned; this module only creates the
 * bytes and decodes exact-size Ed25519 material.
 */

export const PLUGIN_SIGNING_PROTOCOL_VERSION = 1;
export const PLUGIN_SIGNING_DOMAINS = Object.freeze({
  marketplaceIndex: 'marketplace-index',
  catalog: 'catalog',
  update: 'update',
});

const domainSet = new Set(Object.values(PLUGIN_SIGNING_DOMAINS));
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const hexPattern = /^[a-f0-9]+$/;

function issue(path, code, message) {
  return { path, code, message };
}

function fail(code, message, path = '$') {
  throw new PluginSigningError([issue(path, code, message)]);
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalValue(value, path, ancestors) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && hasLoneSurrogate(value)) {
      fail('INVALID_STRING', 'JCS values must not contain lone UTF-16 surrogates.', path);
    }
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_NUMBER', 'JCS values must contain only finite numbers.', path);
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== 'object') {
    fail('INVALID_JSON_VALUE', 'JCS values must be JSON-compatible.', path);
  }
  if (ancestors.has(value)) fail('CYCLIC_VALUE', 'JCS values must not contain cycles.', path);

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        fail('INVALID_ARRAY', 'JCS arrays must not contain enumerable non-index properties.', `${path}.${key}`);
      }
    }
    return Array.from({ length: value.length }, (_, index) => {
      if (!(index in value)) fail('UNDEFINED_VALUE', 'JCS arrays must not contain sparse holes.', `${path}[${index}]`);
      const entry = value[index];
      if (entry === undefined) fail('UNDEFINED_VALUE', 'JCS arrays must not contain undefined values.', `${path}[${index}]`);
      return canonicalValue(entry, `${path}[${index}]`, nextAncestors);
    });
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail('INVALID_JSON_VALUE', 'JCS objects must be plain JSON objects.', path);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) fail('INVALID_JSON_VALUE', 'JCS objects must not contain symbol keys.', path);
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (hasLoneSurrogate(key)) fail('INVALID_KEY', 'JCS object keys must not contain lone UTF-16 surrogates.', `${path}.${key}`);
    if (value[key] === undefined) fail('UNDEFINED_VALUE', 'JCS objects must not contain undefined values.', `${path}.${key}`);
    result[key] = canonicalValue(value[key], `${path}.${key}`, nextAncestors);
  }
  return result;
}

export function canonicalizeJcs(value) {
  return JSON.stringify(canonicalValue(value, '$', new Set()));
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function concatenate(left, right) {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

/**
 * Signed bytes are:
 * UTF-8("LoomTV-Plugin-Signature/v1\\0" + domain + "\\0") ||
 * UTF-8(JCS(payload)).
 */
export function domainSeparatedSignedBytes(domain, payload) {
  if (!domainSet.has(domain)) fail('UNSUPPORTED_DOMAIN', 'The signing domain is not part of the reviewed protocol.', '$.domain');
  const prefix = utf8(`LoomTV-Plugin-Signature/v${PLUGIN_SIGNING_PROTOCOL_VERSION}\u0000${domain}\u0000`);
  return concatenate(prefix, utf8(canonicalizeJcs(payload)));
}

export function encodeBase64Url(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('INVALID_BYTES', 'Expected a Uint8Array.', '$.bytes');
  let base64;
  if (typeof globalThis.Buffer?.from === 'function') {
    base64 = globalThis.Buffer.from(bytes).toString('base64');
  } else if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    base64 = btoa(binary);
  } else {
    fail('BASE64_UNAVAILABLE', 'No base64 encoder is available in this host.');
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64Url(value, path = '$') {
  if (typeof value !== 'string' || !value || !base64UrlPattern.test(value) || value.length % 4 === 1) {
    fail('INVALID_BASE64URL', 'Expected unpadded base64url data.', path);
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let bytes;
  try {
    if (typeof globalThis.Buffer?.from === 'function') {
      bytes = Uint8Array.from(globalThis.Buffer.from(padded, 'base64'));
    } else if (typeof atob === 'function') {
      const binary = atob(padded);
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } else {
      fail('BASE64_UNAVAILABLE', 'No base64 decoder is available in this host.', path);
    }
  } catch {
    fail('INVALID_BASE64URL', 'The base64url value could not be decoded.', path);
  }
  if (encodeBase64Url(bytes) !== value) fail('INVALID_BASE64URL', 'The base64url value is not canonically encoded.', path);
  return bytes;
}

export function decodeEd25519Signature(value, path = '$.signature') {
  const bytes = decodeBase64Url(value, path);
  if (bytes.byteLength !== 64) fail('INVALID_SIGNATURE_LENGTH', 'Ed25519 signatures must decode to exactly 64 bytes.', path);
  return bytes;
}

export function decodeEd25519PublicKey(value, path = '$.publicKey') {
  const bytes = decodeBase64Url(value, path);
  if (bytes.byteLength !== 32) fail('INVALID_PUBLIC_KEY_LENGTH', 'Ed25519 public keys must decode to exactly 32 bytes.', path);
  return bytes;
}

export function hexToBytes(value, path = '$') {
  if (typeof value !== 'string' || !value || value.length % 2 !== 0 || !hexPattern.test(value)) {
    fail('INVALID_HEX', 'Expected an even-length lowercase hexadecimal value.', path);
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function bytesToHex(value, path = '$') {
  if (!(value instanceof Uint8Array)) fail('INVALID_BYTES', 'Expected a Uint8Array.', path);
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class PluginSigningError extends Error {
  constructor(issues) {
    const normalizedIssues = Object.freeze(issues.map((entry) => Object.freeze({ ...entry })));
    const detail = normalizedIssues.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
    super(`Invalid plugin signing data${detail ? `: ${detail}` : '.'}`);
    this.name = 'PluginSigningError';
    this.code = 'PLUGIN_SIGNING_DATA_INVALID';
    this.issues = normalizedIssues;
  }
}

const RFC8032_SIGNATURE_HEX = 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155' + '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

export const PLUGIN_SIGNING_TEST_VECTORS = Object.freeze([
  Object.freeze({
    name: 'rfc8032-ed25519-empty-message',
    domain: null,
    payload: null,
    publicKeyHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    messageHex: '',
    signatureHex: RFC8032_SIGNATURE_HEX,
    signatureBase64Url: encodeBase64Url(hexToBytes(RFC8032_SIGNATURE_HEX)),
    publicKeyBase64Url: encodeBase64Url(hexToBytes('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')),
  }),
  Object.freeze({
    name: 'jcs-domain-separated-catalog-object',
    domain: PLUGIN_SIGNING_DOMAINS.catalog,
    payload: Object.freeze({ b: 'x', a: 1 }),
    canonicalJson: '{"a":1,"b":"x"}',
    signedBytesHex: '4c6f6f6d54562d506c7567696e2d5369676e61747572652f763100636174616c6f67007b2261223a312c2262223a2278227d',
  }),
]);
