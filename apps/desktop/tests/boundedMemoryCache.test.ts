import assert from 'node:assert/strict';
import test from 'node:test';
import { IdleValueCache, MemoryLruCache } from '../src/main/boundedMemoryCache.ts';

test('full catalog reference expires without another read or a GC request', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cache = new IdleValueCache<object>(30_000);
  const catalog = { movies: [1, 2, 3] };
  cache.value = catalog;
  t.mock.timers.tick(29_999);
  assert.equal(cache.peek(), catalog);
  t.mock.timers.tick(1);
  assert.equal(cache.peek(), null);
});

test('catalog reads renew retention, but inspection does not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cache = new IdleValueCache<object>(100);
  const catalog = {};
  cache.value = catalog;
  t.mock.timers.tick(75);
  assert.equal(cache.value, catalog);
  t.mock.timers.tick(75);
  assert.equal(cache.peek(), catalog);
  t.mock.timers.tick(25);
  assert.equal(cache.peek(), null);
});

test('replacing a cached catalog cancels its old expiry timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cache = new IdleValueCache<number>(100);
  cache.value = 1;
  t.mock.timers.tick(80);
  cache.value = 2;
  t.mock.timers.tick(20);
  assert.equal(cache.peek(), 2);
  t.mock.timers.tick(80);
  assert.equal(cache.peek(), null);
});

test('eviction does not mutate an in-flight scan snapshot', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cache = new IdleValueCache<{ movies: number[] }>(100);
  cache.value = { movies: [1] };
  const snapshot = cache.value;
  t.mock.timers.tick(100);
  assert.equal(cache.peek(), null);
  assert.deepEqual(snapshot, { movies: [1] });
});

test('null and explicit clearing remove retained references', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cache = new IdleValueCache<number>(100);
  cache.value = 1;
  cache.clear();
  assert.equal(cache.peek(), null);
  cache.value = 2;
  cache.value = null;
  t.mock.timers.tick(1000);
  assert.equal(cache.peek(), null);
});

test('recent details obey the entry limit and promote accessed entries', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cache = new MemoryLruCache<string, number>({ maxEntries: 2, maxBytes: 100, idleMs: 1000 });
  cache.set('a', 1, 10);
  cache.set('b', 2, 10);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3, 10);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.size, 2);
  cache.clear();
});

test('detail byte limit evicts old entries; an oversized item is not retained', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cache = new MemoryLruCache<string, number>({ maxEntries: 50, maxBytes: 100, idleMs: 1000 });
  cache.set('a', 1, 60);
  cache.set('b', 2, 60);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.estimatedBytes, 60);
  assert.equal(cache.set('huge', 3, 101), false);
  assert.equal(cache.size, 1);
  cache.clear();
});

test('replacing an entry accounts for bytes once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cache = new MemoryLruCache<string, number>({ maxEntries: 2, maxBytes: 100, idleMs: 1000 });
  cache.set('a', 1, 80);
  cache.set('a', 2, 20);
  assert.equal(cache.estimatedBytes, 20);
  assert.equal(cache.get('a'), 2);
  assert.equal(cache.set('a', 3, 200), false);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.estimatedBytes, 0);
});

test('unused details expire even if no further request arrives', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cache = new MemoryLruCache<string, number>({ maxEntries: 2, maxBytes: 100, idleMs: 100 });
  cache.set('a', 1, 20);
  t.mock.timers.tick(50);
  cache.set('b', 2, 30);
  t.mock.timers.tick(50);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.estimatedBytes, 30);
  t.mock.timers.tick(50);
  assert.equal(cache.size, 0);
  assert.equal(cache.estimatedBytes, 0);
});

test('cache keys isolate profiles, catalog revisions and individual items', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cache = new MemoryLruCache<string, number>({ maxEntries: 10, maxBytes: 100, idleMs: 1000 });
  cache.set(JSON.stringify(['owner', 1, 'movie']), 1, 10);
  assert.equal(cache.get(JSON.stringify(['child', 1, 'movie'])), undefined);
  assert.equal(cache.get(JSON.stringify(['owner', 2, 'movie'])), undefined);
  assert.equal(cache.get(JSON.stringify(['owner', 1, 'other'])), undefined);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('invalid limits and byte estimates fail without creating timers', () => {
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => new IdleValueCache(bad), RangeError);
  assert.throws(() => new MemoryLruCache({ maxEntries: 0, maxBytes: 100, idleMs: 100 }), RangeError);
  const cache = new MemoryLruCache({ maxEntries: 2, maxBytes: 100, idleMs: 100 });
  for (const bad of [-1, NaN, Infinity, 0.5]) assert.throws(() => cache.set('a', 1, bad), RangeError);
  assert.equal(cache.size, 0);
});
