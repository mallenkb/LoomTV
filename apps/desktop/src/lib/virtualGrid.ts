export type VirtualGridRange = {
  columns: number;
  columnWidth: number;
  itemHeight: number;
  totalRows: number;
  totalHeight: number;
  startIndex: number;
  endIndex: number;
  offsetY: number;
};

export type VirtualGridLayout = {
  compact: boolean;
  minColumnWidth: number;
  maxColumnWidth: number;
  rowHeight: number;
  gap: number;
};

export function virtualGridLayout(options: {
  containerWidth: number;
  minColumnWidth: number;
  maxColumnWidth: number;
  rowHeight: number;
  gap: number;
}): VirtualGridLayout {
  const compact = options.containerWidth > 0 && options.containerWidth < 640;
  return {
    compact,
    minColumnWidth: compact ? Math.min(options.minColumnWidth, 104) : options.minColumnWidth,
    maxColumnWidth: compact ? Math.min(options.maxColumnWidth, 150) : options.maxColumnWidth,
    rowHeight: compact ? Math.min(options.rowHeight, 250) : options.rowHeight,
    gap: compact ? Math.min(options.gap, 14) : options.gap,
  };
}

export function virtualGridRange(options: {
  itemCount: number;
  containerWidth: number;
  scrollTop: number;
  viewportHeight: number;
  minColumnWidth: number;
  maxColumnWidth: number;
  /** Row pitch in pixels, including the gap between consecutive rows. */
  rowHeight: number;
  gap: number;
  overscanRows?: number;
}): VirtualGridRange {
  const itemCount = Math.max(0, Math.floor(options.itemCount));
  const gap = Math.max(0, options.gap);
  const minColumnWidth = Math.max(1, options.minColumnWidth);
  const maxColumnWidth = Math.max(minColumnWidth, options.maxColumnWidth);
  const containerWidth = Math.max(minColumnWidth, options.containerWidth);
  const columns = Math.max(1, Math.floor((containerWidth + gap) / (minColumnWidth + gap)));
  const columnWidth = Math.min(maxColumnWidth, (containerWidth - gap * (columns - 1)) / columns);
  const rowHeight = Math.max(1, options.rowHeight);
  const itemHeight = Math.max(0, rowHeight - gap);
  const totalRows = Math.ceil(itemCount / columns);
  const totalHeight = Math.max(0, totalRows * rowHeight - (totalRows > 0 ? gap : 0));
  const overscanRows = Math.max(0, options.overscanRows ?? 2);
  const firstRow = Math.min(
    totalRows,
    Math.max(0, Math.floor(Math.max(0, options.scrollTop) / rowHeight) - overscanRows),
  );
  const visibleRows = Math.ceil(Math.max(0, options.viewportHeight) / rowHeight) + overscanRows * 2;
  const lastRow = Math.min(totalRows, firstRow + visibleRows);
  const startIndex = Math.min(itemCount, firstRow * columns);
  const endIndex = Math.min(itemCount, lastRow * columns);

  return {
    columns,
    columnWidth,
    itemHeight,
    totalRows,
    totalHeight,
    startIndex,
    endIndex,
    offsetY: firstRow * rowHeight,
  };
}

export function virtualGridCardHeightDiverges(
  expectedHeight: number,
  measuredHeight: number,
  tolerance = 0.5,
) {
  return !Number.isFinite(measuredHeight)
    || Math.abs(measuredHeight - expectedHeight) > Math.max(0, tolerance);
}

export function virtualGridItemAttributes(
  range: VirtualGridRange,
  visibleIndex: number,
  itemCount: number,
) {
  return {
    role: 'listitem' as const,
    'aria-posinset': range.startIndex + visibleIndex + 1,
    'aria-setsize': itemCount,
    style: { width: range.columnWidth, height: range.itemHeight },
  };
}
