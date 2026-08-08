/**
 * Safe HTTP adapter for the Stremio v3 add-on protocol.
 *
 * This adapter consumes add-on declarations and JSON responses. It never
 * executes remote code, follows install/configuration pages, starts a torrent
 * client, or hands authorization decisions to an add-on.
 */

export const STREMIO_ADAPTER_PROTOCOL_VERSION = 1;
export const STREMIO_INSTALL_STATE_VERSION = 1;

export const STREMIO_RESOURCES = Object.freeze([
  'catalog',
  'meta',
  'stream',
  'subtitles',
]);

export const STREMIO_INSTALL_STATES = Object.freeze([
  'pending-review',
  'enabled',
  'disabled',
]);

export const STREMIO_DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 8_000,
  maxManifestBytes: 256 * 1024,
  maxResponseBytes: 1 * 1024 * 1024,
  maxItems: 200,
  maxStringLength: 4_096,
  maxUrlLength: 4_096,
  maxExtraEntries: 16,
});

const HARD_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxManifestBytes: 1 * 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  maxItems: 1_000,
  maxStringLength: 16_384,
  maxUrlLength: 8_192,
  maxExtraEntries: 32,
});

const supportedResourceSet = new Set(STREMIO_RESOURCES);
const installStateSet = new Set(STREMIO_INSTALL_STATES);
let reviewTokenSequence = 0;
const safeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const manifestIdPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const stableSemVerPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const peerDiscoveryFieldNames = Object.freeze(['sources', 'servers']);
const MAX_CATALOG_OPTION_ITEMS = 256;
const MAX_ADDON_CATALOGS = 200;

export const STREMIO_PEER_TO_PEER_UNSUPPORTED_REASON = 'This source uses torrent or peer-to-peer transport. LoomTV does not provide a peer-to-peer playback engine, so the source cannot be played.';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createIssue(path, code, message) {
  return { path, code, message };
}

function createPath(path, index) {
  return `${path}[${index}]`;
}

function addUnknownKeys(value, allowedKeys, path, issues) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) issues.push(createIssue(`${path}.${key}`, 'unknown_field', 'Unknown fields are not supported.'));
  }
}

function addIssueIfInvalidString(value, path, issues, {
  required = false,
  maxLength = 256,
  pattern,
  message = 'Expected a non-empty string.',
} = {}) {
  if (value === undefined) {
    if (required) issues.push(createIssue(path, 'missing', 'A value is required.'));
    return undefined;
  }
  if (typeof value !== 'string') {
    issues.push(createIssue(path, 'invalid_type', message));
    return undefined;
  }
  const text = value.trim();
  if (!text || text.length > maxLength || controlCharacterPattern.test(text) || (pattern && !pattern.test(text))) {
    issues.push(createIssue(path, 'invalid_value', message));
    return undefined;
  }
  return text;
}

function responseString(value, maxLength = 512) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > maxLength || controlCharacterPattern.test(text)) return undefined;
  return text;
}

function responseRequiredString(value, path, maxLength = 512) {
  const text = responseString(value, maxLength);
  if (text === undefined) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', `The add-on response is missing a valid ${path}.`, {
      issues: [createIssue(path, 'invalid_value', 'Expected a non-empty string.')],
    });
  }
  return text;
}

function normalizeLimits(options = {}) {
  const bounded = (name, minimum, fallback) => {
    const value = Number(options[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(minimum, Math.min(HARD_LIMITS[name], Math.floor(value)));
  };
  return Object.freeze({
    timeoutMs: bounded('timeoutMs', 250, STREMIO_DEFAULT_LIMITS.timeoutMs),
    maxManifestBytes: bounded('maxManifestBytes', 16 * 1024, STREMIO_DEFAULT_LIMITS.maxManifestBytes),
    maxResponseBytes: bounded('maxResponseBytes', 16 * 1024, STREMIO_DEFAULT_LIMITS.maxResponseBytes),
    maxItems: bounded('maxItems', 1, STREMIO_DEFAULT_LIMITS.maxItems),
    maxStringLength: bounded('maxStringLength', 64, STREMIO_DEFAULT_LIMITS.maxStringLength),
    maxUrlLength: bounded('maxUrlLength', 256, STREMIO_DEFAULT_LIMITS.maxUrlLength),
    maxExtraEntries: bounded('maxExtraEntries', 1, STREMIO_DEFAULT_LIMITS.maxExtraEntries),
  });
}

function utf8ByteLength(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return false;
  const [first, second] = numbers;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0 && numbers[2] === 0)
    || (first === 192 && second === 0 && numbers[2] === 2)
    || (first === 192 && second === 88 && numbers[2] === 99)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && numbers[2] === 100)
    || (first === 203 && second === 0 && numbers[2] === 113)
    || first >= 224;
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized.includes(':')) return false;
  const mappedTail = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : '';
  if (mappedTail) {
    if (mappedTail.includes('.')) return isPrivateIpv4(mappedTail);
    const words = mappedTail.split(':');
    if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
      const high = Number.parseInt(words[0], 16);
      const low = Number.parseInt(words[1], 16);
      const mappedIpv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      if (isPrivateIpv4(mappedIpv4)) return true;
    }
  }
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff')
    || normalized.startsWith('64:ff9b:')
    || normalized.startsWith('2001:db8:')
    || normalized.startsWith('2002:');
}

function inspectRemoteHttpsUrl(value, { maxLength = STREMIO_DEFAULT_LIMITS.maxUrlLength } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, code: 'invalid_url', reason: 'The value is not a URL.' };
  }
  const input = value.trim();
  if (input.length > maxLength || controlCharacterPattern.test(input)) {
    return { ok: false, code: 'invalid_url', reason: 'The URL is too long or contains control characters.' };
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, code: 'invalid_url', reason: 'The value is not a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'unsafe_scheme', reason: 'Only HTTPS remote URLs are supported.' };
  }
  if (url.username || url.password) {
    return { ok: false, code: 'embedded_credentials', reason: 'URLs containing credentials are not supported.' };
  }
  if (url.hash) {
    return { ok: false, code: 'fragment_not_allowed', reason: 'URL fragments are not supported for remote requests.' };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const localName = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname === 'localdomain';
  if (localName || isPrivateIpv4(hostname) || isPrivateIpv6(hostname) || (!hostname.includes('.') && !hostname.includes(':'))) {
    return { ok: false, code: 'local_network_not_allowed', reason: 'Local, private, and single-label hosts are not allowed.' };
  }

  return { ok: true, url: url.toString() };
}

function requireRemoteHttpsUrl(value, field, limits) {
  const result = inspectRemoteHttpsUrl(value, { maxLength: limits.maxUrlLength });
  if (!result.ok) {
    throw new StremioAdapterError('UNSAFE_URL', `${field} was rejected: ${result.reason}`, {
      issues: [createIssue(field, result.code, result.reason)],
    });
  }
  return result.url;
}

/**
 * Return a display-safe form of a configured add-on URL. Add-on credentials
 * are commonly encoded in query strings or path segments, so only the origin
 * and the conventional manifest filename are retained.
 */
export function redactStremioUrl(value) {
  const result = inspectRemoteHttpsUrl(value, { maxLength: HARD_LIMITS.maxUrlLength });
  if (!result.ok) return '';
  const url = new URL(result.url);
  const isRootManifest = url.pathname === '/manifest.json';
  const hasManifestFilename = url.pathname.endsWith('/manifest.json');
  if (isRootManifest) return `${url.origin}/manifest.json`;
  return `${url.origin}/…${hasManifestFilename ? '/manifest.json' : ''}`;
}

