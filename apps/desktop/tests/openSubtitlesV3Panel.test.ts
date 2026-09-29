import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import * as subtitles from '../src/lib/openSubtitlesV3.ts';

// Run the real component handlers with hook storage and JSX objects, without a DOM.
// These tests cover async state ownership, not React rendering or visual layout.
const compiled = ts.transpileModule(readFileSync(new URL('../src/components/VideoPlayer/OpenSubtitlesV3Panel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Element = { type: string; props: Record<string, unknown> };
type Props = {
  resolveVideo: () => Promise<subtitles.SubtitleVideo>;
  onSelect: (subtitle: subtitles.OnlineSubtitle, text: string, signal: AbortSignal) => Promise<void>;
};

function mount(props: Props, overrides: Partial<typeof subtitles> = {}) {
  const slots: unknown[] = [];
  const cleanups: (() => void)[] = [];
  let cursor = 0;
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: unknown) => { slots[index] = value; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo: (compute: () => unknown) => compute(),
    useEffect(effect: () => () => void) {
      const index = cursor++;
      if (!(index in slots)) { slots[index] = true; cleanups.push(effect()); }
    },
  };
  const jsx = (type: string, elementProps: Record<string, unknown>) => ({ type, props: elementProps });
  const mocks: Record<string, unknown> = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': { Check: 'check-icon', Search: 'search-icon' },
    '../../lib/openSubtitlesV3': { ...subtitles, ...overrides },
  };
  const exports: { default?: (props: Props) => Element } = {};
  runInNewContext(compiled, { exports, AbortController, require: (id: string) => {
    assert.ok(id in mocks, `Unexpected import ${id}`);
    return mocks[id];
  } });
  const render = () => {
    cursor = 0;
    assert.ok(exports.default);
    return exports.default(props);
  };
  function elements(node: unknown): Element[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!node || typeof node !== 'object' || !('props' in node)) return [];
    const element = node as Element;
    return [element, ...elements(element.props.children)];
  }
  return {
    nodes: () => elements(render()),
    click(label: string) {
      const button = elements(render()).find(node => node.type === 'button'
        && (node.props.children === label || node.props['aria-label'] === label || label === 'result' && 'aria-pressed' in node.props));
      assert.ok(button, `Missing button ${label}`);
      assert.equal(Boolean(button.props.disabled), false);
      (button.props.onClick as () => void)();
    },
    unmount: () => { for (const cleanup of cleanups) cleanup(); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const video = { imdbId: 'tt0133093', type: 'movie' as const };
const subtitle: subtitles.OnlineSubtitle = {
  id: 'one', url: 'https://subs5.strem.io/en/download/file/1', language: 'eng', name: 'Movie.srt', source: 'OpenSubtitles v3',
};

test('cancel during identity lookup prevents the provider search', async () => {
  const identity = deferred<subtitles.SubtitleVideo>();
  let searches = 0;
  const panel = mount({ resolveVideo: () => identity.promise, onSelect: async () => undefined }, {
    findOnlineSubtitles: async () => { searches++; return []; },
  });
  panel.click('Find online subtitles');
  panel.click('Cancel subtitle search');
  identity.resolve(video);
  await setImmediate();
  assert.equal(searches, 0);
  assert.equal(panel.nodes().some(node => node.props['aria-label'] === 'Cancel subtitle search'), false);
  panel.unmount();
});

test('cancelled search cannot replace a newer search or clear its loading state', async () => {
  const old = deferred<subtitles.OnlineSubtitle[]>();
  const current = deferred<subtitles.OnlineSubtitle[]>();
  let searches = 0;
  const panel = mount({ resolveVideo: async () => video, onSelect: async () => undefined }, {
    findOnlineSubtitles: () => ++searches === 1 ? old.promise : current.promise,
  });
  panel.click('Find online subtitles');
  await setImmediate();
  panel.click('Cancel subtitle search');
  panel.click('Find online subtitles');
  await setImmediate();
  old.resolve([subtitle]);
  await setImmediate();
  assert.ok(panel.nodes().some(node => node.props['aria-label'] === 'Cancel subtitle search'));
  assert.equal(panel.nodes().some(node => node.props.children === subtitle.name), false);
  current.resolve([]);
  await setImmediate();
  assert.ok(panel.nodes().some(node => node.props.children === 'No subtitles found for this title.'));
  panel.unmount();
});

for (const action of ['cancel', 'unmount'] as const) {
  test(`${action} suppresses a late download and selection`, async () => {
    const download = deferred<string>();
    let selections = 0;
    let signal: AbortSignal | undefined;
    const panel = mount({ resolveVideo: async () => video, onSelect: async () => { selections++; } }, {
      findOnlineSubtitles: async () => [subtitle],
      downloadOnlineSubtitle: (_subtitle, requestSignal) => { signal = requestSignal; return download.promise; },
    });
    panel.click('Find online subtitles');
    await setImmediate();
    panel.click('result');
    if (action === 'cancel') panel.click('Cancel subtitle download');
    else panel.unmount();
    assert.equal(signal?.aborted, true);
    download.resolve('late timed text');
    await setImmediate();
    assert.equal(selections, 0);
    if (action === 'cancel') panel.unmount();
  });
}

test('cancel reaches a selection callback already awaiting the native engine', async () => {
  const engine = deferred<void>();
  let signal: AbortSignal | undefined;
  let applied = false;
  const panel = mount({
    resolveVideo: async () => video,
    onSelect: async (_subtitle, _text, requestSignal) => {
      signal = requestSignal;
      await engine.promise;
      if (!requestSignal.aborted) applied = true;
    },
  }, { findOnlineSubtitles: async () => [subtitle], downloadOnlineSubtitle: async () => 'timed text' });
  panel.click('Find online subtitles');
  await setImmediate();
  panel.click('result');
  await setImmediate();
  panel.click('Cancel subtitle download');
  assert.equal(signal?.aborted, true);
  engine.resolve();
  await setImmediate();
  assert.equal(applied, false);
  panel.unmount();
});
