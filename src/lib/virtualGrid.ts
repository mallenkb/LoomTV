export type VirtualGridRange = {
  columns: number;
  columnWidth: number;
  totalRows: number;
  totalHeight: number;
  startIndex: number;
  endIndex: number;
  offsetY: number;
};

export function virtualGridRange(options: {
  itemCount: number;
  containerWidth: number;
  scrollTop: number;
  viewportHeight: number;
  minColumnWidth: number;
  maxColumnWidth: number;
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
  const totalRows = Math.ceil(itemCount / columns);
  const totalHeight = Math.max(0, totalRows * rowHeight - (totalRows > 0 ? gap : 0));
  const overscanRows = Math.max(0, options.overscanRows ?? 2);
  const firstRow = Math.max(0, Math.floor(Math.max(0, options.scrollTop) / rowHeight) - overscanRows);
  const visibleRows = Math.ceil(Math.max(0, options.viewportHeight) / rowHeight) + overscanRows * 2;
  const lastRow = Math.min(totalRows, firstRow + visibleRows);
  const startIndex = Math.min(itemCount, firstRow * columns);
  const endIndex = Math.min(itemCount, lastRow * columns);

  return {
    columns,
    columnWidth,
    totalRows,
    totalHeight,
    startIndex,
    endIndex,
    offsetY: firstRow * rowHeight,
  };
}
