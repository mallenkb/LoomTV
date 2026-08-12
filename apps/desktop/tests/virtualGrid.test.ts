import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  virtualGridCardHeightDiverges,
  virtualGridItemAttributes,
  virtualGridLayout,
  virtualGridRange,
} from '../src/lib/virtualGrid.ts';

const source = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('virtual grid renders only visible rows plus overscan', () => {
  const range = virtualGridRange({
    itemCount: 1000,
    containerWidth: 660,
    scrollTop: 900,
    viewportHeight: 600,
    minColumnWidth: 140,
    maxColumnWidth: 200,
    rowHeight: 340,
    gap: 24,
    overscanRows: 1,
  });

  assert.equal(range.columns, 4);
  assert.equal(range.itemHeight, 316);
  assert.equal(range.startIndex, 4);
  assert.equal(range.endIndex, 20);
  assert.equal(range.totalRows, 250);
  assert.equal(range.totalHeight, 84976);
});

test('virtual grid clamps narrow containers to at least one column', () => {
  const range = virtualGridRange({
    itemCount: 3,
    containerWidth: 40,
    scrollTop: 0,
    viewportHeight: 500,
    minColumnWidth: 140,
    maxColumnWidth: 200,
    rowHeight: 340,
    gap: 24,
  });

  assert.equal(range.columns, 1);
  assert.equal(range.columnWidth, 140);
  assert.equal(range.startIndex, 0);
  assert.equal(range.endIndex, 3);
});

test('default grid keeps 1,003 items reachable at a partial final row and deep scroll', () => {
  const range = virtualGridRange({
    itemCount: 1003,
    containerWidth: 660,
    scrollTop: 112_880,
    viewportHeight: 600,
    minColumnWidth: 176,
    maxColumnWidth: 200,
    rowHeight: 340,
    gap: 24,
    overscanRows: 2,
  });

  assert.equal(range.columns, 3);
  assert.equal(range.itemHeight, 316);
  assert.equal(range.totalRows, 335);
  assert.equal(range.totalHeight, 113_876);
  assert.equal(range.startIndex, 990);
  assert.equal(range.endIndex, 1003);
  assert.equal(range.offsetY, 112_200);
});

test('compact grid keeps 1,003 items reachable with a 236px card height', () => {
  const range = virtualGridRange({
    itemCount: 1003,
    containerWidth: 620,
    scrollTop: 49_500,
    viewportHeight: 600,
    minColumnWidth: 104,
    maxColumnWidth: 150,
    rowHeight: 250,
    gap: 14,
    overscanRows: 2,
  });

  assert.equal(range.columns, 5);
  assert.equal(range.itemHeight, 236);
  assert.equal(range.totalRows, 201);
  assert.equal(range.totalHeight, 50_236);
  assert.equal(range.startIndex, 980);
  assert.equal(range.endIndex, 1003);
  assert.equal(range.offsetY, 49_000);
});

test('the 640px transition selects the component compact and default contracts', () => {
  const options = {
    minColumnWidth: 176,
    maxColumnWidth: 200,
    rowHeight: 340,
    gap: 24,
  };
  const compact = virtualGridLayout({ ...options, containerWidth: 639 });
  const regular = virtualGridLayout({ ...options, containerWidth: 640 });

  assert.deepEqual(compact, {
    compact: true,
    minColumnWidth: 104,
    maxColumnWidth: 150,
    rowHeight: 250,
    gap: 14,
  });
  assert.deepEqual(regular, { compact: false, ...options });
  assert.equal(virtualGridRange({
    itemCount: 1,
    containerWidth: 639,
    scrollTop: 0,
    viewportHeight: 600,
    ...compact,
  }).itemHeight, 236);
  assert.equal(virtualGridRange({
    itemCount: 1,
    containerWidth: 640,
    scrollTop: 0,
    viewportHeight: 600,
    ...regular,
  }).itemHeight, 316);
});

test('resize and column-count changes preserve pitch arithmetic', () => {
  const options = {
    itemCount: 1003,
    scrollTop: 0,
    viewportHeight: 720,
    minColumnWidth: 176,
    maxColumnWidth: 200,
    rowHeight: 340,
    gap: 24,
  };
  const narrow = virtualGridRange({ ...options, containerWidth: 420 });
  const medium = virtualGridRange({ ...options, containerWidth: 660 });
  const wide = virtualGridRange({ ...options, containerWidth: 900 });

  assert.deepEqual([narrow.columns, medium.columns, wide.columns], [2, 3, 4]);
  for (const range of [narrow, medium, wide]) {
    assert.equal(range.itemHeight, 316);
    assert.equal(range.totalHeight, range.totalRows * 340 - 24);
    assert.equal(range.offsetY % 340, 0);
  }
});