/** Return only the origin of a validated remote candidate URL for display. */
export function redactStremioResourceUrl(value) {
  const result = inspectRemoteHttpsUrl(value, { maxLength: HARD_LIMITS.maxUrlLength });
  if (!result.ok) return '';
  return `${new URL(result.url).origin}/…`;
}

function optionalRemoteHttpsUrl(value, limits) {
  if (value === undefined || value === null) return undefined;
  const result = inspectRemoteHttpsUrl(value, { maxLength: limits.maxUrlLength });
  return result.ok ? result.url : undefined;
}

async function readResponseText(response, maxBytes) {
  const contentLength = Number.parseInt(response.headers?.get?.('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new StremioAdapterError('RESPONSE_TOO_LARGE', 'The add-on response exceeded LoomTV’s size limit.', { retryable: false });
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new StremioAdapterError('RESPONSE_TOO_LARGE', 'The add-on response exceeded LoomTV’s size limit.', { retryable: false });
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new StremioAdapterError('RESPONSE_SIZE_UNKNOWN', 'The add-on response did not expose a bounded body stream or content length.', { retryable: false });
  }
  const text = await response.text();
  if (typeof text !== 'string') {
    throw new StremioAdapterError('INVALID_HTTP_RESPONSE', 'The add-on response body was not text.', { retryable: false });
  }
  if (utf8ByteLength(text) > maxBytes) {
    throw new StremioAdapterError('RESPONSE_TOO_LARGE', 'The add-on response exceeded LoomTV’s size limit.', { retryable: false });
  }
  return text;
}

async function fetchJson(url, {
  fetchImpl,
  requestGuard,
  limits,
  maxBytes,
  label,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new StremioAdapterError('FETCH_UNAVAILABLE', 'No HTTPS fetch implementation is available for the Stremio adapter.', { retryable: false });
  }
  if (typeof AbortController === 'undefined') {
    throw new StremioAdapterError('ABORT_UNAVAILABLE', 'The Stremio adapter requires AbortController for bounded requests.', { retryable: false });
  }

  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StremioAdapterError('NETWORK_TIMEOUT', `The ${label} request timed out.`, { retryable: true }));
    }, limits.timeoutMs);
  });

  const request = async () => {
    if (typeof requestGuard === 'function') {
      try {
        await requestGuard(url);
      } catch (error) {
        if (error instanceof StremioAdapterError) throw error;
        throw new StremioAdapterError('NETWORK_POLICY_REJECTED', `The ${label} request was rejected by the host network policy.`, { retryable: false, cause: error });
      }
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new StremioAdapterError('NETWORK_TIMEOUT', `The ${label} request timed out.`, { retryable: true });
      }
      throw new StremioAdapterError('NETWORK_ERROR', `The ${label} request failed safely.`, { retryable: true, cause: error });
    }

    if (!response || typeof response !== 'object' || typeof response.text !== 'function') {
      throw new StremioAdapterError('INVALID_HTTP_RESPONSE', `The ${label} request returned an invalid HTTP response.`, { retryable: false });
    }

    const finalUrl = response.url || url;
    const finalUrlCheck = inspectRemoteHttpsUrl(finalUrl, { maxLength: limits.maxUrlLength });
    if (!finalUrlCheck.ok) {
      throw new StremioAdapterError('UNSAFE_REDIRECT', `The ${label} response resolved to an unsafe URL.`, { retryable: false });
    }

    const status = Number(response.status);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new StremioAdapterError('HTTP_ERROR', `The ${label} endpoint returned HTTP ${Number.isFinite(status) ? status : 'an invalid status'}.`, {
        retryable: status >= 500,
      });
    }

    const text = await readResponseText(response, maxBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new StremioAdapterError('INVALID_JSON', `The ${label} endpoint did not return valid JSON.`, { retryable: false });
    }
  };

  try {
    return await Promise.race([request(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeToken(value, path, issues, maxLength = 64) {
  return addIssueIfInvalidString(value, path, issues, {
    required: true,
    maxLength,
    pattern: safeTokenPattern,
    message: 'Expected a safe protocol token.',
  });
}

function normalizeStringArray(value, path, issues, {
  required = false,
  minItems = 0,
  maxItems = 32,
  maxLength = 128,
  pattern,
} = {}) {
  if (value === undefined) {
    if (required) issues.push(createIssue(path, 'missing', 'An array is required.'));
    return [];
  }
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    issues.push(createIssue(path, 'invalid_type', 'Expected a bounded array of strings.'));
    return [];
  }
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = addIssueIfInvalidString(value[index], createPath(path, index), issues, {
      required: true,
      maxLength,
      pattern,
      message: 'Expected a safe string value.',
    });
    if (item !== undefined) values.push(item);
  }
  return values;
}

function normalizeExtraDefinition(value, path, issues) {
  if (!Array.isArray(value) || value.length > 32) {
    issues.push(createIssue(path, 'invalid_type', 'Expected a bounded array of catalog extra definitions.'));
    return [];
  }
  const extras = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = createPath(path, index);
    const item = value[index];
    if (!isRecord(item)) {
      issues.push(createIssue(itemPath, 'invalid_type', 'Expected a catalog extra object.'));
      continue;
    }
    addUnknownKeys(item, new Set(['name', 'isRequired', 'options', 'optionsLimit']), itemPath, issues);
    const name = normalizeToken(item.name, `${itemPath}.name`, issues, 64);
    const isRequired = item.isRequired === undefined ? false : item.isRequired;
    if (typeof isRequired !== 'boolean') issues.push(createIssue(`${itemPath}.isRequired`, 'invalid_type', 'Expected a boolean.'));
    const options = item.options === undefined
      ? undefined
      : normalizeStringArray(item.options, `${itemPath}.options`, issues, { maxItems: MAX_CATALOG_OPTION_ITEMS, maxLength: 128 });
    const optionsLimit = item.optionsLimit === undefined ? undefined : item.optionsLimit;
    if (optionsLimit !== undefined && (!Number.isInteger(optionsLimit) || optionsLimit < 1 || optionsLimit > 100)) {
      issues.push(createIssue(`${itemPath}.optionsLimit`, 'invalid_value', 'Expected an integer between 1 and 100.'));
    }
    if (name !== undefined) extras.push({
      name,
      isRequired: isRequired === true,
      ...(options === undefined ? {} : { options }),
      ...(optionsLimit === undefined ? {} : { optionsLimit }),
    });
  }
  return extras;
}

function normalizeStremioResource(value, path, topTypes, topPrefixes, issues) {
  const item = typeof value === 'string' ? { name: value } : value;
  if (!isRecord(item)) {
    issues.push(createIssue(path, 'invalid_type', 'Expected a Stremio resource string or object.'));
    return null;
  }
  addUnknownKeys(item, new Set(['name', 'types', 'idPrefixes']), path, issues);
  const name = addIssueIfInvalidString(item.name, `${path}.name`, issues, {
    required: true,
    maxLength: 32,
    pattern: safeTokenPattern,
    message: 'Expected a Stremio resource name.',
  });
  const types = item.types === undefined
    ? [...topTypes]
    : normalizeStringArray(item.types, `${path}.types`, issues, { required: true, minItems: 1, maxItems: 32, maxLength: 64, pattern: safeTokenPattern });
  const idPrefixes = item.idPrefixes === undefined
    ? [...topPrefixes]
    : normalizeStringArray(item.idPrefixes, `${path}.idPrefixes`, issues, { maxItems: 32, maxLength: 128 });
  return { name, types, idPrefixes };
}

function normalizeStremioCatalog(value, path, issues) {
  if (!isRecord(value)) {
    issues.push(createIssue(path, 'invalid_type', 'Expected a Stremio catalog object.'));
    return null;
  }
  addUnknownKeys(value, new Set(['type', 'id', 'name', 'extra', 'genres', 'extraSupported', 'extraRequired']), path, issues);
  const type = normalizeToken(value.type, `${path}.type`, issues);
  const id = addIssueIfInvalidString(value.id, `${path}.id`, issues, { required: true, maxLength: 128, message: 'Expected a catalog ID.' });
  const name = addIssueIfInvalidString(value.name, `${path}.name`, issues, { required: true, maxLength: 160, message: 'Expected a catalog name.' });
  const extra = value.extra === undefined ? [] : normalizeExtraDefinition(value.extra, `${path}.extra`, issues);
  if (value.genres !== undefined) normalizeStringArray(value.genres, `${path}.genres`, issues, { maxItems: MAX_CATALOG_OPTION_ITEMS, maxLength: 128 });
  if (value.extraSupported !== undefined) normalizeStringArray(value.extraSupported, `${path}.extraSupported`, issues, { maxItems: 32, maxLength: 64, pattern: safeTokenPattern });
  if (value.extraRequired !== undefined) normalizeStringArray(value.extraRequired, `${path}.extraRequired`, issues, { maxItems: 32, maxLength: 64, pattern: safeTokenPattern });
  return type && id && name ? { type, id, name, extra } : null;
}

function normalizeAddonCatalogs(value, path, issues) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ADDON_CATALOGS) {
    issues.push(createIssue(path, 'invalid_type', `Expected at most ${MAX_ADDON_CATALOGS} add-on catalog declarations.`));
    return [];
  }
  const catalogs = [];
  for (let index = 0; index < value.length; index += 1) {
    const catalog = normalizeStremioCatalog(value[index], createPath(path, index), issues);
    if (catalog) catalogs.push(catalog);
  }
  return catalogs;
}

