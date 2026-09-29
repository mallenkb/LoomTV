import assert from 'node:assert/strict';
import test from 'node:test';
import { publicCatalog } from '../src/public-catalog.js';

const serialize = ({ id, kind, title, seriesId, updatedAt }) => ({ id, kind, title, seriesId, updatedAt });

test('catalog revisions change when an older title disappears', () => {
  const latest = { id: 'new', kind: 'movie', title: 'New', updatedAt: 100 };
  const older = { id: 'old', kind: 'movie', title: 'Old', updatedAt: 1 };
  assert.notEqual(publicCatalog([latest, older], serialize).etag, publicCatalog([latest], serialize).etag);
  assert.equal(publicCatalog([latest], serialize).revision, publicCatalog([latest], serialize).revision);
});

test('series are unique and private fields never enter the catalog', () => {
  const catalog = publicCatalog([
    { id: 'show', kind: 'series', title: 'Show', path: '/private/show' },
    { id: 'episode', kind: 'episode', seriesId: 'show', series: { title: 'Show' }, path: '/private/episode' },
  ], serialize);
  assert.equal(catalog.items.filter((item) => item.id === 'show').length, 1);
  assert.equal(catalog.items.find((item) => item.id === 'episode').seriesId, 'show');
  assert.equal(JSON.stringify(catalog).includes('/private'), false);
});

test('legacy episodes receive a stable synthetic series identity', () => {
  const catalog = publicCatalog([{ id: 'episode', kind: 'episode', series: { title: 'A Show' } }], serialize);
  const episode = catalog.items.find((item) => item.id === 'episode');
  assert.equal(episode.seriesId, 'series:a%20show');
  assert.equal(catalog.items.find((item) => item.id === episode.seriesId).kind, 'series');
});
