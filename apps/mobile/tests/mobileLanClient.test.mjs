import assert from 'node:assert/strict';
import test from 'node:test';
import { MOBILE_LAN_TIMEOUT_MS, createMobileLanClient, mobileLanTimeoutFor } from '../mobileLanClient.ts';

test('operation classes receive distinct deadline budgets', () => {
  assert.equal(mobileLanTimeoutFor('https://desktop/api/v1/discovery'), MOBILE_LAN_TIMEOUT_MS.probe);
  assert.equal(mobileLanTimeoutFor('https://desktop/api/v1/library'), MOBILE_LAN_TIMEOUT_MS.library);
  assert.equal(mobileLanTimeoutFor('https://desktop/api/v1/media/id/playback-plan'), MOBILE_LAN_TIMEOUT_MS.streamPreparation);
  assert.equal(mobileLanTimeoutFor('https://desktop/api/v1/profiles/id/progress'), MOBILE_LAN_TIMEOUT_MS.standard);
});

function recordingClient() {
  const requests = [];
  const client = createMobileLanClient(async (input, init = {}) => {
    requests.push({ input, init });
    return new Response('{"ok":true,"data":{}}', { status: 200 });
  });
  return { client, requests };
}

test('library requests use the canonical API and device credential scheme', async () => {
  const { client, requests } = recordingClient();
  await client.getLibrary('http://192.168.1.20:3847', 'device-token', '"library-etag"');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, 'http://192.168.1.20:3847/api/v1/library/catalog');
  assert.deepEqual(requests[0].init.headers, {
    Authorization: 'LoomDevice device-token',
    'If-None-Match': '"library-etag"',
  });
});

test('pairing creates a canonical approval request without authorization', async () => {
  const { client, requests } = recordingClient();
  await client.pair('http://desktop.local:3847', {
    code: 'pairing-secret',
    deviceId: 'mobile-device',
    deviceName: 'LoomTV iOS',
  });

  assert.equal(requests[0].input, 'http://desktop.local:3847/api/v1/pairing/requests');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(requests[0].init.headers, {
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    name: 'LoomTV iOS',
    kind: 'mobile',
    permissions: ['library.read', 'stream', 'transcode', 'downloads'],
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

  assert.equal(requests[0].input, 'https://desktop.local:3848/api/v1/pairing/requests');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    name: 'LoomTV iOS',
    kind: 'mobile',
    permissions: ['library.read', 'stream', 'transcode', 'downloads'],
  });
  assert.equal(requests[1].input, 'https://desktop.local:3848/api/v1/pairing/requests/approval-id');
  assert.deepEqual(requests[1].init.headers, {
    Authorization: 'LoomPairing approval-secret',
  });
});

test('playback preparation uses a canonical playback plan and device credential', async () => {
  const { client, requests } = recordingClient();
  await client.startHls('http://desktop.local:3847', 'token', 'resource-id', {
    forceTranscode: true,
    startSeconds: 125,
    audioTrackIndex: 2,
  });

  assert.deepEqual(requests[0].init.headers, {
    Authorization: 'LoomDevice token',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    capabilities: {
      containers: ['mp4'],
      videoCodecs: ['h264', 'hevc'],
      audioCodecs: ['aac', 'mp3'],
      supportsHls: true,
      supportsHdr: true,
      supportsTextSubtitles: false,
      subtitleModes: ['burn-in'],
    },
    startSeconds: 125,
    audioTrackId: '2',
  });
  assert.equal(requests[0].input, 'http://desktop.local:3847/api/v1/media/resource-id/playback-plan');
});

test('offline download leases use canonical routes and never place secrets in URLs', async () => {
  const { client, requests } = recordingClient();
  await client.createOfflineDownload('https://server.local:3848', 'device-token', 'media id');
  await client.revokeOfflineDownload('https://server.local:3848', 'device-token', 'lease/id');

  assert.equal(requests[0].input, 'https://server.local:3848/api/v1/downloads');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(requests[0].init.headers, {
    Authorization: 'LoomDevice device-token',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(requests[0].init.body), { mediaId: 'media id', allowRanges: true });
  assert.equal(requests[1].input, 'https://server.local:3848/api/v1/downloads/lease%2Fid');
  assert.equal(requests[1].init.method, 'DELETE');
  assert.deepEqual(requests[1].init.headers, { Authorization: 'LoomDevice device-token' });
});

test('retired segment lookup makes no network request', async () => {
  const { client, requests } = recordingClient();
  const controller = new AbortController();
  const params = new URLSearchParams({ mediaId: 'resource id', season: '1', episode: '2' });
  const response = await client.getPlaybackSegments('http://desktop.local:3847', 'token', params, controller.signal);
  assert.equal(response.status, 410);
  assert.equal(requests.length, 0);
});

test('caller cancellation aborts the wrapped request signal', async () => {
  let wrappedSignal;
  const client = createMobileLanClient((_input, init = {}) => new Promise((_resolve, reject) => {
    wrappedSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  const controller = new AbortController();
  const pending = client.startHls('https://desktop', 'token', 'media-id', {}, undefined, controller.signal);
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
