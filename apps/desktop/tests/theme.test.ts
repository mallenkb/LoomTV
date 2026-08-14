import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DARK_THEMES,
  DEFAULT_THEME_SETTINGS,
  applyTheme,
  normalizeHomeStyle,
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

test('home style defaults to modern but keeps an explicit classic choice', () => {
  assert.equal(DEFAULT_THEME_SETTINGS.homeStyle, 'modern');
  assert.equal(normalizeHomeStyle(undefined), 'modern');
  assert.equal(normalizeHomeStyle('unsupported'), 'modern');
  // A profile that picked Classic must not be migrated onto the new default.
  assert.equal(normalizeHomeStyle('default'), 'default');
});

test('modern overrides a requested light mode because it is dark only', () => {
  withMockThemeRoot(({ dataset }) => {
    applyTheme({ mode: 'light', color: 'blue', homeStyle: 'modern' });

    assert.equal(dataset.homeStyle, 'modern');
    assert.equal(dataset.theme, 'dark');
  });
});

/* These two cover the Classic style's palettes. They name homeStyle explicitly
   because Modern is now the default, and Modern is a dark-only style that
   overrides the requested mode — without it they would assert against the
   Modern palette instead. */
test('light mode updates LoomTV and component primitive tokens together', () => {
  withMockThemeRoot(({ dataset, properties }) => {
    applyTheme({ mode: 'light', color: 'yellow', darkTheme: 'black', homeStyle: 'default' });

    assert.equal(dataset.theme, 'light');
    assert.equal(properties.get('color-scheme'), 'light');
    assert.equal(properties.get('--loom-bg'), '#f5f5f5');
    assert.equal(properties.get('--loom-sidebar'), '#f5f5f5');
    assert.equal(properties.get('--loom-surface'), '#ffffff');
    assert.equal(properties.get('--loom-text'), '#171717');
    assert.equal(properties.get('--loom-active-bg'), '#e7e5e4');
    assert.equal(properties.get('--loom-active-bg-strong'), '#d6d3d1');
    assert.equal(properties.get('--loom-active-text'), '#1c1917');
    assert.equal(properties.get('--loom-active-muted'), '#57534e');
    assert.equal(properties.get('--loom-active-border'), '#d6d3d1');
    assert.equal(properties.get('--loom-focus-ring'), '#a8a29e');
    assert.equal(properties.get('--color-background'), '#f5f5f5');
    assert.equal(properties.get('--color-card-foreground'), '#171717');
  });
});

test('switching back to dark restores the selected dark palette', () => {
  withMockThemeRoot(({ dataset, properties }) => {
    applyTheme({ mode: 'light', color: 'blue', darkTheme: 'black', homeStyle: 'default' });
    applyTheme({ mode: 'dark', color: 'blue', darkTheme: 'black', homeStyle: 'default' });

    assert.equal(dataset.theme, 'dark');
    assert.equal(dataset.darkTheme, 'black');
    assert.equal(properties.get('color-scheme'), 'dark');
    assert.equal(properties.get('--loom-bg'), DARK_THEMES.black.bg);
    assert.equal(properties.get('--loom-sidebar'), DARK_THEMES.black.bg);
    assert.equal(properties.get('--loom-text'), '#fafafa');
  });
});
