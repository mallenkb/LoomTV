/**
 * LoomTV plugin protocol foundation.
 *
 * This module validates declarations only. It deliberately does not load,
 * fetch, or execute plugin code. A future runtime must put any provider
 * implementation behind a separately reviewed transport/sandbox boundary.
 */

export const PLUGIN_MANIFEST_VERSION = 1;
export const PLUGIN_MANIFEST_SCHEMA_ID = 'https://loomtv.app/schemas/plugin-manifest.v1.schema.json';
export const LOOM_PLUGIN_API_VERSION = '1.0.0';

export const SUPPORTED_PLUGIN_CAPABILITIES = Object.freeze([
  'metadata.catalog',
  'subtitle.provider',
  'playback.provider',
]);

/**
 * Playback hooks are intentionally a small, host-mediated allowlist. Adding
 * a hook is a protocol change and must be reviewed with its data and security
 * boundary before it is added here and to the JSON Schema.
 */
export const APPROVED_PLAYBACK_PROVIDER_HOOKS = Object.freeze([
  'resolve-source',
  'list-variants',
]);

const supportedCapabilitySet = new Set(SUPPORTED_PLUGIN_CAPABILITIES);
const approvedPlaybackHookSet = new Set(APPROVED_PLAYBACK_PROVIDER_HOOKS);
const fullSemVerPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const stableSemVerPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const pluginIdPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(path, code, message) {
  return { path, code, message };
}

function pathForIndex(path, index) {
  return `${path}[${index}]`;
}

function addUnknownKeyIssues(value, allowedKeys, path, issues) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(issue(`${path}.${key}`, 'unknown_field', 'Unknown fields are not allowed.'));
    }
  }
}

function readText(value, path, issues, { required = false, maxLength = 256 } = {}) {
  if (value === undefined) {
    if (required) issues.push(issue(path, 'missing', 'A value is required.'));
    return undefined;
  }
  if (typeof value !== 'string') {
    issues.push(issue(path, 'invalid_type', 'Expected a string.'));
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    issues.push(issue(path, 'invalid_value', 'The string must not be empty.'));
    return undefined;
  }
  if (text.length > maxLength) {
    issues.push(issue(path, 'invalid_value', `The string must be at most ${maxLength} characters.`));
    return undefined;
  }
  if (controlCharacterPattern.test(text)) {
    issues.push(issue(path, 'invalid_value', 'Control characters are not allowed.'));
    return undefined;
  }
  return text;
}

function readManifestVersion(value, path, issues) {
  if (typeof value !== 'string' || value.length > 64 || !fullSemVerPattern.test(value)) {
    issues.push(issue(path, 'invalid_version', 'Expected a SemVer release such as 1.2.3.'));
    return undefined;
  }
  return value;
}

function parseStableVersion(value) {
  const match = stableSemVerPattern.exec(String(value));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function version(major, minor, patch) {
  return { major, minor, patch };
}

function constraint(operator, target) {
  return { operator, target };
}

function wildcardConstraints(token) {
  const match = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|x|X))?(?:\.(0|[1-9]\d*|x|X))?$/.exec(token);
  if (!match) return null;

  const major = Number(match[1]);
  const minorPart = match[2];
  const patchPart = match[3];

  if (minorPart === undefined || minorPart === 'x' || minorPart === 'X') {
    return [
      constraint('>=', version(major, 0, 0)),
      constraint('<', version(major + 1, 0, 0)),
    ];
  }

  const minor = Number(minorPart);
  if (patchPart === undefined || patchPart === 'x' || patchPart === 'X') {
    return [
      constraint('>=', version(major, minor, 0)),
      constraint('<', version(major, minor + 1, 0)),
    ];
  }

  const patch = Number(patchPart);
  return [constraint('=', version(major, minor, patch))];
}

function caretConstraints(target) {
  let upper;
  if (target.major > 0) upper = version(target.major + 1, 0, 0);
  else if (target.minor > 0) upper = version(0, target.minor + 1, 0);
  else upper = version(0, 0, target.patch + 1);
  return [constraint('>=', target), constraint('<', upper)];
}

function tildeConstraints(target) {
  return [constraint('>=', target), constraint('<', version(target.major, target.minor + 1, 0))];
}

/**
 * Parse the deliberately small range language supported by v1 manifests.
 * Supported forms are exact/stable SemVer, whitespace-separated comparators,
 * caret, tilde, and x-ranges. OR ranges and prerelease ranges are rejected so
 * compatibility decisions stay deterministic at a trust boundary.
 */
