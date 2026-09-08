import { spawn, execFileSync } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const origin = 'http://127.0.0.1:5197';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const children = new Set();
let closing = false;
const guard = createServer(socket => socket.end('LoomTV Tauri dev is already running.\n'));

function run(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', detached: process.platform !== 'win32' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function stop(code) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
  guard.close();
  process.exitCode = code;
}

async function request(path) {
  try { return await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(1000) }); }
  catch { return null; }
}

function portOccupied() {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: 5197 });
    const finish = occupied => { socket.destroy(); resolve(occupied); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(true));
  });
}

async function isOurServer() {
  const identity = await request('/__loomtv_dev_identity');
  try { if ((await identity?.json())?.root === root) return true; } catch {}
  // Older dev servers predate the identity endpoint. Verify their process and cwd.
  if (process.platform === 'win32') return false;
  try {
    const pids = execFileSync('lsof', ['-nP', '-t', '-iTCP:5197', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/);
    return pids.length > 0 && pids.every(pid => {
      const cwd = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find(line => line.startsWith('n'))?.slice(1);
      const command = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' });
      return cwd && realpathSync(cwd) === root && /(?:vite|vite-plus|vp)(?:[/.\s]|$)/.test(command);
    });
  } catch { return false; }
}

try {
  await new Promise((resolve, reject) => {
    guard.once('error', reject);
    guard.listen(5198, '127.0.0.1', resolve);
  });
  process.on('SIGINT', () => stop(130));
  process.on('SIGTERM', () => stop(143));
  const existing = await portOccupied();
  if (existing) {
    if (!(await isOurServer())) throw new Error('Port 5197 belongs to another server. Stop that server before starting LoomTV.');
    console.log('Using the existing LoomTV frontend on port 5197.');
  } else {
    const frontend = run(pnpm, ['frontend:dev']);
    let failure;
    frontend.once('error', error => { failure = error; });
    frontend.once('exit', code => {
      failure = new Error(`LoomTV frontend exited with code ${code}.`);
      if (!closing) stop(code || 1);
    });
    const deadline = Date.now() + 30000;
    while (!(await isOurServer())) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error('LoomTV frontend did not start within 30 seconds.');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  if (closing) process.exit(process.exitCode);
  const stage = run(process.execPath, ['scripts/stage-runtimes.mjs', '--incremental']);
  await new Promise((resolve, reject) => {
    stage.once('error', reject);
    stage.once('exit', code => code === 0 ? resolve() : reject(new Error(`Runtime staging failed with code ${code}.`)));
  });
  if (!closing) {
    const tauri = run(pnpm, ['exec', 'tauri', 'dev', '--config', JSON.stringify({ build: { beforeDevCommand: '' } }), ...process.argv.slice(2)]);
    tauri.once('error', error => { console.error(error.message); stop(1); });
    tauri.once('exit', code => stop(code || 0));
  }
} catch (error) {
  console.error(error.code === 'EADDRINUSE'
    ? 'A Tauri dev session is already running, or its control port 5198 is occupied. Close that session before starting another.'
    : error.message);
  stop(1);
}