function normalizeConfigDefinitions(value, path, issues) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    issues.push(createIssue(path, 'invalid_type', 'Expected at most 32 configuration definitions.'));
    return [];
  }
  const supportedTypes = new Set(['text', 'number', 'password', 'checkbox', 'select', 'boolean', 'string']);
  const definitions = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = createPath(path, index);
    const item = value[index];
    if (!isRecord(item)) {
      issues.push(createIssue(itemPath, 'invalid_type', 'Expected a configuration definition object.'));
      continue;
    }
    addUnknownKeys(item, new Set(['key', 'type', 'default', 'title', 'options', 'required']), itemPath, issues);
    const key = normalizeToken(item.key, `${itemPath}.key`, issues, 64);
    const type = addIssueIfInvalidString(item.type, `${itemPath}.type`, issues, { required: true, maxLength: 32, message: 'Expected a supported configuration field type.' });
    if (type !== undefined && !supportedTypes.has(type)) issues.push(createIssue(`${itemPath}.type`, 'unsupported_value', 'Unsupported configuration field type.'));
    const title = item.title === undefined
      ? undefined
      : addIssueIfInvalidString(item.title, `${itemPath}.title`, issues, { maxLength: 160, message: 'Expected a configuration field title.' });
    const required = item.required === undefined ? false : item.required;
    if (typeof required !== 'boolean') issues.push(createIssue(`${itemPath}.required`, 'invalid_type', 'Expected a boolean.'));
    const options = item.options === undefined
      ? undefined
      : normalizeStringArray(item.options, `${itemPath}.options`, issues, { maxItems: MAX_CATALOG_OPTION_ITEMS, maxLength: 128 });
    if (item.default !== undefined) {
      const defaultType = typeof item.default;
      const validDefault = defaultType === 'boolean'
        || (defaultType === 'number' && Number.isFinite(item.default))
        || (defaultType === 'string' && item.default.length <= 512 && !controlCharacterPattern.test(item.default));
      if (!validDefault) issues.push(createIssue(`${itemPath}.default`, 'invalid_value', 'Expected a bounded scalar default value.'));
    }
    if (key && type && supportedTypes.has(type)) definitions.push({
      key,
      type,
      required: required === true,
      ...(title === undefined ? {} : { title }),
      ...(options === undefined ? {} : { options }),
    });
  }
  return definitions;
}

function normalizeBehaviorHints(value, path, issues) {
  if (value === undefined) return { adult: false, p2p: false, configurable: false, configurationRequired: false, newEpisodeNotifications: false };
  if (!isRecord(value)) {
    issues.push(createIssue(path, 'invalid_type', 'Expected a behaviorHints object.'));
    return { adult: false, p2p: false, configurable: false, configurationRequired: false, newEpisodeNotifications: false };
  }
  addUnknownKeys(value, new Set(['adult', 'p2p', 'configurable', 'configurationRequired', 'newEpisodeNotifications']), path, issues);
  const result = {};
  for (const key of ['adult', 'p2p', 'configurable', 'configurationRequired', 'newEpisodeNotifications']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      issues.push(createIssue(`${path}.${key}`, 'invalid_type', 'Expected a boolean.'));
    }
    result[key] = value[key] === true;
  }
  return result;
}

