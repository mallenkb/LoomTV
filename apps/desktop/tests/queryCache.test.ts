import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test, { afterEach } from 'node:test';
import { QueryObserver } from '@tanstack/react-query';

// Exercise the production cache and installed TanStack implementation. Only
// browser storage access is replaced, so tests do not touch user profiles.
const scope = { mode: 'host', session: null as null | { baseUrl: string; deviceId: string; selectionRevision: number } };
const scopeKey = Symbol.for('loomtv.query-cache-test.scope');
Object.defineProperty(globalThis, scopeKey, { value: scope, configurable: true });
const moduleUrl = new URL('../src/lib/queryClient.ts', import.meta.url).href;
const stubUrl = `data:text/javascript,${encodeURIComponent(`
  const scope = globalThis[Symbol.for('loomtv.query-cache-test.scope')];
  export const getDesktopLibraryMode = () => scope.mode;
  export const getRemoteDesktopSession = () => scope.session;
`)}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === moduleUrl && specifier === './remoteDesktop') {
      return { url: stubUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { queryClient, trimQueryCache, cachedDesktopRead, invalidateDesktopData, setQueryProfile, queryScope } =
  await import('../src/lib/queryClient.ts');
hooks.deregister();

// Each test clears its cache explicitly. Browser GC timers can otherwise keep
// Node alive after cancelled queries have already left the cache.
const defaults = queryClient.getDefaultOptions();
queryClient.setDefaultOptions({
  ...defaults,
  queries: { ...defaults.queries, gcTime: Infinity },
});

afterEach(() => {
  queryClient.clear();
  setQueryProfile(null);
  scope.mode = 'host';
  scope.session = null;
  queryScope();
});

function seed(count: number, families = 1): void {
  for (let index = 0; index < count; index += 1) {
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: [families === 1 ? 'detail' : `family-${index % families}`, index],
    });
    // Avoid success notifications while preparing a burst for explicit trimming.
    query.setState({ data: index, dataUpdatedAt: index + 1, status: 'success', fetchStatus: 'idle' });
  }
}

test('family trimming retains the newest 24 inactive detail results', () => {
  seed(100);
  trimQueryCache();
  assert.equal(queryClient.getQueryCache().getAll().length, 24);
  assert.equal(queryClient.getQueryData(['detail', 75]), undefined);
  assert.equal(queryClient.getQueryData(['detail', 76]), 76);
  assert.equal(queryClient.getQueryData(['detail', 99]), 99);
});

test('global trimming caps independent inactive families at 160 results', () => {
  seed(300, 10);
  trimQueryCache();
  assert.equal(queryClient.getQueryCache().getAll().length, 160);
});

test('trimming removes known query objects without repeated full-cache matching', () => {
  seed(300);
  const cache = queryClient.getQueryCache();
  const original = cache.findAll;
  let scans = 0;
  cache.findAll = function (...args) {
    scans += 1;
    return original.apply(this, args);
  };
  try {
    trimQueryCache();
    assert.equal(scans, 0);
    assert.equal(cache.getAll().length, 24);
  } finally {
    cache.findAll = original;
  }
});

test('an observed result larger than 8 MiB does not evict unrelated inactive data', () => {
  const observer = new QueryObserver(queryClient, { queryKey: ['active'], enabled: false });
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    queryClient.setQueryData(['active'], 'x'.repeat(5 * 1024 * 1024));
    queryClient.setQueryData(['detail', 'small'], { title: 'Keep this result' });
    trimQueryCache();
    assert.ok(queryClient.getQueryData(['active']));
    assert.deepEqual(queryClient.getQueryData(['detail', 'small']), { title: 'Keep this result' });
  } finally {
    unsubscribe();
  }
});

test('inactive byte pressure evicts older data and retains the newest affordable result', () => {
  queryClient.setQueryData(['detail', 'old'], 'x'.repeat(3 * 1024 * 1024), { updatedAt: 1 });
  queryClient.setQueryData(['detail', 'new'], 'y'.repeat(3 * 1024 * 1024), { updatedAt: 2 });
  assert.equal(queryClient.getQueryData(['detail', 'old']), undefined);
  assert.ok(queryClient.getQueryData(['detail', 'new']));
});

test('concurrent identical reads are deduplicated and fresh results are reused', async () => {
  let calls = 0;
  const read = async () => { calls += 1; await nextTurn(); return { title: 'Cached' }; };
  const values = await Promise.all(Array.from({ length: 20 }, () => cachedDesktopRead('detail', ['same'], read)));
  assert.equal(calls, 1);
  assert.equal(values.length, 20);
  await cachedDesktopRead('detail', ['same'], read);
  assert.equal(calls, 1);
});

test('profile changes do not reuse the previous profile result', async () => {
  setQueryProfile('one');
  assert.equal(await cachedDesktopRead('detail', ['same'], async () => 'one'), 'one');
  setQueryProfile('two');
  assert.equal(await cachedDesktopRead('detail', ['same'], async () => 'two'), 'two');
});

test('remote server and selection changes do not reuse local or prior remote results', async () => {
  assert.equal(await cachedDesktopRead('detail', ['same'], async () => 'local'), 'local');
  scope.mode = 'remote';
  scope.session = { baseUrl: 'https://example.test', deviceId: 'device', selectionRevision: 1 };
  assert.equal(await cachedDesktopRead('detail', ['same'], async () => 'remote-one'), 'remote-one');
  scope.session.selectionRevision = 2;
  assert.equal(await cachedDesktopRead('detail', ['same'], async () => 'remote-two'), 'remote-two');
});

test('targeted invalidation preserves unrelated cached families', async () => {
  await cachedDesktopRead('detail', [1], async () => 'detail');
  await cachedDesktopRead('getProfileLists', [], async () => 'lists');
  invalidateDesktopData(['getProfileLists']);
  let detailCalls = 0;
  assert.equal(await cachedDesktopRead('detail', [1], async () => { detailCalls += 1; return 'changed'; }), 'detail');
  assert.equal(detailCalls, 0);
  assert.equal(await cachedDesktopRead('getProfileLists', [], async () => 'updated'), 'updated');
});

test('expensive reads are limited to four and cancelled queued reads never reach the backend', async () => {
  const releases: Array<() => void> = [];
  let started = 0;
  const read = () => new Promise<number>(resolve => {
    started += 1;
    releases.push(() => resolve(started));
  });
  const reads = Array.from({ length: 8 }, (_, index) => cachedDesktopRead('getThumbnail', [index], read));
  const settled = Promise.allSettled(reads);
  await nextTurn();
  assert.equal(started, 4);
  invalidateDesktopData(['getThumbnail']);
  releases.forEach(release => release());
  await settled;
  await nextTurn();
  assert.equal(started, 4);
  assert.equal(await cachedDesktopRead('getThumbnail', ['next'], async () => 'ready'), 'ready');
});

// Run explicitly with LOOMTV_QUERY_CACHE_BENCHMARK=1, not on every unit-test run.
test('cleanup benchmark compares repeated matching with direct eviction', {
  skip: process.env.LOOMTV_QUERY_CACHE_BENCHMARK !== '1',
}, t => {
  const samples: Array<{ entries: number; matchingMs: number; directMs: number }> = [];
  for (const entries of [160, 1_000, 5_000]) {
    const timings: number[][] = [[], []];
    for (let round = 0; round < 5; round += 1) {
      for (const strategy of [0, 1]) {
        queryClient.clear();
        seed(entries);
        const start = performance.now();
        if (strategy === 0) {
          const idle = queryClient.getQueryCache().getAll()
            .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
          for (const query of idle.slice(24)) {
            queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
          }
        } else {
          trimQueryCache();
        }
        timings[strategy].push(performance.now() - start);
        assert.equal(queryClient.getQueryCache().getAll().length, 24);
      }
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    samples.push({ entries, matchingMs: median(timings[0]), directMs: median(timings[1]) });
  }
  // Timing is diagnostic, not a flaky hardware-dependent pass threshold.
  t.diagnostic(JSON.stringify({ node: process.version, cleanupBenchmark: samples }));
});
