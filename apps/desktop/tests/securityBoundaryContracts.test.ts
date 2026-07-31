import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function source(relativePath: string): string {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

function sourceSection(contents: string, startMarker: string, endMarker: string): string {
  const start = contents.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected source marker: ${startMarker}`);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Expected source marker after ${startMarker}: ${endMarker}`);
  return contents.slice(start, end);
}

test('LAN credentials and media leave loopback only through pinned TLS', () => {
  const lanSecurity = source('../src/main/lanSecurity.ts');
  const lanDiscovery = source('../src/main/lanDiscovery.ts');
  const mediaServer = source('../src/main/mediaServer.ts');

  assert.match(lanSecurity, /return address && port \? `https:\/\//);
  assert.doesNotMatch(lanSecurity, /return address \? `http:\/\//);
  assert.match(lanDiscovery, /certFingerprint/);
  assert.match(mediaServer, /http\.createServer\(createRequestHandler\('loopback'\)\)/);
  assert.match(mediaServer, /https\.createServer\(\{/);
  assert.match(mediaServer, /cert:\s*lanTlsIdentity\.certificatePem/);
  assert.match(mediaServer, /lanCertificateFingerprint\s*=\s*lanTlsIdentity\.certFingerprint/);
  assert.match(mediaServer, /transport:\s*loopbackRequest\s*\?\s*'loopback-http'\s*:\s*'tls'/);
});

test('originless loopback callers cannot bootstrap renderer authority or read raw settings', () => {
  const mediaServer = source('../src/main/mediaServer.ts');
  const ping = sourceSection(
    mediaServer,
    "if (reqUrl.pathname === '/api/ping' && req.method === 'GET')",
    "if (reqUrl.pathname === '/api/renderer/session' && req.method === 'POST')",
  );
  const rendererSession = sourceSection(
    mediaServer,
    "if (reqUrl.pathname === '/api/renderer/session' && req.method === 'POST')",
    "if (reqUrl.pathname === '/api/lan/info')",
  );
  const rendererSettings = sourceSection(
    mediaServer,
    "if (reqUrl.pathname === '/api/renderer/settings')",
    "if (reqUrl.pathname === '/api/renderer/ffmpeg'",
  );

  assert.doesNotMatch(ping, /localAccessToken/);
  assert.match(rendererSession, /!loopbackRequest\s*\|\|\s*!isTrustedRendererHttpOrigin/);
  assert.match(mediaServer, /pathname\.startsWith\('\/api\/renderer\/'\).*isTrustedRendererHttpOrigin/s);
  assert.match(rendererSettings, /requireOwner\(\)/);
  assert.match(rendererSettings, /settingsForRenderer\(loadSettings\(\)\)/);
  assert.match(rendererSettings, /sanitizeRendererSettingsPatch\(patch\)/);
});

test('profile administration derives identity from credentials and revocation clears profile capability', () => {
  const mediaServer = source('../src/main/mediaServer.ts');
  const lanSecurity = source('../src/main/lanSecurity.ts');
  const profileService = source('../src/main/profileService.ts');
  const profileIdentity = sourceSection(
    mediaServer,
    'const profileIdentityForMedia =',
    'const requireProfileMediaAccess =',
  );
  const profileCreation = sourceSection(
    mediaServer,
    "if (reqUrl.pathname === '/api/v2/profiles' && req.method === 'POST')",
    "if (reqUrl.pathname === '/api/v2/profiles/active'",
  );
  const unpair = sourceSection(
    mediaServer,
    "if (reqUrl.pathname === '/api/v2/unpair' && req.method === 'POST')",
    "if (reqUrl.pathname === '/api/v2/library/index'",
  );

  assert.match(profileIdentity, /credentialDeviceId/);
  assert.match(profileIdentity, /credentialDeviceId\s*&&\s*boundDeviceId\s*&&\s*credentialDeviceId\s*!==\s*boundDeviceId/);
  assert.doesNotMatch(profileIdentity, /authorizedDeviceId\s*=\s*boundDeviceId\s*\|\|/);
  assert.match(profileCreation, /requireOwner\(profileDeviceId\)/);
  assert.match(unpair, /Object\.prototype\.hasOwnProperty\.call\(body, 'deviceId'\)/);
  assert.match(unpair, /revokeDeviceProfileAccess\(authenticatedDevice\.id\)/);
  assert.match(lanSecurity, /Object\.prototype\.hasOwnProperty\.call\(body, 'deviceId'\)/);
  assert.match(lanSecurity, /const deviceId = randomUUID\(\)/);
  assert.doesNotMatch(lanSecurity, /const requestedDeviceId/);
  assert.match(profileService, /export function revokeDeviceProfileAccess/);
  assert.match(profileService, /clearDeviceProfileSelection\(deviceId\)/);
  assert.match(profileService, /unlockedUntil\.delete/);
  assert.match(profileService, /failures\.delete/);
});

test('subtitle delivery accepts only typed, media-scoped resources and bounded sidecar files', () => {
  const mediaServer = source('../src/main/mediaServer.ts');
  const resourceRegistry = source('../src/main/resourceRegistry.ts');
  const subtitleRoute = sourceSection(
    mediaServer,
    "if (reqUrl.pathname === '/subtitle')",
    "if (reqUrl.pathname.startsWith('/hls/'))",
  );
  const streamRoute = sourceSection(
    mediaServer,
    "if (reqUrl.pathname !== '/stream')",
    'const releaseStreamLease =',
  );

  assert.match(resourceRegistry, /scopePath\?: string/);
  assert.match(resourceRegistry, /expectedScopePath\?: string/);
  assert.match(resourceRegistry, /resource\.scopePath/);
  assert.match(subtitleRoute, /SUBTITLE_RESOURCE_KIND/);
  assert.match(subtitleRoute, /isSubtitleFileName/);
  assert.match(subtitleRoute, /readBoundedUtf8Subtitle/);
  assert.doesNotMatch(subtitleRoute, /fs\.readFileSync\(/);
  assert.match(mediaServer, /MAX_SIDECAR_SUBTITLE_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/);
  assert.match(mediaServer, /fs\.promises\.open/);
  assert.match(subtitleRoute, /SubtitleFileTooLargeError/);
  assert.match(subtitleRoute, /writeHead\(413/);
  assert.match(streamRoute, /searchParams\.has\('subtitleFile'\)/);
  assert.match(streamRoute, /searchParams\.has\('secondarySubtitleFile'\)/);
  assert.match(streamRoute, /resolveStreamSubtitle\('subtitleResourceId'\)/);
  assert.match(streamRoute, /resolveStreamSubtitle\('secondarySubtitleResourceId'\)/);
  assert.doesNotMatch(streamRoute, /subtitleFilePath:\s*reqUrl\.searchParams\.get/);
});

test('playback sessions bound persistence, credentials, restart churn, and byte ranges', () => {
  const mediaServer = source('../src/main/mediaServer.ts');
  const lanSecurity = source('../src/main/lanSecurity.ts');
  const transcodeManager = source('../src/main/transcodeManager.ts');
  const startHls = sourceSection(
    mediaServer,
    "if (reqUrl.pathname === '/api/v2/start-hls' && req.method === 'POST')",
    "if (routeAccess.kind === 'ipc-only')",
  );

  const lifecycleContracts: Array<[string, string, RegExp]> = [
    ['device activity writes are coalesced', lanSecurity, /PAIRED_DEVICE_TOUCH_FLUSH_MS/],
    ['device activity uses a pending map', lanSecurity, /pendingPairedDeviceTouches/],
    ['HLS bindings are capped', mediaServer, /MAX_HLS_PROFILE_BINDINGS/],
    ['HLS starts have a per-device budget', mediaServer, /consumeHlsStartBudget\(lanDeviceId\)/],
    ['HLS start exhaustion returns 429', startHls, /writeJson\(res, 429/],
    ['session disposal removes profile bindings', mediaServer, /registerTranscodeSessionDisposalListener[\s\S]*hlsProfileBindings\.delete/],
    ['encoder repositioning has a rolling budget', transcodeManager, /MAX_HLS_RESTARTS_PER_WINDOW/],
    ['stream credentials are session scoped', transcodeManager, /HLS_STREAM_TOKEN_QUERY_PARAM/],
    ['stream credentials are bounded', transcodeManager, /MAX_HLS_STREAM_CREDENTIALS_PER_SESSION/],
    ['Range parsing uses the strict helper', mediaServer, /parseHttpByteRange\(range, fileSize\)/],
    ['invalid ranges return 416', mediaServer, /writeHead\(416/],
  ];

  for (const [label, contents, pattern] of lifecycleContracts) {
    assert.match(contents, pattern, label);
  }
  assert.doesNotMatch(startHls, /requestToken\(reqUrl, req\)/);
  assert.match(mediaServer, /authorizeHlsStreamRequest\(reqUrl\)/);
});

test.todo('release signer and notarization verification remains deferred by user request');
