import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cachedArtworkResponseHeaders,
  collectArtworkSourcesForCache,
  artworkCacheFileName,
  customArtworkReference,
  parseCustomArtworkReference,
} from '../src/main/artworkCache.ts';

test('artwork cache keeps bounded title fallbacks and every local episode still', () => {
  const sources = collectArtworkSourcesForCache({
    movies: [{
      poster: 'https://images.example/poster-primary.jpg',
      backdrop: 'https://images.example/backdrop-primary.jpg',
      logo: 'https://images.example/logo-primary.png',
      posterCandidates: [
        'https://images.example/poster-primary.jpg',
        'https://images.example/poster-alt-1.jpg',
        'https://images.example/poster-alt-2.jpg',
        'https://images.example/poster-alt-3.jpg',
      ],
      backdropCandidates: [
        'https://images.example/backdrop-alt-1.jpg',
        'https://images.example/backdrop-alt-2.jpg',
        'https://images.example/backdrop-alt-3.jpg',
      ],
      logoCandidates: [
        'https://images.example/logo-primary.png',
        'https://images.example/logo-alt-1.png',
        'https://images.example/logo-alt-2.png',
        'https://images.example/logo-alt-3.png',
      ],
      episodes: Array.from({ length: 8 }, (_, index) => ({
        still: `https://images.example/episode-${index + 1}.jpg`,
      })),
    }],
  });

  assert.deepEqual(sources, [
    'https://images.example/poster-primary.jpg',
    'https://images.example/backdrop-primary.jpg',
    'https://images.example/logo-primary.png',
    'https://images.example/poster-alt-1.jpg',
    'https://images.example/backdrop-alt-1.jpg',
    'https://images.example/backdrop-alt-2.jpg',
    'https://images.example/logo-alt-1.png',
    'https://images.example/episode-1.jpg',
    'https://images.example/episode-2.jpg',
    'https://images.example/episode-3.jpg',
    'https://images.example/episode-4.jpg',
    'https://images.example/episode-5.jpg',
    'https://images.example/episode-6.jpg',
    'https://images.example/episode-7.jpg',
    'https://images.example/episode-8.jpg',
  ]);
});

test('artwork cache ignores inline, local, and loopback artwork sources', () => {
  const sources = collectArtworkSourcesForCache({
    movies: [{
      poster: 'data:image/png;base64,abc',
      backdrop: 'http://127.0.0.1:3000/api/thumbnail',
      logo: 'file:///Users/example/logo.png',
      posterCandidates: ['https://images.example/poster.jpg'],
      backdropCandidates: ['http://localhost:3000/api/local-image'],
      logoCandidates: ['https://images.example/logo.png'],
    }],
  });

  assert.deepEqual(sources, [
    'https://images.example/poster.jpg',
    'https://images.example/logo.png',
  ]);
});

test('cached artwork responses are not duplicated into Chromium HTTP cache', () => {
  assert.deepEqual(cachedArtworkResponseHeaders('image/png', 1024), {
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store',
    'Content-Length': 1024,
  });
});

test('custom artwork references keep database artwork out of renderer state', () => {
  const reference = customArtworkReference('movie:/Library/Marty Supreme.mkv', 'thumbnail');

  assert.equal(reference, 'loomtv-custom-artwork://artwork/movie%3A%2FLibrary%2FMarty%20Supreme.mkv/thumbnail');
  assert.deepEqual(parseCustomArtworkReference(reference), {
    mediaId: 'movie:/Library/Marty Supreme.mkv',
    target: 'thumbnail',
  });
  assert.equal(parseCustomArtworkReference('data:image/jpeg;base64,abc'), null);
});

test('disk artwork cache file names are stable and content-type aware', () => {
  assert.equal(
    artworkCacheFileName('https://images.example/poster.jpg?size=large', 'image/webp'),
    'a8f2d58f5d2bfa035bfdc0bd9101b5fd421de141b3c5843042b6c260961e6eab.webp',
  );
  assert.equal(
    artworkCacheFileName('https://images.example/poster.jpg?size=large', 'image/jpeg'),
    'a8f2d58f5d2bfa035bfdc0bd9101b5fd421de141b3c5843042b6c260961e6eab.jpg',
  );
});
