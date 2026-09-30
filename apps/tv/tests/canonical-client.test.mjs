import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { CanonicalTvClient, isTvAuthorizationFailure, tvPlaybackCapabilities } from '../src/canonical-client.ts';

test('TV capabilities and its compatibility retry do not overclaim decoder support', async (context) => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ ok: true, data: {} });
  });
  const client = new CanonicalTvClient('https://loomtv.local');
  const tracks = { audioTrackId: 'stream:2', subtitleTrackId: null };
  await client.planPlayback('movie-1', 137, tracks);
  await client.planPlayback('movie-1', 137, tracks, true);
  for (const request of requests) {
    assert.deepEqual(request.capabilities.videoCodecs, ['h264']);
    assert.deepEqual(request.capabilities.audioCodecs, ['aac']);
    assert.deepEqual(request.capabilities.containers, ['mp4']);
    assert.deepEqual(request.capabilities.hdrFormats, []);
    assert.equal(request.capabilities.maxWidth, 1920);
    assert.equal(request.capabilities.maxHeight, 1080);
    assert.equal(request.startSeconds, 137);
    assert.equal(request.audioTrackId, 'stream:2');
    assert.equal(request.subtitleTrackId, null);
  }
  assert.equal(requests[0].capabilities.forceTranscode, false);
  assert.equal(requests[1].capabilities.forceTranscode, true);
  assert.equal(tvPlaybackCapabilities().forceTranscode, false);
});

test('an invitation skips profile state routes and revokes its own session on sign-out', async (context) => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return Response.json({ ok: true, data: {} });
  });
  const client = new CanonicalTvClient('https://loomtv.local', { id: 'invitation-session', secret: 'secret', scheme: 'LoomInvitation' });
  client.useInvitationProfile('fixed-profile');
  assert.deepEqual(await client.progress('movie-1'), { progress: null });
  assert.deepEqual(await client.saveProgress('movie-1', 90, 120), { progress: null });
  assert.deepEqual(await client.listEntries(), { entries: [] });
  assert.equal(requests.length, 0);
  await client.signOut();
  assert.equal(requests[0].url, 'https://loomtv.local/api/v1/invitations/session');
  assert.equal(requests[0].init.method, 'DELETE');
  assert.equal(requests[0].init.headers.Authorization, 'LoomInvitation invitation-session.secret');
  assert.equal(client.isInvitation, false);
});

test('a rejected lease revocation fails before a playback recovery can proceed', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error: { code: 'rate_limited', message: 'Wait.' } }, { status: 429 }));
  await assert.rejects(new CanonicalTvClient('https://loomtv.local').stopPlayback('movie-1', 'lease-1'), { code: 'rate_limited', status: 429 });
});

test('catalog merges canonical series once and derives availability from episodes', async (context) => {
  const episode = { id: 'episode-1', kind: 'episode', title: 'Pilot', available: false };
  const series = { id: 'series-1', kind: 'series', title: 'Show', available: true };
  context.mock.method(globalThis, 'fetch', async (url) => Response.json({ ok: true, data:
    url.endsWith('/series') ? { series: [{ ...series, seasons: [{ episodes: [episode] }] }] }
      : { items: [series, episode, { id: 'movie-1', kind: 'movie', title: 'Movie', available: true }] },
  }));
  const result = await new CanonicalTvClient('https://loomtv.local').library();
  assert.equal(result.items.length, 2);
  const shows = result.items.filter((item) => item.id === series.id);
  assert.equal(shows.length, 1);
  assert.equal(shows[0].available, false);
  assert.deepEqual(shows[0].episodes, [episode]);
});

test('TV progress writes canonical fields and only explicitly supplied watched state', async (context) => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return Response.json({ ok: true, data: {} });
  });
  const client = new CanonicalTvClient('https://loomtv.local');
  await client.selectProfile('profile-1');
  for (const watched of [undefined, true, false]) {
    await client.saveProgress('movie/1', 61.5, 120, watched);
    const request = requests.at(-1);
    assert.equal(request.url, 'https://loomtv.local/api/v1/profiles/profile-1/progress/movie%2F1');
    assert.equal(request.init.method, 'PUT');
    assert.deepEqual(JSON.parse(request.init.body), { position: 61.5, duration: 120, ...(watched !== undefined ? { watched } : {}) });
  }
});

test('TV client rejects cleartext server addresses', () => {
  assert.throws(() => new CanonicalTvClient('http://192.168.1.8:3848'), /HTTPS/);
});

test('TV client resolves capability URLs without exposing server paths', () => {
  const client = new CanonicalTvClient('https://loomtv.local:3848');
  assert.equal(client.absoluteUrl('/api/v1/media/id/direct?token=cap'), 'https://loomtv.local:3848/api/v1/media/id/direct?token=cap');
});

