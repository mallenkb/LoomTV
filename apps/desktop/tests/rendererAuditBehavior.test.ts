import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { z } from 'zod';
import { isEditableShortcutTarget, isPlayerControlTarget } from '../src/components/VideoPlayer/playerControls.ts';

type Node = { type: unknown; props: Record<string, unknown> };
type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
type SearchResponse = { ok: boolean; json: () => Promise<unknown> };

function mountComponent(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}, props: Record<string, unknown> = {}, exportName = 'default') {
  const slots: Slot[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const memoState = (fn: () => unknown, deps?: unknown[]) => {
    const index = cursor++;
    if (!slots[index] || !deps || deps.some((dep, i) => dep !== slots[index].deps?.[i])) slots[index] = { deps, value: fn() };
    return slots[index].value;
  };
  const runEffect = (fn: () => void | (() => void), deps?: unknown[]) => {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !deps || deps.some((dep, i) => dep !== previous.deps?.[i])) {
      effects.push(() => {
        previous?.cleanup?.();
        const cleanup = fn();
        slots[index] = { deps, cleanup: cleanup || undefined };
      });
    }
  };
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value: unknown) => { slots[index].value = typeof value === 'function' ? (value as (current: unknown) => unknown)(slots[index].value) : value; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useMemo: memoState,
    useCallback: (fn: () => unknown, deps: unknown[]) => memoState(() => fn, deps),
    useEffect: runEffect,
    useLayoutEffect: runEffect,
    createContext: () => ({ Provider: 'provider' }),
  };
  const jsx = (type: unknown, elementProps: Record<string, unknown>) => ({ type, props: elementProps });
  const imports = { react: { ...react, default: react }, 'react/jsx-runtime': { jsx, jsxs: jsx }, ...mocks };
  const exports: Record<string, (props: Record<string, unknown>) => Node> = {};
  const compiled = ts.transpileModule(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { exports, AbortController, URL, console, ...globals, require: (id: string) => {
    assert.ok(id in imports, `Unexpected import ${id}`);
    return imports[id as keyof typeof imports];
  } });
  function nodes(node: unknown): Node[] {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== 'object' || !('props' in node)) return [];
    const element = node as Node;
    return [element, ...nodes(element.props.children)];
  }
  return {
    render() {
      cursor = 0;
      effects = [];
      const result = exports[exportName](props);
      effects.forEach(effect => effect());
      return nodes(result);
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('late progress hydration failure cannot replace a new profile and refresh cannot overtake writes', async () => {
  type Progress = { position: number; duration: number; updatedAt: number; watched: boolean };
  const reads: ReturnType<typeof deferred<Record<string, Progress>>>[] = [];
  const writes: ReturnType<typeof deferred<Progress>>[] = [];
  const api = {
    getProgress() { const request = deferred<Record<string, Progress>>(); reads.push(request); return request.promise; },
    saveProgress() { const request = deferred<Progress>(); writes.push(request); return request.promise; },
  };
  const exports = {} as typeof import('../src/lib/progress.ts');
  const storage = new Map([['loomtvProgressMigrationVersion', '1']]);
  let publications = 0;
  const mocks: Record<string, unknown> = {
    react: {}, zod: { z },
    '@tanstack/react-query': { replaceEqualDeep: (_previous: unknown, next: unknown) => next },
    '@/lib/desktopApi': { desktopApi: api },
    '@/lib/desktopDecoders': { parseStoredValue: (_raw: unknown, _schema: unknown, fallback: unknown) => fallback },
    '@/lib/progressSubscription': { createProgressRefreshSubscription: () => ({ publish: () => { publications++; } }) },
  };
  const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/progress.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    exports, Event, URL,
    window: { dispatchEvent: () => undefined },
    localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    require: (id: string) => { assert.ok(id in mocks); return mocks[id]; },
  });
  const old = exports.setProgressProfile('old');
  const current = exports.setProgressProfile('current');
  const stored = { position: 30, duration: 100, updatedAt: 1, watched: false };
  reads[1].resolve({ movie: stored });
  await current;
  const published = publications;
  reads[0].reject(new Error('old failure'));
  await old;
  assert.equal(publications, published);
  assert.equal(exports.getProgressState('movie').position, 30);
  const refresh = exports.refreshProgressFromDatabase();
  const write = exports.saveProgress('movie', 50, 100);
  reads[2].resolve({ movie: { ...stored, position: 80, updatedAt: Date.now() + 100_000 } });
  await refresh;
  assert.equal(exports.getProgressState('movie').position, 50);
  writes[0].resolve({ ...stored, position: 50, updatedAt: 2 });
  await write;
  const beforeReset = exports.refreshProgressFromDatabase();
  const reset = exports.resetProgress(['movie']);
  writes[1].resolve({ ...stored, position: 0, updatedAt: 3 });
  await reset;
  reads[3].resolve({ movie: { ...stored, position: 80, updatedAt: Date.now() + 100_000 } });
  await beforeReset;
  assert.equal(exports.getProgressState('movie').position, 0);
});

