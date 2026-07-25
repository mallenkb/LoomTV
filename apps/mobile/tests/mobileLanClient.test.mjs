import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileLanClient } from '../mobileLanClient.ts';

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
  assert.equal(requests[0].init.signal, controller.signal);
});
