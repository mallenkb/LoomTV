import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

try {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!['--ffmpeg', '--ffprobe'].includes(key) || !value || options.has(key)) {
      throw new Error('Usage: test-media.mjs --ffmpeg /absolute/path --ffprobe /absolute/path');
    }
    options.set(key, value);
  }
  const env = { ...process.env };
  for (const [option, variable] of [['--ffmpeg', 'LOOMTV_TEST_FFMPEG'], ['--ffprobe', 'LOOMTV_TEST_FFPROBE']]) {
    const binary = options.get(option) ?? env[variable];
    if (!binary || !isAbsolute(binary) || !statSync(binary).isFile()) {
      throw new Error(`${option} requires an explicit absolute path to a trusted test binary.`);
    }
    accessSync(binary, constants.X_OK);
    env[variable] = binary;
  }
  const result = spawnSync('cargo', ['test', '-p', 'loomtv-core', '--locked', 'generated_media_probe_hls_seek_range_and_revocation', '--', '--ignored', '--nocapture'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env,
    stdio: 'inherit',
    shell: false,
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The generated-media test could not run.');
  process.exitCode = 1;
}
