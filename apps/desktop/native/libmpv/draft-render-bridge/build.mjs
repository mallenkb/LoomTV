import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit experiment build, not a packaging hook. This does not enable libmpv.
if (process.platform !== 'darwin') throw new Error('The draft libmpv render bridge currently targets macOS only.');
const root = path.dirname(fileURLToPath(import.meta.url));
const include = process.env.LIBMPV_INCLUDE_DIR?.trim();
if (!include || !path.isAbsolute(include)
    || !existsSync(path.join(include, 'mpv/client.h'))
    || !existsSync(path.join(include, 'mpv/render_gl.h'))) {
  throw new Error('Set LIBMPV_INCLUDE_DIR to the absolute include directory containing the upstream mpv headers.');
}
const output = path.resolve(process.argv[2] || path.join(root, 'build/libloomtv_mpv_bridge.dylib'));
mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
try {
  const result = spawnSync('xcrun', ['clang', '-std=c11', '-dynamiclib', '-fobjc-arc', '-fblocks',
    '-fvisibility=hidden', '-Wall', '-Wextra', '-Werror=return-type', '-Wno-deprecated-declarations',
    '-I', include, path.join(root, 'bridge.m'), '-framework', 'Cocoa', '-framework', 'OpenGL',
    '-install_name', '@rpath/libloomtv_mpv_bridge.dylib', '-o', temporary], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`The native bridge did not compile (exit ${result.status}).`);
  renameSync(temporary, output);
  console.log(output);
} finally {
  rmSync(temporary, { force: true });
}
