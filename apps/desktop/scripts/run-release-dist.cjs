const { spawnSync } = require('node:child_process');

const ATTEMPTS = 3;

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runDist() {
  const command = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
  return spawnSync(command, [
    'pnpm',
    '--filter',
    'loom-media-server-desktop',
    'run',
    'dist',
  ], {
    cwd: require('node:path').resolve(__dirname, '../../..'),
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
}

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const result = runDist();
  if (result.status === 0) process.exit(0);

  if (attempt === ATTEMPTS) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }

  const delay = attempt * 10_000;
  console.warn(`Desktop packaging attempt ${attempt} failed; retrying in ${delay / 1_000}s.`);
  wait(delay);
}
