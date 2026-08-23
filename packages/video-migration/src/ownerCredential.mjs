/**
 * Owner account credential for a desktop-sourced migration.
 *
 * The desktop app has no account model: it has profiles and optional four-digit profile
 * PINs. The canonical store requires exactly one owner account with a scrypt password
 * credential that is `NOT NULL`. There is no password to carry across, so the migration
 * takes one from the operator instead of inventing one, and refuses to run without it.
 * Silently writing an unusable random credential would lock the owner out of the server
 * the migration just created.
 *
 * The derivation matches `hashPassword` in the canonical server's `apps/server/src/admin-service.js`:
 * scrypt with default parameters, a 16-byte hex salt, 64 derived bytes, base64 hash.
 *
 * The salt is derived from the owner account ID rather than drawn at random. The canonical
 * import fingerprint covers the projected owner credential, so a random salt would give
 * every attempt a different migration ID and no rerun could be recognised as the same
 * migration. The account ID is derived from this installation's own profile identifiers,
 * so the salt stays unique to the installation.
 */

import { promisify } from 'node:util';
import { createHash, scrypt as scryptCallback } from 'node:crypto';
import { migrationError } from './errors.mjs';

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 64;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

/**
 * @param {object} input
 * @param {string} input.name owner display name
 * @param {string} input.password owner password, never logged, never written to a report
 * @param {string} [input.accountId] reuse an existing opaque owner account ID on rerun
 */
export async function createOwnerAccount({ name, password, accountId, createdAt = Date.now() }) {
  const displayName = String(name || '').trim();
  if (!displayName) {
    throw migrationError('owner_credential_required', 'A desktop migration needs an owner account name.');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw migrationError(
      'owner_credential_required',
      `A desktop migration needs an owner password of ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
  if (typeof accountId !== 'string' || !accountId) {
    throw migrationError('owner_credential_required', 'A desktop migration needs a stable owner account identifier.');
  }
  const salt = createHash('sha256').update(`loomtv-canonical-owner-salt:${accountId}`).digest('hex').slice(0, 32);
  const derived = await scrypt(password, salt, PASSWORD_BYTES);
  return {
    id: accountId,
    name: displayName.slice(0, 80),
    salt,
    hash: Buffer.from(derived).toString('base64'),
    createdAt,
    updatedAt: createdAt,
  };
}
