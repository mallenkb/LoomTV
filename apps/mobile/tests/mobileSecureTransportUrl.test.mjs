import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeLoopbackProxyBaseUrl,
  rewriteSecureLanUrl,
} from '../mobileSecureTransportUrl.ts';

test('secure LAN rewriting preserves the native loopback session secret', () => {
  const proxyBaseUrl = normalizeLoopbackProxyBaseUrl('http://localhost:49412/abc123');
  assert.equal(
    rewriteSecureLanUrl(
      'https://192.168.68.66:3848/api/v2/pair?mode=approval#result',
      'https://192.168.68.66:3848',
      proxyBaseUrl,
    ),
    'http://localhost:49412/abc123/api/v2/pair?mode=approval#result',
  );
});

test('secure LAN rewriting rejects untrusted proxies and leaves other hosts untouched', () => {
  assert.throws(
    () => normalizeLoopbackProxyBaseUrl('http://localhost:49412/'),
    /invalid loopback endpoint/,
  );
  assert.throws(
    () => normalizeLoopbackProxyBaseUrl('https://example.com/abc123'),
    /invalid loopback endpoint/,
  );
  assert.equal(
    rewriteSecureLanUrl(
      'https://other.local:3848/api/v2/library',
      'https://desktop.local:3848',
      'http://127.0.0.1:49412/abc123',
    ),
    'https://other.local:3848/api/v2/library',
  );
});
