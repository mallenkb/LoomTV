import assert from 'node:assert/strict';
import test from 'node:test';

import { createNativeOwnerSession } from '../src/main/nativeOwnerSession.ts';

function harness() {
  let clock = 1_000_000;
  let issued = 0;
  let release: (() => void) | null = null;
  let holdNext = false;
  const session = createNativeOwnerSession({
    now: () => clock,
    issue: async () => {
      issued += 1;
      const token = `token-${issued}`;
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { adminToken: token, expiresAt: clock + 60 * 60 * 1000 };
    },
  });
  return {
    session,
    issued: () => issued,
    advance: (ms: number) => { clock += ms; },
    hold: () => { holdNext = true; },
    release: () => release?.(),
  };
}

const unauthorized = () => Object.assign(new Error('expired'), { status: 401 });

test('after a restart the first request gets a fresh session and later requests reuse it', async () => {
  const h = harness();
  const used: string[] = [];
  await h.session.send(async (token) => { used.push(token); });
  await h.session.send(async (token) => { used.push(token); });
  assert.deepEqual(used, ['token-1', 'token-1']);
  assert.equal(h.issued(), 1);
});

test('a session close to expiry is renewed before the request is sent', async () => {
  const h = harness();
  await h.session.token();
  h.advance(60 * 60 * 1000 - 10_000);
  assert.equal(await h.session.token(), 'token-2');
});

test('a 401 renews the session and retries exactly once', async () => {
  const h = harness();
  const used: string[] = [];
  const result = await h.session.send(async (token) => {
    used.push(token);
    if (token === 'token-1') throw unauthorized();
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(used, ['token-1', 'token-2']);

  let attempts = 0;
  await assert.rejects(() => h.session.send(async () => { attempts += 1; throw unauthorized(); }), { status: 401 });
  assert.equal(attempts, 2);
});

test('other failures are not retried', async () => {
  const h = harness();
  let attempts = 0;
  await assert.rejects(() => h.session.send(async () => {
    attempts += 1;
    throw Object.assign(new Error('bad request'), { status: 400 });
  }), { status: 400 });
  assert.equal(attempts, 1);
  assert.equal(h.issued(), 1);
});

test('concurrent requests share one renewal', async () => {
  const h = harness();
  const tokens = await Promise.all([h.session.token(), h.session.token(), h.session.token()]);
  assert.deepEqual(tokens, ['token-1', 'token-1', 'token-1']);
  assert.equal(h.issued(), 1);
});

test('a renewal that finishes after the host stops is discarded', async () => {
  const h = harness();
  h.hold();
  const pending = h.session.token();
  await Promise.resolve();
  h.session.reset();
  h.release();
  await assert.rejects(pending, /host changed/);
  assert.equal(await h.session.token(), 'token-2');
});

test('an already expired session from the host is rejected', async () => {
  const session = createNativeOwnerSession({
    now: () => 10,
    issue: async () => ({ adminToken: 'stale', expiresAt: 5 }),
  });
  await assert.rejects(() => session.token(), /expired native session/);
  assert.throws(() => session.set({ adminToken: '', expiresAt: 100 }), /expired native session/);
});
