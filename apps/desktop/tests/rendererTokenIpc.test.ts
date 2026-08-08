import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { IncomingHttpHeaders } from 'node:http';
import { isIpcOnlyHttpRoute, mediaServerRouteAccess } from '../src/main/lanRoutePolicy.ts';
import {
  authorizeRendererHttpRequest,
  isTrustedRendererHttpOrigin,
  RENDERER_SESSION_ROUTE,
} from '../src/main/rendererHttpAccess.ts';
import { describeErrorForLog, redactRequestSecrets } from '../src/main/serverSecurity.ts';
import { isTrustedIpcSender } from '../src/main/trustedIpcSender.ts';

const LOOPBACK_PORT = 3847;
const DEV_ORIGIN = 'http://localhost:5173';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([DEV_ORIGIN]);

function trustsOrigin(headers: IncomingHttpHeaders): boolean {
  return isTrustedRendererHttpOrigin({
    headers,
    allowedOrigins: ALLOWED_ORIGINS,
    loopbackServerPort: LOOPBACK_PORT,
  });
}

function sessionRouteOutcome(headers: IncomingHttpHeaders, loopbackRequest: boolean) {
  return authorizeRendererHttpRequest({
    pathname: RENDERER_SESSION_ROUTE,
    loopbackRequest,
    trustedOrigin: () => trustsOrigin(headers),
  });
}

test('a loopback caller forging a trusted Origin is still refused the renderer credential', () => {
  // Both forgeries are trivial for any local process: the dev-server origin is
  // a fixed string, and the /app/ origin is the media server's own address.
  const forgedDevOrigin: IncomingHttpHeaders = { origin: DEV_ORIGIN };
  const forgedAppOrigin: IncomingHttpHeaders = { origin: `http://127.0.0.1:${LOOPBACK_PORT}` };
  const forgedReferer: IncomingHttpHeaders = {
    'sec-fetch-site': 'same-origin',
    referer: `http://127.0.0.1:${LOOPBACK_PORT}/app/index.html`,
  };

  // The predicate accepts all three, which is exactly why it may not authorize.
  assert.equal(trustsOrigin(forgedDevOrigin), true);
  assert.equal(trustsOrigin(forgedAppOrigin), true);
  assert.equal(trustsOrigin(forgedReferer), true);

  for (const headers of [forgedDevOrigin, forgedAppOrigin, forgedReferer]) {
    const decision = sessionRouteOutcome(headers, true);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.status, 410);
    assert.doesNotMatch(JSON.stringify(decision), /token/i);
  }
});

test('a plain loopback HTTP caller with no Origin gets no renderer credential', () => {
  const decision = sessionRouteOutcome({}, true);
  assert.equal(trustsOrigin({}), false);
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.status, 410);
});

test('a remote HTTP caller reaches neither the credential route nor the renderer surface', () => {
  const remoteHeaders: IncomingHttpHeaders = { origin: `http://127.0.0.1:${LOOPBACK_PORT}` };

  const credential = sessionRouteOutcome(remoteHeaders, false);
  assert.equal(credential.allowed, false);
  assert.equal(credential.allowed === false && credential.status, 410);

  const catalog = authorizeRendererHttpRequest({
    pathname: '/api/renderer/library/index',
    loopbackRequest: false,
    trustedOrigin: () => trustsOrigin(remoteHeaders),
  });
  assert.equal(catalog.allowed, false);
  assert.equal(catalog.allowed === false && catalog.status, 403);
});

test('the loopback renderer surface still serves a genuine same-origin request', () => {
  const decision = authorizeRendererHttpRequest({
    pathname: '/api/renderer/library/index',
    loopbackRequest: true,
    trustedOrigin: () => trustsOrigin({ origin: DEV_ORIGIN }),
  });
  assert.deepEqual(decision, { allowed: true });

  // Non-renderer paths are not this gate's business.
  assert.deepEqual(
    authorizeRendererHttpRequest({ pathname: '/api/ping', loopbackRequest: true, trustedOrigin: () => false }),
    { allowed: true },
  );
});

test('no HTTP method or classification reopens the renderer credential route', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.deepEqual(
      mediaServerRouteAccess(RENDERER_SESSION_ROUTE, method),
      { kind: 'ipc-only' },
      method,
    );
  }
  assert.equal(isIpcOnlyHttpRoute(RENDERER_SESSION_ROUTE), true);

  // Every remaining unauthenticated route, enumerated: none returns a secret.
  for (const [pathname, method] of [
    ['/', 'GET'],
    ['/pair', 'GET'],
    ['/api/ping', 'GET'],
    ['/api/lan/info', 'GET'],
  ] as const) {
    assert.deepEqual(mediaServerRouteAccess(pathname, method), { kind: 'public' });
  }
});

