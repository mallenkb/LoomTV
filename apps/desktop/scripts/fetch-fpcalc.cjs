const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VERSION = '1.6.0';
const assets = {
  'darwin-arm64': ['chromaprint-fpcalc-1.6.0-macos-universal.tar.gz', '31f654cce8308fcb22869d043770eb66afffed95e8a548fd877f0e670c16d7ec'],
  'darwin-x64': ['chromaprint-fpcalc-1.6.0-macos-universal.tar.gz', '31f654cce8308fcb22869d043770eb66afffed95e8a548fd877f0e670c16d7ec'],
  'linux-arm64': ['chromaprint-fpcalc-1.6.0-linux-arm64.tar.gz', 'c8667f556f77d8ebbe08b75a968c0592bd2a67aaa696eff91715feb5083b1cd4'],
  'linux-x64': ['chromaprint-fpcalc-1.6.0-linux-x86_64.tar.gz', '946dc3eade645eb835c8d163c6bb354e092239988bff190b9c42589e8d5cf00a'],
  'win32-x64': ['chromaprint-fpcalc-1.6.0-windows-x86_64.zip', '30179d3d0dc4cc92f1a0995c1a2e523fb4867724c2ee6a6ceae474f8e4d6937a'],
};

function platformFolder() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

function findFile(root, fileName) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(fullPath, fileName);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

async function main() {
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`No pinned fpcalc build for ${process.platform}-${process.arch}.`);
  const [name, expectedHash] = asset;
  const destinationDir = path.join(__dirname, '..', 'resources', 'fpcalc', platformFolder());
  const destination = path.join(destinationDir, process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc');
  if (fs.existsSync(destination)) {
    const version = spawnSync(destination, ['-version'], { encoding: 'utf8' });
    if (version.status === 0 && `${version.stdout}${version.stderr}`.includes(VERSION)) return;
  }

  const response = await fetch(`https://github.com/acoustid/chromaprint/releases/download/v${VERSION}/${name}`);
  if (!response.ok) throw new Error(`Could not download ${name}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  if (digest !== expectedHash) throw new Error(`Checksum mismatch for ${name}.`);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'loomtv-fpcalc-'));
  try {
    const archivePath = path.join(temporary, name);
    const extracted = path.join(temporary, 'extracted');
    fs.mkdirSync(extracted);
    fs.writeFileSync(archivePath, archive);
    const unpack = process.platform === 'win32'
      ? spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}' -Force`,
      ], { encoding: 'utf8' })
      : spawnSync('tar', ['-xf', archivePath, '-C', extracted], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error(unpack.stderr || `Could not extract ${name}.`);
    const binary = findFile(extracted, process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc');
    if (!binary) throw new Error(`${name} did not contain fpcalc.`);
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.copyFileSync(binary, destination);
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
