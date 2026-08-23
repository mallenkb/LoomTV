import assert from 'node:assert/strict';
import test from 'node:test';
import { CanonicalTvClient } from '../src/canonical-client.ts';

test('TV client rejects cleartext server addresses', () => {
  assert.throws(() => new CanonicalTvClient('http://192.168.1.8:3848'), /HTTPS/);
});

test('TV client resolves capability URLs without exposing server paths', () => {
  const client = new CanonicalTvClient('https://loomtv.local:3848');
  assert.equal(client.absoluteUrl('/api/v1/media/id/direct?token=cap'), 'https://loomtv.local:3848/api/v1/media/id/direct?token=cap');
});