test('marker loads and post-write refreshes stay with the selected episode', async () => {
  const requests: { selection: { episode: number }; result: ReturnType<typeof deferred<unknown[]>> }[] = [];
  const mutation = deferred<void>();
  const streams: string[] = [];
  const panel = mountComponent('pages/SkipTimestampManager.tsx', {
    '@/components/ui/button': { Button: 'button' },
    '@/lib/desktopApi': { desktopApi: {
      getLibrary: async () => ({ movies: [], tvShows: [{ id: 'show', title: 'Show', type: 'tv', filePath: '/show', episodeFiles: [{ season: 1, episode: 1, filePath: '/one.mp4' }, { season: 1, episode: 2, filePath: '/two.mp4' }] }] }),
      setPlaybackActivity: async () => undefined,
      getManagedMediaSegments: (selection: { episode: number }) => { const result = deferred<unknown[]>(); requests.push({ selection, result }); return result.promise; },
      updateManagedMediaSegment: () => mutation.promise,
      getStreamUrl: async (file: string) => { streams.push(file); return { url: file }; },
    } },
  }, {}, { settings: { exclusions: { seasons: [] }, seasonOverrides: {} } });
  panel.render();
  await nextTurn();
  panel.render(); panel.render(); panel.render(); panel.render();
  const marker = (id: string, episode: number) => ({ id, mediaId: 'show', season: 1, episode, type: 'intro', source: 'automatic', status: 'review', confidence: 1, startMs: 0, endMs: 90000 });
  const latest = requests.at(-1);
  assert.equal(latest?.selection.episode, 1);
  latest?.result.resolve([marker('one', 1)]);
  await nextTurn();
  const approve = panel.render().find(node => node.props.children === 'Approve');
  assert.ok(approve);
  (approve.props.onClick as () => void)();
  const episode = panel.render().find(node => node.props['aria-label'] === 'Episode');
  assert.ok(episode);
  (episode.props.onChange as (event: unknown) => void)({ target: { value: '2' } });
  panel.render(); panel.render();
  requests.at(-1)?.result.resolve([marker('two', 2)]);
  await nextTurn();
  for (const request of requests.slice(0, -1)) request.result.resolve([marker('stale', 1)]);
  const count = requests.length;
  mutation.resolve();
  await nextTurn();
  assert.equal(requests.length, count);
  const edit = panel.render().find(node => node.type === 'button' && Array.isArray(node.props.children));
  assert.ok(edit);
  (edit.props.onClick as () => void)();
  const preview = panel.render().find(node => node.props.children === 'Preview');
  assert.ok(preview);
  (preview.props.onClick as () => void)();
  await nextTurn();
  assert.deepEqual(streams, ['/two.mp4']);
  panel.unmount();
});