/** Validate and normalize the safe subset of a Stremio v3 manifest. */
export function normalizeStremioManifest(input, manifestUrl, options = {}) {
  const limits = normalizeLimits(options);
  requireRemoteHttpsUrl(manifestUrl, 'manifestUrl', limits);
  const issues = [];
  if (!isRecord(input)) {
    throw new StremioAdapterError('INVALID_MANIFEST', 'The Stremio manifest must be a JSON object.', {
      issues: [createIssue('$', 'invalid_type', 'Expected a JSON object.')],
    });
  }

  addUnknownKeys(input, new Set([
    'id',
    'version',
    'name',
    'description',
    'resources',
    'types',
    'idPrefixes',
    'catalogs',
    'logo',
    'background',
    'contactEmail',
    'behaviorHints',
    'addonCatalogs',
    'config',
  ]), '$', issues);

  const id = addIssueIfInvalidString(input.id, '$.id', issues, {
    required: true,
    maxLength: 128,
    pattern: manifestIdPattern,
    message: 'Expected a lowercase dot-separated Stremio add-on ID.',
  });
  const version = addIssueIfInvalidString(input.version, '$.version', issues, {
    required: true,
    maxLength: 64,
    pattern: stableSemVerPattern,
    message: 'Expected a Stremio add-on SemVer version.',
  });
  const name = addIssueIfInvalidString(input.name, '$.name', issues, { required: true, maxLength: 160, message: 'Expected a Stremio add-on name.' });
  const description = addIssueIfInvalidString(input.description, '$.description', issues, { required: true, maxLength: 1_000, message: 'Expected a Stremio add-on description.' });
  const types = normalizeStringArray(input.types, '$.types', issues, { required: true, minItems: 1, maxItems: 32, maxLength: 64, pattern: safeTokenPattern });
  const idPrefixes = normalizeStringArray(input.idPrefixes, '$.idPrefixes', issues, { maxItems: 32, maxLength: 128 });

  const resources = [];
  const unsupportedResources = [];
  if (!Array.isArray(input.resources) || input.resources.length < 1 || input.resources.length > 16) {
    issues.push(createIssue('$.resources', 'invalid_value', 'The manifest must declare 1-16 resources.'));
  } else {
    for (let index = 0; index < input.resources.length; index += 1) {
      const resource = normalizeStremioResource(input.resources[index], createPath('$.resources', index), types, idPrefixes, issues);
      if (resource && supportedResourceSet.has(resource.name)) resources.push(resource);
      else if (resource?.name && !unsupportedResources.includes(resource.name)) unsupportedResources.push(resource.name);
    }
  }
  if (resources.length === 0) issues.push(createIssue('$.resources', 'unsupported_resource', 'The manifest must declare at least one Loom-supported resource.'));

  const catalogs = [];
  if (!Array.isArray(input.catalogs) || input.catalogs.length > 200) {
    issues.push(createIssue('$.catalogs', 'invalid_type', 'Expected a bounded catalogs array.'));
  } else {
    const catalogKeys = new Set();
    for (let index = 0; index < input.catalogs.length; index += 1) {
      const catalog = normalizeStremioCatalog(input.catalogs[index], createPath('$.catalogs', index), issues);
      if (!catalog) continue;
      const key = `${catalog.type}:${catalog.id}`;
      if (catalogKeys.has(key)) issues.push(createIssue(createPath('$.catalogs', index), 'duplicate_catalog', 'Catalog type and ID must be unique within an add-on.'));
      catalogKeys.add(key);
      catalogs.push(catalog);
    }
  }

  const addonCatalogs = normalizeAddonCatalogs(input.addonCatalogs, '$.addonCatalogs', issues);
  const config = normalizeConfigDefinitions(input.config, '$.config', issues);

  const logoUrl = input.logo === undefined ? undefined : optionalRemoteHttpsUrl(input.logo, limits);
  const backgroundUrl = input.background === undefined ? undefined : optionalRemoteHttpsUrl(input.background, limits);
  const contactEmail = input.contactEmail === undefined
    ? undefined
    : addIssueIfInvalidString(input.contactEmail, '$.contactEmail', issues, { maxLength: 254, message: 'Expected a contact email string.' });
  const behaviorHints = normalizeBehaviorHints(input.behaviorHints, '$.behaviorHints', issues);

  if (issues.length > 0) {
    throw new StremioAdapterError('INVALID_MANIFEST', 'The Stremio manifest failed LoomTV’s compatibility and safety checks.', { issues, retryable: false });
  }

  const resourceNames = new Set(resources.map((resource) => resource.name));
  const compatibilityWarnings = [
    ...unsupportedResources.map((resource) => ({
      code: 'unsupported_resource_ignored',
      path: '$.resources',
      message: `The ${resource} resource is declared by the add-on but is not used by LoomTV.`,
    })),
    ...(input.logo !== undefined && logoUrl === undefined ? [{
      code: 'unsafe_optional_url_ignored',
      path: '$.logo',
      message: 'The add-on logo was omitted because it is not a public HTTPS URL.',
    }] : []),
    ...(input.background !== undefined && backgroundUrl === undefined ? [{
      code: 'unsafe_optional_url_ignored',
      path: '$.background',
      message: 'The add-on background was omitted because it is not a public HTTPS URL.',
    }] : []),
    ...(addonCatalogs.length > 0 ? [{
      code: 'addon_catalogs_ignored',
      path: '$.addonCatalogs',
      message: 'Add-on discovery catalogs are not imported by LoomTV.',
    }] : []),
    ...(config.length > 0 ? [{
      code: 'configuration_ui_unavailable',
      path: '$.config',
      message: 'Configuration fields are declared, but LoomTV does not render or submit remote add-on configuration forms.',
    }] : []),
  ];
  return deepFreeze({
    adapterProtocolVersion: STREMIO_ADAPTER_PROTOCOL_VERSION,
    id,
    version,
    name,
    description,
    resources,
    types,
    idPrefixes,
    catalogs,
    unsupportedResources,
    compatibilityWarnings,
    ...(config.length === 0 ? {} : { config }),
    ...(logoUrl === undefined ? {} : { logoUrl }),
    ...(backgroundUrl === undefined ? {} : { backgroundUrl }),
    ...(contactEmail === undefined ? {} : { contactEmail }),
    behaviorHints,
    peerToPeerDeclared: behaviorHints.p2p === true,
    supportedLoomCapabilities: Object.freeze([
      ...(resourceNames.has('catalog') || resourceNames.has('meta') ? ['metadata.catalog'] : []),
      ...(resourceNames.has('stream') ? ['playback.provider'] : []),
      ...(resourceNames.has('subtitles') ? ['subtitle.provider'] : []),
    ]),
  });
}

function inspectP2pSource(stream) {
  const sourceUrl = typeof stream.url === 'string' ? stream.url.trim() : '';
  const magnetUrl = [sourceUrl, stream.magnet, stream.magnetUrl, stream.torrentUrl]
    .find((candidate) => typeof candidate === 'string' && /^magnet:/i.test(candidate.trim()));
  if (magnetUrl) return { sourceKind: 'torrent', reference: 'magnet-source' };
  if (/\.torrent(?:[?#]|$)/i.test(sourceUrl)) return { sourceKind: 'torrent', reference: 'torrent-url' };
  if (typeof stream.torrentUrl === 'string' && stream.torrentUrl.trim()) {
    return { sourceKind: 'torrent', reference: 'torrent-url' };
  }
  if (stream.torrent !== undefined && stream.torrent !== false && stream.torrent !== null) {
    return { sourceKind: 'torrent', reference: 'torrent-source' };
  }
  if (typeof stream.infoHash === 'string' && stream.infoHash.trim()) {
    return { sourceKind: 'torrent', reference: 'info-hash-source' };
  }
  if (stream.fileIdx !== undefined) {
    return { sourceKind: 'torrent', reference: 'torrent-file-index' };
  }
  if (peerDiscoveryFieldNames.some((field) => {
    const value = stream[field];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return value !== undefined && value !== null;
  })) {
    return { sourceKind: 'peer-to-peer', reference: 'peer-discovery-source' };
  }
  return null;
}

function streamLabel(stream) {
  return responseString(stream.name) || responseString(stream.title) || responseString(stream.description);
}

function normalizeSubtitleCandidate(value, context, index, limits) {
  const path = `subtitles[${index}]`;
  if (!isRecord(value)) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', `The add-on returned a malformed subtitle at ${path}.`, {
      issues: [createIssue(path, 'invalid_type', 'Expected a subtitle object.')],
    });
  }
  const id = responseRequiredString(value.id, `${path}.id`, 256);
  const lang = responseRequiredString(value.lang, `${path}.lang`, 32);
  const urlCheck = inspectRemoteHttpsUrl(value.url, { maxLength: limits.maxUrlLength });
  if (!urlCheck.ok) {
    return {
      candidate: null,
      rejection: { index, reasonCode: urlCheck.code, reason: urlCheck.reason },
    };
  }
  return {
    candidate: {
      id,
      language: lang,
      url: urlCheck.url,
      urlRedacted: redactStremioResourceUrl(urlCheck.url),
      source: context,
    },
    rejection: null,
  };
}

function normalizeSubtitleList(value, context, limits, path = 'subtitles') {
  if (!Array.isArray(value) || value.length > limits.maxItems) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', `The add-on returned an invalid ${path} array.`, {
      issues: [createIssue(path, 'invalid_type', `Expected at most ${limits.maxItems} subtitle objects.`)],
    });
  }
  const subtitles = [];
  const rejected = [];
  for (let index = 0; index < value.length; index += 1) {
    const normalized = normalizeSubtitleCandidate(value[index], context, index, limits);
    if (normalized.candidate) subtitles.push(normalized.candidate);
    if (normalized.rejection) rejected.push(normalized.rejection);
  }
  return { subtitles, rejected };
}

