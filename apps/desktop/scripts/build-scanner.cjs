const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const targets = {
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
};
function buildScanner(platform = process.platform, arch = process.arch) {
  const target = targets[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported scanner target: ${platform}-${arch}`);
  if (platform !== process.platform || arch !== process.arch) execFileSync('rustup', ['target', 'add', target], { stdio: 'inherit' });
  const crate = path.join(root, 'native/scanner');
  const executable = platform === 'win32' ? 'loom-scanner.exe' : 'loom-scanner';
  execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', path.join(crate, 'Cargo.toml'), '--target', target], { stdio: 'inherit' });
  const destination = path.join(root, 'resources/scanner', `${platform}-${arch}`);
  fs.mkdirSync(destination, { recursive: true });
  const binary = path.join(destination, executable);
  fs.copyFileSync(path.join(crate, 'target', target, 'release', executable), binary);
  fs.chmodSync(binary, 0o755);
  return binary;
}
module.exports = { buildScanner };
if (require.main === module) buildScanner(process.argv[2], process.argv[3]);
