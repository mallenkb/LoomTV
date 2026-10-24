const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const VERSION = '0.32.3';
// Upstream release asset SHA-256 digests, pinned independently of download URLs.
const hashes = {
  arm64: '69fbffdacb9abda2a76809693443328b6aad71af25947e0733913340365f4da8',
  x64: '4f79b7ff0fe035db8d2006842537aca2a2def957569aae6ff578107b56adec38',
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hasSlice = (binary, arch) => fs.existsSync(binary)
  && spawnSync('/usr/bin/lipo', [binary, '-verify_arch', arch === 'x64' ? 'x86_64' : arch]).status === 0;

function installedVersion() {
  let directory = path.dirname(require.resolve('node-datachannel'));
  while (true) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (metadata.name === 'node-datachannel') return metadata.version;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Could not resolve node-datachannel package metadata.');
    directory = parent;
  }
}

async function download(url, expectedHash) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`node-datachannel download returned HTTP ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (digest(bytes) !== expectedHash) throw new Error('node-datachannel release archive checksum mismatch.');
      return bytes;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

async function stageDatachannel(resources, platform, arch) {
  if (platform !== 'darwin') return;
  const expectedHash = hashes[arch];
  if (!expectedHash) throw new Error(`No pinned node-datachannel prebuild for ${platform}-${arch}.`);
  const target = path.join(resources, 'app.asar.unpacked/node_modules/node-datachannel/build/Release/node_datachannel.node');
  if (hasSlice(target, arch)) return;
  if (installedVersion() !== VERSION) {
    throw new Error('Update the pinned node-datachannel archives before packaging a new version.');
  }
  const name = `node-datachannel-v${VERSION}-napi-v8-darwin-${arch}.tar.gz`;
  const directory = path.join(os.homedir(), '.cache', 'loom-node-datachannel', VERSION);
  const archive = path.join(directory, name);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(archive) || digest(fs.readFileSync(archive)) !== expectedHash) {
    const bytes = await download(`https://github.com/murat-dogan/node-datachannel/releases/download/v${VERSION}/${name}`, expectedHash);
    const temporary = `${archive}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, archive);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-datachannel-'));
  try {
    const member = 'build/Release/node_datachannel.node';
    execFileSync('tar', ['-xzf', archive, '-C', scratch, member]);
    const binary = path.join(scratch, member);
    if (!hasSlice(binary, arch)) throw new Error(`node-datachannel archive does not contain a ${arch} addon.`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(binary, target);
    fs.chmodSync(target, 0o755);
    console.log(`[native-modules] Staged the verified node-datachannel ${platform}-${arch} addon.`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { stageDatachannel };
