import assert from 'node:assert/strict';
import test from 'node:test';
import { cachedArtworkResponseHeaders, collectArtworkSourcesForCache } from '../src/main/artworkCache.ts';

test('artwork cache only keeps bounded external artwork fallbacks', () => {
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
