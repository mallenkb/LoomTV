import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Linux packaging requires and stages the VLC runtime instead of silently omitting it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-linux-staging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'desktop');
  const source = path.join(root, 'source');
  const stage = path.join(desktop, 'scripts/stage-native-runtimes.cjs');
  for (const folder of [path.dirname(stage), path.join(desktop, 'resources/ffmpeg'), path.join(source, 'plugins')]) {
    fs.mkdirSync(folder, { recursive: true });
  }
  fs.copyFileSync(new URL('../scripts/stage-native-runtimes.cjs', import.meta.url), stage);
  fs.writeFileSync(path.join(desktop, 'resources/ffmpeg/runtime-provenance.json'), JSON.stringify({
    distributionPolicy: { bundledNativePlaybackTargets: { libvlc: ['linux-x64'] } },
  }));
  const env = { ...process.env };
  for (const name of ['LOOMTV_LIBVLC_SOURCE_DIR', 'LOOMTV_NATIVE_RUNTIME_SOURCE_ROOT', 'LOOMTV_NATIVE_RUNTIME_TARGETS']) delete env[name];
  assert.throws(() => execFileSync(process.execPath, [stage, '--required', '--target=linux-x64'], { env, stdio: 'pipe' }), /sources are required/);
  fs.writeFileSync(path.join(source, 'libvlc.so'), 'Linux fixture');
  fs.writeFileSync(path.join(source, 'plugins/decoder.so'), 'decoder fixture');
  execFileSync(process.execPath, [stage, '--required', '--target=linux-x64'], { env: { ...env, LOOMTV_LIBVLC_SOURCE_DIR: source } });
  const destination = path.join(desktop, 'resources/libvlc/linux/x64');
  assert.equal(fs.readFileSync(path.join(destination, 'libvlc.so'), 'utf8'), 'Linux fixture');
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.platform, 'linux');
  assert.equal(manifest.architecture, 'x64');
});

test('restaging patched VLC regenerates the flattened macOS package manifest', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-vlc-staging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'desktop');
  const source = path.join(root, 'source');
  const write = (file: string, value: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const stage = path.join(desktop, 'scripts/stage-native-runtimes.cjs');
  write(stage, fs.readFileSync(new URL('../scripts/stage-native-runtimes.cjs', import.meta.url), 'utf8'));
  write(path.join(desktop, 'resources/ffmpeg/runtime-provenance.json'), JSON.stringify({
    distributionPolicy: { bundledNativePlaybackTargets: { libvlc: ['darwin-arm64'] } },
  }));
  const macos = path.join(source, 'VLC.app/Contents/MacOS');
  write(path.join(macos, 'lib/libvlc.dylib'), 'library');
  write(path.join(macos, 'plugins/libmacosx_plugin.dylib'), 'unused VLC UI');
  write(path.join(macos, 'share/license.txt'), 'license');
  const plugin = path.join(macos, 'plugins/libvideotoolbox_plugin.dylib');
  const destination = path.join(desktop, 'resources/libvlc/darwin/arm64');
  const env = { ...process.env, LOOMTV_LIBVLC_SOURCE_DIR: source };
  delete env.LOOMTV_NATIVE_RUNTIME_SOURCE_ROOT;
  delete env.LOOMTV_NATIVE_RUNTIME_TARGETS;
  for (const version of ['original decoder', 'patched decoder']) {
    write(plugin, version);
    execFileSync(process.execPath, [stage, '--required', '--target=darwin-arm64'], { env });
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'packaged-runtime-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files.map((entry: { path: string }) => entry.path).sort(), [
      'lib/libvlc.dylib', 'plugins/libvideotoolbox_plugin.dylib', 'share/license.txt',
    ]);
    const entry = manifest.files.find((entry: { path: string }) => entry.path === 'plugins/libvideotoolbox_plugin.dylib');
    assert.ok(entry);
    assert.equal(entry.sha256, undefined);
    assert.ok(manifest.files.every((entry: { sha256?: string }) => entry.sha256 === undefined));
    assert.equal(fs.readFileSync(path.join(destination, 'VLC.app/Contents/MacOS/plugins/libvideotoolbox_plugin.dylib'), 'utf8'), version);
  }
});