test('the media server no longer holds the local access token it used to disclose', () => {
  // The credential is not merely unreferenced by a handler: it is no longer a
  // dependency of the module, so no future edit can serialize it by accident.
  const source = fs.readFileSync(new URL('../src/main/mediaServer.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('LOCAL_ACCESS_TOKEN'), false);
  assert.equal(source.includes('localAccessToken'), false);
  assert.equal(source.includes(RENDERER_SESSION_ROUTE), false);
});

test('IPC delivery accepts the main window frame and rejects every other sender', () => {
  const mainWindow = {
    mainWindowWebContentsId: 7,
    mainWindowUrl: 'http://localhost:5173/index.html',
    mainWindowDestroyed: false,
    senderFrameIsMainFrame: true,
  };

  assert.equal(isTrustedIpcSender({
    senderWebContentsId: 7,
    senderFrameUrl: 'http://localhost:5173/index.html',
    ...mainWindow,
  }), true);

  // A packaged build loads from file:, where every URL shares the null origin,
  // so the rule compares the document path instead.
  assert.equal(isTrustedIpcSender({
    senderWebContentsId: 7,
    senderFrameIsMainFrame: true,
    senderFrameUrl: 'file:///Applications/LoomTV.app/renderer/index.html',
    mainWindowWebContentsId: 7,
    mainWindowUrl: 'file:///Applications/LoomTV.app/renderer/index.html',
    mainWindowDestroyed: false,
  }), true);

  const rejected: Array<[string, Parameters<typeof isTrustedIpcSender>[0]]> = [
    ['another webContents', { senderWebContentsId: 8, senderFrameUrl: 'http://localhost:5173/index.html', ...mainWindow }],
    ['a same-origin subframe', {
      ...mainWindow,
      senderWebContentsId: 7,
      senderFrameIsMainFrame: false,
      senderFrameUrl: 'http://localhost:5173/index.html',
    }],
    ['a cross-origin subframe', { senderWebContentsId: 7, senderFrameUrl: 'https://evil.example/index.html', ...mainWindow }],
    ['a destroyed frame', { senderWebContentsId: 7, senderFrameUrl: null, ...mainWindow }],
    ['a closed window', {
      senderWebContentsId: 7,
      senderFrameIsMainFrame: true,
      senderFrameUrl: 'http://localhost:5173/index.html',
      mainWindowWebContentsId: null,
      mainWindowUrl: null,
      mainWindowDestroyed: true,
    }],
    ['a different packaged document', {
      senderWebContentsId: 7,
      senderFrameIsMainFrame: true,
      senderFrameUrl: 'file:///tmp/attacker/index.html',
      mainWindowWebContentsId: 7,
      mainWindowUrl: 'file:///Applications/LoomTV.app/renderer/index.html',
      mainWindowDestroyed: false,
    }],
    ['an unparseable frame URL', { senderWebContentsId: 7, senderFrameUrl: 'not a url', ...mainWindow }],
  ];

  for (const [label, identity] of rejected) {
    assert.equal(isTrustedIpcSender(identity), false, label);
  }
});

test('logged request URLs and errors never carry a replayable credential', () => {
  const token = 'b3f1c0de5ecre7';
  const url = `http://127.0.0.1:3847/stream?path=%2Fm.mkv&loomtvToken=${token}&t=12`;

  const redacted = redactRequestSecrets(url);
  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.includes('path=%2Fm.mkv'), true);
  assert.equal(redacted.includes('t=12'), true);

  assert.equal(redactRequestSecrets(`GET /api/v2/library?token=${token}`).includes(token), false);
  assert.equal(redactRequestSecrets(`/hls/x.m3u8?streamToken=${token}`).includes(token), false);
  assert.equal(redactRequestSecrets(`x-loomtv-token: ${token}`).includes(token), false);
  assert.equal(redactRequestSecrets(`authorization: Bearer ${token}`).includes(token), false);

  const described = describeErrorForLog(new Error(`fetch failed for ${url}`));
  assert.equal(described.includes(token), false);
  assert.match(described, /fetch failed/);
  assert.equal(describeErrorForLog(`plain ${url}`).includes(token), false);
});

test('a session without the IPC bridge is left unauthenticated rather than credentialed', () => {
  // Compatibility contract for the /app/ browser renderer: it can still reach
  // credential-free discovery, but the routes that need authority now fail
  // closed. Nothing about the request can talk the server into a token.
  assert.deepEqual(mediaServerRouteAccess('/api/ping', 'GET'), { kind: 'public' });
  assert.deepEqual(mediaServerRouteAccess('/api/renderer/library/index', 'GET'), { kind: 'desktop' });
  assert.deepEqual(mediaServerRouteAccess(RENDERER_SESSION_ROUTE, 'POST'), { kind: 'ipc-only' });

  const bridgeless = sessionRouteOutcome({ origin: `http://127.0.0.1:${LOOPBACK_PORT}` }, true);
  assert.equal(bridgeless.allowed, false);
  assert.equal(bridgeless.allowed === false && bridgeless.status, 410);
});
