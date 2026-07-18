import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DARK_THEMES,
  applyTheme,
  normalizeThemeMode,
} from '../src/lib/theme.ts';

type MockThemeRoot = {
  dataset: Record<string, string>;
  properties: Map<string, string>;
};

function withMockThemeRoot(run: (root: MockThemeRoot) => void): void {
  const originalDocument = globalThis.document;
  const properties = new Map<string, string>();
  const dataset: Record<string, string> = {};
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: {
        dataset,
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
        },
      },
    },
  });

  try {
    run({ dataset, properties });
  } finally {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
  }
}

test('theme mode normalization defaults safely to dark', () => {
  assert.equal(normalizeThemeMode('light'), 'light');
  assert.equal(normalizeThemeMode('dark'), 'dark');
  assert.equal(normalizeThemeMode('unsupported'), 'dark');
});

test('light mode updates LoomTV and component primitive tokens together', () => {
  withMockThemeRoot(({ dataset, properties }) => {
    applyTheme({ mode: 'light', color: 'yellow', darkTheme: 'black' });

    assert.equal(dataset.theme, 'light');
    assert.equal(properties.get('color-scheme'), 'light');
    assert.equal(properties.get('--loom-bg'), '#f4f6f8');
    assert.equal(properties.get('--loom-sidebar'), '#f4f6f8');
    assert.equal(properties.get('--loom-surface'), '#ffffff');
    assert.equal(properties.get('--loom-text'), '#17212b');
    assert.equal(properties.get('--loom-active-bg'), '#e7e5e4');
    assert.equal(properties.get('--loom-active-bg-strong'), '#d6d3d1');
    assert.equal(properties.get('--loom-active-text'), '#1c1917');
    assert.equal(properties.get('--loom-active-muted'), '#57534e');
    assert.equal(properties.get('--loom-active-border'), '#d6d3d1');
    assert.equal(properties.get('--loom-focus-ring'), '#a8a29e');
    assert.equal(properties.get('--color-background'), '#f4f6f8');
    assert.equal(properties.get('--color-card-foreground'), '#17212b');
  });
});

test('switching back to dark restores the selected dark palette', () => {
  withMockThemeRoot(({ dataset, properties }) => {
    applyTheme({ mode: 'light', color: 'blue', darkTheme: 'black' });
    applyTheme({ mode: 'dark', color: 'blue', darkTheme: 'black' });

    assert.equal(dataset.theme, 'dark');
    assert.equal(dataset.darkTheme, 'black');
    assert.equal(properties.get('color-scheme'), 'dark');
    assert.equal(properties.get('--loom-bg'), DARK_THEMES.black.bg);
    assert.equal(properties.get('--loom-sidebar'), DARK_THEMES.black.bg);
    assert.equal(properties.get('--loom-text'), '#ffffff');
  });
});
