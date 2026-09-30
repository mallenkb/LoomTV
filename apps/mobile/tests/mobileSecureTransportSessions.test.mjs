import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const nativeAvailable = process.platform === 'darwin' && spawnSync('swiftc', ['--version']).status === 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(25);
  }
}
async function compile(source, executable) {
  const child = spawn('swiftc', [source, '-o', executable]);
  let error = '';
  child.stderr.on('data', (data) => { error = (error + data).slice(-8_000); });
  assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0, error);
}
function consumer(port, target, { paused = false, slow = false, halfClose = false, bodyBytes = 0 } = {}) {
  const socket = net.connect({ host: '127.0.0.1', port });
  let headers = Buffer.alloc(0);
  let status = 0;
  let bodyBytesReceived = 0;
  let bodyText = Buffer.alloc(0);
  let ended = false;
  let error;
  const hash = createHash('sha256');
  const connected = new Promise((resolve) => socket.once('connect', () => {
    const request = `GET ${target} HTTP/1.1\r\nHost: localhost\r\nX-Fixture-Body-Bytes: ${bodyBytes}\r\nConnection: close\r\n\r\n`;
    if (halfClose) socket.end(request);
    else socket.write(request);
    if (paused) socket.pause();
    resolve();
  }));
  socket.on('error', (value) => { error = value.code; });
  socket.on('end', () => { ended = true; });
  socket.on('data', (chunk) => {
    if (!status) {
      headers = Buffer.concat([headers, chunk]);
      const separator = headers.indexOf('\r\n\r\n');
      if (separator < 0) return;
      status = Number(headers.toString('ascii', 0, separator).split(' ')[1]);
      chunk = headers.subarray(separator + 4);
      headers = Buffer.alloc(0);
    }
    hash.update(chunk);
    if (bodyText.length < 1024) bodyText = Buffer.concat([bodyText, chunk.subarray(0, 1024 - bodyText.length)]);
    bodyBytesReceived += chunk.length;
    if (slow) { socket.pause(); setTimeout(() => socket.resume(), 5); }
  });
  const done = new Promise((resolve) => socket.once('close', () => resolve({
    status, bodyText: bodyText.toString('utf8'), bodyBytes: bodyBytesReceived, hash: hash.digest('hex'), ended, error,
  })));
  return { socket, connected, done };
}