test('the final partial row remains rendered at the valid scroll limit after column changes', () => {
  const itemCount = 1003;
  const viewportHeight = 720;
  for (const containerWidth of [420, 660, 900]) {
    const initial = virtualGridRange({
      itemCount,
      containerWidth,
      scrollTop: 0,
      viewportHeight,
      minColumnWidth: 176,
      maxColumnWidth: 200,
      rowHeight: 340,
      gap: 24,
      overscanRows: 2,
    });
    const bottom = virtualGridRange({
      itemCount,
      containerWidth,
      scrollTop: Math.max(0, initial.totalHeight - viewportHeight),
      viewportHeight,
      minColumnWidth: 176,
      maxColumnWidth: 200,
      rowHeight: 340,
      gap: 24,
      overscanRows: 2,
    });

    assert.equal(bottom.endIndex, itemCount);
    assert.ok(bottom.startIndex < itemCount);
    assert.equal(bottom.offsetY % 340, 0);
  }
});

test('empty grids have no rows while retaining the normalized card-height contract', () => {
  const range = virtualGridRange({
    itemCount: 0,
    containerWidth: 900,
    scrollTop: 20_000,
    viewportHeight: 720,
    minColumnWidth: 176,
    maxColumnWidth: 200,
    rowHeight: 340,
    gap: 24,
  });

  assert.equal(range.itemHeight, 316);
  assert.equal(range.totalRows, 0);
  assert.equal(range.totalHeight, 0);
  assert.equal(range.startIndex, 0);
  assert.equal(range.endIndex, 0);
  assert.equal(range.offsetY, 0);
});

test('measured card-height drift uses a subpixel tolerance', () => {
  assert.equal(virtualGridCardHeightDiverges(316, 316), false);
  assert.equal(virtualGridCardHeightDiverges(316, 316.5), false);
  assert.equal(virtualGridCardHeightDiverges(316, 316.51), true);
  assert.equal(virtualGridCardHeightDiverges(236, Number.NaN), true);
});

test('rendered wrappers receive exact geometry and virtual-list position metadata', () => {
  const range = virtualGridRange({
    itemCount: 1003,
    containerWidth: 660,
    scrollTop: 112_880,
    viewportHeight: 600,
    minColumnWidth: 176,
    maxColumnWidth: 200,
    rowHeight: 340,
    gap: 24,
    overscanRows: 2,
  });

  assert.deepEqual(virtualGridItemAttributes(range, 0, 1003), {
    role: 'listitem',
    'aria-posinset': 991,
    'aria-setsize': 1003,
    style: { width: 200, height: 316 },
  });
  assert.deepEqual(virtualGridItemAttributes(range, 12, 1003), {
    role: 'listitem',
    'aria-posinset': 1003,
    'aria-setsize': 1003,
    style: { width: 200, height: 316 },
  });
});

test('poster markup contains missing-artwork and long-title geometry inside the pinned card', () => {
  const gridSource = source('../src/components/VirtualPosterGrid.tsx');
  const cardSource = source('../src/components/MediaPosterCard.tsx');
  const stylesSource = source('../src/index.css');

  assert.match(gridSource, /\.\.\.virtualGridItemAttributes\(range, visibleIndex, items\.length\)/);
  assert.match(gridSource, /role="list"/);
  assert.match(cardSource, /movies: `[^`]*loom-virtual-poster-card[^`]*flex[^`]*h-full[^`]*flex-col[^`]*overflow-hidden/);
  assert.match(cardSource, /tv: `[^`]*loom-virtual-poster-card[^`]*flex[^`]*h-full[^`]*flex-col[^`]*overflow-hidden/);
  assert.match(cardSource, /others: `[^`]*loom-virtual-poster-card[^`]*flex[^`]*h-full[^`]*flex-col[^`]*overflow-hidden/);
  assert.match(cardSource, /FALLBACK_CLASS = '[^']*h-full[^']*'/);
  assert.match(cardSource, /loom-poster-frame[^"]*aspect-\[2\/3\][^"]*min-h-0[^"]*shrink/);
  assert.match(cardSource, /<div className="mt-2 shrink-0 overflow-hidden[^"]*">/);
  assert.match(cardSource, /\? 'line-clamp-2[^']*min-h-\[2rem\][^']*break-all/);
  assert.match(cardSource, /: 'line-clamp-2[^']*text-sm/);
  assert.match(stylesSource, /\.loom-poster-link\.loom-virtual-poster-card\s*\{[^}]*width: 100% !important;[^}]*max-width: 100% !important;/s);
});

test('card-height diagnostics are development-only and warn once per grid instance', () => {
  const gridSource = source('../src/components/VirtualPosterGrid.tsx');

  assert.match(gridSource, /if \(!IS_DEVELOPMENT \|\| warnedAboutCardHeightRef\.current\)/);
  assert.match(gridSource, /if \(warnedAboutCardHeightRef\.current\) return true;/);
  assert.match(gridSource, /for \(const card of renderedCards\) \{\s*if \(warnIfCardHeightDiverges\(card\)\) return undefined;/);
  assert.match(gridSource, /\[range\.endIndex, range\.itemHeight, range\.startIndex, visibleItemIds\]/);
});