function normalizeVideo(value, context, limits) {
  if (!isRecord(value)) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The add-on returned a malformed video object.', { retryable: false });
  }
  const id = responseRequiredString(value.id, 'video.id', 256);
  const title = responseRequiredString(value.title, 'video.title', 512);
  const video = {
    id,
    title,
    ...(responseString(value.released, 128) === undefined ? {} : { released: responseString(value.released, 128) }),
    ...(optionalRemoteHttpsUrl(value.thumbnail, limits) === undefined ? {} : { thumbnailUrl: optionalRemoteHttpsUrl(value.thumbnail, limits) }),
    ...(responseString(value.overview, 1_000) === undefined ? {} : { overview: responseString(value.overview, 1_000) }),
    ...(Number.isInteger(value.season) && value.season >= 0 && value.season <= 10_000 ? { season: value.season } : {}),
    ...(Number.isInteger(value.episode) && value.episode >= 0 && value.episode <= 10_000 ? { episode: value.episode } : {}),
    ...(typeof value.available === 'boolean' ? { available: value.available } : {}),
  };
  if (value.streams !== undefined) {
    if (!Array.isArray(value.streams) || value.streams.length > limits.maxItems) {
      throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The video streams field must be a bounded array.', { retryable: false });
    }
    video.embeddedSources = value.streams.map((stream, index) => normalizeStreamCandidate(
      stream,
      { ...context, itemId: id, sourceIndex: index },
      limits,
      `videos[${index}]`,
    ));
  }
  return video;
}

function normalizeMetaCandidate(value, context, limits, { expectedType, expectedId } = {}) {
  if (!isRecord(value)) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The add-on returned a malformed metadata object.', { retryable: false });
  }
  const id = responseRequiredString(value.id, 'meta.id', 256);
  const type = responseRequiredString(value.type, 'meta.type', 64);
  if (expectedType !== undefined && type !== expectedType) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The add-on returned metadata for an unexpected content type.', {
      issues: [createIssue('meta.type', 'mismatch', `Expected metadata type ${expectedType}.`)],
      retryable: false,
    });
  }
  if (expectedId !== undefined && id !== expectedId) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The add-on returned metadata for an unexpected content ID.', {
      issues: [createIssue('meta.id', 'mismatch', 'The metadata ID must match the requested ID.')],
      retryable: false,
    });
  }
  const title = responseRequiredString(value.name, 'meta.name', 512);
  const genres = value.genres === undefined ? [] : value.genres;
  if (!Array.isArray(genres) || genres.length > 64 || genres.some((genre) => responseString(genre, 128) === undefined)) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The metadata genres field is invalid.', { retryable: false });
  }
  const videos = value.videos === undefined ? [] : value.videos;
  if (!Array.isArray(videos) || videos.length > limits.maxItems) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The metadata videos field is invalid.', { retryable: false });
  }
  return {
    id,
    type,
    title,
    source: context,
    genres: genres.map((genre) => responseString(genre, 128)),
    ...(optionalRemoteHttpsUrl(value.poster, limits) === undefined ? {} : { posterUrl: optionalRemoteHttpsUrl(value.poster, limits) }),
    ...(optionalRemoteHttpsUrl(value.background, limits) === undefined ? {} : { backgroundUrl: optionalRemoteHttpsUrl(value.background, limits) }),
    ...(optionalRemoteHttpsUrl(value.logo, limits) === undefined ? {} : { logoUrl: optionalRemoteHttpsUrl(value.logo, limits) }),
    ...(['poster', 'square', 'landscape'].includes(value.posterShape) ? { posterShape: value.posterShape } : {}),
    ...(responseString(value.description, 2_000) === undefined ? {} : { description: responseString(value.description, 2_000) }),
    ...(responseString(value.releaseInfo, 128) === undefined ? {} : { releaseInfo: responseString(value.releaseInfo, 128) }),
    ...(responseString(value.released, 128) === undefined ? {} : { released: responseString(value.released, 128) }),
    ...(Number.isFinite(Number(value.imdbRating)) && Number(value.imdbRating) >= 0 && Number(value.imdbRating) <= 10 ? { rating: Number(value.imdbRating) } : {}),
    ...(responseString(value.runtime, 64) === undefined ? {} : { runtime: responseString(value.runtime, 64) }),
    ...(responseString(value.language, 64) === undefined ? {} : { language: responseString(value.language, 64) }),
    ...(responseString(value.country, 64) === undefined ? {} : { country: responseString(value.country, 64) }),
    ...(optionalRemoteHttpsUrl(value.website, limits) === undefined ? {} : { websiteUrl: optionalRemoteHttpsUrl(value.website, limits) }),
    ...(videos.length === 0 ? {} : { videos: videos.map((video) => normalizeVideo(video, context, limits)) }),
  };
}

function normalizeStreamCandidate(value, context, limits, path = 'stream') {
  if (!isRecord(value)) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', `The add-on returned a malformed stream at ${path}.`, {
      issues: [createIssue(path, 'invalid_type', 'Expected a stream object.')],
    });
  }
  const label = streamLabel(value);
  const base = {
    id: `${context.addonId}:${context.itemId || 'item'}:${context.sourceIndex ?? 0}`,
    source: context,
    requiresLoomAuthorization: true,
    ...(label === undefined ? {} : { name: label }),
  };
  const p2p = inspectP2pSource(value);
  if (p2p) {
    return {
      ...base,
      sourceKind: p2p.sourceKind,
      availability: 'rejected',
      playableByLoom: false,
      requiresExplicitConsent: false,
      reason: STREMIO_PEER_TO_PEER_UNSUPPORTED_REASON,
      reasonCode: 'P2P_UNSUPPORTED',
      reference: p2p.reference,
    };
  }

  const urlValue = typeof value.url === 'string' ? value.url.trim() : undefined;
  if (urlValue !== undefined) {
    const urlCheck = inspectRemoteHttpsUrl(urlValue, { maxLength: limits.maxUrlLength });
    if (urlCheck.ok) {
      const isHls = new URL(urlCheck.url).pathname.toLowerCase().endsWith('.m3u8');
      const embedded = value.subtitles === undefined
        ? { subtitles: [], rejected: [] }
        : normalizeSubtitleList(value.subtitles, context, limits, `${path}.subtitles`);
      return {
        ...base,
        sourceKind: isHls ? 'hls' : 'https-media',
        availability: 'playable',
        playableByLoom: true,
        requiresExplicitConsent: false,
        url: urlCheck.url,
        urlRedacted: redactStremioResourceUrl(urlCheck.url),
        ...(embedded.subtitles.length === 0 ? {} : { subtitles: embedded.subtitles }),
        ...(embedded.rejected.length === 0 ? {} : { rejectedSubtitles: embedded.rejected }),
      };
    }
    return {
      ...base,
      sourceKind: 'unsupported',
      availability: 'rejected',
      playableByLoom: false,
      requiresExplicitConsent: false,
      reason: urlCheck.reason,
      reasonCode: urlCheck.code,
    };
  }

  let reason = 'The stream did not contain a direct HTTPS media URL.';
  if (value.ytId !== undefined) reason = 'YouTube player sources are not supported by the Loom adapter.';
  else if (value.externalUrl !== undefined) reason = 'External webpage links are not direct media sources.';
  else if (value.fileMustInclude !== undefined) reason = 'Archive and file-selection sources are not supported by the Loom adapter.';
  return {
    ...base,
    sourceKind: 'unsupported',
    availability: 'rejected',
    playableByLoom: false,
    requiresExplicitConsent: false,
    reason,
    reasonCode: 'unsupported_source',
  };
}

function normalizeCatalogResponse(payload, context, limits) {
  if (!isRecord(payload) || !Array.isArray(payload.metas) || payload.metas.length > limits.maxItems) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The catalog response must contain a bounded metas array.', { retryable: false });
  }
  return deepFreeze({
    resource: 'catalog',
    source: context,
    items: payload.metas.map((meta) => normalizeMetaCandidate(meta, context, limits, { expectedType: context.type })),
  });
}

