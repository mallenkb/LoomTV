/**
 * Filesystem containment for media paths.
 *
 * Every read, stream, transcode, download, probe, and delete that touches a
 * catalog path goes through this module so that containment is decided in one
 * place instead of at each call site. The invariant it enforces is:
 *
 *   realpath(candidate) is exactly realpath(root), or it begins with
 *   realpath(root) + path.sep, and the bytes that are actually served come
 *   from a descriptor opened with O_NOFOLLOW whose fstat reports a regular
 *   file with the same device and inode observed when the request was
 *   authorized.
 *
 * `deleteLibraryItem` already used the realpath-then-compare shape; this is
 * that shape extracted, given descriptor-safe open semantics, and applied to
 * the remaining media decision points.
 *
 * Error messages here never contain a filesystem path. Callers surface them
 * directly in HTTP responses and operational logs, and an escape attempt must
 * not become a path-disclosure oracle.
 */

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

// O_NOFOLLOW does not exist on Windows. Falling back to 0 keeps the open
// working; containment there rests on the realpath comparison and the
// device/inode binding alone. See SUPPORTS_NOFOLLOW for callers that report
// the difference.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW || 0;

export const SUPPORTS_NOFOLLOW = O_NOFOLLOW !== 0;

const MAX_PATH_LENGTH = 4_096;

export function mediaPathError(code, message, status) {
  return Object.assign(new Error(message), { status, code });
}

function escapeError() {
  return mediaPathError('media_path_escape', 'Media path is outside its configured root.', 403);
}

function unavailableError(error) {
  return mediaPathError(
    'media_path_unavailable',
    'The media file is unavailable.',
    error?.code === 'EACCES' || error?.code === 'EPERM' ? 403 : 409,
  );
}

function substitutedError() {
  return mediaPathError('media_path_substituted', 'The media file changed while it was being opened.', 409);
}

/**
 * Segment-boundary containment. A plain `startsWith` treats `/media/movies`
 * as a parent of `/media/movies-private`; comparing against the parent plus a
 * separator does not. The separator is only appended when the parent does not
 * already end in one, so a filesystem root (`/`, `C:\`) is handled correctly
 * rather than being turned into `//`.
 */
export function isPathWithin(parentPath, candidatePath) {
  if (typeof parentPath !== 'string' || typeof candidatePath !== 'string') return false;
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  if (candidate === parent) return true;
  const parentPrefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return candidate.startsWith(parentPrefix);
}

function assertUsablePath(value, code, message, status = 400) {
  if (typeof value !== 'string' || !value.trim()) throw mediaPathError(code, message, status);
  if (value.length > MAX_PATH_LENGTH || value.includes('\u0000')) throw mediaPathError(code, message, status);
}

/**
 * Resolve the closest ancestor that exists and report the segments below it
 * that do not.
 *
 * Two callers need this. Output targets are expected to be missing, and their
 * existing ancestors must still be proven to stay inside the root. Read
 * targets use it only after a strict realpath has already failed, to decide
 * whether the failure is "missing inside the root" or an escape attempt —
 * without that, a path outside the root that happens not to exist would be
 * reported as unavailable, which tells the caller something about the
 * filesystem outside the root.
 *
 * realpath fails with ENOENT both for a genuinely absent path and for a
 * dangling symlink, so lstat distinguishes them and the result is reported
 * rather than thrown; only `allowMissing` treats a dangling final component as
 * a hard failure.
 */
async function nearestExistingReal(resolvedPath) {
  const missing = [];
  let current = resolvedPath;
  for (;;) {
    try {
      return { real: await fs.realpath(current), missing: missing.reverse(), brokenLink: false };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw unavailableError(error);
      const brokenLink = missing.length === 0 && Boolean(await fs.lstat(current).catch(() => null));
      const parent = path.dirname(current);
      if (parent === current) throw unavailableError(error);
      missing.push(path.basename(current));
      current = parent;
      if (brokenLink) {
        const real = await fs.realpath(parent).catch(() => null);
        if (real === null) continue;
        return { real, missing: missing.reverse(), brokenLink: true };
      }
    }
  }
}

/**
 * Resolve `candidatePath` to a canonical real path and prove it is contained
 * by `rootPath`.
 *
 * Containment is decided only after both sides are canonicalized. A lexical
 * pre-check against the root would be wrong in both directions: a root that is
 * itself a symlink legitimately holds catalog entries recorded under either
 * the link path or the resolved path, and neither form is an escape.
 *
 * @param {string} rootPath configured library root, mount, or cache root
 * @param {string} candidatePath path being read, written, or removed
 * @param {{ allowMissing?: boolean }} [options] allowMissing permits an output
 *   target that does not exist yet, provided its existing ancestors resolve
 *   inside the root
 */