test('saved connection recovery distinguishes authorization loss from an outage', () => {
  assert.equal(isTvAuthorizationFailure({ status: 401 }), true);
  assert.equal(isTvAuthorizationFailure({ status: 403 }), true);
  assert.equal(isTvAuthorizationFailure({ status: 500 }), false);
  assert.equal(isTvAuthorizationFailure(new TypeError('Network request failed')), false);
});

test('TV discovery accepts the document a real Loom server sends', async (context) => {
  const { createCanonicalVideoServer } = await import('../../server/src/server.js');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-tv-discovery-'));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  const paths = { dataDir: path.join(base, 'data'), cacheDir: path.join(base, 'cache'), mediaDir: null };
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.cacheDir, { recursive: true });
  const server = createCanonicalVideoServer({
    host: '127.0.0.1', port: 0, paths, version: '9.9.9-test',
    bootstrapSecret: 'tv-discovery-bootstrap-secret-32-bytes',
  });
  const address = await server.start();
  context.after(() => server.stop());

  const client = new CanonicalTvClient('https://loomtv.local', null, `http://127.0.0.1:${address.port}`);
  const discovery = await client.discover();
  assert.equal(discovery.serverVersion, '9.9.9-test');
  assert.equal(typeof discovery.apiVersion, 'string');
});

test('TV discovery also accepts an envelope and rejects non-Loom answers', async (context) => {
  const responses = [
    Response.json({ ok: true, data: { apiVersion: '1', serverVersion: '2.0.4', certificateFingerprint: 'ab' } }),
    Response.json({ ok: false, error: { code: 'maintenance', message: 'Down for maintenance.' } }, { status: 503 }),
    Response.json({ hello: 'not loom' }),
    new Response('<html>router login</html>', { status: 200 }),
  ];
  context.mock.method(globalThis, 'fetch', async () => responses.shift());
  const client = new CanonicalTvClient('https://loomtv.local');
  assert.deepEqual(await client.discover(), { apiVersion: '1', serverVersion: '2.0.4', certificateFingerprint: 'ab' });
  await assert.rejects(client.discover(), { code: 'maintenance', status: 503, message: 'Down for maintenance.' });
  await assert.rejects(client.discover(), { code: 'invalid_discovery' });
  await assert.rejects(client.discover(), { code: 'invalid_discovery' });
});

const executable = (name) => {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { return null; }
};
const ffmpeg = executable('ffmpeg');
const ffprobe = executable('ffprobe');

async function invitationFixture(context, realVideo = false, options = {}) {
  const { createCanonicalVideoServer } = await import('../../server/src/server.js');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-tv-invitation-'));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  const paths = { dataDir: path.join(base, 'data'), cacheDir: path.join(base, 'cache'), mediaDir: null };
  const mediaDir = path.join(base, 'media');
  await Promise.all([paths.dataDir, paths.cacheDir, mediaDir].map((directory) => fs.mkdir(directory, { recursive: true })));
  if (realVideo) {
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050',
      '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-shortest', path.join(mediaDir, 'Film (2020).mp4')]);
    assert.equal(generated.status, 0, String(generated.stderr));
  } else await fs.writeFile(path.join(mediaDir, 'Film (2020).mkv'), 'fake-video');
  const bootstrapSecret = 'tv-invitation-bootstrap-secret-32-bytes';
  const server = createCanonicalVideoServer({ host: '127.0.0.1', port: 0, paths, version: 'test', bootstrapSecret,
    ...(realVideo ? { ffmpegPath: ffmpeg, ffprobePath: ffprobe } : {}), ...(options.clock ? { clock: options.clock } : {}) });
  const address = await server.start();
  context.after(() => server.stop());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const call = async (method, route, body, token) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const owner = await call('POST', '/api/v1/auth/owner', { name: 'Owner', password: 'tv-invitation-password', bootstrapSecret });
  const token = owner.body.data.adminToken;
  const root = await call('POST', '/api/v1/library/roots', { path: mediaDir }, token);
  assert.equal(root.status, 201);
  const rootId = root.body.data.root?.id ?? root.body.data.id;
  await call('POST', '/api/v1/library/scan', {}, token);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await call('GET', '/api/v1/library/scan', null, token)).body.data.state !== 'scanning') break;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  const profile = await call('POST', '/api/v1/profiles', { name: 'Guest room' }, token);
  const profileId = profile.body.data.profile.id;
  const invitation = await call('POST', '/api/v1/invitations', {
    profileId, rootIds: [rootId], ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
  }, token);
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));

  const tv = new CanonicalTvClient('https://loomtv.local', null, baseUrl);
  const accepted = await tv.acceptInvitation(invitation.body.data.id, invitation.body.data.secret, 'tv-device-1');
  assert.equal(accepted.scope?.profileId, profileId);
  const credential = { ...accepted.credential, scheme: 'LoomInvitation' };
  tv.setCredential(credential);
  return { tv, credential, profileId, rootId, baseUrl, call, token, accepted };
}