function normalizeMetaResponse(payload, context, limits) {
  if (!isRecord(payload)) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The metadata response must be an object.', { retryable: false });
  }
  if (payload.meta === null) return deepFreeze({ resource: 'meta', source: context, item: null });
  if (!isRecord(payload.meta)) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The metadata response must contain a meta object or null.', { retryable: false });
  }
  return deepFreeze({
    resource: 'meta',
    source: context,
    item: normalizeMetaCandidate(payload.meta, context, limits, { expectedType: context.type, expectedId: context.itemId }),
  });
}

function normalizeStreamResponse(payload, context, limits) {
  if (!isRecord(payload) || !Array.isArray(payload.streams) || payload.streams.length > limits.maxItems) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The stream response must contain a bounded streams array.', { retryable: false });
  }
  const sources = payload.streams.map((stream, index) => normalizeStreamCandidate(
    stream,
    { ...context, sourceIndex: index },
    limits,
    `streams[${index}]`,
  ));
  return deepFreeze({
    resource: 'stream',
    source: context,
    sources,
    playableCount: sources.filter((source) => source.playableByLoom).length,
    unsupportedPeerToPeerCount: sources.filter((source) => source.reasonCode === 'P2P_UNSUPPORTED').length,
    rejectedCount: sources.filter((source) => source.availability === 'rejected').length,
  });
}

function normalizeSubtitlesResponse(payload, context, limits) {
  if (!isRecord(payload) || !Array.isArray(payload.subtitles) || payload.subtitles.length > limits.maxItems) {
    throw new StremioAdapterError('INVALID_RESPONSE_SHAPE', 'The subtitle response must contain a bounded subtitles array.', { retryable: false });
  }
  const normalized = normalizeSubtitleList(payload.subtitles, context, limits);
  return deepFreeze({
    resource: 'subtitles',
    source: context,
    subtitles: normalized.subtitles,
    rejectedCount: normalized.rejected.length,
    rejected: normalized.rejected,
  });
}

function normalizeExtra(value, limits) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new StremioAdapterError('INVALID_REQUEST', 'Stremio request extra values must be an object.', { retryable: false });
  const entries = Object.entries(value);
  if (entries.length > limits.maxExtraEntries) throw new StremioAdapterError('INVALID_REQUEST', 'Too many Stremio request extra values were supplied.', { retryable: false });
  const result = {};
  for (const [key, raw] of entries) {
    if (!safeTokenPattern.test(key)) throw new StremioAdapterError('INVALID_REQUEST', 'Stremio request extra keys must be safe tokens.', { retryable: false });
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      const text = String(raw);
      if (text.length > 512 || controlCharacterPattern.test(text)) throw new StremioAdapterError('INVALID_REQUEST', 'Stremio request extra values are too long or unsafe.', { retryable: false });
      result[key] = text;
    } else {
      throw new StremioAdapterError('INVALID_REQUEST', 'Stremio request extra values must be strings, numbers, or booleans.', { retryable: false });
    }
  }
  return result;
}

function appendExtraSegment(url, extra, limits) {
  const entries = Object.entries(extra);
  if (entries.length === 0) return url.toString();
  const serialized = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  if (serialized.length > limits.maxStringLength) throw new StremioAdapterError('INVALID_REQUEST', 'The Stremio request extra segment is too long.', { retryable: false });
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname.slice(0, -5)}/${serialized}.json`;
  return parsed.toString();
}

function buildResourceUrl(manifestUrl, resource, type, id, extra, limits) {
  const manifest = new URL(manifestUrl);
  const base = new URL('./', manifest);
  const path = `${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const url = new URL(path, base);
  url.search = manifest.search;
  const withExtra = appendExtraSegment(url, extra, limits);
  return requireRemoteHttpsUrl(withExtra, 'resource endpoint', limits);
}

function supportsResource(manifest, resource, type, id) {
  return manifest.resources.some((candidate) => {
    if (candidate.name !== resource) return false;
    if (!candidate.types.includes(type)) return false;
    if (resource === 'catalog') return true;
    return candidate.idPrefixes.length === 0 || candidate.idPrefixes.some((prefix) => id.startsWith(prefix));
  });
}

function catalogIsDeclared(manifest, type, catalogId) {
  return manifest.catalogs.some((catalog) => catalog.type === type && catalog.id === catalogId);
}

function requestToken(value, field) {
  if (typeof value !== 'string' || !safeTokenPattern.test(value.trim())) {
    throw new StremioAdapterError('INVALID_REQUEST', `${field} must be a safe Stremio protocol token.`, { retryable: false });
  }
  return value.trim();
}

function requestId(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || controlCharacterPattern.test(value)) {
    throw new StremioAdapterError('INVALID_REQUEST', `${field} must be a bounded string.`, { retryable: false });
  }
  return value.trim();
}

function nowTimestamp(now) {
  const value = Number(now());
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}

function createReviewToken() {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === 'function') return randomUuid.call(globalThis.crypto);
  reviewTokenSequence += 1;
  return `${Date.now().toString(36)}-${reviewTokenSequence.toString(36)}`;
}

function makeRecord(input) {
  return deepFreeze({
    installStateVersion: STREMIO_INSTALL_STATE_VERSION,
    addonId: input.addonId,
    manifestUrl: input.manifestUrl,
    manifest: input.manifest,
    reviewToken: input.reviewToken,
    state: input.state,
    trusted: input.trusted,
    installedAt: input.installedAt,
    reviewedAt: input.reviewedAt,
    ...(input.approvedAt === undefined ? {} : { approvedAt: input.approvedAt }),
    ...(input.disabledAt === undefined ? {} : { disabledAt: input.disabledAt }),
  });
}

function publicRecord(record) {
  const { manifestUrl, ...safe } = record;
  const parsed = new URL(manifestUrl);
  return deepFreeze({
    ...safe,
    manifestOrigin: parsed.origin,
    manifestUrlRedacted: redactStremioUrl(manifestUrl),
  });
}

function requestSource(record, type, itemId, sourceIndex) {
  return deepFreeze({
    addonId: record.addonId,
    manifestOrigin: new URL(record.manifestUrl).origin,
    manifestUrlRedacted: redactStremioUrl(record.manifestUrl),
    type,
    itemId,
    ...(sourceIndex === undefined ? {} : { sourceIndex }),
  });
}

function requireRecordId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new StremioAdapterError('INVALID_REQUEST', 'An add-on ID is required.', { retryable: false });
  return value.trim();
}

function requireEnabled(record) {
  if (!record || record.state !== 'enabled' || record.trusted !== true) {
    throw new StremioAdapterError('ADDON_NOT_ENABLED', 'The Stremio add-on is not enabled by explicit user approval.', { retryable: false });
  }
}

function normalizePersistedTimestamp(value, path, issues, required = true) {
  if (value === undefined && !required) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    issues.push(createIssue(path, 'invalid_value', 'Expected a non-negative integer timestamp.'));
    return undefined;
  }
  return value;
}

