import assert from 'node:assert/strict';
import test from 'node:test';
import { virtualGridRange } from '../src/lib/virtualGrid.ts';

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
