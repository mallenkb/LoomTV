import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverRust, hasScannerProcesses, stopScannerProcesses } from '../src/main/scanning/rustScannerClient.ts';
import { SCANNER_PROTOCOL } from '../src/main/scanning/discoveryTypes.ts';

const binary = path.resolve(import.meta.dirname, '../native/scanner/target/release/loom-scanner' + (process.platform === 'win32' ? '.exe' : ''));

test('startup and inactivity deadlines reap a worker that ignores SIGTERM', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-worker-timeout-'));
  try {
    for (const handshake of [false, true]) {
      const pidFile = path.join(root, 'pid');
      const worker = path.join(root, 'worker');
      await fs.writeFile(worker, `#!${process.execPath}\nconst fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.once('data', (data) => {
  if (${handshake}) { const hello = JSON.parse(data.toString().trim());
    process.stdout.write(JSON.stringify({version: ${SCANNER_PROTOCOL}, id: hello.id, kind: 'ready', capabilities: ['discovery', 'cancel', 'ack', 'signature']}) + '\\n'); }
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
      await assert.rejects(discoverRust(worker, root, async () => undefined, {
        startupTimeoutMs: 2000, inactivityTimeoutMs: 50, shutdownTimeoutMs: 50,
      }), /timed out|stopped responding/);
      const pid = Number(await fs.readFile(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('inactivity and shutdown interrupt a blocked batch consumer', { timeout: 5000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-worker-consumer-'));
  try {
    await fs.writeFile(path.join(root, 'video.mp4'), 'fixture');
    await assert.rejects(discoverRust(binary, root, async () => new Promise<void>(() => undefined), {
      startupTimeoutMs: 1000, inactivityTimeoutMs: 50, shutdownTimeoutMs: 50,
    }), /stopped responding/);
    let entered: () => void = () => undefined;
    const consuming = new Promise<void>((resolve) => { entered = resolve; });
    const work = discoverRust(binary, root, async () => {
      entered();
      return new Promise<void>(() => undefined);
    }, { shutdownTimeoutMs: 50 });
    const rejected = assert.rejects(work, /shut down/);
    await consuming;
    assert.equal(hasScannerProcesses(), true);
    await stopScannerProcesses();
    assert.equal(hasScannerProcesses(), false);
    await rejected;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('cancellation after completion output cannot become a successful attempt', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-worker-complete-'));
  const controller = new AbortController();
  const completed = path.join(root, 'completed');
  try {
    const worker = path.join(root, 'worker');
    const signature = `inventory-v1:0:${createHash('sha256').digest('hex')}`;
    await fs.writeFile(worker, `#!${process.execPath}\nconst fs = require('node:fs'); process.on('SIGTERM', () => {});
process.stdin.once('data', (data) => {
  const hello = JSON.parse(data.toString().trim());
  process.stdout.write(JSON.stringify({version: ${SCANNER_PROTOCOL}, id: hello.id, kind: 'ready', capabilities: ['discovery', 'cancel', 'ack', 'signature']}) + '\\n');
  process.stdin.once('data', () => {
    process.stdout.end(JSON.stringify({version: ${SCANNER_PROTOCOL}, id: hello.id, kind: 'complete', directories: 1, stats: 1, peakRssBytes: null, signature: ${JSON.stringify(signature)}, fileCount: 0}) + '\\n');
    fs.writeFileSync(${JSON.stringify(completed)}, 'complete');
  });
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const rejected = assert.rejects(discoverRust(worker, root, async () => undefined, {
      signal: controller.signal, shutdownTimeoutMs: 50,
    }), /abort|cancel/i);
    const deadline = Date.now() + 3000;
    while (!(await fs.stat(completed).catch(() => undefined))) {
      if (Date.now() > deadline) throw new Error('Worker did not emit completion.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await rejected;
  } finally { controller.abort(); await fs.rm(root, { recursive: true, force: true }); }
});
