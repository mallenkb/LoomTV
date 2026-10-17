import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the render bridge. scripts/fetch-native-runtimes.cjs runs this after
// it installs the libmpv runtime, and scripts/bundle-libmpv.cjs when it bundles
// libmpv. The upstream mpv headers in include/ are the default; set
// LIBMPV_INCLUDE_DIR to build against others. LIBMPV_BRIDGE_ARCH and
// LIBMPV_BRIDGE_MIN_MACOS set the target architecture and deployment target.
if (process.platform !== 'darwin') throw new Error('The libmpv render bridge targets macOS only.');
const root = path.dirname(fileURLToPath(import.meta.url));
const include = process.env.LIBMPV_INCLUDE_DIR?.trim() || path.join(root, 'include');
if (!path.isAbsolute(include)
    || !existsSync(path.join(include, 'mpv/client.h'))
    || !existsSync(path.join(include, 'mpv/render_gl.h'))) {
  throw new Error('Set LIBMPV_INCLUDE_DIR to the absolute include directory containing the upstream mpv headers.');
}
const arch = process.env.LIBMPV_BRIDGE_ARCH?.trim() || process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported bridge architecture: ${arch}`);
const minimumMacOS = process.env.LIBMPV_BRIDGE_MIN_MACOS?.trim();
if (minimumMacOS && !/^\d+(\.\d+){0,2}$/.test(minimumMacOS)) throw new Error(`Invalid minimum macOS version: ${minimumMacOS}`);
const output = path.resolve(process.argv[2] || path.join(root, 'build/libloomtv_mpv_bridge.dylib'));
mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
try {
  const result = spawnSync('xcrun', ['clang', '-std=c11', '-dynamiclib', '-fobjc-arc', '-fblocks',
    '-arch', arch === 'x64' ? 'x86_64' : 'arm64',
    ...(minimumMacOS ? [`-mmacosx-version-min=${minimumMacOS}`] : []),
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