export async function resolveContainedPath(rootPath, candidatePath, options = {}) {
  const { allowMissing = false } = options;
  assertUsablePath(rootPath, 'media_root_unavailable', 'The media root is not configured.', 409);
  assertUsablePath(candidatePath, 'media_path_invalid', 'The media path is invalid.');

  const rootRealPath = await fs.realpath(path.resolve(rootPath)).catch((error) => {
    throw mediaPathError(
      'media_root_unavailable',
      'The media root is not available.',
      error?.code === 'EACCES' || error?.code === 'EPERM' ? 403 : 409,
    );
  });

  const resolvedCandidate = path.resolve(candidatePath);
  // path.resolve has already collapsed every '.' and '..', so a missing tail
  // can only be plain names. Rejecting anything else keeps a future caller
  // from handing this function an unresolved path.
  const projected = (nearest) => {
    if (nearest.missing.some((segment) => !segment || segment === '.' || segment === '..')) throw escapeError();
    return nearest.missing.length ? path.join(nearest.real, ...nearest.missing) : nearest.real;
  };

  if (allowMissing) {
    const nearest = await nearestExistingReal(resolvedCandidate);
    // An output target whose final component is a dangling symlink is not a
    // creatable path: writing to it would follow the link.
    if (nearest.brokenLink) throw unavailableError({ code: 'ENOENT' });
    const realPath = projected(nearest);
    if (!isPathWithin(rootRealPath, realPath)) throw escapeError();
    return { rootRealPath, realPath, existed: nearest.missing.length === 0 };
  }

  const strict = await fs.realpath(resolvedCandidate).then(
    (realPath) => ({ realPath, error: null }),
    (error) => ({ realPath: null, error }),
  );
  if (strict.error) {
    // Decide containment before reporting why the path could not be resolved.
    // A candidate that never could have been inside the root is an escape,
    // whether or not anything exists at the other end of it.
    const nearest = await nearestExistingReal(resolvedCandidate).catch(() => null);
    if (!nearest || !isPathWithin(rootRealPath, projected(nearest))) throw escapeError();
    throw unavailableError(strict.error);
  }
  if (!isPathWithin(rootRealPath, strict.realPath)) throw escapeError();
  return { rootRealPath, realPath: strict.realPath, existed: true };
}

/**
 * Open a contained file in a way that survives substitution between the
 * containment check and the read.
 *
 * O_NOFOLLOW rejects a final component that became a symlink after realpath
 * ran, and the fstat of the returned descriptor — not a second stat by name —
 * decides whether this is a regular file and whether it is still the file the
 * caller authorized. Callers own the returned handle and must close it.
 *
 * @param {string} rootPath containing root
 * @param {string} candidatePath file to open
 * @param {{ expectedFileId?: {dev: number, ino: number} | null }} [options]
 */
export async function openContainedFile(rootPath, candidatePath, options = {}) {
  const { expectedFileId = null } = options;
  const { rootRealPath, realPath } = await resolveContainedPath(rootPath, candidatePath);

  const handle = await fs.open(realPath, fsConstants.O_RDONLY | O_NOFOLLOW).catch((error) => {
    // ELOOP from an O_NOFOLLOW open means the final component turned into a
    // symlink after realpath resolved it. That is a substitution, not a
    // missing file, and it must not be reported as one.
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') throw substitutedError();
    throw unavailableError(error);
  });

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw mediaPathError('media_path_not_a_file', 'The media path is not a file.', 409);
    const fileId = { dev: stats.dev, ino: stats.ino };
    if (expectedFileId && (expectedFileId.dev !== fileId.dev || expectedFileId.ino !== fileId.ino)) {
      throw substitutedError();
    }
    // The descriptor cannot be mapped back to a path portably, so compare it
    // with what the name resolves to now. This closes the window in which a
    // parent directory was swapped between realpath and open; it cannot close
    // a swap that happens after this check, which stays a documented residual
    // risk on platforms without a path-from-descriptor call.
    const named = await fs.lstat(realPath).catch(() => null);
    if (!named || named.dev !== fileId.dev || named.ino !== fileId.ino) throw substitutedError();
    return { handle, stats, fileId, realPath, rootRealPath };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Prove a media file is contained, present, and a regular file, and report the
 * identity a later open must still see. Used where the consumer reopens the
 * path itself (FFmpeg) and where authorization runs earlier than the read.
 */
export async function statContainedFile(rootPath, candidatePath, options = {}) {
  const opened = await openContainedFile(rootPath, candidatePath, options);
  await opened.handle.close().catch(() => undefined);
  return { stats: opened.stats, fileId: opened.fileId, realPath: opened.realPath, rootRealPath: opened.rootRealPath };
}

/**
 * Relative path for logs and messages. Containment has already been proven, so
 * this only decides how much of the verified path is safe to record: the part
 * below the root, never the root itself.
 */
export function containedRelativePath(rootRealPath, realPath) {
  const relative = path.relative(rootRealPath, realPath);
  return !relative || relative.startsWith('..') || path.isAbsolute(relative) ? path.basename(realPath) : relative;
}