test('remote profile polling refreshes personal state without overwriting pending or completed writes', async () => {
  let tick!: () => void;
  let cleared = false;
  let progressRefreshes = 0;
  let preferences: Record<string, unknown> = { theme: 'initial' };
  let lists: unknown[] = [];
  let delayed = false;
  const preferenceRead = deferred<Record<string, unknown>>();
  const listRead = deferred<unknown[]>();
  const preferenceWrite = deferred<Record<string, unknown>>();
  const listWrite = deferred<unknown[]>();
  const state = { profileId: 'one', automaticSignIn: true, selectionRevision: 1 };
  const panel = mountComponent('contexts/ProfileContext.tsx', {
    '@tanstack/react-query': { replaceEqualDeep: (_previous: unknown, next: unknown) => next },
    '@/lib/queryClient': { invalidateDesktopData: () => undefined, setQueryProfile: () => undefined },
    '@/components/ConfirmProvider': { useConfirm: () => undefined },
    '@/lib/playbackLifecycle': { hasActivePlayback: () => false, shutdownActivePlayback: async () => undefined },
    '@/lib/progress': { setProgressProfile: async () => undefined, flushProgressWrites: async () => undefined, refreshProgressFromDatabase: async () => { progressRefreshes++; } },
    '@/lib/desktopApi': { desktopApi: {
      listProfiles: async () => [{ id: 'one', type: 'owner' }],
      getActiveProfileState: async () => state,
      getProfilePreferences: () => delayed ? preferenceRead.promise : Promise.resolve(preferences),
      getProfileLists: () => delayed ? listRead.promise : Promise.resolve(lists),
      saveProfilePreferences: () => preferenceWrite.promise,
      setProfileListEntry: () => listWrite.promise,
      onProfilesChanged: () => () => undefined,
      onActiveProfileChanged: () => () => undefined,
      isRemoteLibraryMode: () => true,
    } },
  }, {
    window: { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => { cleared = true; }, addEventListener: () => undefined, removeEventListener: () => undefined },
    document: { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined },
  }, {}, 'ProfileProvider');
  type Value = { preferences: Record<string, unknown>; lists: { mediaId: string }[]; savePreferences: (patch: unknown) => Promise<void>; setListEntry: (id: string, kind: string, present: boolean) => Promise<void> };
  const value = () => panel.render()[0].props.value as Value;
  panel.render();
  await nextTurn();
  assert.equal(value().preferences.theme, 'initial');
  preferences = { theme: 'remote' };
  lists = [{ mediaId: 'remote', kind: 'watchlist' }];
  tick();
  await nextTurn();
  assert.equal(value().preferences.theme, 'remote');
  assert.equal(value().lists[0].mediaId, 'remote');
  assert.equal(progressRefreshes, 1);
  delayed = true;
  tick();
  await nextTurn();
  const save = value().savePreferences({ theme: 'local' });
  const saveList = value().setListEntry('local', 'watchlist', true);
  preferenceWrite.resolve({ theme: 'local' });
  listWrite.resolve([{ mediaId: 'local', kind: 'watchlist' }]);
  await Promise.all([save, saveList]);
  preferenceRead.resolve({ theme: 'stale' });
  listRead.resolve([{ mediaId: 'stale', kind: 'watchlist' }]);
  await nextTurn();
  assert.equal(value().preferences.theme, 'local');
  assert.equal(value().lists[0].mediaId, 'local');
  panel.unmount();
  assert.equal(cleared, true);
});

