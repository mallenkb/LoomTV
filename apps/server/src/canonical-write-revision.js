export const ADMIN_WRITE_REVISION = Symbol('canonical-admin-write-revision');

/** The symbol survives object spreads but never JSON serialization.
 * @template {object} T @param {T} target @param {unknown} source @returns {T} */
export function carryAdminWriteRevision(target, source) {
  if (source && typeof source === 'object' && ADMIN_WRITE_REVISION in source) {
    Object.defineProperty(target, ADMIN_WRITE_REVISION, { value: source[ADMIN_WRITE_REVISION], enumerable: true });
  }
  return target;
}
