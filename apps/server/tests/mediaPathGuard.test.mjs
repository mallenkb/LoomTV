import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SUPPORTS_NOFOLLOW,
  containedRelativePath,
  isPathWithin,
  openContainedFile,
  resolveContainedPath,
  statContainedFile,
} from '../src/media-path-guard.js';

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX-only path semantics' : false };
const WIN32_ONLY = { skip: process.platform === 'win32' ? false : 'win32-only path semantics' };

/**
 * os.tmpdir() is itself a symlink on macOS, so every fixture root is
 * canonicalized up front. Tests that need the *unresolved* spelling ask for it
 * explicitly, because a symlinked root is the normal case on this platform and
 * must not read as an escape.
 */
async function makeBase(prefix = 'loomtv-guard-') {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { raw: created, real: await fs.realpath(created) };
}

async function writeFileIn(dir, name, contents = 'fake-video-bytes') {
  const target = path.join(dir, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  return target;
}

async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function assertNoPathDisclosure(error, ...secrets) {
  assert.ok(error, 'the operation must be rejected');
  const message = String(error.message);
  for (const secret of secrets) {
    assert.equal(message.includes(secret), false, `error message must not disclose ${secret}`);
    // A bare basename is fine; the full path and the root are not.
    assert.equal(message.includes(path.dirname(secret)), false, 'error message must not disclose a parent path');
  }
}

test('isPathWithin holds the segment boundary, the filesystem root, and trailing separators', () => {
  const parent = path.join(path.sep, 'srv', 'media', 'movies');
  assert.equal(isPathWithin(parent, path.join(parent, 'Heat.mkv')), true);
  assert.equal(isPathWithin(parent, parent), true, 'a root contains itself');
  assert.equal(isPathWithin(`${parent}${path.sep}`, path.join(parent, 'Heat.mkv')), true);

  // Sibling-prefix confusion: a naive startsWith accepts all three of these.
  assert.equal(isPathWithin(parent, `${parent}-private${path.sep}secret.mkv`), false);
  assert.equal(isPathWithin(parent, `${parent}.bak`), false);
  assert.equal(isPathWithin(parent, `${parent}extra`), false);

  assert.equal(isPathWithin(parent, path.join(parent, '..', 'other', 'x.mkv')), false);
  assert.equal(isPathWithin(undefined, parent), false);
});

test('isPathWithin treats the filesystem root as a container without doubling its separator', POSIX_ONLY, () => {
  assert.equal(isPathWithin('/', '/etc/passwd'), true);
  assert.equal(isPathWithin('/', '/'), true);
  // The bug this guards: `${'/'}${'/'}` produces '//', which matches nothing.
  assert.equal(isPathWithin('/', '/srv'), true);
});

test('isPathWithin handles drive roots and UNC shares', WIN32_ONLY, () => {
  assert.equal(isPathWithin('C:\\', 'C:\\media\\Heat.mkv'), true);
  assert.equal(isPathWithin('C:\\media', 'C:\\media-private\\secret.mkv'), false);
  assert.equal(isPathWithin('\\\\nas\\media', '\\\\nas\\media\\Heat.mkv'), true);
  assert.equal(isPathWithin('\\\\nas\\media', '\\\\nas\\media-private\\secret.mkv'), false);
});

test('a normal file inside the root resolves, including through a symlinked root', async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'library');
  const file = await writeFileIn(root, path.join('Show', 'episode.mkv'));

  const resolved = await resolveContainedPath(root, file);
  assert.equal(resolved.realPath, await fs.realpath(file));
  assert.equal(resolved.rootRealPath, root);
  assert.equal(resolved.existed, true);
  assert.equal(isPathWithin(resolved.rootRealPath, resolved.realPath), true);

  // The same file reached through a symlinked spelling of the root is the same
  // file, not an escape. This is the ordinary case on macOS, where the whole
  // temp tree lives behind /var -> /private/var.
  const linkedRoot = path.join(base.real, 'library-link');
  await fs.symlink(root, linkedRoot, 'dir');
  const throughLink = await resolveContainedPath(linkedRoot, path.join(linkedRoot, 'Show', 'episode.mkv'));
  assert.equal(throughLink.realPath, resolved.realPath);

  // ...and a catalog entry recorded under the link still resolves against the
  // root recorded without it.
  const mixed = await resolveContainedPath(root, path.join(linkedRoot, 'Show', 'episode.mkv'));
  assert.equal(mixed.realPath, resolved.realPath);
});

test('sibling roots sharing a string prefix cannot reach each other', async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'movies');
  await fs.mkdir(root, { recursive: true });
  const secret = await writeFileIn(path.join(base.real, 'movies-private'), 'secret.mkv');

  const error = await rejection(resolveContainedPath(root, secret));
  assert.equal(error?.status, 403);
  assert.equal(error?.code, 'media_path_escape');
  assertNoPathDisclosure(error, secret, root);
});

