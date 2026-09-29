import assert from 'node:assert/strict';
import test from 'node:test';
import { createKdfLimiter } from '../src/kdf-admission.js';

test('the KDF limiter bounds concurrent checks and hands slots to waiters in order', async () => {
  const limiter = createKdfLimiter({ maxConcurrent: 2, maxQueued: 2 });
  const gates = [];
  const order = [];
  const job = (name) => limiter.run(() => new Promise((resolve) => { gates.push(() => { order.push(name); resolve(name); }); }));
  const running = [job('a'), job('b'), job('c'), job('d')];
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(limiter.stats(), { active: 2, queued: 2 });
  await assert.rejects(limiter.run(async () => 'e'), { status: 429, code: 'verification_busy' });
  while (gates.length || limiter.stats().active) {
    gates.shift()?.();
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.ok(limiter.stats().active <= 2);
  }
  assert.deepEqual(await Promise.all(running), ['a', 'b', 'c', 'd']);
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
});

test('a failed check releases its slot', async () => {
  const limiter = createKdfLimiter({ maxConcurrent: 1, maxQueued: 1 });
  await assert.rejects(limiter.run(async () => { throw new Error('boom'); }), { message: 'boom' });
  assert.equal(await limiter.run(async () => 'ok'), 'ok');
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
});