function persistedManifestInput(value) {
  if (!isRecord(value)) return value;
  const hasNormalizedMarkers = Object.hasOwn(value, 'adapterProtocolVersion')
    || Object.hasOwn(value, 'logoUrl')
    || Object.hasOwn(value, 'backgroundUrl')
    || Object.hasOwn(value, 'peerToPeerDeclared')
    || Object.hasOwn(value, 'supportedLoomCapabilities');
  if (!hasNormalizedMarkers) return value;
  return {
    id: value.id,
    version: value.version,
    name: value.name,
    description: value.description,
    resources: Array.isArray(value.resources)
      ? [
        ...value.resources.map((resource) => ({
          name: resource?.name,
          ...(resource?.types === undefined ? {} : { types: resource.types }),
          ...(resource?.idPrefixes === undefined ? {} : { idPrefixes: resource.idPrefixes }),
        })),
        ...(Array.isArray(value.unsupportedResources) ? value.unsupportedResources : []),
      ]
      : value.resources,
    types: value.types,
    idPrefixes: value.idPrefixes,
    catalogs: value.catalogs,
    ...(value.logoUrl === undefined ? {} : { logo: value.logoUrl }),
    ...(value.backgroundUrl === undefined ? {} : { background: value.backgroundUrl }),
    ...(value.contactEmail === undefined ? {} : { contactEmail: value.contactEmail }),
    ...(value.behaviorHints === undefined ? {} : { behaviorHints: value.behaviorHints }),
    ...(value.config === undefined ? {} : { config: value.config }),
  };
}

function normalizePersistedRecord(value, path, options) {
  const issues = [];
  if (!isRecord(value)) {
    throw new StremioAdapterError('INVALID_PERSISTED_STATE', 'A persisted Stremio add-on record must be an object.', { retryable: false });
  }
  addUnknownKeys(value, new Set(['installStateVersion', 'addonId', 'manifestUrl', 'manifest', 'reviewToken', 'state', 'trusted', 'installedAt', 'reviewedAt', 'approvedAt', 'disabledAt']), path, issues);
  if (value.installStateVersion !== STREMIO_INSTALL_STATE_VERSION) issues.push(createIssue(`${path}.installStateVersion`, 'unsupported_version', 'Unsupported Stremio install state version.'));
  const addonId = addIssueIfInvalidString(value.addonId, `${path}.addonId`, issues, { required: true, maxLength: 128, pattern: manifestIdPattern, message: 'Expected a Stremio add-on ID.' });
  const reviewToken = addIssueIfInvalidString(value.reviewToken, `${path}.reviewToken`, issues, { required: true, maxLength: 128, message: 'Expected a persisted review token.' });
  const persistedManifestUrl = typeof value.manifestUrl === 'string' ? value.manifestUrl : undefined;
  let manifestUrl;
  let manifest;
  try {
    manifestUrl = requireRemoteHttpsUrl(persistedManifestUrl, `${path}.manifestUrl`, options);
    manifest = normalizeStremioManifest(persistedManifestInput(value.manifest), manifestUrl, options);
  } catch (error) {
    if (error instanceof StremioAdapterError) issues.push(...error.issues.map((entry) => ({ ...entry, path: `${path}.manifest.${entry.path}` })));
    else issues.push(createIssue(`${path}.manifest`, 'invalid_value', 'The persisted manifest is invalid.'));
  }
  if (manifest && addonId && manifest.id !== addonId) issues.push(createIssue(`${path}.manifest.id`, 'mismatch', 'Persisted add-on ID does not match the manifest ID.'));
  if (!installStateSet.has(value.state)) issues.push(createIssue(`${path}.state`, 'invalid_value', 'Unsupported persisted install state.'));
  if (typeof value.trusted !== 'boolean') issues.push(createIssue(`${path}.trusted`, 'invalid_type', 'Persisted trust state must be boolean.'));
  if (value.state === 'enabled' && value.trusted !== true) issues.push(createIssue(`${path}.trusted`, 'inconsistent_state', 'Enabled add-ons must have explicit trusted state.'));
  if (value.state !== 'enabled' && value.trusted === true) issues.push(createIssue(`${path}.trusted`, 'inconsistent_state', 'Pending or disabled add-ons cannot remain trusted.'));
  const installedAt = normalizePersistedTimestamp(value.installedAt, `${path}.installedAt`, issues);
  const reviewedAt = normalizePersistedTimestamp(value.reviewedAt, `${path}.reviewedAt`, issues);
  const approvedAt = normalizePersistedTimestamp(value.approvedAt, `${path}.approvedAt`, issues, false);
  const disabledAt = normalizePersistedTimestamp(value.disabledAt, `${path}.disabledAt`, issues, false);
  if (value.state === 'enabled' && approvedAt === undefined) issues.push(createIssue(`${path}.approvedAt`, 'missing', 'Enabled add-ons must retain an approval timestamp.'));
  if (value.state === 'enabled' && disabledAt !== undefined) issues.push(createIssue(`${path}.disabledAt`, 'inconsistent_state', 'Enabled add-ons cannot retain a disabled timestamp.'));
  if (value.state === 'pending-review' && approvedAt !== undefined) issues.push(createIssue(`${path}.approvedAt`, 'inconsistent_state', 'Pending reviews cannot retain an approval timestamp.'));
  if (value.state === 'pending-review' && disabledAt !== undefined) issues.push(createIssue(`${path}.disabledAt`, 'inconsistent_state', 'Pending reviews cannot retain a disabled timestamp.'));
  if (value.state === 'disabled' && disabledAt === undefined) issues.push(createIssue(`${path}.disabledAt`, 'missing', 'Disabled add-ons must retain a disabled timestamp.'));
  if (issues.length > 0 || !manifest || !manifestUrl || !addonId || !reviewToken) {
    throw new StremioAdapterError('INVALID_PERSISTED_STATE', 'Persisted Stremio add-on state failed validation.', { issues, retryable: false });
  }
  return makeRecord({ addonId, manifestUrl, manifest, reviewToken, state: value.state, trusted: value.trusted, installedAt, reviewedAt, approvedAt, disabledAt });
}

function serializeRecord(record) {
  return {
    ...record,
    manifest: persistedManifestInput(record.manifest),
  };
}

export class StremioAdapterError extends Error {
  constructor(code, message, { issues = [], retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StremioAdapterError';
    this.code = code;
    this.retryable = retryable;
    this.issues = deepFreeze(issues.map((entry) => ({ ...entry })));
  }
}

/**
 * Registry and HTTP client boundary for user-installed Stremio add-ons.
 * Reviewing a URL never enables it. Only approve({ confirmed: true }) changes
 * a record into an enabled/trusted state. The approval must include the
 * reviewToken returned by the current review result.
 */
export class StremioAddonRegistry {
  constructor(options = {}) {
    this.options = Object.freeze({
      fetchImpl: options.fetchImpl || globalThis.fetch,
      requestGuard: typeof options.requestGuard === 'function' ? options.requestGuard : undefined,
      limits: normalizeLimits(options),
      now: typeof options.now === 'function' ? options.now : Date.now,
    });
    this.records = new Map();
  }

  static fromPersistedState(snapshot, options = {}) {
    const registry = new StremioAddonRegistry(options);
    registry.loadPersistedState(snapshot);
    return registry;
  }