test('dot traversal is rejected whether or not the target exists', async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'library');
  await fs.mkdir(root, { recursive: true });
  const outside = await writeFileIn(base.real, 'outside.mkv');

  const present = await rejection(resolveContainedPath(root, path.join(root, '..', 'outside.mkv')));
  assert.equal(present?.status, 403);
  assert.equal(present?.code, 'media_path_escape');

  // A missing target outside the root must also read as an escape. Reporting
  // it as "unavailable" would answer existence questions about the filesystem
  // outside the root.
  const absent = await rejection(resolveContainedPath(root, path.join(root, '..', 'never-created.mkv')));
  assert.equal(absent?.status, 403);
  assert.equal(absent?.code, 'media_path_escape');
  assertNoPathDisclosure(absent, outside, root);
});

test('a file symlink inside the root that points outside it is rejected', POSIX_ONLY, async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'library');
  await fs.mkdir(root, { recursive: true });
  const outside = await writeFileIn(base.real, 'private.mkv', 'secret-bytes');
  const link = path.join(root, 'looks-inside.mkv');
  await fs.symlink(outside, link, 'file');

  const error = await rejection(resolveContainedPath(root, link));
  assert.equal(error?.status, 403);
  assert.equal(error?.code, 'media_path_escape');

  const opened = await rejection(openContainedFile(root, link));
  assert.equal(opened?.status, 403);
  assertNoPathDisclosure(opened, outside);
});

test('a directory symlink that escapes the root is rejected', POSIX_ONLY, async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'library');
  await fs.mkdir(root, { recursive: true });
  const outsideDir = path.join(base.real, 'elsewhere');
  const outsideFile = await writeFileIn(outsideDir, 'private.mkv');
  await fs.symlink(outsideDir, path.join(root, 'shortcut'), 'dir');

  const error = await rejection(resolveContainedPath(root, path.join(root, 'shortcut', 'private.mkv')));
  assert.equal(error?.status, 403);
  assert.equal(error?.code, 'media_path_escape');
  assertNoPathDisclosure(error, outsideFile);
});

test('a broken symlink inside the root is unavailable, not contained', POSIX_ONLY, async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'library');
  await fs.mkdir(root, { recursive: true });
  const link = path.join(root, 'dangling.mkv');
  await fs.symlink(path.join(root, 'never-existed.mkv'), link, 'file');

  const error = await rejection(resolveContainedPath(root, link));
  assert.equal(error?.status, 409);
  assert.equal(error?.code, 'media_path_unavailable');

  const opened = await rejection(openContainedFile(root, link));
  assert.equal(opened?.status, 409);

  // A link whose target is outside the root is unreadable while it dangles, and
  // becomes an escape the moment the target exists. Containment tracks what the
  // path resolves to, not where the link happens to sit.
  const escaping = path.join(root, 'points-outside.mkv');
  const outsideTarget = path.join(base.real, 'appears-later.mkv');
  await fs.symlink(outsideTarget, escaping, 'file');
  const whileDangling = await rejection(resolveContainedPath(root, escaping));
  assert.equal(whileDangling?.status, 409);
  assert.equal(whileDangling?.code, 'media_path_unavailable');

  await fs.writeFile(outsideTarget, 'secret-bytes');
  const onceResolvable = await rejection(resolveContainedPath(root, escaping));
  assert.equal(onceResolvable?.status, 403);
  assert.equal(onceResolvable?.code, 'media_path_escape');
  assertNoPathDisclosure(onceResolvable, outsideTarget);
});

test('a missing output target is allowed inside the root and refused through an escaped parent', POSIX_ONLY, async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'cache');
  await fs.mkdir(root, { recursive: true });

  const inside = await resolveContainedPath(root, path.join(root, 'session-1', 'index.m3u8'), { allowMissing: true });
  assert.equal(inside.existed, false);
  assert.equal(inside.realPath, path.join(root, 'session-1', 'index.m3u8'));

  // The parent exists but resolves outside the root: the nearest existing
  // ancestor, not the literal string, decides containment.
  const outsideDir = path.join(base.real, 'escaped');
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.symlink(outsideDir, path.join(root, 'redirected'), 'dir');
  const escaped = await rejection(
    resolveContainedPath(root, path.join(root, 'redirected', 'segment-00000.ts'), { allowMissing: true }),
  );
  assert.equal(escaped?.status, 403);
  assert.equal(escaped?.code, 'media_path_escape');

  // A dangling final component is not a creatable target: a write would follow
  // the link rather than create a file.
  const dangling = path.join(root, 'dangling-output.ts');
  await fs.symlink(path.join(base.real, 'gone.ts'), dangling, 'file');
  const broken = await rejection(resolveContainedPath(root, dangling, { allowMissing: true }));
  assert.equal(broken?.status, 409);
  assert.equal(broken?.code, 'media_path_unavailable');
});