test('player window handlers defer controls and Escape to the topmost modal', () => {
  const source = readFileSync(new URL('../src/components/VideoPlayer.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('    const ownsPlaybackShortcut =');
  const end = source.indexOf('    return () => {', start);
  assert.ok(start > 0 && end > start);
  const handlers = new Map<string, (event: KeyboardEvent) => void>();
  let topmost = true;
  let toggles = 0;
  let seeks = 0;
  class Target {
    readonly control: boolean;
    constructor(control = false) { this.control = control; }
    closest() { return this.control ? this : null; }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Element');
  Object.defineProperty(globalThis, 'Element', { value: Target, configurable: true });
  try {
    const surface = new Target();
    const control = new Target(true);
    const document = { activeElement: surface };
    const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(compiled, {
      window: { addEventListener: (name: string, handler: (event: KeyboardEvent) => void) => handlers.set(name, handler) },
      document, containerRef: { current: surface }, isTopmostModalContent: () => topmost,
      isEditableShortcutTarget, isPlayerControlTarget,
      playerStateRef: { current: 'playing' }, togglePlay: () => { toggles++; },
      resetSurfaceDoubleClickGuard: () => undefined, seekTo: () => { seeks++; }, playbackPositionRef: { current: 0 },
    });
    const send = (key: string, target: Target = surface, type = 'keydown') => {
      let prevented = false;
      handlers.get(type)?.({ key, code: key === ' ' ? 'Space' : key, target, preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => undefined } as unknown as KeyboardEvent);
      return prevented;
    };
    for (const key of [' ', 'ArrowRight', 'Home', 'k', 'Escape']) {
      assert.equal(send(key, control), false);
      document.activeElement = control;
      assert.equal(send(key), false);
      document.activeElement = surface;
    }
    topmost = false;
    assert.equal(send(' '), false);
    assert.equal(send('Escape'), false);
    topmost = true;
    assert.equal(send('Escape'), false);
    assert.equal(send(' '), true);
    assert.equal(send(' ', surface, 'keyup'), true);
    assert.equal(send('ArrowRight'), true);
    assert.equal(toggles, 1);
    assert.equal(seeks, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'Element', original);
    else Reflect.deleteProperty(globalThis, 'Element');
  }
});

test('virtual grid remeasures after sibling layout changes and disconnects on unmount', () => {
  const source = readFileSync(new URL('../src/components/VirtualPosterGrid.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('    const root = rootRef.current;');
  const end = source.indexOf('\n  }, []);', start);
  assert.ok(start > 0 && end > start);
  let margin = 500;
  const scroller = { scrollTop: 100, getBoundingClientRect: () => ({ top: 10 }), parentElement: null };
  const content = { parentElement: scroller };
  const section = { parentElement: content };
  const root = { parentElement: section, clientWidth: 800, getBoundingClientRect: () => ({ top: margin }) };
  let geometry = { width: 0, margin: 0 };
  let measure!: () => void;
  let disconnected = false;
  const observed: unknown[] = [];
  const compiled = ts.transpileModule(`(() => {${source.slice(start, end)}\n})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const cleanup = runInNewContext(compiled, {
    rootRef: { current: root }, setContainer: () => undefined,
    getComputedStyle: (element: unknown) => ({ overflowY: element === scroller ? 'auto' : 'visible' }),
    setGeometry: (update: (current: typeof geometry) => typeof geometry) => { geometry = update(geometry); },
    ResizeObserver: class {
      constructor(callback: () => void) { measure = callback; }
      observe(element: unknown) { observed.push(element); }
      disconnect() { disconnected = true; }
    },
  }) as () => void;
  assert.equal(geometry.margin, 590);
  assert.ok(observed.includes(content));
  margin = 900;
  measure();
  assert.equal(geometry.margin, 990);
  cleanup();
  assert.equal(disconnected, true);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`Archive search ignores stale ${outcome} and finally while a newer page loads`, async () => {
    const requests: { result: ReturnType<typeof deferred<SearchResponse>>; signal: AbortSignal }[] = [];
    let debounce!: () => void;
    const panel = mountComponent('pages/ArchiveOrgAddon.tsx', {
      '@tanstack/react-router': { useParams: () => ({ addonId: 'org.archive.clean' }) },
      'lucide-react': {},
      zod: { z },
      '@/components/SafeArtwork': {},
      '@/components/LibrarySearch': {},
      '@/components/ContentShimmer': { PosterGridShimmer: 'loading' },
      '@/components/ThemeProvider': { useTheme: () => ({ theme: {} }) },
      '@/lib/desktopApi': { desktopApi: { listAvailableStremioPlugins: async () => [{ addonId: 'org.archive.clean', state: 'enabled', trusted: true }] } },
    }, {
      window: { setTimeout: (fn: () => void) => { debounce = fn; return 1; }, clearTimeout: () => undefined },
      fetch: (_url: string, options: { signal: AbortSignal }) => {
        const result = deferred<SearchResponse>();
        requests.push({ result, signal: options.signal });
        return result.promise;
      },
    });
    panel.render();
    await nextTurn();
    const search = (value: string) => {
      const input = panel.render().find(node => node.props.placeholder === 'Search public-domain movies');
      assert.ok(input);
        (input.props.onChange as (value: string) => void)(value);
      panel.render();
      debounce();
      panel.render();
    };
    search('current');
    await nextTurn();
    assert.equal(requests[0].signal.aborted, true);
    if (outcome === 'success') requests[0].result.resolve({ ok: true, json: async () => ({ response: { docs: [{ identifier: 'stale' }], numFound: 1 } }) });
    else requests[0].result.reject(new Error('stale failure'));
    await nextTurn();
    assert.ok(panel.render().some(node => node.type === 'loading'));
    assert.equal(panel.render().some(node => node.props.role === 'alert'), false);
    requests[1].result.resolve({ ok: true, json: async () => ({ response: { docs: [{ identifier: 'current' }], numFound: 1 } }) });
    await nextTurn();
    assert.ok(panel.render().some(node => node.props['aria-label'] === 'Play current'));
    assert.equal(panel.render().some(node => node.props['aria-label'] === 'Play stale'), false);
    search('unmounted');
    await nextTurn();
    panel.unmount();
    assert.equal(requests[2].signal.aborted, true);
    requests[2].result.reject(new Error('unmounted'));
    await nextTurn();
  });
}
