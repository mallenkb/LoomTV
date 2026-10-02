import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HTTP_DISK_CACHE_BYTES, clearOversizedHttpCacheOnce, httpDiskCacheSwitch } from '../src/main/httpCacheBudget.ts';

test('caps the Chromium disk cache well below its default ceiling', () => {
  assert.deepEqual(httpDiskCacheSwitch(), ['disk-cache-size', String(HTTP_DISK_CACHE_BYTES)]);
  assert.ok(HTTP_DISK_CACHE_BYTES <= 128 * 1024 * 1024);
});

test('clears an oversized cache exactly once per data directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-http-cache-'));
  let clears = 0;
  const clear = async () => { clears += 1; };
  assert.equal(await clearOversizedHttpCacheOnce(dir, clear), true);
  assert.equal(await clearOversizedHttpCacheOnce(dir, clear), false);
  assert.equal(clears, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retries the clear on the next launch when it fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-http-cache-'));
  await assert.rejects(clearOversizedHttpCacheOnce(dir, async () => { throw new Error('busy'); }));
  assert.equal(await clearOversizedHttpCacheOnce(dir, async () => undefined), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