test('the root itself resolves but is not servable as a file', async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'library');
  await fs.mkdir(root, { recursive: true });

  const resolved = await resolveContainedPath(root, root);
  assert.equal(resolved.realPath, root);
  assert.equal(resolved.rootRealPath, root);

  const opened = await rejection(openContainedFile(root, root));
  assert.equal(opened?.status, 409);
  assert.equal(opened?.code, 'media_path_not_a_file');
  assertNoPathDisclosure(opened, root);
});

test('an unavailable root and a malformed candidate fail as typed errors', async () => {
  const base = await makeBase();
  const missingRoot = path.join(base.real, 'not-mounted');

  const rootError = await rejection(resolveContainedPath(missingRoot, path.join(missingRoot, 'a.mkv')));
  assert.equal(rootError?.status, 409);
  assert.equal(rootError?.code, 'media_root_unavailable');

  for (const candidate of ['', '   ', null, undefined, `${base.real}${'x'.repeat(5_000)}`]) {
    const error = await rejection(resolveContainedPath(base.real, candidate));
    assert.equal(error?.code, 'media_path_invalid', `candidate ${String(candidate).slice(0, 16)} must be rejected`);
    assert.equal(error?.status, 400);
  }
});

test('a file replaced between the containment check and the open is rejected', async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'library');
  const file = await writeFileIn(root, 'episode.mkv', 'original-bytes');

  const authorized = await statContainedFile(root, file);
  assert.equal(typeof authorized.fileId.ino, 'number');

  // The same file still opens under its recorded identity.
  const same = await openContainedFile(root, file, { expectedFileId: authorized.fileId });
  assert.equal(same.fileId.ino, authorized.fileId.ino);
  await same.handle.close();

  // Replacing it — the time-of-check/time-of-use window between a catalog read
  // and a stream open — changes the inode and must be refused rather than
  // served under the authorization granted for the old file.
  await fs.rm(file);
  await fs.writeFile(file, 'substituted-bytes');
  const substituted = await rejection(openContainedFile(root, file, { expectedFileId: authorized.fileId }));
  assert.equal(substituted?.status, 409);
  assert.equal(substituted?.code, 'media_path_substituted');
  assertNoPathDisclosure(substituted, file);
});

test('the platform provides the no-follow open the guard relies on', POSIX_ONLY, async () => {
  assert.equal(SUPPORTS_NOFOLLOW, true, 'O_NOFOLLOW must exist on this platform');
  const base = await makeBase();
  const target = await writeFileIn(base.real, 'target.mkv');
  const link = path.join(base.real, 'link.mkv');
  await fs.symlink(target, link, 'file');

  // This is the primitive that rejects a final component which became a
  // symlink after realpath ran; the guard cannot defend that window without it.
  const error = await rejection(fs.open(link, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW));
  assert.equal(error?.code, 'ELOOP');

  const handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  await handle.close();
});

test('containment is decided on canonical paths, never on the raw spelling', async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'library');
  const file = await writeFileIn(root, 'CaseProbe.mkv');

  const caseInsensitive = await fs.access(path.join(root, 'caseprobe.mkv')).then(() => true, () => false);
  const result = await resolveContainedPath(root, path.join(root, 'caseprobe.mkv')).catch((error) => error);

  if (result instanceof Error) {
    // Fail-closed is acceptable: a spelling the filesystem did not canonicalize
    // is refused rather than guessed at.
    assert.ok(['media_path_escape', 'media_path_unavailable'].includes(result.code));
  } else {
    // Whatever the filesystem's case rules, the resolved path must still be
    // inside the root — the guard never returns an uncontained path.
    assert.equal(isPathWithin(root, result.realPath), true);
    assert.equal(caseInsensitive, true, 'only a case-insensitive filesystem can resolve this spelling');
  }
  await fs.rm(file);
});

test('containedRelativePath reports only the portion below the root', async () => {
  const base = await makeBase();
  const root = path.join(base.real, 'library');
  const file = await writeFileIn(root, path.join('Show', 'S01E01.mkv'));

  assert.equal(containedRelativePath(root, file), path.join('Show', 'S01E01.mkv'));
  assert.equal(containedRelativePath(root, root), path.basename(root));
  // An uncontained input degrades to a basename rather than emitting '..'
  // segments or an absolute path into a log line.
  assert.equal(containedRelativePath(root, path.join(base.real, 'outside.mkv')), 'outside.mkv');
});
