import assert from 'node:assert/strict';
import test from 'node:test';
import { MOBILE_LAN_TIMEOUT_MS, createMobileLanClient, mobileLanTimeoutFor } from '../mobileLanClient.ts';

test('operation classes receive distinct deadline budgets', () => {
  assert.equal(mobileLanTimeoutFor('https://desktop/api/v2/client-config'), MOBILE_LAN_TIMEOUT_MS.probe);
  assert.equal(mobileLanTimeoutFor('https://desktop/api/v2/library'), MOBILE_LAN_TIMEOUT_MS.library);
  assert.equal(mobileLanTimeoutFor('https://desktop/api/v2/start-hls'), MOBILE_LAN_TIMEOUT_MS.streamPreparation);
  assert.equal(mobileLanTimeoutFor('https://desktop/api/v2/progress'), MOBILE_LAN_TIMEOUT_MS.standard);
});

function recordingClient() {
  const requests = [];
  const client = createMobileLanClient(async (input, init = {}) => {
    requests.push({ input, init });
    return new Response('{}', { status: 200 });
  });
  return { client, requests };
}

test('library requests preserve bearer authorization and conditional ETag headers', async () => {
  const { client, requests } = recordingClient();
  await client.getLibrary('http://192.168.1.20:3847', 'device-token', '"library-etag"');

  assert.equal(requests[0].input, 'http://192.168.1.20:3847/api/v2/library');
  assert.deepEqual(requests[0].init.headers, {
    Authorization: 'Bearer device-token',
    'X-Loom-Profile-Api-Version': '1',
    'If-None-Match': '"library-etag"',
  });
});

test('pairing sends exactly the existing JSON request contract without authorization', async () => {
  const { client, requests } = recordingClient();
  await client.pair('http://desktop.local:3847', {
    code: 'pairing-secret',
    deviceId: 'mobile-device',
    deviceName: 'LoomTV iOS',
  });

  assert.equal(requests[0].input, 'http://desktop.local:3847/api/v2/pair');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(requests[0].init.headers, {
    'Content-Type': 'application/json',
    'X-Loom-Profile-Api-Version': '1',
  });
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    code: 'pairing-secret',
    deviceId: 'mobile-device',
    deviceName: 'LoomTV iOS',
  });
});

test('one-tap pairing requests desktop approval and polls with its short-lived secret', async () => {
  const { client, requests } = recordingClient();
  await client.pair('https://desktop.local:3848', {
    approvalRequested: true,
    deviceName: 'LoomTV iOS',
  });
  await client.pairingApprovalStatus('https://desktop.local:3848', {
    requestId: 'approval-id',
    requestSecret: 'approval-secret',
  });

  assert.equal(requests[0].input, 'https://desktop.local:3848/api/v2/pair');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    approvalRequested: true,
    deviceName: 'LoomTV iOS',
  });
  assert.equal(requests[1].input, 'https://desktop.local:3848/api/v2/pair/status');
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    requestId: 'approval-id',
    requestSecret: 'approval-secret',
  });
});

test('HLS preparation preserves media ID, options, and bearer headers', async () => {
  const { client, requests } = recordingClient();
  await client.startHls('http://desktop.local:3847', 'token', 'resource-id', {
    forceTranscode: true,
    startSeconds: 125,
    audioTrackIndex: 2,
  });

  assert.deepEqual(requests[0].init.headers, {
    Authorization: 'Bearer token',
    'X-Loom-Profile-Api-Version': '1',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    mediaId: 'resource-id',
    options: { forceTranscode: true, startSeconds: 125, audioTrackIndex: 2 },
  });
});

test('segment lookup forwards cancellation and encodes query parameters', async () => {
  const { client, requests } = recordingClient();
  const controller = new AbortController();
  const params = new URLSearchParams({ mediaId: 'resource id', season: '1', episode: '2' });
  await client.getPlaybackSegments('http://desktop.local:3847', 'token', params, controller.signal);

  assert.equal(
    requests[0].input,
    'http://desktop.local:3847/api/v2/playback/segments?mediaId=resource+id&season=1&episode=2',
  );
  assert.ok(requests[0].init.signal instanceof AbortSignal);
});

test('caller cancellation aborts the wrapped request signal', async () => {
  let wrappedSignal;
  const client = createMobileLanClient((_input, init = {}) => new Promise((_resolve, reject) => {
    wrappedSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  const controller = new AbortController();
  const pending = client.getPlaybackSegments('https://desktop', 'token', new URLSearchParams(), controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(wrappedSignal.aborted, true);
});

test('operation deadline aborts a hanging request with a typed timeout', async () => {
  const client = createMobileLanClient((_input, init = {}) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }), () => 10);
  await assert.rejects(
    client.getProgress('https://desktop', 'token'),
    (error) => error?.name === 'MobileLanTimeoutError' && error.timeoutMs === 10,
  );
});

test('client lifecycle cancellation aborts every active operation', async () => {
  const signals = [];
  const client = createMobileLanClient((_input, init = {}) => new Promise((_resolve, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  const pending = [
    client.getLibrary('https://desktop', 'token'),
    client.getProgress('https://desktop', 'token'),
  ];
  client.cancelActiveRequests();
  await Promise.all(pending.map((request) => assert.rejects(request, { name: 'AbortError' })));
  assert.equal(signals.every((signal) => signal.aborted), true);
});
