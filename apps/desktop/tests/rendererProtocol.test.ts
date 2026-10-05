import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PACKAGED_RENDERER_URL, isPackagedRendererUrl, packagedRendererAssetPath } from '../src/main/rendererProtocol.ts';
import { isExpectedAppUrl, isTrustedIpcSender } from '../src/main/trustedIpcSender.ts';

test('packaged renderer resolves local assets inside the renderer directory, including asar paths', () => {
  for (const root of ['/app/.vite/renderer/main_window', '/app/app.asar/.vite/renderer/main_window']) {
    assert.equal(packagedRendererAssetPath(PACKAGED_RENDERER_URL, root), path.join(root, 'index.html'));
    assert.equal(packagedRendererAssetPath('loomtv://app/assets/main.js?v=2', root), path.join(root, 'assets/main.js'));
    assert.equal(packagedRendererAssetPath('loomtv://app/fonts/a%20b.woff2', root), path.join(root, 'fonts/a b.woff2'));
  }
});

test('asset resolution rejects media hosts, alternate authorities, malformed escapes, and traversal', () => {
  const root = '/app/renderer';
  for (const url of [
    'file:///private/secret', 'https://app/index.html', 'plexserver://app/index.html',
    'loomtv://remote/index.html', 'loomtv://app:80/index.html', 'loomtv://user@app/index.html',
    'loomtv://app/%2fprivate/secret', 'loomtv://app/a%2f..%2f..%2fsecret',
    'loomtv://app/%5c..%5csecret', 'loomtv://app/%00secret', 'loomtv://app/%zz', 'loomtv://app/',
  ]) assert.equal(packagedRendererAssetPath(url, root), null, url);
});

test('custom-scheme IPC trust compares the exact host and document rather than the null URL origin', () => {
  assert.equal(isExpectedAppUrl(`${PACKAGED_RENDERER_URL}#/movie/one`, PACKAGED_RENDERER_URL), true);
  for (const url of ['loomtv://remote/index.html', 'loomtv://app/assets/main.js', 'loomtv://app:80/index.html', 'loomtv://user@app/index.html', 'file:///index.html']) {
    assert.equal(isExpectedAppUrl(url, PACKAGED_RENDERER_URL), false, url);
  }
  assert.equal(isExpectedAppUrl('loomtv://remote/index.html', 'loomtv://remote/index.html'), false);
  const identity = {
    senderWebContentsId: 7, mainWindowWebContentsId: 7, senderFrameIsMainFrame: true,
    senderFrameUrl: PACKAGED_RENDERER_URL, expectedAppUrl: PACKAGED_RENDERER_URL, mainWindowDestroyed: false,
  };
  assert.equal(isTrustedIpcSender(identity), true);
  assert.equal(isTrustedIpcSender({ ...identity, senderFrameIsMainFrame: false }), false);
  assert.equal(isTrustedIpcSender({ ...identity, senderWebContentsId: 8 }), false);
  assert.equal(isPackagedRendererUrl('loomtv://app:80/index.html'), false);
});

test('renderer cache wiring retains CSP, sandboxing, navigation guards, and the media handlers', () => {
  const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const window = fs.readFileSync(new URL('../src/main/windowManager.ts', import.meta.url), 'utf8');
  assert.match(main, /codeCache: scheme === 'loomtv'/);
  assert.match(main, /responseHeaders\['Content-Security-Policy'\] = \[csp\]/);
  assert.match(main, /isPackagedRendererUrl\(details.url\)/);
  assert.doesNotMatch(main, /bypassCSP: true/);
  assert.match(window, /sandbox: true/);
  assert.match(window, /webSecurity: true/);
  assert.match(window, /nodeIntegration: false/);
  assert.match(window, /on\('will-navigate', rejectUnexpectedNavigation\)/);
  assert.match(main, /protocol.handle\('plexserver', handleMediaProtocol\)/);
});

test('origin migration disables page scripts and IPC and preserves existing target preferences', () => {
  const source = fs.readFileSync(new URL('../src/main/rendererStorageMigration.ts', import.meta.url), 'utf8');
  assert.match(source, /javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true/);
  assert.doesNotMatch(source, /preload:/);
  assert.match(source, /localStorage.getItem\(key\) === null/);
  assert.match(source, /key.startsWith\('loom'\)/);
  assert.match(source, /entries.length > 256/);
  assert.match(source, /will-frame-navigate/);
  assert.match(source, /finally \{ window.destroy\(\); \}/);
});
