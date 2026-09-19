import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';

type Node = { type: string; props: Record<string, unknown> };
type Listener = (event: { clientX: number; buttons: number }) => void;

function mountPreview() {
  const listeners = new Map<string, Listener>();
  const slider = {
    getBoundingClientRect: () => ({ left: 10, width: 200 }),
    addEventListener: (name: string, listener: Listener) => { listeners.set(name, listener); },
    removeEventListener: (name: string) => { listeners.delete(name); },
  };
  const windows = new Map<string, Listener>();
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const requests: number[] = [];
  let disposed = false;
  class Cache {
    constructor(_file: string, _duration: number, _changed: () => void) {}
    request(seconds: number) { requests.push(seconds); }
    nearest() { return null; }
    dispose() { disposed = true; }
  }

  const slots: { value?: unknown; deps?: unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: initial };
      return [slots[index].value, (value: unknown) => {
        slots[index].value = typeof value === 'function'
          ? (value as (current: unknown) => unknown)(slots[index].value)
          : value;
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((dep, i) => dep !== previous.deps?.[i])) {
        effects.push(() => {
          previous?.cleanup?.();
          const cleanup = effect();
          slots[index] = { deps, cleanup: cleanup || undefined };
        });
      }
    },
  };
  const jsx = (type: string, props: Record<string, unknown>): Node => ({ type, props });
  const imports: Record<string, unknown> = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './SeekPreviewCache': { default: Cache },
    './helpers': { formatTime: (seconds: number) => `${Math.floor(seconds)}s` },
  };
  const compiled = ts.transpileModule(readFileSync(new URL('../src/components/VideoPlayer/SeekHoverPreview.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { default?: (props: Record<string, unknown>) => Node | null } = {};
  runInNewContext(compiled, {
    exports,
    require: (id: string) => { assert.ok(id in imports, `Unexpected import ${id}`); return imports[id]; },
    window: {
      addEventListener: (name: string, listener: Listener) => { windows.set(name, listener); },
      removeEventListener: (name: string) => { windows.delete(name); },
    },
    requestAnimationFrame: (callback: () => void) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  });
  const props = { filePath: '/movie.mp4', duration: 100, sliderRef: { current: slider }, visible: true, playbackPositionRef: { current: 12 } };
  return {
    listeners,
    requests,
    render() {
      cursor = 0;
      effects = [];
      const result = exports.default?.(props) ?? null;
      effects.forEach((effect) => effect());
      return result;
    },
    flushFrame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()); },
    unmount() { slots.forEach((slot) => slot.cleanup?.()); },
    get disposed() { return disposed; },
  };
}

test('hover and primary-button drag update the preview position, then pointer exit hides it', () => {
  const preview = mountPreview();
  assert.equal(preview.render(), null);
  assert.deepEqual(preview.requests, [12]);

  preview.listeners.get('pointermove')?.({ clientX: 60, buttons: 0 });
  preview.flushFrame();
  assert.equal(preview.requests.at(-1), 25);
  const hovered = preview.render();
  assert.ok(hovered);
  assert.equal((hovered.props.style as { left: number }).left, 84);

  preview.listeners.get('pointerdown')?.({ clientX: 160, buttons: 2 });
  assert.equal(preview.render(), null);
  assert.equal(preview.requests.at(-1), 25);

  preview.listeners.get('pointerdown')?.({ clientX: 160, buttons: 1 });
  preview.flushFrame();
  assert.equal(preview.requests.at(-1), 75);
  const dragged = preview.render();
  assert.ok(dragged);
  assert.equal((dragged.props.style as { left: number }).left, 116);

  preview.listeners.get('pointerleave')?.({ clientX: 160, buttons: 0 });
  assert.equal(preview.render(), null);
  preview.unmount();
  assert.equal(preview.disposed, true);
});