test('a TV invitation restores its fixed profile against a real Loom server', async (context) => {
  const { credential, profileId, baseUrl } = await invitationFixture(context);
  // A fresh client models loading a credential after the TV app restarts.
  const tv = new CanonicalTvClient('https://loomtv.local', JSON.parse(JSON.stringify(credential)), baseUrl);
  await tv.discover();

  // Invitation credentials cannot list profiles; this is what failed before.
  await assert.rejects(tv.profiles(), { status: 403 });

  // Restoring a saved invitation validates it and recovers the profile.
  const me = await tv.me();
  assert.equal(me.invitation?.profileId, profileId);
  tv.useInvitationProfile(profileId);
  const library = await tv.library();
  assert.equal(library.items.length, 1);
  assert.deepEqual(await tv.progress(library.items[0].id), { progress: null });
  assert.deepEqual(await tv.listEntries(), { entries: [] });
});

test('a restored TV invitation streams direct and forced HLS with live session boundaries', {
  skip: !ffmpeg || !ffprobe ? 'ffmpeg and ffprobe are required' : false,
  timeout: 60_000,
}, async (context) => {
  const { tv: accepting, credential, profileId, rootId, baseUrl, call, token } = await invitationFixture(context, true);
  const tv = new CanonicalTvClient('https://loomtv.local', JSON.parse(JSON.stringify(credential)), baseUrl);
  await tv.discover();
  assert.equal((await tv.me()).invitation.profileId, profileId);
  tv.useInvitationProfile(profileId);
  const mediaId = (await tv.library()).items[0].id;
  const ordinary = await tv.planPlayback(mediaId);
  assert.ok(ordinary.directUrl, 'the H.264/AAC MP4 fixture is directly playable');
  const direct = await fetch(tv.absoluteUrl(ordinary.directUrl));
  assert.equal(direct.status, 200);
  assert.ok((await direct.arrayBuffer()).byteLength > 0);
  const directRenewal = await tv.renewPlayback(mediaId, 'direct', ordinary.directSessionId);
  assert.equal((await fetch(directRenewal.url)).status, 200);
  await tv.stopPlayback(mediaId, ordinary.directSessionId);
  assert.equal((await fetch(directRenewal.url)).status, 401);

  const forced = await tv.planPlayback(mediaId, 0, {}, true);
  assert.ok(forced.transcodeUrl);
  const hls = await tv.startTranscode(forced.transcodeUrl);
  const playlistResponse = await fetch(hls.playlistUrl);
  assert.equal(playlistResponse.status, 200);
  const playlist = await playlistResponse.text();
  assert.match(playlist, /#EXTM3U/);
  const segment = playlist.split(/\r?\n/).find((line) => line && !line.startsWith('#'));
  assert.ok(segment, 'a successful startup advertises an existing segment');
  const segmentUrl = new URL(segment, hls.playlistUrl);
  const segmentResponse = await fetch(segmentUrl);
  assert.equal(segmentResponse.status, 200);
  assert.ok((await segmentResponse.arrayBuffer()).byteLength > 0);
  const hlsRenewal = await tv.renewPlayback(mediaId, 'hls', hls.sessionId);
  assert.equal((await fetch(hlsRenewal.url)).status, 200);

  // A different invitation from the same issuer/profile has no authority over
  // this session, even when its media and device scopes happen to match.
  const otherInvitation = await call('POST', '/api/v1/invitations', { profileId, rootIds: [rootId] }, token);
  assert.equal(otherInvitation.status, 201);
  const other = await accepting.acceptInvitation(otherInvitation.body.data.id, otherInvitation.body.data.secret, 'tv-device-1');
  const otherTv = new CanonicalTvClient('https://loomtv.local', { ...other.credential, scheme: 'LoomInvitation' }, baseUrl);
  otherTv.useInvitationProfile(profileId);
  await assert.rejects(otherTv.renewPlayback(mediaId, 'hls', hls.sessionId), { status: 401 });
  await assert.rejects(otherTv.stopPlayback(mediaId, hls.sessionId), { status: 401 });
  assert.equal((await fetch(hlsRenewal.url)).status, 200, 'cross-session refusal leaves playback active');
  const unscoped = await fetch(`${baseUrl}/api/v1/media/${mediaId}/transcode`, {
    method: 'POST', headers: { Authorization: `LoomInvitation ${credential.id}.${credential.secret}` },
  });
  assert.equal(unscoped.status, 401, 'an invitation needs an opaque scoped plan');

  await tv.stopPlayback(mediaId, hls.sessionId);
  assert.equal((await fetch(hlsRenewal.url)).status, 401);
  const activeDirect = await tv.planPlayback(mediaId);
  const activeHls = await tv.startTranscode((await tv.planPlayback(mediaId, 0, {}, true)).transcodeUrl);
  await tv.signOut();
  await assert.rejects(new CanonicalTvClient('https://loomtv.local', credential, baseUrl).me(), { status: 401 });
  assert.equal((await fetch(tv.absoluteUrl(activeDirect.directUrl))).status, 401);
  assert.notEqual((await fetch(activeHls.playlistUrl)).status, 200, 'revocation invalidates existing HLS capabilities');
  assert.notEqual((await fetch(segmentUrl)).status, 200);
});

test('invitation HLS renewal crosses the first idle boundary but respects actual idle and absolute expiry', {
  skip: !ffmpeg || !ffprobe ? 'ffmpeg and ffprobe are required' : false,
  timeout: 60_000,
}, async (context) => {
  const initialTime = Date.now();
  let currentTime = initialTime;
  const minute = 60_000;
  const { tv, credential, profileId, rootId, baseUrl, call, token } = await invitationFixture(context, true, {
    clock: () => currentTime, ttlMs: 45 * minute,
  });
  tv.useInvitationProfile(profileId);
  const mediaId = (await tv.library()).items[0].id;
  const lease = await tv.startTranscode((await tv.planPlayback(mediaId, 0, {}, true)).transcodeUrl);
  const consumeSegment = async (playlistUrl) => {
    const response = await fetch(playlistUrl);
    assert.equal(response.status, 200);
    const line = (await response.text()).split(/\r?\n/).find((entry) => entry && !entry.startsWith('#'));
    assert.ok(line);
    const segment = await fetch(new URL(line, playlistUrl));
    assert.equal(segment.status, 200);
    await segment.arrayBuffer();
  };
  await consumeSegment(lease.playlistUrl);
  let renewed;
  for (let elapsed = 4; elapsed <= 32; elapsed += 4) {
    currentTime = initialTime + elapsed * minute;
    renewed = await tv.renewPlayback(mediaId, 'hls', lease.sessionId);
  }
  assert.equal((await fetch(renewed.url)).status, 200, 'authenticated keepalive crosses the original 30-minute invitation idle boundary');
  const bounded = await fetch(`${baseUrl}/api/v1/media/${mediaId}/playback-session/renew`, {
    method: 'POST', headers: { Authorization: `LoomInvitation ${credential.id}.${credential.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'hls', sessionId: lease.sessionId }),
  });
  assert.equal(bounded.status, 200);
  assert.equal((await bounded.json()).data.absoluteExpiresAt, initialTime + 45 * minute);

  // Capability-only renewal keeps the media lease alive, but does not count as
  // authenticated invitation activity or resurrect an expired invitation.
  const secondInvitation = await call('POST', '/api/v1/invitations', { profileId, rootIds: [rootId], ttlMs: 45 * minute }, token);
  assert.equal(secondInvitation.status, 201);
  const accepted = await tv.acceptInvitation(secondInvitation.body.data.id, secondInvitation.body.data.secret, 'idle-tv');
  const idleTv = new CanonicalTvClient('https://loomtv.local', { ...accepted.credential, scheme: 'LoomInvitation' }, baseUrl);
  idleTv.useInvitationProfile(profileId);
  const idleLease = await idleTv.startTranscode((await idleTv.planPlayback(mediaId, 0, {}, true)).transcodeUrl);
  await consumeSegment(idleLease.playlistUrl);
  let capability = new URL(idleLease.playlistUrl).searchParams.get('token');
  let latestPlaylist = idleLease.playlistUrl;
  for (let elapsed = 36; elapsed <= 60; elapsed += 4) {
    currentTime = initialTime + elapsed * minute;
    const result = await call('POST', `/api/v1/media/${mediaId}/playback-session/renew`, { action: 'hls', token: capability });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    capability = result.body.data.token;
    latestPlaylist = idleTv.absoluteUrl(result.body.data.playlistUrl);
    if (elapsed === 44) {
      currentTime = initialTime + 45 * minute;
      assert.equal((await fetch(renewed.url)).status, 401, 'the original invitation absolute expiry remains a hard cap');
      await assert.rejects(tv.me(), { status: 401 });
    }
  }
  currentTime = initialTime + 62 * minute;
  const expired = await call('POST', `/api/v1/media/${mediaId}/playback-session/renew`, { action: 'hls', token: capability });
  assert.equal(expired.status, 401, 'true invitation idle expiry blocks a media lease that otherwise remains valid');
  assert.notEqual((await fetch(latestPlaylist)).status, 200);
  await assert.rejects(idleTv.me(), { status: 401 }, 'failed capability authorization did not extend invitation idle expiry');
});