test('native session lanes drain large callbacks, isolate slow consumers, and bound admission and cleanup', {
  skip: !nativeAvailable ? 'macOS Network framework and Swift compiler are required' : false,
  timeout: 110_000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-proxy-sessions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const module = await fs.readFile(new URL('../modules/loomtv-secure-transport/ios/LoomTvSecureTransportModule.swift', import.meta.url), 'utf8');
  const buffer = await fs.readFile(new URL('../modules/loomtv-secure-transport/ios/LoomTvResponseBuffer.swift', import.meta.url), 'utf8');
  const fixture = await fs.readFile(new URL('./fixtures/proxy-sessions.swift', import.meta.url), 'utf8');
  // Remove the Expo wrapper only. Pinning, request parsing, the pool, delegates
  // and sink compile unchanged, alongside their real Apple frameworks.
  const native = module.replace('import ExpoModulesCore\n', '').replace(/public final class LoomTvSecureTransportModule: Module \{[\s\S]*?\n\}\n(?=\nprivate let maxHeaderBytes)/, '');
  assert.doesNotMatch(native, /ExpoModulesCore|: Module \{/);
  const source = path.join(directory, 'main.swift');
  const executable = path.join(directory, 'proxy-sessions');
  await fs.writeFile(source, `${native}\n${buffer}\n${fixture}`);
  await compile(source, executable);

  const received = [];
  const produced = new Map();
  const chunk = Buffer.alloc(64 * 1024, 0x5a);
  const bulkBytes = 32 * 1024 * 1024;
  const server = http.createServer(async (request, response) => {
    const target = request.url;
    received.push(target);
    request.resume();
    if (target.startsWith('/hold/')) return;
    if (target.startsWith('/bulk/')) {
      response.writeHead(200, { 'Content-Length': bulkBytes });
      let closed = false;
      response.on('close', () => { closed = true; });
      for (let bytes = 0; bytes < bulkBytes && !closed; bytes += chunk.length) {
        produced.set(target, bytes + chunk.length);
        if (!response.write(chunk)) {
          await new Promise((resolve) => {
            const cleanup = () => { response.off('drain', cleanup); response.off('close', cleanup); resolve(); };
            response.once('drain', cleanup);
            response.once('close', cleanup);
          });
        }
      }
      if (!closed) response.end();
      return;
    }
    response.writeHead(200, { 'Content-Length': 5 });
    response.end('small');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const upstream = `http://127.0.0.1:${server.address().port}`;
  const children = [];
  const consumers = [];
  t.after(() => {
    for (const item of consumers) item.socket.destroy();
    for (const child of children) child.kill();
  });
  async function startFixture() {
    const child = spawn(executable, [upstream]);
    children.push(child);
    let output = '';
    let error = '';
    child.stdout.on('data', (data) => { output = (output + data).slice(-4_000); });
    child.stderr.on('data', (data) => { error = (error + data).slice(-4_000); });
    await until(() => output.includes('PORT ') || child.exitCode !== null, `native listener failed: ${error}`);
    const match = output.match(/PORT (\d+)/);
    assert.ok(match, error);
    const port = Number(match[1]);
    return {
      child,
      async admitted(target) {
        await until(() => output.split('\n').includes(`ADMITTED ${target}`), `request ${target} must be admitted`);
      },
      request(target, options) {
        const item = consumer(port, target, options);
        consumers.push(item);
        return item;
      },
    };
  }
  const first = await startFixture();
  async function partialRequest(origin, body = false) {
    const target = new URL(origin);
    const socket = net.connect({ host: '127.0.0.1', port: Number(target.port) });
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.on('error', () => {});
    const connected = new Promise((resolve) => socket.once('connect', () => {
      if (body) socket.write(`POST ${target.pathname}/api/ping HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nshort`);
      else socket.write(`GET ${target.pathname}/api/ping HTTP/1.1\r\nHost: localhost\r\n`);
      resolve();
    }));
    const item = { socket, done: closed };
    consumers.push(item);
    await connected;
    return item;
  }
  const localStart = await first.request('/local-start').done;
  assert.equal(localStart.status, 200);
  const partial = [];
  for (let index = 0; index < 32; index += 1) partial.push(await partialRequest(localStart.bodyText, index % 2 === 0));
  let localCount = 0;
  const countDeadline = Date.now() + 2_000;
  while (localCount !== 32 && Date.now() < countDeadline) {
    localCount = Number((await first.request('/local-count').done).bodyText);
    if (localCount !== 32) await delay(25);
  }
  assert.equal(localCount, 32, 'accepted parsing connections must reach only the fixed cap');
  const overflowPartial = await partialRequest(localStart.bodyText);
  await overflowPartial.done;
  assert.equal(Number((await first.request('/local-count').done).bodyText), 32, 'local admission must reject excess sockets');
  assert.equal((await first.request('/local-stop').done).status, 200);
  await Promise.all(partial.map((item) => item.done));
  assert.equal(Number((await first.request('/local-count').done).bodyText), 0, 'stop must remove and close partial-header/body connections');
  const localRestart = await first.request('/local-start').done;
  const timedPartial = await partialRequest(localRestart.bodyText, true);
  const receiveStarted = Date.now();
  await timedPartial.done;
  assert.ok(Date.now() - receiveStarted < 12_000, 'an incomplete request body must expire at its receive deadline');
  assert.equal(Number((await first.request('/local-count').done).bodyText), 0);
  assert.equal((await first.request('/local-stop').done).status, 200);
  assert.equal((await first.request('/start-race').done).status, 200,
    'stale listener failures and concurrent starts/stops must preserve the latest generation');
  const stalled = first.request('/bulk/stalled', { paused: true, slow: true });
  await until(() => (produced.get('/bulk/stalled') ?? 0) >= 1024 * 1024, 'bulk upstream must start and fill the paused consumer');
  await delay(500);
  const beforeSmall = Date.now();
  const small = await first.request('/small/independent').done;
  assert.equal(small.status, 200);
  assert.equal(small.bodyBytes, 5);
  assert.ok(Date.now() - beforeSmall < 2_000, 'a stalled lane cannot block another request');
  stalled.socket.resume();
  const full = await stalled.done;
  assert.equal(full.status, 200);
  assert.equal(full.bodyBytes, bulkBytes, 'slow consumer must receive the full response');
  assert.equal(full.hash, createHash('sha256').update(Buffer.alloc(bulkBytes, 0x5a)).digest('hex'));
  assert.equal(full.ended, true, 'final drain must precede graceful EOF');

  const oversized = await first.request('/oversized', { slow: true }).done;
  assert.equal(oversized.bodyBytes, 16 * 1024 * 1024, 'a single oversized callback must be sliced and drained');
  assert.equal(oversized.hash, createHash('sha256').update(Buffer.alloc(oversized.bodyBytes, 0x5a)).digest('hex'));
  assert.equal(oversized.ended, true);
  const halfClosed = await first.request('/small/half-close', { halfClose: true }).done;
  assert.equal(halfClosed.status, 200, 'request-side FIN must allow the response');
  assert.equal(halfClosed.bodyBytes, 5);

  const cancelling = first.request('/bulk/cancel-wait', { paused: true });
  await until(() => (produced.get('/bulk/cancel-wait') ?? 0) >= 1024 * 1024, 'cancel test must have a stalled producer');
  await delay(300);
  assert.equal((await first.request('/stop').done).status, 200);
  cancelling.socket.resume();
  const cancelled = await cancelling.done;
  assert.ok(cancelled.bodyBytes < bulkBytes, 'stop must interrupt the waiting body callback');
  const afterStop = produced.get('/bulk/cancel-wait');
  await delay(250);
  assert.equal(produced.get('/bulk/cancel-wait'), afterStop, 'stop must cancel upstream work');
  assert.equal((await first.request('/small/stopped').done).status, 503, 'a stopped pool cannot admit work');
  first.child.kill();

  const second = await startFixture();
  const holds = Array.from({ length: 6 }, (_, index) => second.request(`/hold/queue-${index}`));
  await until(() => holds.every((_, index) => received.includes(`/hold/queue-${index}`)), 'all six lanes must be occupied');
  const expiredQueued = second.request('/small/expired');
  await second.admitted('/small/expired');
  assert.equal((await second.request('/expire-queued').done).status, 200);
  const seventh = second.request('/small/seventh');
  await seventh.connected;
  await delay(100);
  assert.ok(!received.includes('/small/seventh'), 'normal excess work must wait without reaching upstream');
  holds[0].socket.resetAndDestroy();
  assert.equal((await seventh.done).status, 200, 'a reset must release its lane for waiting work');
  await expiredQueued.done;
  assert.ok(!received.includes('/small/expired'), 'promotion must reject expired work even before its timer runs');
  const fill = second.request('/hold/queue-fill');
  await until(() => received.includes('/hold/queue-fill'), 'refill the sixth lane');

  const queued = [];
  for (let index = 0; index < 12; index += 1) {
    const target = `/small/queued-${index}`;
    queued.push(second.request(target));
    await second.admitted(target);
  }
  assert.equal((await second.request('/small/count-overflow').done).status, 503, 'waiting count must have a hard bound');
  queued[0].socket.resetAndDestroy();
  await queued[0].done;
  await delay(100);
  const replacement = second.request('/small/queue-replacement');
  await second.admitted('/small/queue-replacement');
  fill.socket.resetAndDestroy();
  const completed = await Promise.all([...queued.slice(1), replacement].map((item) => item.done));
  assert.ok(completed.every((item) => item.status === 200), 'queued requests must finish when one lane becomes free');
  assert.ok(!received.includes('/small/queued-0'), 'reset queued work must never reach upstream');
  assert.deepEqual(received.filter((target) => target.startsWith('/small/queued-') || target === '/small/queue-replacement'),
    [...Array.from({ length: 11 }, (_, index) => `/small/queued-${index + 1}`), '/small/queue-replacement'], 'waiting work must preserve FIFO order');

  const bodyFill = second.request('/hold/body-fill');
  await until(() => received.includes('/hold/body-fill'), 'occupy the free lane before body admission');
  const bodyQueue = [0, 1].map((index) => second.request(`/small/body-${index}`, { bodyBytes: 2 * 1024 * 1024 }));
  await Promise.all(bodyQueue.map((item) => item.connected));
  await delay(100);
  assert.equal((await second.request('/small/body-overflow', { bodyBytes: 1 }).done).status, 503, 'waiting request bodies must also be bounded');
  bodyQueue[0].socket.resetAndDestroy();
  await bodyQueue[0].done;
  await delay(100);
  const bodyReplacement = second.request('/small/body-replacement', { bodyBytes: 2 * 1024 * 1024 });
  await second.admitted('/small/body-replacement');
  assert.equal((await second.request('/stop').done).status, 200);
  await Promise.all([...holds.slice(1), bodyFill, bodyQueue[1], bodyReplacement].map((item) => item.done));
  assert.ok(!received.includes('/small/body-1') && !received.includes('/small/body-replacement'), 'stop must discard queued work');
  second.child.kill();

  const third = await startFixture();
  const finalDrain = third.request('/hold/final-drain');
  await until(() => received.includes('/hold/final-drain'), 'final-drain transfer must be registered');
  assert.equal((await third.request('/stage-final-drain').done).status, 200,
    'an upstream-completed sink must remain registered while a body send is outstanding');
  assert.equal((await third.request('/stop').done).status, 200);
  await finalDrain.done;
  third.child.kill();
});
