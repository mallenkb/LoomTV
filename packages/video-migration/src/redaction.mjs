/**
 * Report redaction guards.
 *
 * The program contract says reports omit secrets, tokens, PINs, raw library paths,
 * and certificate material, and the canonical server's plan carries `plan.state` with credentials and
 * raw locators in it. Rather than trusting every call site, the bridge runs the
 * finished report through these guards before it is written, and refuses to write a
 * report that would leak.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { migrationError } from './errors.mjs';

/** Keys that may never appear anywhere in a report, at any depth. */
const FORBIDDEN_KEYS = new Set([
  'accesstoken', 'accesstokenhash', 'allowedfolders', 'cert', 'credential', 'credentials',
  'dataurl', 'filepath', 'folderpath', 'hash', 'hmacsecret', 'key', 'locator', 'password',
  'passwordhash', 'path', 'pin', 'pinhash', 'pinsalt', 'privatekey', 'refreshtoken',
  'refreshtokenhash', 'salt', 'secret', 'secrethash', 'sharetoken', 'state', 'token', 'tokenhash',
]);

/** Values shaped like an absolute path, a UNC share, a home-relative path, or a URL. */
const LOCATOR_SHAPES = [
  /^[\\/]/,
  /^~[\\/]/,
  /^[A-Za-z]:[\\/]/,
  /:\/\//,
  /^data:/i,
];

/**
 * Stable, non-reversible reference to a locator. Two records that pointed at the same
 * path share a fingerprint, so operators can correlate rows in a report without the
 * report ever naming a directory.
 */
export function locatorFingerprint(locator) {
  return createHash('sha256').update(path.resolve(String(locator))).digest('hex').slice(0, 32);
}

/** Same construction for values that are already opaque, such as a track-preference scope. */
export function opaqueFingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function looksLikeLocator(value) {
  return LOCATOR_SHAPES.some((shape) => shape.test(value));
}

/**
 * A forbidden key only leaks when it carries something to leak. the canonical server's frozen report ends
 * with `redactions: { rawPaths: true, credentials: true, sourceLocators: true }`, which
 * are assertions that redaction happened, not the material itself. Booleans, numbers, and
 * null under a forbidden key are therefore allowed; strings, objects, and arrays are not.
 */
function carriesMaterial(value) {
  if (value === null || value === undefined) return false;
  return typeof value !== 'boolean' && typeof value !== 'number';
}

function walk(node, trail, onViolation) {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => walk(entry, `${trail}[${index}]`, onViolation));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const next = trail ? `${trail}.${key}` : key;
      if (FORBIDDEN_KEYS.has(key.toLowerCase()) && carriesMaterial(value)) onViolation(next, 'forbidden_key');
      walk(value, next, onViolation);
    }
    return;
  }
  if (typeof node === 'string' && looksLikeLocator(node)) onViolation(trail, 'locator_shaped_value');
}

/**
 * Throws when the report would carry a secret or a raw locator. The thrown error names
 * the offending field trail and the rule that fired, never the offending value.
 */
export function assertRedacted(report) {
  const violations = [];
  walk(report, '', (field, rule) => violations.push({ field, rule }));
  if (violations.length) {
    throw migrationError(
      'report_redaction_violation',
      'The migration report contains fields that the program contract forbids.',
      { violations: violations.slice(0, 32), violationCount: violations.length },
    );
  }
  return report;
}

/**
 * the canonical server froze the report field list. A report with extra or missing top-level fields is
 * rejected rather than written, so an operator never reads a report that a later
 * canonical reader will refuse.
 */
export function assertReportFields(report, expectedFields) {
  const actual = Object.keys(report).sort();
  const expected = [...expectedFields].sort();
  const missing = expected.filter((field) => !actual.includes(field));
  const unexpected = actual.filter((field) => !expected.includes(field));
  if (missing.length || unexpected.length) {
    throw migrationError(
      'report_field_mismatch',
      'The migration report does not match the frozen canonical report field list.',
      { missing, unexpected },
    );
  }
  return report;
}
