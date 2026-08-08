/**
 * Internal validation helpers shared by the pre-phase plugin contracts.
 *
 * These helpers are intentionally not part of the package export surface.
 * Host-only constructors and untrusted wire parsers each decide which error
 * class and policy to apply around them.
 */

export const FORBIDDEN_WIRE_FIELDS = Object.freeze(new Set([
  'profile',
  'profileId',
  'deviceRef',
  'selectionRevision',
  'authorization',
  'revalidation',
  'pairingToken',
  'sessionToken',
  'url',
  'href',
  'uri',
  'path',
  'filePath',
  'downloadUrl',
  'command',
  'executable',
  'argv',
  'entrypoint',
  'script',
  'sourceUrl',
  'proxyUrl',
]));

export const REVERSE_DNS_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const OPAQUE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function makeIssue(path, code, message) {
  return { path, code, message };
}

export function failWith(ErrorClass, code, message, path = '$') {
  throw new ErrorClass([makeIssue(path, code, message)]);
}

export function addUnknownFieldIssues(value, allowed, path, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(makeIssue(`${path}.${key}`, 'unknown_field', 'Unknown fields are not supported.'));
  }
}

export function rejectForbiddenWireFields(value, path, ErrorClass, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectForbiddenWireFields(entry, `${path}[${index}]`, ErrorClass, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_WIRE_FIELDS.has(key)) {
      failWith(ErrorClass, 'HOST_ONLY_FIELD_FORBIDDEN', `Wire DTOs must not contain host-only or raw transport field ${key}.`, `${path}.${key}`);
    }
    rejectForbiddenWireFields(child, `${path}.${key}`, ErrorClass, seen);
  }
}

export function strictRecord(value, allowed, ErrorClass, kind, { rejectWireClaims = false } = {}) {
  if (!isRecord(value)) failWith(ErrorClass, 'INVALID_TYPE', `${kind} must be an object.`);
  if (rejectWireClaims) rejectForbiddenWireFields(value, '$', ErrorClass);
  const issues = [];
  addUnknownFieldIssues(value, allowed, '$', issues);
  if (issues.length > 0) throw new ErrorClass(issues);
  return value;
}

export function readText(value, path, ErrorClass, { required = true, maxLength = 256, trim = true } = {}) {
  if (value === undefined) {
    if (required) failWith(ErrorClass, 'MISSING', 'A value is required.', path);
    return undefined;
  }
  if (typeof value !== 'string') failWith(ErrorClass, 'INVALID_TYPE', 'Expected a string.', path);
  const normalized = trim ? value.trim() : value;
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    failWith(ErrorClass, 'INVALID_VALUE', `Expected a non-empty string of at most ${maxLength} characters.`, path);
  }
  return normalized;
}

export function readOpaqueReference(value, path, ErrorClass) {
  const normalized = readText(value, path, ErrorClass);
  if (!OPAQUE_REFERENCE_PATTERN.test(normalized)) {
    failWith(ErrorClass, 'INVALID_REFERENCE', 'Expected an opaque reference token without URL or path separators.', path);
  }
  return normalized;
}

export function readReverseDnsId(value, path, ErrorClass) {
  const normalized = readText(value, path, ErrorClass, { maxLength: 128 });
  if (!REVERSE_DNS_ID_PATTERN.test(normalized)) {
    failWith(ErrorClass, 'INVALID_ADDON_ID', 'Expected a lowercase reverse-DNS add-on ID.', path);
  }
  return normalized;
}

export function readInteger(value, path, ErrorClass, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    failWith(ErrorClass, 'INVALID_INTEGER', `Expected an integer between ${min} and ${max}.`, path);
  }
  return value;
}

export function readBoolean(value, path, ErrorClass) {
  if (typeof value !== 'boolean') failWith(ErrorClass, 'INVALID_TYPE', 'Expected a boolean.', path);
  return value;
}

export function readEnum(value, allowed, path, ErrorClass, label = 'value') {
  if (!allowed.includes(value)) failWith(ErrorClass, 'UNSUPPORTED_VALUE', `Unsupported ${label}.`, path);
  return value;
}

export function readStringArray(value, path, ErrorClass, { maxItems = 32, maxLength = 128 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    failWith(ErrorClass, 'INVALID_ARRAY', `Expected an array with at most ${maxItems} entries.`, path);
  }
  const result = value.map((entry, index) => readText(entry, `${path}[${index}]`, ErrorClass, { maxLength }));
  if (new Set(result).size !== result.length) failWith(ErrorClass, 'DUPLICATE_VALUE', 'Array values must be unique.', path);
  return result;
}

export function readSha256(value, path, ErrorClass) {
  const normalized = readText(value, path, ErrorClass, { maxLength: 64 });
  if (!SHA256_PATTERN.test(normalized)) failWith(ErrorClass, 'INVALID_DIGEST', 'Expected a lowercase SHA-256 digest.', path);
  return normalized;
}

export function readSemVer(value, path, ErrorClass) {
  const normalized = readText(value, path, ErrorClass, { maxLength: 64 });
  if (!SEMVER_PATTERN.test(normalized)) failWith(ErrorClass, 'INVALID_VERSION', 'Expected a SemVer release version.', path);
  return normalized;
}

export function readTimeWindow(issuedAt, expiresAt, path, ErrorClass, maxLifetime) {
  const issued = readInteger(issuedAt, `${path}.issuedAt`, ErrorClass);
  const expires = readInteger(expiresAt, `${path}.expiresAt`, ErrorClass);
  if (expires <= issued) failWith(ErrorClass, 'INVALID_WINDOW', 'expiresAt must be later than issuedAt.', `${path}.expiresAt`);
  if (expires - issued > maxLifetime) {
    failWith(ErrorClass, 'INVALID_WINDOW', `The validity window must not exceed ${maxLifetime} milliseconds.`, path);
  }
  return { issuedAt: issued, expiresAt: expires };
}

function isIpv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isPrivateIpv4(value) {
  if (!isIpv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a >= 224;
}

export function readPublicHttpsOrigin(value, path, ErrorClass) {
  const normalized = readText(value, path, ErrorClass, { maxLength: 512 });
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    failWith(ErrorClass, 'INVALID_ORIGIN', 'Expected an absolute HTTPS origin.', path);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    failWith(ErrorClass, 'INVALID_ORIGIN', 'Origins must be HTTPS, credential-free, path-free, query-free, and use the default port.', path);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.local') || hostname.includes(':') || isPrivateIpv4(hostname)) {
    failWith(ErrorClass, 'PRIVATE_ORIGIN_FORBIDDEN', 'Local, private, single-label, and IPv6 origins are not accepted.', path);
  }
  return parsed.origin;
}

export function compareSemVerStrings(left, right) {
  const parse = (value) => value.split(/[.+-]/, 1)[0].split('.').map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
