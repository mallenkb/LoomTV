import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStremioItemId, stremioItemId } from '../src/main/stremioPluginWire.ts';

test('Discover item identity remains addon and type namespaced at the host boundary', () => {
  const id = stremioItemId('org.example.catalog', 'movie', 'tt123');
  assert.deepEqual(parseStremioItemId(id), {
    addonId: 'org.example.catalog',
    type: 'movie',
    providerId: 'tt123',
  });
  assert.equal(parseStremioItemId(stremioItemId('org.example.catalog', 'series', 'tt123'))?.type, 'series');
  assert.equal(parseStremioItemId('tt123'), null);
});
