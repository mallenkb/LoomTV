import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import * as ts from 'typescript';

const scope = {
  api: { getThumbnail: async (_file: string, time: string, _preview: boolean) => ({ url: time }) },
};
const scopeKey = Symbol.for('loomtv.seek-preview-cache-test.scope');
Object.defineProperty(globalThis, scopeKey, { value: scope, configurable: true });
const cacheUrl = new URL('../src/components/VideoPlayer/SeekPreviewCache.ts', import.meta.url).href;
const stubUrl = `data:text/javascript,${encodeURIComponent(`
  export const desktopApi = globalThis[Symbol.for('loomtv.seek-preview-cache-test.scope')].api;
`)}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === cacheUrl && specifier === '@/lib/desktopApi') {
      return { url: stubUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== cacheUrl) return nextLoad(url, context);
    return {
      format: 'module',
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      shortCircuit: true,
    };
  },
});
const { default: SeekPreviewCache } = await import('../src/components/VideoPlayer/SeekPreviewCache.ts');
hooks.deregister();

class MockImage {
  static instances: MockImage[] = [];
  decoding = '';
  naturalWidth = 1024;
  naturalHeight = 1024;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  removed = false;
  private value = '';

  constructor() { MockImage.instances.push(this); }
  set src(value: string) { this.value = value; }
  get src() { return this.value; }
  removeAttribute(name: string) {
    assert.equal(name, 'src');
    this.removed = true;
    this.value = '';
  }
  decode() { return Promise.resolve(); }
  load() { this.onload?.(); }
}

globalThis.Image = MockImage as unknown as typeof Image;

const settle = async () => { await nextTurn(); };

test('preview retention stays within the decoded byte limit and releases evicted images', async () => {
  const requests: string[] = [];
  scope.api.getThumbnail = async (_file, time, preview) => {
    assert.equal(preview, true);
    requests.push(time);
    return { url: time };
  };
  MockImage.instances = [];
  const cache = new SeekPreviewCache('/movie.mp4', 100, () => undefined);
  try {
    cache.request(0);
    for (let count = 0; count < 2; count += 1) {
      await settle();
      MockImage.instances.at(-1)?.load();
      await settle();
    }
    assert.deepEqual(requests, ['0', '2']);

    cache.request(20);
    for (let count = 0; count < 3; count += 1) {
      await settle();
      MockImage.instances.at(-1)?.load();
      await settle();
    }
    assert.deepEqual(requests, ['0', '2', '20', '22', '18']);
    assert.equal(MockImage.instances.filter((image) => !image.removed).length, 2);
    assert.equal(MockImage.instances[0].removed, true);
    assert.equal(cache.nearest(0)?.frame, 18);
  } finally {
    cache.dispose();
  }
  assert.equal(MockImage.instances.filter((image) => !image.removed).length, 0);
});

test('disposing during image loading cancels it and stops further preview work', async () => {
  const requests: string[] = [];
  let changes = 0;
  scope.api.getThumbnail = async (_file, time) => {
    requests.push(time);
    return { url: time };
  };
  MockImage.instances = [];
  const cache = new SeekPreviewCache('/movie.mp4', 100, () => { changes += 1; });
  cache.request(10);
  await settle();
  assert.deepEqual(requests, ['10']);
  const image = MockImage.instances[0];
  assert.equal(image.src, '10');

  cache.dispose();
  await settle();
  image.load();
  await settle();
  cache.request(40);
  assert.equal(image.removed, true);
  assert.equal(cache.nearest(10), null);
  assert.equal(changes, 0);
  assert.deepEqual(requests, ['10']);
});

test('a new drag target replaces queued frames after the active extraction finishes', async () => {
  const requests: string[] = [];
  scope.api.getThumbnail = async (_file, time) => {
    requests.push(time);
    return { url: time };
  };
  MockImage.instances = [];
  const cache = new SeekPreviewCache('/movie.mp4', 100, () => undefined);
  cache.request(0);
  await settle();
  cache.request(20);
  cache.request(30);
  assert.deepEqual(requests, ['0']);

  MockImage.instances[0].load();
  await settle();
  assert.deepEqual(requests, ['0', '30']);
  cache.dispose();
});
