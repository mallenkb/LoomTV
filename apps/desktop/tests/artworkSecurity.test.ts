import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectArtworkBytes, artworkNegativeCacheAllows, rememberArtworkFailure } from '../src/main/artworkSecurity.ts';

test('artwork security rejects SVG, unknown signatures, and animated image containers', () => {
  assert.throws(() => inspectArtworkBytes(Buffer.from('<svg/>'), 'image/svg+xml'), /SVG/);
  assert.throws(() => inspectArtworkBytes(Buffer.from('not-an-image'), 'image/png'), /signature/);
  assert.throws(() => inspectArtworkBytes(Buffer.from('GIF89a'), 'image/gif'), /signature|incomplete|frame/);
});

test('artwork failures are negatively cached for the bounded retry window', () => {
  const source = 'https://images.example/bad.webp';
  assert.equal(artworkNegativeCacheAllows(source, 100), true);
  rememberArtworkFailure(source, 100);
  assert.equal(artworkNegativeCacheAllows(source, 101), false);
  assert.equal(artworkNegativeCacheAllows(source, 100 + 5 * 60 * 1000 + 1), true);
});