function parseApiRange(range) {
  const normalized = String(range || '').trim();
  if (!normalized || normalized.includes('||')) return null;
  if (normalized === '*' || normalized.toLowerCase() === 'x') return [];

  const tokens = normalized.split(/\s+/);
  const constraints = [];
  for (const token of tokens) {
    if (token === '*' || token.toLowerCase() === 'x') return null;

    const wildcard = wildcardConstraints(token);
    if (wildcard) {
      constraints.push(...wildcard);
      continue;
    }

    const caret = /^\^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(token);
    if (caret) {
      constraints.push(...caretConstraints(parseStableVersion(caret[1])));
      continue;
    }

    const tilde = /^~((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(token);
    if (tilde) {
      constraints.push(...tildeConstraints(parseStableVersion(tilde[1])));
      continue;
    }

    const comparator = /^(<=|>=|<|>|=)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(token);
    if (!comparator) return null;
    constraints.push(constraint(comparator[1] || '=', parseStableVersion(comparator[2])));
  }
  return constraints;
}

function satisfiesConstraint(candidate, current) {
  const comparison = compareVersions(current, candidate.target);
  switch (candidate.operator) {
    case '>': return comparison > 0;
    case '>=': return comparison >= 0;
    case '<': return comparison < 0;
    case '<=': return comparison <= 0;
    case '=': return comparison === 0;
    default: return false;
  }
}

export function isLoomApiRangeCompatible(range, loomApiVersion = LOOM_PLUGIN_API_VERSION) {
  const constraints = parseApiRange(range);
  const current = parseStableVersion(loomApiVersion);
  return constraints !== null && current !== null && constraints.every((candidate) => satisfiesConstraint(candidate, current));
}

function validateHomepage(value, path, issues) {
  const homepage = readText(value, path, issues, { maxLength: 2_048 });
  if (homepage === undefined) return undefined;
  try {
    const url = new URL(homepage);
    if (url.protocol !== 'https:' || url.username || url.password) {
      issues.push(issue(path, 'invalid_value', 'Homepage URLs must use HTTPS and must not contain credentials.'));
      return undefined;
    }
  } catch {
    issues.push(issue(path, 'invalid_value', 'Homepage must be a valid HTTPS URL.'));
    return undefined;
  }
  return homepage;
}

function validateCapability(value, path, issues, seenTypes) {
  if (!isRecord(value)) {
    issues.push(issue(path, 'invalid_type', 'Expected a capability object.'));
    return null;
  }

  const type = value.type;
  const isPlayback = type === 'playback.provider';
  addUnknownKeyIssues(value, new Set(isPlayback ? ['type', 'apiVersion', 'hooks'] : ['type', 'apiVersion']), path, issues);

  if (typeof type !== 'string' || !supportedCapabilitySet.has(type)) {
    issues.push(issue(`${path}.type`, 'unsupported_capability', `Capability must be one of: ${SUPPORTED_PLUGIN_CAPABILITIES.join(', ')}.`));
    return null;
  }
  if (seenTypes.has(type)) {
    issues.push(issue(`${path}.type`, 'duplicate_capability', 'Each capability category may be declared only once.'));
  }
  seenTypes.add(type);

  if (value.apiVersion !== 1) {
    issues.push(issue(`${path}.apiVersion`, 'unsupported_version', 'Only capability API version 1 is supported.'));
  }

  if (type !== 'playback.provider') return { type, apiVersion: 1 };

  if (!Array.isArray(value.hooks)) {
    issues.push(issue(`${path}.hooks`, 'invalid_type', 'Playback providers must declare an array of approved hooks.'));
    return { type, apiVersion: 1, hooks: [] };
  }
  if (value.hooks.length < 1 || value.hooks.length > APPROVED_PLAYBACK_PROVIDER_HOOKS.length) {
    issues.push(issue(`${path}.hooks`, 'invalid_value', `Playback providers must declare 1-${APPROVED_PLAYBACK_PROVIDER_HOOKS.length} hooks.`));
  }

  const hooks = [];
  const seenHooks = new Set();
  for (let index = 0; index < value.hooks.length; index += 1) {
    const hookPath = pathForIndex(`${path}.hooks`, index);
    const hook = value.hooks[index];
    if (typeof hook !== 'string' || !approvedPlaybackHookSet.has(hook)) {
      issues.push(issue(hookPath, 'unsupported_hook', `Hook must be one of: ${APPROVED_PLAYBACK_PROVIDER_HOOKS.join(', ')}.`));
      continue;
    }
    if (seenHooks.has(hook)) {
      issues.push(issue(hookPath, 'duplicate_hook', 'Playback hooks must be unique.'));
      continue;
    }
    seenHooks.add(hook);
    hooks.push(hook);
  }
  return { type, apiVersion: 1, hooks };
}

function freezeManifest(manifest) {
  const capabilities = manifest.capabilities.map((capability) => Object.freeze(
    capability.type === 'playback.provider'
      ? { ...capability, hooks: Object.freeze([...capability.hooks]) }
      : { ...capability },
  ));
  return Object.freeze({
    ...manifest,
    loomApi: Object.freeze({ ...manifest.loomApi }),
    capabilities: Object.freeze(capabilities),
  });
}

/**
 * Validate and normalize an untrusted manifest at an install or load
 * boundary. The host API check is enabled by default; pass the host version
 * explicitly when validating for a different Loom runtime.
 */
export function validatePluginManifest(input, options = {}) {
  const issues = [];
  if (!isRecord(input)) {
    throw new PluginManifestValidationError([
      issue('$', 'invalid_type', 'A plugin manifest must be a JSON object.'),
    ]);
  }

  addUnknownKeyIssues(input, new Set([
    'manifestVersion',
    'id',
    'name',
    'version',
    'loomApi',
    'description',
    'author',
    'homepage',
    'capabilities',
  ]), '$', issues);

  if (input.manifestVersion !== PLUGIN_MANIFEST_VERSION) {
    issues.push(issue('$.manifestVersion', 'unsupported_version', `Only manifest version ${PLUGIN_MANIFEST_VERSION} is supported.`));
  }

  const id = readText(input.id, '$.id', issues, { required: true, maxLength: 128 });
  if (id !== undefined && !pluginIdPattern.test(id)) {
    issues.push(issue('$.id', 'invalid_value', 'Use a lowercase reverse-DNS identifier such as org.example.loom.catalog.'));
  }

  const name = readText(input.name, '$.name', issues, { required: true, maxLength: 80 });
  const version = readManifestVersion(input.version, '$.version', issues);
  const description = readText(input.description, '$.description', issues, { maxLength: 500 });
  const author = readText(input.author, '$.author', issues, { maxLength: 120 });
  const homepage = input.homepage === undefined
    ? undefined
    : validateHomepage(input.homepage, '$.homepage', issues);

  let apiRange;
  if (!isRecord(input.loomApi)) {
    issues.push(issue('$.loomApi', 'invalid_type', 'loomApi must be an object containing a compatible range.'));
  } else {
    addUnknownKeyIssues(input.loomApi, new Set(['range']), '$.loomApi', issues);
    apiRange = readText(input.loomApi.range, '$.loomApi.range', issues, { required: true, maxLength: 128 });
    if (apiRange !== undefined && parseApiRange(apiRange) === null) {
      issues.push(issue('$.loomApi.range', 'invalid_range', 'Use stable SemVer comparators, caret, tilde, or x-ranges; OR ranges are not supported.'));
    }
  }

  const capabilities = [];
  if (!Array.isArray(input.capabilities)) {
    issues.push(issue('$.capabilities', 'invalid_type', 'capabilities must be an array.'));
  } else {
    if (input.capabilities.length < 1 || input.capabilities.length > 8) {
      issues.push(issue('$.capabilities', 'invalid_value', 'Declare between 1 and 8 capabilities.'));
    }
    const seenTypes = new Set();
    for (let index = 0; index < input.capabilities.length; index += 1) {
      const capability = validateCapability(input.capabilities[index], pathForIndex('$.capabilities', index), issues, seenTypes);
      if (capability) capabilities.push(capability);
    }
  }

  const hostApiVersion = options.loomApiVersion || LOOM_PLUGIN_API_VERSION;
  const parsedHostApiVersion = parseStableVersion(hostApiVersion);
  if (parsedHostApiVersion === null) {
    issues.push(issue('options.loomApiVersion', 'invalid_version', 'The host Loom API version must be stable SemVer.'));
  } else if (options.checkCompatibility !== false && apiRange && parseApiRange(apiRange) !== null && !isLoomApiRangeCompatible(apiRange, hostApiVersion)) {
    issues.push(issue('$.loomApi.range', 'incompatible_loom_api', `The manifest is not compatible with Loom API ${hostApiVersion}.`));
  }

  if (issues.length > 0) throw new PluginManifestValidationError(issues);

  return freezeManifest({
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    id,
    name,
    version,
    loomApi: { range: apiRange },
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    capabilities,
  });
}

/** Install boundary alias: validate before persistence or registration. */
export function installPluginManifest(input, options = {}) {
  return validatePluginManifest(input, options);
}

/** Load boundary alias: validate again when a persisted declaration is used. */
export function loadPluginManifest(input, options = {}) {
  return validatePluginManifest(input, options);
}

export class PluginManifestValidationError extends Error {
  constructor(issues) {
    const normalizedIssues = Object.freeze(issues.map((entry) => Object.freeze({ ...entry })));
    const detail = normalizedIssues.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
    super(`Invalid LoomTV plugin manifest${detail ? `: ${detail}` : '.'}`);
    this.name = 'PluginManifestValidationError';
    this.code = 'PLUGIN_MANIFEST_INVALID';
    this.issues = normalizedIssues;
  }
}

export * from './stremio-adapter.mjs';