  async reviewManifestUrl(manifestUrl) {
    const safeManifestUrl = requireRemoteHttpsUrl(manifestUrl, 'manifestUrl', this.options.limits);
    const rawManifest = await fetchJson(safeManifestUrl, {
      fetchImpl: this.options.fetchImpl,
      requestGuard: this.options.requestGuard,
      limits: this.options.limits,
      maxBytes: this.options.limits.maxManifestBytes,
      label: 'manifest',
    });
    const manifest = normalizeStremioManifest(rawManifest, safeManifestUrl, this.options.limits);
    const timestamp = nowTimestamp(this.options.now);
    for (const [id, existing] of this.records.entries()) {
      if (existing.manifestUrl === safeManifestUrl && id !== manifest.id) {
        this.records.set(id, makeRecord({ ...existing, state: 'disabled', trusted: false, disabledAt: timestamp }));
      }
    }
    const existing = this.records.get(manifest.id);
    const record = makeRecord({
      addonId: manifest.id,
      manifestUrl: safeManifestUrl,
      manifest,
      reviewToken: createReviewToken(),
      state: 'pending-review',
      trusted: false,
      installedAt: existing?.installedAt || timestamp,
      reviewedAt: timestamp,
    });
    this.records.set(manifest.id, record);
    return deepFreeze({
      ...publicRecord(record),
      approvalRequired: true,
      reviewWarnings: Object.freeze([
        ...manifest.compatibilityWarnings.map((warning) => warning.message),
        ...(manifest.peerToPeerDeclared ? [STREMIO_PEER_TO_PEER_UNSUPPORTED_REASON] : []),
        ...(manifest.behaviorHints.configurationRequired ? ['This add-on declares required configuration; LoomTV does not fetch remote configuration pages.'] : []),
      ]),
    });
  }

  approve(addonId, approval) {
    const id = requireRecordId(addonId);
    const record = this.records.get(id);
    if (!record) throw new StremioAdapterError('ADDON_NOT_FOUND', 'The Stremio add-on is not installed.', { retryable: false });
    if (record.state === 'enabled' && record.trusted === true) return publicRecord(record);
    if (!isRecord(approval) || approval.confirmed !== true || approval.reviewToken !== record.reviewToken) {
      throw new StremioAdapterError('APPROVAL_REQUIRED', 'Explicit approval for the current reviewed manifest is required before enabling this Stremio add-on.', { retryable: false });
    }
    const timestamp = nowTimestamp(this.options.now);
    const enabled = makeRecord({ ...record, state: 'enabled', trusted: true, approvedAt: timestamp, disabledAt: undefined });
    this.records.set(id, enabled);
    return publicRecord(enabled);
  }

  disable(addonId) {
    const id = requireRecordId(addonId);
    const record = this.records.get(id);
    if (!record) throw new StremioAdapterError('ADDON_NOT_FOUND', 'The Stremio add-on is not installed.', { retryable: false });
    const disabled = makeRecord({ ...record, state: 'disabled', trusted: false, disabledAt: nowTimestamp(this.options.now) });
    this.records.set(id, disabled);
    return publicRecord(disabled);
  }

  remove(addonId) {
    return this.records.delete(requireRecordId(addonId));
  }

  get(addonId) {
    const record = this.records.get(requireRecordId(addonId));
    return record ? publicRecord(record) : undefined;
  }

  list() {
    return deepFreeze([...this.records.values()].map(publicRecord));
  }

  toJSON() {
    return deepFreeze({
      stateVersion: STREMIO_INSTALL_STATE_VERSION,
      addons: [...this.records.values()].map(serializeRecord),
    });
  }

  loadPersistedState(snapshot) {
    const issues = [];
    if (!isRecord(snapshot)) throw new StremioAdapterError('INVALID_PERSISTED_STATE', 'Persisted Stremio add-on state must be an object.', { retryable: false });
    addUnknownKeys(snapshot, new Set(['stateVersion', 'addons']), '$', issues);
    if (snapshot.stateVersion !== STREMIO_INSTALL_STATE_VERSION) issues.push(createIssue('$.stateVersion', 'unsupported_version', 'Unsupported Stremio install state version.'));
    if (!Array.isArray(snapshot.addons) || snapshot.addons.length > 64) issues.push(createIssue('$.addons', 'invalid_value', 'Persisted add-ons must be a bounded array.'));
    if (issues.length > 0) throw new StremioAdapterError('INVALID_PERSISTED_STATE', 'Persisted Stremio add-on state failed validation.', { issues, retryable: false });
    const records = new Map();
    for (let index = 0; index < snapshot.addons.length; index += 1) {
      const record = normalizePersistedRecord(snapshot.addons[index], createPath('$.addons', index), this.options.limits);
      if (records.has(record.addonId)) throw new StremioAdapterError('INVALID_PERSISTED_STATE', 'Persisted Stremio add-on IDs must be unique.', { retryable: false });
      records.set(record.addonId, record);
    }
    this.records = records;
    return this.list();
  }

  requireEnabledRecord(addonId) {
    return publicRecord(this.requireEnabledInternalRecord(addonId));
  }

  requireEnabledInternalRecord(addonId) {
    const record = this.records.get(requireRecordId(addonId));
    requireEnabled(record);
    return record;
  }

  async fetchCatalog(addonId, { type, catalogId, extra } = {}) {
    const record = this.requireEnabledInternalRecord(addonId);
    const normalizedType = requestToken(type, 'type');
    const normalizedCatalogId = requestId(catalogId, 'catalogId');
    if (!catalogIsDeclared(record.manifest, normalizedType, normalizedCatalogId) || !supportsResource(record.manifest, 'catalog', normalizedType, normalizedCatalogId)) {
      throw new StremioAdapterError('RESOURCE_NOT_DECLARED', 'The installed add-on does not declare this catalog resource.', { retryable: false });
    }
    const normalizedExtra = normalizeExtra(extra, this.options.limits);
    const url = buildResourceUrl(record.manifestUrl, 'catalog', normalizedType, normalizedCatalogId, normalizedExtra, this.options.limits);
    const payload = await fetchJson(url, { fetchImpl: this.options.fetchImpl, requestGuard: this.options.requestGuard, limits: this.options.limits, maxBytes: this.options.limits.maxResponseBytes, label: 'catalog' });
    return normalizeCatalogResponse(payload, requestSource(record, normalizedType, normalizedCatalogId), this.options.limits);
  }

  async fetchMeta(addonId, { type, id, extra } = {}) {
    return this.fetchResource(addonId, 'meta', type, id, extra, (payload, context) => normalizeMetaResponse(payload, context, this.options.limits));
  }

  async fetchStreams(addonId, { type, videoId, extra } = {}) {
    return this.fetchResource(addonId, 'stream', type, videoId, extra, (payload, context) => normalizeStreamResponse(payload, context, this.options.limits));
  }

  async fetchSubtitles(addonId, { type, videoId, extra } = {}) {
    return this.fetchResource(addonId, 'subtitles', type, videoId, extra, (payload, context) => normalizeSubtitlesResponse(payload, context, this.options.limits));
  }

  async fetchResource(addonId, resource, type, id, extra, normalize) {
    const record = this.requireEnabledInternalRecord(addonId);
    const normalizedType = requestToken(type, 'type');
    const normalizedId = requestId(id, resource === 'stream' || resource === 'subtitles' ? 'videoId' : 'id');
    if (!supportsResource(record.manifest, resource, normalizedType, normalizedId)) {
      throw new StremioAdapterError('RESOURCE_NOT_DECLARED', `The installed add-on does not declare the ${resource} resource for this request.`, { retryable: false });
    }
    const normalizedExtra = normalizeExtra(extra, this.options.limits);
    const url = buildResourceUrl(record.manifestUrl, resource, normalizedType, normalizedId, normalizedExtra, this.options.limits);
    const payload = await fetchJson(url, { fetchImpl: this.options.fetchImpl, requestGuard: this.options.requestGuard, limits: this.options.limits, maxBytes: this.options.limits.maxResponseBytes, label: resource });
    return normalize(payload, requestSource(record, normalizedType, normalizedId));
  }
}

export function createStremioAddonRegistry(options = {}) {
  return new StremioAddonRegistry(options);
}

export function serializeStremioAddonState(registry) {
  if (!registry || typeof registry.toJSON !== 'function') throw new StremioAdapterError('INVALID_REQUEST', 'A StremioAddonRegistry is required.', { retryable: false });
  return registry.toJSON();
}
